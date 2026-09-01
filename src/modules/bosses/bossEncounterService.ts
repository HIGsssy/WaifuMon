/**
 * BossEncounterService — the whole Stage 1 lifecycle, and the only place that
 * writes boss tables.
 *
 * Discord-agnostic on purpose: nothing in this file imports discord.js, knows
 * what an embed is, or decides what a message says. The Discord layer calls in
 * with plain ids and gets plain rows back, which is what lets the scheduler,
 * the admin commands, and a test all drive the same code.
 *
 * The five things this service is responsible for getting right:
 *
 *   1. **One active encounter per guild.** Enforced by a partial unique index,
 *      not by a read-then-write. Two processes ticking at the same moment both
 *      insert; one gets a unique violation and reads it as "already spawned".
 *   2. **Restart invisibility.** Every decision that could be re-made
 *      differently is persisted the moment it is made: the drawn boss, the
 *      deadline, the next appearance, the announcement's message id. Recovery
 *      re-reads; it never re-decides.
 *   3. **Claimable, retryable resolution.** The `scouting → resolving`
 *      transition is a single conditional `UPDATE`, so exactly one process
 *      wins it. A claim that goes stale (a worker died) may be taken over
 *      after a configured timeout, and the takeover *finishes* rather than
 *      redoing, because every payout is individually idempotent.
 *   4. **Snapshot-at-commitment.** A participation freezes every stat the
 *      damage formula reads. Nothing at resolution consults the live copy for
 *      anything except where to put the XP.
 *   5. **Rewards at resolution only.** There is no code path from `commit` to
 *      `rollBossRewards`. Committing writes a row and nothing else.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  BOSS_ACTIVE_STATUSES,
  bossEncounters,
  bossParticipations,
  guildBossState,
  items,
  type Affinity,
  type BossEncounterRow,
  type BossParticipationRow,
  type BossResolutionReason,
  type GuildBossStateRow,
  type Rarity,
} from '../../db/schema';
import {
  BossAlreadyCommittedError,
  BossEncounterNotFoundError,
  BossEncounterNotOpenError,
  BossNoActiveBuddyError,
  ContentValidationError,
  isUniqueViolation,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { defaultRng, type Rng } from '../../shared/random';
import { resolveRace } from '../cards/race';
import type { CollectionService } from '../collection/collectionService';
import {
  bossRewardTableVersion,
  type BossContent,
  type BossEncountersConfig,
  type BossRewardTable,
  type LoadedContent,
} from '../content/schemas';
import type { InventoryService } from '../inventory/inventoryService';
import { currentSeductivePower } from '../power/seductivePower';
import { BOSS_AFFINITY_VERSION, bossAffinityBonus } from './bossAffinity';
import {
  BOSS_DAMAGE_FORMULA_VERSION,
  computeBattleDamage,
  estimateDamageRange,
  responseBonusFor,
  type DamageRange,
} from './bossDamage';
import { bossDrawInt } from './bossRandom';
import { mergeGrants, rollBossRewards } from './bossRewards';
import {
  appliedBuddyBonus,
  applyPercentModifierInt,
  buddyBonusPercent,
  type AppliedBuddyBonus,
} from '../buddyBonus/buddyBonusEffects';
import type { BuddyBonusService } from '../buddyBonus/buddyBonusService';
import {
  drawFromBag,
  parseShuffleBagState,
  type ShuffleBagCandidate,
  type ShuffleBagState,
} from './bossShuffleBag';
import { DEFAULT_REGION } from './regions';

const MS_PER_MINUTE = 60_000;

/**
 * Internal control-flow marker: a payout transaction discovered that another
 * process had already applied this participation.
 *
 * Thrown rather than returned so the *whole* transaction — including the
 * inventory writes it had already made — rolls back. Returning would commit a
 * duplicate grant alongside a lost status update, which is precisely the
 * double-payment this design exists to prevent. Never escapes this module.
 */
class AlreadyAppliedSignal extends Error {
  constructor(participationId: number) {
    super(`participation ${participationId} was applied concurrently`);
    this.name = 'AlreadyAppliedSignal';
  }
}

/** A committed buddy's rewards, as they are handed over and printed. */
export interface BossRewardGrantView {
  slug: string;
  name: string;
  quantity: number;
}

/** What the ephemeral preview shows before a player confirms. */
export interface BossCommitPreview {
  encounter: BossEncounterRow;
  waifuId: number;
  waifuName: string;
  speciesName: string;
  level: number;
  currentSp: number;
  buddyAffinity: Affinity;
  bossAffinity: Affinity;
  affinityBonus: number;
  responseBonus: number;
  estimate: DamageRange;
  /** True when this exact copy is a duplicate — the preview names the copy id. */
  hasDuplicates: boolean;
}

/** One resolved participation, joined to everything a result line needs. */
export interface BossParticipationResult {
  participation: BossParticipationRow;
  rewards: BossRewardGrantView[];
  /**
   * The `boss_reward_gain` bonus that scaled this payout, or `null`.
   *
   * Resolved from the **committed** copy's species — the same snapshot the
   * payout itself used — so a player who swapped Buddy after committing sees
   * the bonus that actually paid, not the one they are wearing now.
   */
  rewardBonus: AppliedBuddyBonus | null;
}

export interface BossResolutionResult {
  encounter: BossEncounterRow;
  reason: BossResolutionReason;
  participants: BossParticipationResult[];
  totalDamage: number;
  totalAttacks: number;
  /** The earliest committer, for the cosmetic "First on the Scene" callout. */
  firstOnScene: BossParticipationRow | null;
  /** True when this call did the work; false when it found everything done. */
  applied: boolean;
}

export interface BossSpawnResult {
  encounter: BossEncounterRow;
  boss: BossContent;
  /** True when the draw emptied and refilled the shuffle bag. */
  refilled: boolean;
  /** True when spacing had to be sacrificed to the bag guarantee. */
  affinityRepeat: boolean;
}

export interface BossEncounterServiceDeps {
  db: Db;
  inventory: InventoryService;
  collection: CollectionService;
  /**
   * Live content snapshot, read through a getter so an admin "Save + Reload"
   * makes newly-authored bosses drawable without a restart — exactly the
   * pattern `AppearanceService` uses.
   */
  getContent: () => LoadedContent;
  /**
   * Buddy Bonus lookup. Optional — without it a payout is exactly what the
   * reward table rolled.
   *
   * Only its content-reading side is used here: a boss payout resolves
   * `boss_reward_gain` from the **committed** participation's species, never
   * from the player's currently-equipped Buddy. See
   * `applyParticipationRewards`.
   */
  buddyBonus?: BuddyBonusService | undefined;
  logger: Logger;
  /**
   * Drives the shuffle and the downtime pick. Injected so a test can make the
   * rotation deterministic. Note that this is *not* what damage and rewards
   * use — those are derived, never rolled.
   */
  rng?: Rng;
}

