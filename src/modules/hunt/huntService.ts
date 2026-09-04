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
import type { Db, DbOrTx } from '../../db/client';
import {
  encounters,
  items,
  playerCurrencies,
  players,
  regionEncounterPools,
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
import { resolveHuntSessionBoundary, type HuntSessionBoundary } from './huntSession';
import {
  DEFAULT_REGION,
  REGION_EXCLUSIVE_TAG,
  REGION_EXCLUSIVE_TAG_JSON,
} from '../locations/regions';
import { toRegion } from '../travel/travelCatalog';
import {
  appliedBuddyBonus,
  applyPercentModifier,
  applyPercentModifierInt,
  buddyBonusPercent,
  type AppliedBuddyBonus,
  encounterRarityWeightPercent,
  encounterSpeciesWeightPercent,
  rollBuddyBonusProc,
  type BuddyBonus,
} from '../buddyBonus/buddyBonusEffects';
import { speciesRefFromRow, type BuddyBonusService } from '../buddyBonus/buddyBonusService';

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
  /**
   * Whether this hunt crossed a hunt-session boundary. Purely descriptive —
   * the coordinator turns it into `PLAYER_STARTED_HUNT` /
   * `PLAYER_COMPLETED_HUNT` narration. No gameplay branches on it.
   */
  session: HuntSessionBoundary;
  /**
   * True when the active Buddy's `energy_save_chance` bonus procced and this
   * hunt cost no Energy. Presentation only — the spend already happened (or
   * did not) before this was reported.
   */
  energySaved: boolean;
  /**
   * Every Buddy Bonus that actually affected *this* hunt — a proc that fired,
   * an award that grew, a targeted bonus whose target the encountered species
   * met. Empty with no buddy, and empty when the equipped buddy's bonus had
   * nothing to do with what happened, so a caller can render the list without
   * deciding what is relevant.
   */
  buddyBonuses: AppliedBuddyBonus[];
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
   * As {@link getActiveEncounter}, but joined to the species row.
   *
   * Added for the Platform API (Phase 2): an encounter carries only a
   * `species_id`, and the API's content endpoints are slug-addressed and
   * carry no ids, so a client holding a bare id could not resolve who the
   * player met. Purely additive — `getActiveEncounter` is untouched and
   * remains what the Discord handlers call. Same filter, same expiry rule,
   * one query instead of two.
   */
  getActiveEncounterDetail(
    playerId: number,
    now?: Date,
  ): Promise<{ encounter: EncounterRow; species: SpeciesRow } | null>;

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

  /**
   * The hunt's own region/rarity species draw, exposed for *scripted* spawns.
   *
   * {@link WildEncounterSpawner} calls this when something outside the hunt
   * ("a wild Waifumon appears") must pick a species and the author named none.
   * Sharing the draw is the point: a scripted spawn then has the same
   * distribution the player would have met hunting in that region, and the
   * rarity table, region pools and fallbacks stay stated exactly once.
   *
   * Reads only. No Energy, no cooldown, no row written, no Buddy Bonus applied
   * (a bonus is earned by hunting, not by a script handing you an encounter).
   * Returns `null` when no pool — not even the global fallback — has anything.
   */
  pickSpeciesForSpawn(
    tx: DbOrTx,
    playerId: number,
    playerLevel: number,
    regionId: string | null,
  ): Promise<SpeciesRow | null>;
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
  /**
   * Active Buddy Bonus lookup. Optional: without it every Buddy Bonus term
   * below is 0 or absent and the hunt behaves exactly as it did before.
   */
  buddyBonus?: BuddyBonusService | undefined;
  logger: Logger;
  rng?: Rng;
}

const MAX_RARITY_REROLLS = 6;

