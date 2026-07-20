/**
 * HuntService (Milestone 2A): spends 1 Hunt Energy, honors a per-player
 * cooldown, enforces "one active encounter per player", rolls the weighted
 * result table, and either creates an encounter row or grants a non-encounter
 * reward — all in a single transaction so a failure never consumes energy.
 *
 * Capture attempts, public messages, duplicate handling, and rare
 * announcements are explicitly out of scope here and land in the next
 * milestone.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  encounters,
  items,
  playerCurrencies,
  players,
  species,
  type EncounterRow,
  type ItemRow,
  type Rarity,
  type SpeciesRow,
} from '../../db/schema';
import {
  ActiveEncounterError,
  EncounterNotFoundError,
  HuntCooldownError,
  InsufficientEnergyError,
  isUniqueViolation,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { defaultRng, rollWeighted, type Rng, type WeightedEntry } from '../../shared/random';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { HuntResultKind, TablesContent } from '../content/schemas';
import type {
  LevelUpEvent,
  ProgressionService,
} from '../progression/progressionService';
import type { BuddyAwardResult, CollectionService } from '../collection/collectionService';
import type { CareService, CareTickSummary } from '../care/careService';
import type { QuestService } from '../quests/questService';

interface WithXp {
  levelUps: LevelUpEvent[];
  /** Per-hunt buddy XP + affection award, null when the player has no buddy. */
  buddyAward: BuddyAwardResult | null;
  /**
   * Care Mode pending-tick summary applied at the start of this hunt (before
   * energy was spent). `null` when Care Mode was not active. Care Mode is
   * *always* exited by a hunt, regardless of tick count.
   */
  careExit: CareTickSummary | null;
}

export interface HuntEncounterResult extends WithXp {
  kind: 'encounter';
  species: SpeciesRow;
  encounter: EncounterRow;
  energyRemaining: number;
}

export interface HuntItemResult extends WithXp {
  kind: 'item_find' | 'rare_item_find';
  item: ItemRow;
  quantity: number;
  energyRemaining: number;
}

export interface HuntWaifubuxResult extends WithXp {
  kind: 'waifubux_find';
  amount: number;
  balanceAfter: number;
  energyRemaining: number;
}

export interface HuntEssenceResult extends WithXp {
  kind: 'essence_find';
  amount: number;
  balanceAfter: number;
  energyRemaining: number;
}

export interface HuntFlavorResult extends WithXp {
  kind: 'flavor';
  text: string;
  energyRemaining: number;
}

export type HuntResult =
  | HuntEncounterResult
  | HuntItemResult
  | HuntWaifubuxResult
  | HuntEssenceResult
  | HuntFlavorResult;

export interface HuntService {
  /**
   * Spend 1 energy, honor cooldown, enforce one-active-encounter, then roll.
   * The energy spend + encounter creation (or reward grant) is atomic — a
   * thrown error means no state changed.
   */
  hunt(playerId: number, channelId: string, now?: Date): Promise<HuntResult>;

  /** Read-only fetch of the player's active encounter, if any. */
  getActiveEncounter(playerId: number, now?: Date): Promise<EncounterRow | null>;

  /**
   * Resolve the given active encounter with state='released'. Milestone 2A
   * only supports pre-attempt release; capture attempts land in the next
   * milestone.
   */
  letHerGo(playerId: number, encounterId: number, now?: Date): Promise<EncounterRow>;

  /**
   * Best-effort startup sweep: mark encounters whose `expires_at` has passed
   * as 'expired'. Also invoked lazily by hunt() when it finds a stale row.
   */
  expireStale(now?: Date): Promise<number>;
}

export interface HuntServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  progression: ProgressionService;
  collection: CollectionService;
  care: CareService;
  quests: QuestService;
  tables: TablesContent;
  logger: Logger;
  rng?: Rng;
}

const MAX_RARITY_REROLLS = 6;