export interface BossEncounterService {
  // ── guild state ──────────────────────────────────────────────────────────
  /** Reads (creating on first touch) the guild's scheduler state row. */
  ensureState(guildDbId: number): Promise<GuildBossStateRow>;
  setPaused(guildDbId: number, paused: boolean): Promise<GuildBossStateRow>;
  /** Records a scheduling failure an operator has to fix. Idempotent. */
  suspend(guildDbId: number, reason: string, now?: Date): Promise<void>;
  /** Clears a suspension once the channel checks out again. Idempotent. */
  clearSuspension(guildDbId: number): Promise<void>;

  // ── lifecycle ────────────────────────────────────────────────────────────
  getActive(guildDbId: number): Promise<BossEncounterRow | undefined>;
  getEncounter(encounterId: number): Promise<BossEncounterRow | undefined>;
  /** The boss content behind an encounter, or undefined if it has been retired. */
  bossFor(encounter: BossEncounterRow): BossContent | undefined;
  /**
   * Draw and persist the next appearance when one is due. Returns null —
   * never throws — when the guild is paused, suspended, already has an active
   * encounter, is not yet due, or has no drawable bosses.
   */
  spawnIfDue(guildDbId: number, now?: Date): Promise<BossSpawnResult | null>;
  /**
   * Admin force-spawn. Bypasses the due check and, deliberately, the shuffle
   * bag: a forced boss is marked `forced` and leaves the rotation untouched.
   */
  forceSpawn(guildDbId: number, bossId?: string, now?: Date): Promise<BossSpawnResult>;
  /**
   * Open the scouting window: stamps the start and the deadline, and records
   * the announcement's message id. Idempotent — a second call on an encounter
   * that is already scouting returns it unchanged rather than moving the
   * deadline.
   */
  beginScouting(
    encounterId: number,
    channelId: string,
    messageId: string,
    now?: Date,
  ): Promise<BossEncounterRow>;
  /** Repoint an encounter at a replacement message without creating another. */
  repairMessage(
    encounterId: number,
    channelId: string,
    messageId: string,
  ): Promise<BossEncounterRow>;

  // ── Discord delivery state ───────────────────────────────────────────────
  //
  // An encounter owes Discord two things when it ends: the completion edit on
  // its original announcement, and a separate results message beneath it.
  // Neither can share a transaction with the Discord call that performs it, so
  // each is stamped *after* the call succeeds and every stamp is idempotent.
  // A restart repairs whatever is unstamped; a retry that finds a stamp does
  // nothing. See `boss_encounters.completion_edited_at` / `results_*`.

  /** Record that the announcement has been edited into its terminal form. */
  markCompletionEdited(encounterId: number, now?: Date): Promise<BossEncounterRow | undefined>;
  /**
   * Record the published results message.
   *
   * Conditional on `results_message_id` still being null, so two processes
   * racing to publish cannot both claim it — the loser's row read tells it a
   * results message already exists. `pageSize` is frozen alongside the id so
   * pagination pages the encounter the way it was published.
   */
  markResultsPublished(
    encounterId: number,
    messageId: string,
    pageSize: number | null,
    now?: Date,
  ): Promise<BossEncounterRow | undefined>;
  /**
   * Finished encounters that still owe Discord something.
   *
   * The restart-recovery query for presentation, mirroring `findUnannounced`
   * for the opening half of the lifecycle. Ordered oldest-first so a backlog
   * is published in the order it happened rather than in reverse.
   */
  findUndelivered(limit?: number): Promise<BossEncounterRow[]>;
  /** Encounters whose window has closed, plus stale `resolving` claims. */
  findResolvable(now?: Date): Promise<BossEncounterRow[]>;
  /** Encounters drawn but not yet announced — the restart-recovery path. */
  findUnannounced(now?: Date): Promise<BossEncounterRow[]>;
  /** Live encounters with an announcement to refresh. */
  findScouting(now?: Date): Promise<BossEncounterRow[]>;
  /**
   * Resolve: claim, compute, pay, publish. Safe to call repeatedly and safe to
   * call concurrently — a caller that loses the claim gets `applied: false`
   * with the finished results.
   */
  resolve(encounterId: number, now?: Date): Promise<BossResolutionResult | null>;
  /** End an encounter early. Committed participants are still paid. */
  cancel(
    encounterId: number,
    reason: BossResolutionReason,
    now?: Date,
  ): Promise<BossResolutionResult | null>;