export function createHuntService(deps: HuntServiceDeps): HuntService {
  const { db, currency, inventory, progression, collection, care, quests, tables, logger } =
    deps;
  const rng = deps.rng ?? defaultRng();
  const buddyBonus = deps.buddyBonus;
  const hunt = tables.hunt;

  /**
   * Applies the level-40 rare-encounter shift additively: subtracts `weightUnits`
   * from `fromRarity` (floored at 0) and adds it to `toRarity`. Total weight
   * is preserved so the roll stays uniform.
   */
  function rarityEntriesFor(
    level: number,
    bonus: BuddyBonus | null,
  ): Array<WeightedEntry<Rarity>> {
    // A rarity-shaped `encounter_weight` bonus moves *this* table: inside a
    // single rarity bucket every candidate shares a rarity, so scaling them
    // there would cancel out. Relative, so a +10% on a weight of 100 is 110.
    const entries: Array<WeightedEntry<Rarity>> = hunt.rarityTable.map((r) => ({
      weight: applyPercentModifier(r.weight, encounterRarityWeightPercent(bonus, r.rarity)),
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

  /**
   * One region's bucket at one rarity: every enabled species the region's pool
   * lists, carrying that pool's **region-local** weight.
   *
   * The weight comes from `region_encounter_pools`, not `species`, which is the
   * entire point of the junction table — a species can be a rarity in Waifu
   * Valley and a local fixture in Twin Peeks without being two rows in
   * `species`. `Math.max(1, …)` mirrors the pre-region code's defensiveness;
   * the column's CHECK already forbids anything lower.
   */
  /**
   * `species.tags` does not contain `region_exclusive`.
   *
   * A jsonb containment test rather than a scan, so it stays a single indexed
   * -friendly predicate the planner can fold into the existing rarity filter.
   * `tags` is NOT NULL with a `[]` default, so there is no null case to guard.
   */
  function notRegionExclusive() {
    return sql`not (${species.tags} @> ${REGION_EXCLUSIVE_TAG_JSON}::jsonb)`;
  }

  async function regionBucket(
    tx: DbOrTx,
    regionId: string,
    rarity: Rarity,
  ): Promise<Array<WeightedEntry<SpeciesRow>>> {
    const rows = await tx
      .select({ species, weight: regionEncounterPools.weight })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
      .where(
        and(
          eq(regionEncounterPools.regionId, regionId),
          eq(species.rarity, rarity),
          eq(species.enabled, true),
        ),
      );
    return rows.map((r) => ({ weight: Math.max(1, r.weight), value: r.species }));
  }

  /**
   * Picks who the player meets, in the region they are standing in.
   *
   * The **only** thing region changes about a hunt. Everything upstream —
   * energy, cooldown, the one-active-encounter invariant, and crucially the
   * level-adjusted rarity roll — is untouched, and everything downstream
   * (capture chance, rarity value, XP) never learns a region existed. A
   * player who travels meets different Waifumon; she does not catch them at
   * different odds.
   *
   * Four tiers, each giving up one more piece of content's intent:
   *
   *   1. the player's region at the rolled rarity — the normal path;
   *   2. **Waifu Valley's explicit pool** at that rarity, when the player's
   *      region has nobody in that bucket. Preferred over the global fallback
   *      because the starting region is a curated set: a Twin Peeks trainer who
   *      rolls a rarity Twin Peeks has no entry for should meet a valley
   *      regular, not an arbitrary row from the species table;
   *   3. the **pre-region global query** — every enabled species at that
   *      rarity, weighted by `species.per_species_weight`, *minus* anything
   *      tagged `region_exclusive`. This is the behavior the hunt had before
   *      regions existed, and it is retained rather than dropped because it is
   *      the difference between "no pools are seeded" degrading into *the old
   *      game* and degrading into a single fixed species. A content set with no
   *      `content/regions/` directory at all is a supported configuration (see
   *      `validateRegionContent`) and lands here on every draw. The exclusion
   *      is what keeps "exclusive" from meaning "usually": a species whose
   *      whole design is that you must travel to meet her must not be
   *      reachable by a query that has stopped consulting regions;
   *   4. an absolute emergency — any enabled species at all, exclusives
   *      included — reached only when tiers 1–3 have found nothing across
   *      every reroll. That means either an empty species table or a corpus in
   *      which *every* enabled species is region-exclusive and none of them is
   *      pooled, both of which are broken content rather than a configuration.
   *      Logged at error level, because handing out an exclusive is a promise
   *      broken and someone needs to know it happened.
   */
  async function pickEncounterSpecies(
    tx: DbOrTx,
    playerId: number,
    level: number,
    regionId: string,
    bonus: BuddyBonus | null,
  ): Promise<SpeciesRow | null> {
    /**
     * Species-shaped `encounter_weight` (race / affinity / ownership) applied
     * to one bucket of candidates, as a **relative** weight modifier: a
     * baseline weight of 100 with a +10% bonus becomes 110. Nothing is added
     * to or removed from the pool — only the odds between its members move.
     *
     * Ownership is resolved with one query for the whole bucket, and only when
     * the bonus actually targets ownership.
     */
    const applyEncounterWeights = async (
      entries: Array<WeightedEntry<SpeciesRow>>,
    ): Promise<Array<WeightedEntry<SpeciesRow>>> => {
      if (entries.length === 0 || !bonus || !buddyBonus) return entries;
      if (bonus.effectId !== 'encounter_weight') return entries;
      const owned =
        bonus.target?.type === 'ownership'
          ? await buddyBonus.ownedSpeciesIds(
              tx,
              playerId,
              entries.map((e) => e.value.id),
            )
          : new Set<number>();
      const out: Array<WeightedEntry<SpeciesRow>> = [];
      for (const entry of entries) {
        const ref = speciesRefFromRow(entry.value);
        // `subjectFor` resolves race from authored content (the `species` table
        // carries only `archetype`); ownership is filled in from the bulk read
        // above rather than a query per candidate.
        const subject = {
          ...(await buddyBonus.subjectFor(tx, playerId, ref)),
          owned: owned.has(entry.value.id),
        };
        const percent = encounterSpeciesWeightPercent(bonus, subject);
        out.push({ weight: applyPercentModifier(entry.weight, percent), value: entry.value });
      }
      return out;
    };

    const rarityEntries = rarityEntriesFor(level, bonus);
    for (let attempt = 0; attempt < MAX_RARITY_REROLLS; attempt++) {
      const rarity = rollWeighted(rarityEntries, rng);
      let entries = await regionBucket(tx, regionId, rarity);
      if (entries.length === 0 && regionId !== DEFAULT_REGION) {
        entries = await regionBucket(tx, DEFAULT_REGION, rarity);
        if (entries.length > 0) {
          logger.warn(
            { rarity, regionId, attempt },
            'region has no species at this rarity, falling back to the starting region pool',
          );
        }
      }
      if (entries.length === 0) {
        // Neither pool has this rarity. Before rerolling, fall back to the
        // region-blind query the hunt used before pools existed — otherwise a
        // deployment whose pools are empty (or absent) would reroll six times
        // and then hand every player the same arbitrary species forever.
        //
        // Region-exclusive species are excluded here, and that exclusion is
        // the point: this query has stopped consulting regions, so anything it
        // can reach is by definition meetable without travelling. A pool is
        // the *only* way to meet an exclusive.
        const global = await tx
          .select()
          .from(species)
          .where(
            and(eq(species.rarity, rarity), eq(species.enabled, true), notRegionExclusive()),
          );
        if (global.length > 0) {
          logger.warn(
            { rarity, regionId, attempt },
            'no region pool covers this rarity, falling back to the global species table',
          );
          entries = global.map((s) => ({ weight: Math.max(1, s.perSpeciesWeight), value: s }));
        }
      }
      if (entries.length === 0) {
        logger.warn({ rarity, regionId, attempt }, 'no enabled species in rarity bucket, rerolling');
        continue;
      }
      return rollWeighted(await applyEncounterWeights(entries), rng);
    }

    // Rerolls exhausted. Give up on rarity, but keep giving up in the same
    // order: pooled content first, then non-exclusive content, and only then
    // the emergency.
    const valleyRow = await tx
      .select({ species })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
      .where(and(eq(regionEncounterPools.regionId, DEFAULT_REGION), eq(species.enabled, true)))
      .limit(1);
    if (valleyRow[0]) {
      logger.warn(
        { regionId },
        'rarity reroll exhausted, using arbitrary species from the starting region pool',
      );
      return valleyRow[0].species;
    }

    const openRow = await tx
      .select()
      .from(species)
      .where(and(eq(species.enabled, true), notRegionExclusive()))
      .limit(1);
    if (openRow[0]) {
      logger.warn(
        { regionId },
        'rarity reroll exhausted and no region pools seeded, using an arbitrary non-exclusive species',
      );
      return openRow[0];
    }

    // Tier 4. Every enabled species is region-exclusive and none of them is
    // pooled — there is no honest answer left, only the choice between handing
    // out an exclusive and handing out nothing. An encounter beats a crash, so
    // the exclusive goes out and the log says so at error level: this is a
    // content emergency, not a fallback anyone should see in normal operation.
    const anyRow = await tx.select().from(species).where(eq(species.enabled, true)).limit(1);
    if (anyRow[0]) {
      logger.error(
        {
          tag: 'hunt/exclusive-emergency-fallback',
          regionId,
          slug: anyRow[0].slug,
          exclusiveTag: REGION_EXCLUSIVE_TAG,
        },
        'EMERGENCY: no pooled or non-exclusive species exist anywhere — handing out the ' +
          `region-exclusive "${anyRow[0].slug}" outside any region pool. Seed region ` +
          'encounter pools, or untag species that are not meant to be region-locked.',
      );
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

        // The active Buddy Bonus, resolved **once** per hunt and reused by
        // every step below, so a single hunt can never see two different
        // answers to "who is the buddy". Null with no buddy equipped, or when
        // her species authors no bonus.
        const activeBonus = (await buddyBonus?.getActiveBuddyBonus(tx, playerId))?.bonus ?? null;

        // Hunt-session boundary (narration only). Computed from the locked
        // player row *before* `applyAndExit` clears the Care Mode fields, so
        // "was the player resting?" is answered against pre-hunt state.
        const session = resolveHuntSessionBoundary({
          lastHuntAt: player.lastHuntAt,
          careModeActive:
            player.careModeStartedAt != null &&
            player.careModeLastTickAt != null &&
            player.careModeWaifuId != null,
          now,
          idleMinutes: hunt.sessionIdleMinutes,
        });

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
        //
        // `energy_save_chance` is rolled here, at the one moment the hunt would
        // consume Energy. A proc does not skip or cheapen anything else: the
        // hunt runs in full, the cooldown is stamped, the tables roll — the
        // decrement simply does not happen. The energy check above still ran,
        // so a player at 0 Energy cannot hunt on a lucky roll.
        // The draw is taken **only** when there is a chance to win: with no
        // `energy_save_chance` bonus equipped — every hunt in the game before
        // this feature, and most of them after — the RNG stream is untouched
        // and every downstream roll lands exactly where it always did.
        const energySavePercent = buddyBonusPercent(activeBonus, 'energy_save_chance');
        const energySaved =
          energySavePercent > 0 && rollBuddyBonusProc(energySavePercent, rng.next());
        /**
         * What this hunt will report. A bonus joins the list only at the moment
         * it changed something: the proc that fired, the award that grew, the
         * targeted bonus the encounter matched. A failed proc adds nothing —
         * there is no "your bonus did not fire" to tell.
         */
        const buddyBonuses: AppliedBuddyBonus[] = [];
        if (energySaved && activeBonus) {
          buddyBonuses.push(appliedBuddyBonus(activeBonus, { base: 1, final: 0 }));
        }
        const [updatedCur] = await tx
          .update(playerCurrencies)
          .set({
            ...(energySaved ? {} : { huntEnergy: sql`${playerCurrencies.huntEnergy} - 1` }),
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
        //
        // `hunt_item_find_chance` scales the two item-finding outcomes' weights
        // relatively (+10% on a weight of 100 → 110) rather than adding a
        // second, independent item roll: the shipped table stays the single
        // statement of what a hunt can produce, and every other outcome keeps
        // its own weight and simply loses a proportional share of the total.
        const itemFindPercent = buddyBonusPercent(activeBonus, 'hunt_item_find_chance');
        const kind: HuntResultKind = rollWeighted(
          hunt.resultTable.map((r) => ({
            weight:
              r.kind === 'item_find' || r.kind === 'rare_item_find'
                ? applyPercentModifier(r.weight, itemFindPercent)
                : r.weight,
            value: r.kind,
          })),
          rng,
        );

        if (kind === 'encounter') {
          // Resolved from the player row already locked above, so a travel
          // committing mid-hunt cannot change which pool this draw reads.
          const huntRegion = toRegion(player.currentRegion);
          const picked = await pickEncounterSpecies(
            tx,
            playerId,
            player.level,
            huntRegion,
            activeBonus,
          );
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
              energySaved,
              buddyBonuses,
              session,
            } satisfies HuntFlavorResult;
          }
          // Did an `encounter_weight` bonus actually apply to *this* species?
          // Asked of the service rather than re-derived here, so the answer is
          // the same match the weighting used — including ownership.
          const encounterPercent =
            (await buddyBonus?.percentForSpecies(
              tx,
              playerId,
              'encounter_weight',
              speciesRefFromRow(picked),
            )) ?? 0;
          if (encounterPercent !== 0 && activeBonus) buddyBonuses.push(appliedBuddyBonus(activeBonus));

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
                // Snapshot only. Nothing reads it back to make a decision —
                // capture stays region-agnostic — it records where she was met
                // so the row is still honest after the player travels away.
                regionId: huntRegion,
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
              energySaved,
              buddyBonuses,
              session,
            } satisfies HuntEncounterResult;
          } catch (err) {
            if (isUniqueViolation(err)) {
              throw new ActiveEncounterError(-1);
            }
            throw err;
          }
        }

        if (kind === 'item_find' || kind === 'rare_item_find') {
          // Reported on the find itself, and phrased as a chance: the bonus
          // improved the odds of reaching this outcome, it did not hand over
          // the item and it did not change the stack size.
          if (itemFindPercent !== 0 && activeBonus) buddyBonuses.push(appliedBuddyBonus(activeBonus));
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
              energySaved,
              buddyBonuses,
              session,
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
            energySaved,
            buddyBonuses,
            session,
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
            energySaved,
            buddyBonuses,
            session,
          } satisfies HuntWaifubuxResult;
        }

        if (kind === 'essence_find') {
          // `essence_gain` scales the award, not the range: the table still
          // decides how much a find is worth, the bonus decides what it becomes.
          const baseAmount = rng.intInclusive(hunt.essenceFind.min, hunt.essenceFind.max);
          const amount = applyPercentModifierInt(
            baseAmount,
            buddyBonusPercent(activeBonus, 'essence_gain'),
          );
          if (activeBonus && amount > baseAmount) {
            buddyBonuses.push(appliedBuddyBonus(activeBonus, { base: baseAmount, final: amount }));
          }
          const row = await currency.grantEssence(tx, playerId, amount);
          return {
            kind: 'essence_find',
            amount,
            balanceAfter: row.essence,
            energyRemaining,
            levelUps,
            buddyAward,
            careExit: careForResult,
            energySaved,
            buddyBonuses,
            session,
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
          energySaved,
          buddyBonuses,
          session,
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

    async getActiveEncounterDetail(playerId, now = new Date()) {
      const [row] = await db
        .select({ encounter: encounters, species })
        .from(encounters)
        .innerJoin(species, eq(encounters.speciesId, species.id))
        .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')))
        .limit(1);
      if (!row) return null;
      if (row.encounter.expiresAt.getTime() <= now.getTime()) return null;
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

    // The hunt's own draw, with `bonus = null`. A scripted spawn is not a
    // hunt, so no Buddy Bonus weighting applies — but the rarity table,
    // region pools and their fallbacks are shared rather than restated.
    pickSpeciesForSpawn(tx, playerId, playerLevel, regionId) {
      return pickEncounterSpecies(tx, playerId, playerLevel, toRegion(regionId), null);
    },
  };
}