export function createHuntService(deps: HuntServiceDeps): HuntService {
  const { db, currency, inventory, progression, collection, care, quests, tables, logger } =
    deps;
  const rng = deps.rng ?? defaultRng();
  const hunt = tables.hunt;

  /**
   * Applies the level-40 rare-encounter shift additively: subtracts `weightUnits`
   * from `fromRarity` (floored at 0) and adds it to `toRarity`. Total weight
   * is preserved so the roll stays uniform.
   */
  function rarityEntriesFor(level: number): Array<WeightedEntry<Rarity>> {
    const entries: Array<WeightedEntry<Rarity>> = hunt.rarityTable.map((r) => ({
      weight: r.weight,
      value: r.rarity,
    }));
    const shift = progression.computeRareShift(level);
    if (!shift) return entries;
    return entries.map((e) => {
      if (e.value === shift.fromRarity) {
        return { weight: Math.max(0, e.weight - shift.weightUnits), value: e.value };
      }
      if (e.value === shift.toRarity) {
        return { weight: e.weight + shift.weightUnits, value: e.value };
      }
      return e;
    });
  }

  async function pickEncounterSpecies(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    level: number,
  ): Promise<SpeciesRow | null> {
    const rarityEntries = rarityEntriesFor(level);
    for (let attempt = 0; attempt < MAX_RARITY_REROLLS; attempt++) {
      const rarity = rollWeighted(rarityEntries, rng);
      const rows = await tx
        .select()
        .from(species)
        .where(and(eq(species.rarity, rarity), eq(species.enabled, true)));
      if (rows.length === 0) {
        logger.warn({ rarity, attempt }, 'no enabled species in rarity bucket, rerolling');
        continue;
      }
      const picked = rollWeighted(
        rows.map((s) => ({ weight: Math.max(1, s.perSpeciesWeight), value: s })),
        rng,
      );
      return picked;
    }
    // Absolute fallback: any enabled species at all.
    const anyRow = await tx.select().from(species).where(eq(species.enabled, true)).limit(1);
    if (anyRow[0]) {
      logger.warn('rarity reroll exhausted, using arbitrary enabled species');
      return anyRow[0];
    }
    return null;
  }

  async function loadItemBySlug(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    slug: string,
  ): Promise<ItemRow | null> {
    const [row] = await tx.select().from(items).where(eq(items.slug, slug));
    return row ?? null;
  }

  return {
    async hunt(playerId, channelId, now = new Date()) {
      // Care Mode: apply pending ticks *before* the hunt transaction so
      // recovered energy is visible on the energy check. This step does not
      // exit Care Mode — if the hunt fails with insufficient energy the
      // player stays in Care Mode (spec §5B / hunt interaction). The care
      // fields are cleared inside the hunt transaction only after energy
      // has been successfully spent.
      const careTicks = await care.applyPending(playerId, now);

      return db.transaction(async (tx) => {
        // Lock the currency row (serializes concurrent hunts for this player).
        const currencies = await currency.lockCurrencies(tx, playerId);

        // Lock the player row for the lastHuntAt read/write.
        const [player] = await tx
          .select()
          .from(players)
          .where(eq(players.id, playerId))
          .for('update');
        if (!player) throw new EncounterNotFoundError();

        // One-active-encounter check (lazily expire stale rows here).
        const [active] = await tx
          .select()
          .from(encounters)
          .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')))
          .for('update');
        if (active) {
          if (active.expiresAt.getTime() <= now.getTime()) {
            await tx
              .update(encounters)
              .set({ state: 'expired', resolvedAt: now })
              .where(eq(encounters.id, active.id));
          } else {
            throw new ActiveEncounterError(active.id);
          }
        }

        // Cooldown check.
        if (player.lastHuntAt) {
          const retryAt = new Date(
            player.lastHuntAt.getTime() + hunt.cooldownSeconds * 1000,
          );
          if (retryAt.getTime() > now.getTime()) {
            throw new HuntCooldownError(retryAt);
          }
        }

        // Energy check.
        if (currencies.huntEnergy < 1) {
          throw new InsufficientEnergyError();
        }

        // Energy is sufficient — exit Care Mode inside this transaction so
        // the clear is atomic with the spend. `care.applyPending` above
        // already advanced any pending ticks; this call just clears the
        // care_* fields (ticksProcessed=0).
        const careExit = await care.applyAndExit(tx, playerId, now);
        // Fold the two summaries: report the ticks that were actually
        // granted (careTicks) but the post-call state (cleared) from
        // careExit. Either can be null-ish when Care Mode wasn't active.
        const careForResult = careTicks.active || careTicks.ticksProcessed > 0 || careExit.stopped
          ? { ...careTicks, active: false, stopped: careExit.stopped || careTicks.stopped }
          : null;

        // Spend energy + stamp lastHuntAt.
        const [updatedCur] = await tx
          .update(playerCurrencies)
          .set({
            huntEnergy: sql`${playerCurrencies.huntEnergy} - 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(playerCurrencies.playerId, playerId))
          .returning();
        await tx.update(players).set({ lastHuntAt: now }).where(eq(players.id, playerId));

        const energyRemaining = updatedCur?.huntEnergy ?? 0;

        // Grant hunt XP (in the same tx — energy spent + XP go together).
        const xp = await progression.grantXp(tx, playerId, {
          eventType: 'hunt',
          xpDelta: tables.progression.xp.hunt,
          metadata: { channelId },
        });
        const levelUps = xp.levelUps;

        // Buddy hunt reward — small XP + affection, only if a buddy is set.
        const buddyAward = await collection.awardBuddyOnHunt(tx, playerId);

        // Daily-quest progress: 1 hunt energy spent per hunt, plus buddy
        // affection gained (if any). Care Mode ticks and their affection
        // are recorded by CareService inside its own tick core, so we do
        // NOT re-record them here.
        await quests.recordQuestEvent(tx, playerId, 'hunt_energy_spent', 1, {}, now);
        if (buddyAward && buddyAward.affectionGranted > 0) {
          await quests.recordQuestEvent(
            tx,
            playerId,
            'waifu_affection_gained',
            buddyAward.affectionGranted,
            {},
            now,
          );
        }

        // Roll the result table.
        const kind: HuntResultKind = rollWeighted(
          hunt.resultTable.map((r) => ({ weight: r.weight, value: r.kind })),
          rng,
        );

        if (kind === 'encounter') {
          const picked = await pickEncounterSpecies(tx, player.level);
          if (!picked) {
            // No species at all — degrade to flavor rather than crash.
            logger.error('no enabled species available; degrading encounter to flavor');
            return {
              kind: 'flavor',
              text: hunt.flavor[rng.intInclusive(0, hunt.flavor.length - 1)]!,
              energyRemaining,
              levelUps,
              buddyAward,
              careExit: careForResult,
            } satisfies HuntFlavorResult;
          }
          const expiresAt = new Date(now.getTime() + hunt.encounterExpirySeconds * 1000);
          try {
            const [encounter] = await tx
              .insert(encounters)
              .values({
                playerId,
                speciesId: picked.id,
                channelId,
                state: 'active',
                attemptCount: 0,
                maxAttempts: 3,
                expiresAt,
              })
              .returning();
            return {
              kind: 'encounter',
              species: picked,
              encounter: encounter!,
              energyRemaining,
              levelUps,
              buddyAward,
              careExit: careForResult,
            } satisfies HuntEncounterResult;
          } catch (err) {
            if (isUniqueViolation(err)) {
              throw new ActiveEncounterError(-1);
            }
            throw err;
          }
        }

        if (kind === 'item_find' || kind === 'rare_item_find') {
          const table = kind === 'item_find' ? hunt.itemFind : hunt.rareItemFind;
          const sub = rollWeighted(
            table.sub.map((s) => ({ weight: s.weight, value: s })),
            rng,
          );
          const item = await loadItemBySlug(tx, sub.slug);
          if (!item || !item.enabled) {
            logger.warn({ slug: sub.slug }, 'hunt reward item missing or disabled');
            return {
              kind: 'flavor',
              text: hunt.flavor[rng.intInclusive(0, hunt.flavor.length - 1)]!,
              energyRemaining,
              levelUps,
              buddyAward,
              careExit: careForResult,
            } satisfies HuntFlavorResult;
          }
          const quantity = rng.intInclusive(sub.minQty, sub.maxQty);
          await inventory.addItem(tx, playerId, item.id, quantity);
          return {
            kind,
            item,
            quantity,
            energyRemaining,
            levelUps,
            buddyAward,
            careExit: careForResult,
          } satisfies HuntItemResult;
        }

        if (kind === 'waifubux_find') {
          const amount = rng.intInclusive(hunt.waifubuxFind.min, hunt.waifubuxFind.max);
          const row = await currency.grantWaifubux(tx, playerId, amount);
          return {
            kind: 'waifubux_find',
            amount,
            balanceAfter: row.waifubux,
            energyRemaining,
            levelUps,
            buddyAward,
            careExit: careForResult,
          } satisfies HuntWaifubuxResult;
        }

        if (kind === 'essence_find') {
          const amount = rng.intInclusive(hunt.essenceFind.min, hunt.essenceFind.max);
          const row = await currency.grantEssence(tx, playerId, amount);
          return {
            kind: 'essence_find',
            amount,
            balanceAfter: row.essence,
            energyRemaining,
            levelUps,
            buddyAward,
            careExit: careForResult,
          } satisfies HuntEssenceResult;
        }

        // kind === 'flavor'
        const text = hunt.flavor[rng.intInclusive(0, hunt.flavor.length - 1)]!;
        return {
          kind: 'flavor',
          text,
          energyRemaining,
          levelUps,
          buddyAward,
          careExit: careForResult,
        } satisfies HuntFlavorResult;
      });
    },

    async getActiveEncounter(playerId, now = new Date()) {
      const [row] = await db
        .select()
        .from(encounters)
        .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')))
        .limit(1);
      if (!row) return null;
      if (row.expiresAt.getTime() <= now.getTime()) return null;
      return row;
    },

    async letHerGo(playerId, encounterId, now = new Date()) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(encounters)
          .where(and(eq(encounters.id, encounterId), eq(encounters.playerId, playerId)))
          .for('update');
        if (!locked || locked.state !== 'active') {
          throw new EncounterNotFoundError();
        }
        if (locked.expiresAt.getTime() <= now.getTime()) {
          await tx
            .update(encounters)
            .set({ state: 'expired', resolvedAt: now })
            .where(eq(encounters.id, locked.id));
          throw new EncounterNotFoundError();
        }
        const [updated] = await tx
          .update(encounters)
          .set({ state: 'released', resolvedAt: now })
          .where(eq(encounters.id, locked.id))
          .returning();
        return updated!;
      });
    },

    async expireStale(now = new Date()) {
      const rows = await db
        .update(encounters)
        .set({ state: 'expired', resolvedAt: now })
        .where(and(eq(encounters.state, 'active'), lte(encounters.expiresAt, now)))
        .returning({ id: encounters.id });
      return rows.length;
    },
  };
}