  // ── commitment ───────────────────────────────────────────────────────────
  /** What the ephemeral preview renders. Writes nothing. */
  preview(
    encounterId: number,
    guildDbId: number,
    playerId: number,
    now?: Date,
  ): Promise<BossCommitPreview>;
  /**
   * Create the participation. The *only* mutation the commit path performs —
   * no XP, no items, no damage.
   */
  commit(
    encounterId: number,
    guildDbId: number,
    playerId: number,
    identity: { discordUserId: string; trainerName: string },
    now?: Date,
  ): Promise<BossParticipationRow>;
  countParticipants(encounterId: number): Promise<number>;
  listParticipations(
    encounterId: number,
    opts?: { page?: number; pageSize?: number },
  ): Promise<{
    entries: BossParticipationResult[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>;
  getParticipation(
    encounterId: number,
    playerId: number,
  ): Promise<BossParticipationResult | null>;
  /**
   * The earliest committer — the cosmetic "First on the Scene".
   *
   * A dedicated query rather than something the caller derives from a page:
   * the results listing is sorted by *damage*, so page one's first row is
   * almost never the first arrival, and every renderer would otherwise have to
   * re-sort a full listing to find one row.
   */
  getFirstOnScene(encounterId: number): Promise<BossParticipationRow | null>;
}

export function createBossEncounterService(
  deps: BossEncounterServiceDeps,
): BossEncounterService {
  const { db, inventory, collection, getContent, logger } = deps;
  const rng = deps.rng ?? defaultRng();
  const buddyBonus = deps.buddyBonus;

  const config = (): BossEncountersConfig => getContent().tables.bossEncounters;

  /**
   * Bosses that may actually be drawn for a region, in content order.
   *
   * Two switches, not one: the boss's own `enabled`, and the `enabled` of the
   * reward table it is paid from. A boss whose table is switched off is
   * **not** spawned — appearing and then handing out nothing is a worse
   * failure than not appearing, and it would only be discovered at resolution
   * by the players who committed.
   *
   * The skip is logged at error level with the fix in the message, because
   * from the outside a boss that quietly stops rotating is indistinguishable
   * from a broken scheduler.
   */
  function candidatesFor(region: string): BossContent[] {
    const content = getContent();
    const tables = new Map(content.bossRewards.map((t) => [t.id, t]));
    return content.bosses.filter((b) => {
      if (!b.enabled || b.region !== region) return false;
      const table = tables.get(b.rewardTable);
      if (!table) {
        // The loader rejects this at boot, so reaching it means content was
        // reloaded with a table removed while the process was running.
        logger.error(
          { tag: 'boss/reward-table-missing', bossId: b.id, rewardTable: b.rewardTable },
          `boss "${b.id}" references reward table "${b.rewardTable}", which is not in ` +
            'content/bossRewards.json — the boss will not spawn until it is added',
        );
        return false;
      }
      if (!table.enabled) {
        logger.error(
          { tag: 'boss/reward-table-disabled', bossId: b.id, rewardTable: b.rewardTable },
          `boss "${b.id}" will not spawn: its reward table "${b.rewardTable}" is disabled. ` +
            `Set "enabled": true on that table in content/bossRewards.json, or disable the ` +
            'boss itself to stop this message.',
        );
        return false;
      }
      return true;
    });
  }

  function bagCandidates(region: string): ShuffleBagCandidate[] {
    return candidatesFor(region).map((b) => ({ id: b.id, affinity: b.affinity }));
  }

  /**
   * The reward table an encounter is paid from, by id.
   *
   * Deliberately does **not** check `enabled`: that switch governs whether new
   * encounters may *spawn* against the table (see `candidatesFor`), not
   * whether an encounter that already happened may be paid. Disabling a table
   * must never strand participants who committed while it was live.
   */
  function rewardTableFor(key: string): BossRewardTable {
    const table = getContent().bossRewards.find((t) => t.id === key);
    if (!table) {
      // Reachable only if content was edited between the announcement and the
      // resolution. Loud, because the alternative is paying an arbitrary table.
      throw new ContentValidationError(`Boss reward table "${key}" no longer exists`);
    }
    return table;
  }

  /** Item rows for a set of slugs, keyed by slug. One query per payout batch. */
  async function itemsBySlug(tx: DbOrTx, slugs: readonly string[]) {
    if (slugs.length === 0) return new Map<string, typeof items.$inferSelect>();
    const rows = await tx.select().from(items).where(inArray(items.slug, [...slugs]));
    return new Map(rows.map((r) => [r.slug, r]));
  }

  // ── guild state ───────────────────────────────────────────────────────────

  async function ensureState(guildDbId: number): Promise<GuildBossStateRow> {
    const inserted = await db
      .insert(guildBossState)
      .values({ guildId: guildDbId, region: DEFAULT_REGION })
      .onConflictDoNothing({ target: guildBossState.guildId })
      .returning();
    if (inserted[0]) return inserted[0];
    const [existing] = await db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    // The insert above guarantees a row exists; a missing one here would mean
    // the guild row itself vanished, which the FK already prevents.
    return existing!;
  }

  // ── spawning ──────────────────────────────────────────────────────────────

  /**
   * Insert a `scheduled` encounter, converting the one-active-per-guild unique
   * violation into `null`.
   *
   * That conversion is the multi-process story: both workers draw, both
   * insert, one row lands. The loser also rolls back its bag update, because
   * the whole thing runs in one transaction — so a lost race consumes nothing.
   */
  async function insertEncounter(
    tx: DbOrTx,
    values: typeof bossEncounters.$inferInsert,
  ): Promise<BossEncounterRow | null> {
    const [row] = await tx
      .insert(bossEncounters)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  function encounterValuesFor(
    guildDbId: number,
    region: string,
    boss: BossContent,
    scheduledAt: Date,
    forced: boolean,
  ): typeof bossEncounters.$inferInsert {
    const table = rewardTableFor(boss.rewardTable);
    return {
      guildId: guildDbId,
      region,
      bossId: boss.id,
      bossName: boss.name,
      bossAffinity: boss.affinity,
      bossArtwork: boss.artwork,
      rewardTable: boss.rewardTable,
      rewardTableVersion: bossRewardTableVersion(table),
      calcVersion: BOSS_DAMAGE_FORMULA_VERSION,
      affinityVersion: BOSS_AFFINITY_VERSION,
      status: 'scheduled',
      forced,
      scheduledAt,
    };
  }

  async function spawnIfDue(
    guildDbId: number,
    now: Date = new Date(),
  ): Promise<BossSpawnResult | null> {
    const cfg = config();
    if (!cfg.enabled) return null;
    await ensureState(guildDbId);

    return db.transaction(async (tx) => {
      // Lock the guild's scheduler row for the whole draw. Two processes
      // ticking at once serialize here, so the bag can never be consumed twice
      // for one appearance.
      const [state] = await tx
        .select()
        .from(guildBossState)
        .where(eq(guildBossState.guildId, guildDbId))
        .for('update');
      if (!state) return null;
      if (state.paused || state.suspendedReason !== null) return null;
      if (state.nextSpawnAt !== null && state.nextSpawnAt.getTime() > now.getTime()) return null;

      const active = await tx
        .select({ id: bossEncounters.id })
        .from(bossEncounters)
        .where(
          and(
            eq(bossEncounters.guildId, guildDbId),
            inArray(bossEncounters.status, [...BOSS_ACTIVE_STATUSES]),
          ),
        );
      if (active.length > 0) return null;

      const region = state.region;
      const candidates = bagCandidates(region);
      const draw = drawFromBag(parseShuffleBagState(state.bagState), candidates, rng);
      if (!draw) {
        logger.warn({ guildId: guildDbId, region }, 'boss spawn skipped — no enabled bosses');
        return null;
      }
      const boss = candidatesFor(region).find((b) => b.id === draw.bossId)!;

      const encounter = await insertEncounter(
        tx,
        encounterValuesFor(guildDbId, region, boss, now, false),
      );
      // Lost the race to another process. Roll nothing back explicitly — this
      // transaction simply commits no bag change, because we return before
      // writing it.
      if (!encounter) return null;

      await writeBagState(tx, guildDbId, draw.state, { nextSpawnAt: state.nextSpawnAt });

      logger.info(
        {
          tag: 'boss/spawn',
          guildId: guildDbId,
          encounterId: encounter.id,
          bossId: boss.id,
          affinity: boss.affinity,
          refilled: draw.refilled,
          affinityRepeat: draw.affinityRepeat,
          bagRemaining: draw.state.remaining.length,
        },
        'boss encounter scheduled',
      );
      return {
        encounter,
        boss,
        refilled: draw.refilled,
        affinityRepeat: draw.affinityRepeat,
      };
    });
  }

  /**
   * Record the next appearance on the guild's scheduler state, creating the
   * row if it is missing. See the call site in `finishResolution` for why the
   * upsert rather than an update.
   */
  async function writeNextSpawn(
    guildDbId: number,
    nextSpawnAt: Date,
    now: Date,
  ): Promise<void> {
    await db
      .insert(guildBossState)
      .values({ guildId: guildDbId, region: DEFAULT_REGION, nextSpawnAt, updatedAt: now })
      .onConflictDoUpdate({
        target: guildBossState.guildId,
        set: { nextSpawnAt, updatedAt: now },
      });
  }

  async function writeBagState(
    tx: DbOrTx,
    guildDbId: number,
    bagState: ShuffleBagState,
    extra: { nextSpawnAt?: Date | null } = {},
  ): Promise<void> {
    await tx
      .update(guildBossState)
      .set({
        bagState: bagState as unknown as Record<string, unknown>,
        updatedAt: new Date(),
        ...(extra.nextSpawnAt === undefined ? {} : { nextSpawnAt: extra.nextSpawnAt }),
      })
      .where(eq(guildBossState.guildId, guildDbId));
  }

  // ── commitment ────────────────────────────────────────────────────────────

  /**
   * Load an encounter and assert it belongs to this guild and is still taking
   * commitments. The guild check is what makes a copied custom id from another
   * server inert rather than merely unlikely to work.
   */
  async function loadOpenEncounter(
    tx: DbOrTx,
    encounterId: number,
    guildDbId: number,
    now: Date,
  ): Promise<BossEncounterRow> {
    const [row] = await tx
      .select()
      .from(bossEncounters)
      .where(eq(bossEncounters.id, encounterId));
    if (!row || row.guildId !== guildDbId) throw new BossEncounterNotFoundError();
    if (row.status !== 'scouting') throw new BossEncounterNotOpenError();
    // The deadline is authoritative even before the scheduler notices it: a
    // button pressed at 60:00.001 must not slip a participation in ahead of a
    // resolution that has not started yet.
    if (row.deadlineAt !== null && row.deadlineAt.getTime() <= now.getTime()) {
      throw new BossEncounterNotOpenError();
    }
    return row;
  }

  /** The snapshot both `preview` and `commit` derive from — one source. */
  async function snapshotBuddy(
    tx: DbOrTx,
    encounter: BossEncounterRow,
    playerId: number,
    now: Date,
  ) {
    const buddy = await collection.resolveActiveBuddy(tx, playerId);
    if (!buddy) throw new BossNoActiveBuddyError();

    const cfg = config();
    const maxLevel = getContent().tables.waifuProgression.maxLevel;
    const currentSp = currentSeductivePower(buddy.waifu.baseSp, buddy.waifu.level, maxLevel);
    const affinityBonus = bossAffinityBonus(buddy.species.affinity, encounter.bossAffinity, {
      wheel: cfg.affinityWheel as Record<string, Affinity>,
      advantageBonus: cfg.affinityAdvantageBonus,
    });
    // A missing `scoutingStartedAt` cannot happen for a `scouting` encounter,
    // but reading `createdAt` rather than throwing keeps a hand-built fixture
    // from failing on bookkeeping rather than on behaviour.
    const origin = encounter.scoutingStartedAt ?? encounter.createdAt;
    const responseBonus = responseBonusFor(origin, now, cfg.responseBrackets);

    return {
      buddy,
      currentSp,
      affinityBonus,
      responseBonus,
      attacks: cfg.attacksPerParticipation,
      waifuName: buddy.waifu.nickname ?? buddy.species.name,
    };
  }

  // ── resolution ────────────────────────────────────────────────────────────

  /**
   * Pay one participation, or discover it has already been paid.
   *
   * The whole idempotency argument lives in the `WHERE` clause of the final
   * update: the row is only written when it is still `pending`, and the XP and
   * inventory writes share that transaction. So a retry either does everything
   * or nothing, and a second process racing the first loses the conditional
   * update and rolls its duplicate payments back with it.
   */
  async function applyParticipationRewards(
    participation: BossParticipationRow,
    encounter: BossEncounterRow,
    now: Date,
  ): Promise<BossParticipationRow> {
    if (participation.rewardStatus === 'applied') return participation;

    const table = rewardTableFor(encounter.rewardTable);
    const maxLevel = getContent().tables.waifuProgression.maxLevel;

    const performancePercent = bossDrawInt(
      encounter.id,
      participation.id,
      'performance',
      config().performanceMinPercent,
      config().performanceMaxPercent,
    );
    const totalDamage = computeBattleDamage({
      currentSp: participation.currentSp,
      attacks: participation.attackCount ?? config().attacksPerParticipation,
      performancePercent,
      affinityBonus: participation.affinityBonus,
      responseBonus: participation.responseBonus,
    });
    const roll = rollBossRewards({
      table,
      encounterId: encounter.id,
      participationId: participation.id,
      buddyLevel: participation.level,
      maxLevel,
    });
    // Configuration problems the pure roller found. Logged here, once per
    // participation, because this is the moment they cost a player something —
    // an empty group pays nobody, silently, until someone says so.
    for (const warning of roll.warnings) {
      logger.error(
        {
          tag: 'boss/reward-group-skipped',
          encounterId: encounter.id,
          participationId: participation.id,
          rewardTable: encounter.rewardTable,
          groupId: warning.groupId,
        },
        warning.message,
      );
    }
    /**
     * `boss_reward_gain` — applied to the payout, never to the draw.
     *
     * The table, the group gates and the weighted picks are all untouched, so
     * *what* a participation wins is exactly what it would have won without a
     * Buddy; only the size of the eligible outcome moves. Cosmetic battle
     * damage above is deliberately left alone — it is narration, not a reward.
     *
     * **Read from the committed copy, not from whoever is Buddy now.** This is
     * the one place in the game where a Buddy Bonus is *not* resolved from the
     * live Buddy slot, and it is deliberate: a participation already snapshots
     * the copy that was committed — her level, SP, rarity, affinity and race
     * all come from that snapshot and none of them follow a later swap — so
     * her bonus must not either. Committing A and swapping to B before
     * resolution pays A's bonus and not B's, in both directions.
     *
     * `speciesSlug` is that snapshot's record of *which species* was
     * committed (the same copy `waifuId` names), so this is a pure content
     * read: no query, and it still answers correctly if the committed copy has
     * since been released. Merged first, so a stack that two groups both
     * contributed to is scaled once.
     */
    const rewardPercent = buddyBonusPercent(
      buddyBonus?.bonusForSpeciesSlug(participation.speciesSlug),
      'boss_reward_gain',
    );
    const grants = mergeGrants(roll.items).map((grant) => ({
      ...grant,
      quantity: applyPercentModifierInt(grant.quantity, rewardPercent),
    }));
    const buddyXp = applyPercentModifierInt(roll.buddyXp, rewardPercent);

    return db.transaction(async (tx) => {
      // Re-read under the transaction: another process may have finished this
      // participation between our read and this write.
      const [current] = await tx
        .select()
        .from(bossParticipations)
        .where(eq(bossParticipations.id, participation.id))
        .for('update');
      if (!current || current.rewardStatus === 'applied') return current ?? participation;

      const itemRows = await itemsBySlug(tx, grants.map((g) => g.slug));
      const granted: BossRewardGrantView[] = [];
      for (const grant of grants) {
        const item = itemRows.get(grant.slug);
        if (!item) {
          // Content named an item that is not seeded. Skip the stack rather
          // than failing the whole payout — the XP and the rest are still owed,
          // and a loud log is the right severity for a content bug found at
          // payout time.
          logger.error(
            { tag: 'boss/reward-missing-item', encounterId: encounter.id, slug: grant.slug },
            'boss reward references an unseeded item — stack skipped',
          );
          continue;
        }
        await inventory.addItem(tx, participation.playerId, item.id, grant.quantity);
        granted.push({ slug: item.slug, name: item.name, quantity: grant.quantity });
      }

      // XP goes to the *snapshotted* copy, not to whoever is buddy now. A
      // released copy returns null and is recorded as zero.
      const award = await collection.awardWaifuXp(
        tx,
        participation.playerId,
        participation.waifuId,
        buddyXp,
      );
      const xpAwarded = award?.xpGranted ?? 0;

      const [updated] = await tx
        .update(bossParticipations)
        .set({
          performancePercent,
          attackCount: participation.attackCount ?? config().attacksPerParticipation,
          totalDamage,
          xpAwarded,
          rewardItems: granted as unknown as Record<string, unknown>[],
          rewardStatus: 'applied',
          resolvedAt: now,
        })
        .where(
          and(
            eq(bossParticipations.id, participation.id),
            eq(bossParticipations.rewardStatus, 'pending'),
          ),
        )
        .returning();
      // Lost the conditional update — the whole transaction, inventory writes
      // included, rolls back when we throw out of it. Instead, return the
      // winner's row: nothing here was committed.
      if (!updated) {
        throw new AlreadyAppliedSignal(participation.id);
      }
      return updated;
    }).catch(async (err) => {
      if (err instanceof AlreadyAppliedSignal) {
        const [row] = await db
          .select()
          .from(bossParticipations)
          .where(eq(bossParticipations.id, participation.id));
        return row ?? participation;
      }
      throw err;
    });
  }

  /** Pick and persist the next appearance. Called exactly once per resolution. */
  function nextSpawnFrom(now: Date): Date {
    const cfg = config();
    const minutes = rng.intInclusive(cfg.downtimeMinutesMin, cfg.downtimeMinutesMax);
    return new Date(now.getTime() + minutes * MS_PER_MINUTE);
  }

  async function finishResolution(
    encounter: BossEncounterRow,
    reason: BossResolutionReason,
    now: Date,
  ): Promise<BossResolutionResult> {
    const pending = await db
      .select()
      .from(bossParticipations)
      .where(eq(bossParticipations.encounterId, encounter.id))
      .orderBy(asc(bossParticipations.committedAt), asc(bossParticipations.id));

    const resolved: BossParticipationRow[] = [];
    for (const participation of pending) {
      resolved.push(await applyParticipationRewards(participation, encounter, now));
    }

    const totalDamage = resolved.reduce((sum, p) => sum + (p.totalDamage ?? 0), 0);
    const nextSpawnAt = encounter.nextSpawnAt ?? nextSpawnFrom(now);

    const [finished] = await db
      .update(bossEncounters)
      .set({
        status: 'resolved',
        resolutionReason: reason,
        participantCount: resolved.length,
        totalDamage,
        resolvedAt: now,
        nextSpawnAt,
      })
      .where(eq(bossEncounters.id, encounter.id))
      .returning();

    // The next appearance is persisted on the guild's scheduler state too —
    // that is the row `spawnIfDue` reads, and writing it here (rather than at
    // the next tick) is what makes a restart unable to reroll it.
    //
    // Upserted rather than updated: an encounter can outlive its state row (a
    // guild reset, an operator clearing the table, a fixture that inserted an
    // encounter directly), and a plain UPDATE would silently match nothing —
    // losing the downtime and letting the very next tick spawn immediately.
    await writeNextSpawn(encounter.guildId, nextSpawnAt, now);

    const rewardViews = await hydrateRewards(resolved);

    logger.info(
      {
        tag: 'boss/resolved',
        guildId: encounter.guildId,
        encounterId: encounter.id,
        bossId: encounter.bossId,
        reason,
        participants: resolved.length,
        totalDamage,
        nextSpawnAt: nextSpawnAt.toISOString(),
      },
      'boss encounter resolved',
    );

    return {
      encounter: finished!,
      reason,
      participants: rewardViews,
      totalDamage,
      totalAttacks: resolved.reduce((sum, p) => sum + (p.attackCount ?? 0), 0),
      firstOnScene: resolved[0] ?? null,
      applied: true,
    };
  }

  /**
   * Attach item names to stored reward slugs.
   *
   * The slugs and quantities are frozen on the row; only the display name is
   * looked up, so renaming an item updates old results' wording without
   * changing what was actually granted.
   */
  /**
   * The bonus a participation's payout was scaled by, for its result line.
   *
   * Reads the committed species from the participation snapshot — never the
   * player's live Buddy — so this reports exactly what `applyParticipationRewards`
   * applied. `null` when the committed copy grants no `boss_reward_gain`.
   */
  function rewardBonusFor(participation: BossParticipationRow): AppliedBuddyBonus | null {
    const bonus = buddyBonus?.bonusForSpeciesSlug(participation.speciesSlug);
    if (!bonus || buddyBonusPercent(bonus, 'boss_reward_gain') === 0) return null;
    return appliedBuddyBonus(bonus);
  }

  async function hydrateRewards(
    rows: readonly BossParticipationRow[],
  ): Promise<BossParticipationResult[]> {
    const slugs = new Set<string>();
    for (const row of rows) {
      for (const entry of (row.rewardItems ?? []) as { slug?: string }[]) {
        if (typeof entry.slug === 'string') slugs.add(entry.slug);
      }
    }
    const byslug = await itemsBySlug(db, [...slugs]);
    return rows.map((participation) => ({
      participation,
      rewardBonus: rewardBonusFor(participation),
      rewards: ((participation.rewardItems ?? []) as {
        slug?: string;
        name?: string;
        quantity?: number;
      }[])
        .filter((e): e is { slug: string; name?: string; quantity: number } =>
          typeof e.slug === 'string' && typeof e.quantity === 'number')
        .map((e) => ({
          slug: e.slug,
          name: byslug.get(e.slug)?.name ?? e.name ?? e.slug,
          quantity: e.quantity,
        })),
    }));
  }

  /** Build the already-finished result for a caller that lost the claim. */
  async function readResolved(
    encounter: BossEncounterRow,
  ): Promise<BossResolutionResult> {
    const rows = await db
      .select()
      .from(bossParticipations)
      .where(eq(bossParticipations.encounterId, encounter.id))
      .orderBy(asc(bossParticipations.committedAt), asc(bossParticipations.id));
    return {
      encounter,
      reason: (encounter.resolutionReason ?? 'unchallenged') as BossResolutionReason,
      participants: await hydrateRewards(rows),
      totalDamage: encounter.totalDamage,
      totalAttacks: rows.reduce((sum, p) => sum + (p.attackCount ?? 0), 0),
      firstOnScene: rows[0] ?? null,
      applied: false,
    };
  }

  return {
    ensureState,

    async setPaused(guildDbId, paused) {
      await ensureState(guildDbId);
      const [row] = await db
        .update(guildBossState)
        .set({ paused, updatedAt: new Date() })
        .where(eq(guildBossState.guildId, guildDbId))
        .returning();
      logger.info({ tag: 'boss/pause', guildId: guildDbId, paused }, 'boss scheduling pause set');
      return row!;
    },

    async suspend(guildDbId, reason, now = new Date()) {
      await ensureState(guildDbId);
      const [row] = await db
        .update(guildBossState)
        .set({ suspendedReason: reason, suspendedAt: now, updatedAt: now })
        // Only stamp `suspendedAt` on the *first* suspension, so an operator
        // sees how long it has been broken rather than how long ago the last
        // tick re-noticed.
        .where(
          and(eq(guildBossState.guildId, guildDbId), isNull(guildBossState.suspendedReason)),
        )
        .returning();
      if (row) {
        logger.error(
          { tag: 'boss/suspended', guildId: guildDbId, reason },
          'boss scheduling suspended — operator action required',
        );
        return;
      }
      // Already suspended: refresh only the reason text, keeping the clock.
      await db
        .update(guildBossState)
        .set({ suspendedReason: reason, updatedAt: now })
        .where(eq(guildBossState.guildId, guildDbId));
    },

    async clearSuspension(guildDbId) {
      const [row] = await db
        .update(guildBossState)
        .set({ suspendedReason: null, suspendedAt: null, updatedAt: new Date() })
        .where(
          and(eq(guildBossState.guildId, guildDbId), sql`${guildBossState.suspendedReason} is not null`),
        )
        .returning();
      if (row) {
        logger.info(
          { tag: 'boss/resumed', guildId: guildDbId },
          'boss scheduling suspension cleared',
        );
      }
    },

    async getActive(guildDbId) {
      const [row] = await db
        .select()
        .from(bossEncounters)
        .where(
          and(
            eq(bossEncounters.guildId, guildDbId),
            inArray(bossEncounters.status, [...BOSS_ACTIVE_STATUSES]),
          ),
        )
        .orderBy(desc(bossEncounters.id))
        .limit(1);
      return row;
    },

    async getEncounter(encounterId) {
      const [row] = await db
        .select()
        .from(bossEncounters)
        .where(eq(bossEncounters.id, encounterId));
      return row;
    },

    bossFor(encounter) {
      return getContent().bosses.find((b) => b.id === encounter.bossId);
    },

    spawnIfDue,

    async forceSpawn(guildDbId, bossId, now = new Date()) {
      await ensureState(guildDbId);
      const state = await ensureState(guildDbId);
      const region = state.region;
      const pool = candidatesFor(region);
      if (pool.length === 0) {
        throw new ContentValidationError(`No enabled bosses for region "${region}"`);
      }
      const boss = bossId ? pool.find((b) => b.id === bossId) : pool[rng.intInclusive(0, pool.length - 1)];
      if (!boss) {
        throw new ContentValidationError(
          `Boss "${bossId}" is not an enabled boss in region "${region}"`,
        );
      }
      // Forced spawns leave the bag alone on purpose: a live test must not
      // consume a draw the rotation still owes the players, and repeating the
      // same forced boss must stay repeatable.
      const encounter = await insertEncounter(
        db,
        encounterValuesFor(guildDbId, region, boss, now, true),
      );
      if (!encounter) throw new BossEncounterNotOpenError();
      logger.warn(
        {
          tag: 'boss/force-spawn',
          guildId: guildDbId,
          encounterId: encounter.id,
          bossId: boss.id,
        },
        'boss encounter force-spawned by an admin (shuffle bag untouched)',
      );
      return { encounter, boss, refilled: false, affinityRepeat: false };
    },

    async beginScouting(encounterId, channelId, messageId, now = new Date()) {
      const cfg = config();
      const deadline = new Date(now.getTime() + cfg.scoutingMinutes * MS_PER_MINUTE);
      const [row] = await db
        .update(bossEncounters)
        .set({
          status: 'scouting',
          channelId,
          messageId,
          scoutingStartedAt: now,
          deadlineAt: deadline,
        })
        // Conditional on `scheduled`: a second call (a racing process, a retry
        // after a slow Discord response) cannot move a deadline that is
        // already running.
        .where(and(eq(bossEncounters.id, encounterId), eq(bossEncounters.status, 'scheduled')))
        .returning();
      if (row) {
        logger.info(
          {
            tag: 'boss/scouting',
            encounterId,
            channelId,
            messageId,
            deadlineAt: deadline.toISOString(),
          },
          'boss scouting window opened',
        );
        return row;
      }
      const [existing] = await db
        .select()
        .from(bossEncounters)
        .where(eq(bossEncounters.id, encounterId));
      if (!existing) throw new BossEncounterNotFoundError();
      return existing;
    },

    async repairMessage(encounterId, channelId, messageId) {
      const [row] = await db
        .update(bossEncounters)
        .set({ channelId, messageId })
        .where(
          and(
            eq(bossEncounters.id, encounterId),
            inArray(bossEncounters.status, [...BOSS_ACTIVE_STATUSES]),
          ),
        )
        .returning();
      if (!row) throw new BossEncounterNotFoundError();
      logger.warn(
        { tag: 'boss/message-repaired', encounterId, channelId, messageId },
        'boss announcement message repointed',
      );
      return row;
    },

    async markCompletionEdited(encounterId, now = new Date()) {
      // Conditional on the stamp still being null so a slow retry cannot
      // overwrite the moment the edit actually landed with a later one.
      const [row] = await db
        .update(bossEncounters)
        .set({ completionEditedAt: now })
        .where(
          and(
            eq(bossEncounters.id, encounterId),
            isNull(bossEncounters.completionEditedAt),
          ),
        )
        .returning();
      return row;
    },

    async markResultsPublished(encounterId, messageId, pageSize, now = new Date()) {
      const [row] = await db
        .update(bossEncounters)
        .set({
          resultsMessageId: messageId,
          resultsPublishedAt: now,
          resultsPageSize: pageSize,
        })
        // The guard that makes concurrent publication safe: whoever writes
        // first owns the results message, and the loser simply finds it set.
        .where(
          and(
            eq(bossEncounters.id, encounterId),
            isNull(bossEncounters.resultsMessageId),
          ),
        )
        .returning();
      if (!row) {
        logger.warn(
          { tag: 'boss/results-already-published', encounterId, messageId },
          'a results message was already recorded for this encounter — not overwriting',
        );
      }
      return row;
    },

    async findUndelivered(limit = 25) {
      return db
        .select()
        .from(bossEncounters)
        .where(
          and(
            inArray(bossEncounters.status, ['resolved', 'cancelled']),
            // A message id is required for either repair to mean anything: an
            // encounter that never got announced has nothing to edit and no
            // place to put results.
            isNotNull(bossEncounters.messageId),
            or(
              isNull(bossEncounters.completionEditedAt),
              isNull(bossEncounters.resultsPublishedAt),
            ),
          ),
        )
        .orderBy(asc(bossEncounters.resolvedAt), asc(bossEncounters.id))
        .limit(limit);
    },

    async findResolvable(now = new Date()) {
      const staleBefore = new Date(
        now.getTime() - config().resolveClaimTimeoutMinutes * MS_PER_MINUTE,
      );
      return db
        .select()
        .from(bossEncounters)
        .where(
          or(
            and(
              eq(bossEncounters.status, 'scouting'),
              lte(bossEncounters.deadlineAt, now),
            ),
            // A `resolving` claim older than the timeout: its owner died. Every
            // payout is individually idempotent, so a takeover finishes the
            // job rather than repeating it.
            and(
              eq(bossEncounters.status, 'resolving'),
              lte(bossEncounters.resolvingAt, staleBefore),
            ),
          ),
        )
        .orderBy(asc(bossEncounters.deadlineAt));
    },

    async findUnannounced() {
      return db
        .select()
        .from(bossEncounters)
        .where(and(eq(bossEncounters.status, 'scheduled')))
        .orderBy(asc(bossEncounters.scheduledAt));
    },

    async findScouting() {
      return db
        .select()
        .from(bossEncounters)
        .where(eq(bossEncounters.status, 'scouting'))
        .orderBy(asc(bossEncounters.deadlineAt));
    },

    async resolve(encounterId, now = new Date()) {
      const staleBefore = new Date(
        now.getTime() - config().resolveClaimTimeoutMinutes * MS_PER_MINUTE,
      );
      // The claim. One conditional UPDATE decides the winner across every
      // process: a `scouting` encounter, or a `resolving` one whose owner has
      // gone quiet for longer than the timeout.
      const [claimed] = await db
        .update(bossEncounters)
        .set({ status: 'resolving', resolvingAt: now })
        .where(
          and(
            eq(bossEncounters.id, encounterId),
            or(
              eq(bossEncounters.status, 'scouting'),
              and(
                eq(bossEncounters.status, 'resolving'),
                lte(bossEncounters.resolvingAt, staleBefore),
              ),
            ),
          ),
        )
        .returning();

      if (!claimed) {
        const [existing] = await db
          .select()
          .from(bossEncounters)
          .where(eq(bossEncounters.id, encounterId));
        if (!existing) return null;
        // Finished by someone else, or claimed by a worker that is still alive.
        if (existing.status === 'resolved') return readResolved(existing);
        logger.info(
          { tag: 'boss/claim-lost', encounterId, status: existing.status },
          'boss resolution already claimed by another process',
        );
        return null;
      }

      const [{ total } = { total: 0 }] = await db
        .select({ total: count() })
        .from(bossParticipations)
        .where(eq(bossParticipations.encounterId, encounterId));
      const reason: BossResolutionReason = total > 0 ? 'repelled' : 'unchallenged';
      const started = Date.now();
      const result = await finishResolution(claimed, reason, now);
      logger.info(
        {
          tag: 'boss/resolve-duration',
          encounterId,
          durationMs: Date.now() - started,
          participants: result.participants.length,
        },
        'boss resolution complete',
      );
      return result;
    },

    async cancel(encounterId, reason, now = new Date()) {
      const [claimed] = await db
        .update(bossEncounters)
        .set({ status: 'resolving', resolvingAt: now })
        .where(
          and(
            eq(bossEncounters.id, encounterId),
            inArray(bossEncounters.status, ['scheduled', 'scouting']),
          ),
        )
        .returning();
      if (!claimed) return null;

      const [{ total } = { total: 0 }] = await db
        .select({ total: count() })
        .from(bossParticipations)
        .where(eq(bossParticipations.encounterId, encounterId));
      // A cancelled encounter still pays whoever committed: they gave up their
      // participation for this window and cannot get it back.
      if (total === 0) {
        const nextSpawnAt = nextSpawnFrom(now);
        const [finished] = await db
          .update(bossEncounters)
          .set({
            status: 'cancelled',
            resolutionReason: reason,
            resolvedAt: now,
            nextSpawnAt,
          })
          .where(eq(bossEncounters.id, encounterId))
          .returning();
        await writeNextSpawn(claimed.guildId, nextSpawnAt, now);
        return {
          encounter: finished!,
          reason,
          participants: [],
          totalDamage: 0,
          totalAttacks: 0,
          firstOnScene: null,
          applied: true,
        };
      }
      const result = await finishResolution(claimed, reason, now);
      // `finishResolution` marks it resolved; an admin cancellation with
      // participants is a real (early) battle, and the reason column is what
      // records that it ended by hand.
      return result;
    },

    async preview(encounterId, guildDbId, playerId, now = new Date()) {
      const encounter = await loadOpenEncounter(db, encounterId, guildDbId, now);
      const existing = await db
        .select()
        .from(bossParticipations)
        .where(
          and(
            eq(bossParticipations.encounterId, encounterId),
            eq(bossParticipations.playerId, playerId),
          ),
        );
      if (existing[0]) throw new BossAlreadyCommittedError(existing[0].waifuName);

      const snapshot = await snapshotBuddy(db, encounter, playerId, now);
      const duplicates = await collection.hasOtherActiveCopies(playerId, snapshot.buddy.waifu.id);

      return {
        encounter,
        waifuId: snapshot.buddy.waifu.id,
        waifuName: snapshot.waifuName,
        speciesName: snapshot.buddy.species.name,
        level: snapshot.buddy.waifu.level,
        currentSp: snapshot.currentSp,
        buddyAffinity: snapshot.buddy.species.affinity as Affinity,
        bossAffinity: encounter.bossAffinity as Affinity,
        affinityBonus: snapshot.affinityBonus,
        responseBonus: snapshot.responseBonus,
        estimate: estimateDamageRange(
          {
            currentSp: snapshot.currentSp,
            attacks: snapshot.attacks,
            affinityBonus: snapshot.affinityBonus,
            responseBonus: snapshot.responseBonus,
          },
          {
            minPercent: config().performanceMinPercent,
            maxPercent: config().performanceMaxPercent,
          },
        ),
        hasDuplicates: duplicates,
      };
    },

    async commit(encounterId, guildDbId, playerId, identity, now = new Date()) {
      try {
        return await db.transaction(async (tx) => {
          const encounter = await loadOpenEncounter(tx, encounterId, guildDbId, now);
          const snapshot = await snapshotBuddy(tx, encounter, playerId, now);
          const { waifu, species } = snapshot.buddy;

          const [row] = await tx
            .insert(bossParticipations)
            .values({
              encounterId,
              playerId,
              discordUserId: identity.discordUserId,
              trainerName: identity.trainerName,
              waifuId: waifu.id,
              speciesId: species.id,
              speciesSlug: species.slug,
              waifuName: snapshot.waifuName,
              level: waifu.level,
              baseSp: waifu.baseSp,
              currentSp: snapshot.currentSp,
              rarity: species.rarity as Rarity,
              affinity: species.affinity,
              race: resolveRace(species),
              affection: waifu.affection,
              committedAt: now,
              responseBonus: snapshot.responseBonus,
              affinityBonus: snapshot.affinityBonus,
              attackCount: snapshot.attacks,
            })
            .returning();

          await tx
            .update(bossEncounters)
            .set({ participantCount: sql`${bossEncounters.participantCount} + 1` })
            .where(eq(bossEncounters.id, encounterId));

          return row!;
        });
      } catch (err) {
        // The unique index is what makes a double-clicked Confirm safe. The
        // loser reads its own violation as "you already committed" rather than
        // as an error, and nothing was written.
        if (isUniqueViolation(err)) {
          const [existing] = await db
            .select()
            .from(bossParticipations)
            .where(
              and(
                eq(bossParticipations.encounterId, encounterId),
                eq(bossParticipations.playerId, playerId),
              ),
            );
          throw new BossAlreadyCommittedError(existing?.waifuName ?? 'Your buddy');
        }
        throw err;
      }
    },

    async countParticipants(encounterId) {
      const [{ total } = { total: 0 }] = await db
        .select({ total: count() })
        .from(bossParticipations)
        .where(eq(bossParticipations.encounterId, encounterId));
      return total;
    },

    async listParticipations(encounterId, opts = {}) {
      const pageSize = Math.max(1, Math.min(25, opts.pageSize ?? config().resultsPageSize));
      const [{ total } = { total: 0 }] = await db
        .select({ total: count() })
        .from(bossParticipations)
        .where(eq(bossParticipations.encounterId, encounterId));
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(Math.max(1, opts.page ?? 1), totalPages);
      const rows = await db
        .select()
        .from(bossParticipations)
        .where(eq(bossParticipations.encounterId, encounterId))
        // Damage descending is the ordering a reader wants; committed-at breaks
        // ties so the page is stable across requests and across restarts.
        .orderBy(
          desc(bossParticipations.totalDamage),
          asc(bossParticipations.committedAt),
          asc(bossParticipations.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return {
        entries: await hydrateRewards(rows),
        page,
        pageSize,
        total,
        totalPages,
      };
    },

    async getFirstOnScene(encounterId) {
      const [row] = await db
        .select()
        .from(bossParticipations)
        .where(eq(bossParticipations.encounterId, encounterId))
        // `id` breaks a tie between two commitments in the same millisecond,
        // so the callout is stable rather than whichever row the planner
        // happened to return first.
        .orderBy(asc(bossParticipations.committedAt), asc(bossParticipations.id))
        .limit(1);
      return row ?? null;
    },

    async getParticipation(encounterId, playerId) {
      const [row] = await db
        .select()
        .from(bossParticipations)
        .where(
          and(
            eq(bossParticipations.encounterId, encounterId),
            eq(bossParticipations.playerId, playerId),
          ),
        );
      if (!row) return null;
      const [hydrated] = await hydrateRewards([row]);
      return hydrated ?? null;
    },
  };
}
