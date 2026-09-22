/**
 * Expeditions — the state machine, the transactions, and the idempotency.
 *
 * UI-agnostic and fully drivable from tests. Nothing Discord-shaped reaches
 * this file.
 *
 * ── The state machine ──────────────────────────────────────────────────────
 *
 *   deploy ──► active ──(completes_at passed, resolve)──► resolved ──► claimed
 *                 └──────────────(cancel)──────────────► cancelled
 *
 * `active` is the only state a mission is created in and the only one it can
 * leave. Nothing re-enters it. The four shape CHECKs on the table make every
 * other combination unrepresentable rather than merely unvisited.
 *
 * ── The three guarantees, and why there are three ──────────────────────────
 *
 * The one thing this feature must never do is pay twice. Three independent
 * mechanisms stop it, and they are independent on purpose — each covers a
 * failure the others do not:
 *
 *   1. **Partial unique indexes.** One active row per (player, region) and
 *      one per waifu. A double-clicked Deploy loses to a unique violation in
 *      the database, not to a service-side count that read a stale value.
 *
 *   2. **Conditional UPDATEs.** Resolution and claiming are each a single
 *      `UPDATE ... WHERE <expected state> RETURNING`. No row returned means
 *      somebody else got there first, and the loser grants nothing. This is
 *      the primary guarantee.
 *
 *   3. **Deterministic derivation.** The outcome and the payout are computed
 *      from `expeditionRandom`, keyed on the row id. Two callers racing to
 *      resolve do not compute *different* results and then fight over which
 *      one lands — they compute the *same* result, and the UPDATE arbitrates
 *      between two identical writes. Without this, (2) would still be correct,
 *      but a retry after a partial failure would be correct only by luck.
 *
 * ── Concurrency is regional ────────────────────────────────────────────────
 *
 * A player may have **one active mission per region**, and as many regions
 * running at once as they can reach. There is no global slot count anywhere in
 * this file: capacity is a consequence of the world, so shipping expedition
 * content for a new region raises every player's ceiling with no edit to
 * content, to this service, or to the schema.
 *
 * Two rules keep that honest, and they are separate on purpose:
 *
 *   - `(player_id, region)` unique-while-active — you cannot run Waifu Valley
 *     twice;
 *   - `(waifu_id)` unique-while-active — and you cannot solve that by sending
 *     the same WaifuMon to Twin Peeks instead.
 *
 * A *resolved but uncollected* mission also holds its region, which is service
 * policy rather than an index: it stops a player stacking a new mission on top
 * of a payout they have not looked at and losing track of it.
 *
 * ── Location is a deployment requirement, and only that ────────────────────
 *
 * `deploy` refuses a mission whose region is not the one the player is
 * standing in, reading that through the canonical travel service rather than
 * the `players` row. Nothing else in this file asks where the player is:
 * inspecting, resolving, claiming and cancelling all work from anywhere, and
 * travelling away mid-flight changes nothing about a running mission.
 *
 * ── Timing lives in Postgres ───────────────────────────────────────────────
 *
 * `completes_at <= now()` is evaluated *in the database*, inside the same
 * statement that claims the row. No in-memory timer is ever the source of
 * truth, nothing is scheduled with `setTimeout`, and surviving a restart
 * mid-flight is the normal case rather than a recovery path. A process that
 * has been down for a day comes back and resolves everything that fell due
 * while it was gone, on the next read.
 *
 * ── Lazy resolution ────────────────────────────────────────────────────────
 *
 * A mission resolves on *read*. The player cannot observe a result without
 * asking for one, so a worker tick buys nothing in V1 — it is only needed for
 * push notifications, which is a later phase. `getActive` resolves what is due
 * before returning, which makes "open the screen" the trigger and makes the
 * resolve path exercised on every single view rather than on a rare timer.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  items,
  playerExpeditions,
  playerWaifus,
  species,
  type ExpeditionOutcome,
  type PlayerExpeditionRow,
  type SpeciesRow,
} from '../../db/schema';
import {
  ExpeditionAlreadyClaimedError,
  ExpeditionContentError,
  ExpeditionNotActiveError,
  ExpeditionNotCancellableError,
  ExpeditionNotCompleteError,
  ExpeditionNotFoundError,
  ExpeditionRegionBusyError,
  ExpeditionsDisabledError,
  ExpeditionWrongRegionError,
  WaifuUnavailableError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { RaceCode } from '../cards/race';
import type {
  ExpeditionRewardTable,
  LoadedContent,
  RegionalExpedition,
} from '../content/schemas';
import type { CollectionService } from '../collection/collectionService';
import type { CurrencyService } from '../currency/currencyService';
import type { EssenceAwardService } from '../currency/essenceAwardService';
import type { InventoryService } from '../inventory/inventoryService';
import type { ProgressionService } from '../progression/progressionService';
import {
  ALWAYS_AVAILABLE,
  type WaifuAvailabilityService,
  type WaifuUnavailabilityReason,
} from '../collection/waifuAvailability';
import { normalizeAffinity } from '../capture/affinityMath';
import { buildBoard, orderBoardForDisplay, rotationEndsAt } from './expeditionBoard';
import { evaluateSuitability } from './expeditionMath';
import { compareCandidates, evaluateMatch, parseStoredMatch } from './expeditionMatch';
import { expeditionDrawFraction, EXPEDITION_LOGIC_VERSION } from './expeditionRandom';
import { rollExpeditionRewards, type ExpeditionRewardPayload } from './expeditionRewards';
import {
  EXPEDITION_PLAN_VERSION,
  type ExpeditionBoard,
  type ExpeditionCandidate,
  type ExpeditionClaimResult,
  type ExpeditionResolutionPlan,
  type ExpeditionView,
} from './types';

export interface ExpeditionService {
  /**
   * The player's board for the region they are standing in, plus what they
   * already have running here and elsewhere.
   */
  getBoard(playerId: number): Promise<ExpeditionBoard>;
  /** Owned copies with a match quality each, best first, and why any cannot be sent. */
  getCandidates(playerId: number, expeditionKey: string): Promise<ExpeditionCandidate[]>;
  /**
   * Validate, snapshot, compute chances, insert ACTIVE — one transaction.
   *
   * Refuses unless the player is standing in the mission's region and has
   * nothing open there. The `(player_id, region)` unique index is the race
   * guard, not the validation above it.
   */
  deploy(playerId: number, expeditionKey: string, waifuId: number): Promise<ExpeditionView>;
  /**
   * Every open mission across **every** region, resolving any that are due.
   * Safe — and intended — to call on every screen open. Ordered by region so
   * a list of them is stable between reads.
   */
  getActive(playerId: number): Promise<ExpeditionView[]>;
  /** Grant the resolved rewards exactly once and mark CLAIMED. */
  claim(playerId: number, expeditionId: number): Promise<ExpeditionClaimResult>;
  /**
   * Abandon an active mission: return the copy, roll nothing, pay nothing.
   * See {@link createExpeditionService} for why it does not resolve.
   */
  cancel(playerId: number, expeditionId: number): Promise<ExpeditionView>;
  /** Recent terminal missions, newest first. */
  getHistory(playerId: number, limit?: number): Promise<ExpeditionView[]>;
  /**
   * Which of this player's copies are away. The expedition module's
   * contribution to the shared availability vocabulary — registered in
   * `index.ts` rather than imported by collection, which would be a cycle.
   */
  unavailabilityFor(
    tx: DbOrTx,
    playerId: number,
    waifuIds: readonly number[],
  ): Promise<Map<number, WaifuUnavailabilityReason[]>>;
}

export interface ExpeditionServiceDeps {
  db: Db;
  logger: Logger;
  /** A closure, not a snapshot: an admin reload must be visible immediately. */
  getContent: () => LoadedContent;
  /** Race is content, never a column. Injected exactly as elsewhere. */
  resolveRace: (row: SpeciesRow) => RaceCode;
  /**
   * Where the player is standing, from the canonical travel service.
   *
   * A narrow port rather than the whole `TravelService`, and injected rather
   * than imported, for the usual two reasons: expeditions must not learn what
   * a route or a pass is, and `travel` is composed after the availability knot
   * this service sits inside. It is the *same* function `travel.getCurrentRegion`
   * exposes, so the defaulting of an odd `players.current_region` value happens
   * once, there, and this file never reads that column.
   */
  getCurrentRegion: (playerId: number) => Promise<string>;
  currency: CurrencyService;
  essenceAward: EssenceAwardService;
  inventory: InventoryService;
  collection: CollectionService;
  progression?: ProgressionService | undefined;
  /**
   * Optional, defaulting to "nothing is unavailable" — the same contract every
   * other optional dependency in this repository has. A fixture that wires the
   * service by hand sees a world with no Buddy and no Care Mode, which is
   * exactly what such a fixture has.
   */
  availability?: WaifuAvailabilityService | undefined;
  /** Injectable clock. Only the board and display reads use it; see below. */
  now?: () => Date;
}

export function createExpeditionService(deps: ExpeditionServiceDeps): ExpeditionService {
  const {
    db,
    logger,
    getContent,
    resolveRace,
    currency,
    essenceAward,
    inventory,
    collection,
    progression,
    getCurrentRegion,
  } = deps;
  const availability = deps.availability ?? ALWAYS_AVAILABLE;
  /**
   * Used for the board window and for rendering "time remaining" only.
   *
   * Never for deciding whether a mission is due: that comparison happens in
   * Postgres, in the resolving statement itself, so clock skew between the bot
   * and the database cannot resolve a mission early or leave one stuck.
   */
  const now = deps.now ?? (() => new Date());

  const config = () => getContent().tables.expeditions;

  function findDefinition(key: string): RegionalExpedition | undefined {
    return getContent().expeditions.find((e) => e.key === key);
  }

  function findTable(id: string | null): ExpeditionRewardTable | undefined {
    if (id == null) return undefined;
    return getContent().expeditionRewards.find((t) => t.id === id);
  }

  /**
   * Copy everything resolution will need out of content.
   *
   * Called once, at deployment, inside the deploying transaction. Every
   * failure it can produce is a *content* problem, and raising them here is
   * the entire point of snapshotting: a misconfigured mission fails at the
   * moment somebody presses Deploy, with nothing written, instead of twelve
   * hours later with a player waiting.
   */
  function buildPlan(definition: RegionalExpedition): ExpeditionResolutionPlan {
    const successTable = findTable(definition.rewardTable);
    if (!successTable) {
      throw new ExpeditionContentError(
        `expedition "${definition.key}" names unknown reward table "${definition.rewardTable}"`,
      );
    }
    if (!successTable.enabled) {
      throw new ExpeditionContentError(
        `expedition "${definition.key}" names disabled reward table "${definition.rewardTable}"`,
      );
    }
    // A disabled *bonus* or *failure* table is treated as absent rather than
    // fatal. Both are optional by design, and refusing the deployment would
    // turn "we switched off the rare-find table for a week" into "nobody can
    // run this mission" — a much larger outage than the edit intended.
    const bonusTable = findTable(definition.exceptionalRewardTable);
    const failureTable = findTable(definition.failureRewardTable);

    return {
      planVersion: EXPEDITION_PLAN_VERSION,
      definition: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        emoji: definition.emoji,
        type: definition.type,
        durationMinutes: definition.durationMinutes,
        recommendedLevel: definition.recommendedLevel,
      },
      successTable,
      bonusTable: bonusTable?.enabled ? bonusTable : null,
      failureTable: failureTable?.enabled ? failureTable : null,
    };
  }

  function planOf(row: PlayerExpeditionRow): ExpeditionResolutionPlan | null {
    return (row.resolutionPlan as ExpeditionResolutionPlan | null) ?? null;
  }

  /**
   * Row → view.
   *
   * Display text comes from the snapshot, falling back to the live definition
   * and then to the bare key. The order matters: the snapshot is what the
   * player was shown when they deployed, so it wins even if content has since
   * renamed the mission. The fallbacks exist for rows whose plan has been
   * cleared at resolution.
   */
  function toView(row: PlayerExpeditionRow, at: Date, waifuName = 'Your WaifuMon'): ExpeditionView {
    const plan = planOf(row);
    const live = findDefinition(row.expeditionKey);
    const remainingMs = row.completesAt.getTime() - at.getTime();
    return {
      id: row.id,
      slotIndex: row.slotIndex,
      expeditionKey: row.expeditionKey,
      region: row.region,
      waifuId: row.waifuId,
      waifuName,
      name: plan?.definition.name ?? live?.name ?? row.expeditionKey,
      emoji: plan?.definition.emoji ?? live?.emoji ?? null,
      description: plan?.definition.description ?? live?.description ?? '',
      status: row.status as ExpeditionView['status'],
      match: parseStoredMatch(row.suitabilityBand),
      startedAt: row.startedAt,
      completesAt: row.completesAt,
      resolvedAt: row.resolvedAt,
      claimedAt: row.claimedAt,
      cancelledAt: row.cancelledAt,
      outcome: row.outcome as ExpeditionOutcome | null,
      rewards: (row.rewards as ExpeditionRewardPayload | null) ?? null,
      secondsRemaining: Math.max(0, Math.ceil(remainingMs / 1000)),
      isDue: row.status === 'active' && remainingMs <= 0,
    };
  }

  /**
   * Display names for a batch of deployed copies, in one query.
   *
   * A nickname wins over the species name, matching every other screen. Rows
   * whose copy has somehow vanished fall back to the default in `toView`
   * rather than dropping the mission from the list — the mission is real even
   * if the pointer is not, and hiding it would look like lost rewards.
   */
  async function waifuNames(
    tx: DbOrTx,
    waifuIds: readonly number[],
  ): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    if (waifuIds.length === 0) return names;
    const rows = await tx
      .select({ id: playerWaifus.id, nickname: playerWaifus.nickname, speciesName: species.name })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(inArray(playerWaifus.id, [...waifuIds]));
    for (const row of rows) names.set(row.id, row.nickname?.trim() || row.speciesName);
    return names;
  }

  /** Every copy the player owns and has not released, with her species row. */
  async function ownedCopies(
    tx: DbOrTx,
    playerId: number,
  ): Promise<{ waifu: typeof playerWaifus.$inferSelect; species: SpeciesRow }[]> {
    return tx
      .select({ waifu: playerWaifus, species })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)));
  }

  /**
   * Resolve one due mission.
   *
   * The outcome and payout are derived *before* the UPDATE, from the row id.
   * If two callers arrive together they compute identical values, so the
   * UPDATE is choosing between two identical writes rather than adjudicating a
   * disagreement — which is why "no row returned, re-read and return theirs"
   * is safe rather than merely convenient.
   *
   * The plan is **trimmed**, not cleared, in the same statement. The reward
   * tables go: the payout is now fixed in `rewards`, so they can never be
   * needed again, and keeping them would store every historical mission's
   * tables forever for no reader (their ids and versions live on in
   * `rewards.sources` for audit). The small `definition` block stays, because
   * a mission whose definition has since been deleted from content still has
   * to render its own name on the results screen and in history — and
   * "test_run" where "Desert Supply Run" belongs is a visible regression for
   * the sake of a few dozen bytes.
   */
  async function resolveRow(
    tx: DbOrTx,
    row: PlayerExpeditionRow,
  ): Promise<PlayerExpeditionRow> {
    const plan = planOf(row);
    if (!plan) {
      // Unreachable through `deploy`, which always writes a plan. Refusing
      // loudly beats inventing a payout: a row in this state is a bug, and
      // guessing at rewards would hide it behind a plausible number.
      logger.error(
        { expeditionId: row.id, expeditionKey: row.expeditionKey },
        'expedition row has no resolution plan — refusing to resolve',
      );
      throw new ExpeditionContentError(
        `expedition ${row.id} has no resolution plan and cannot be resolved`,
      );
    }

    const roll = expeditionDrawFraction(row.id, 'outcome');
    let outcome: ExpeditionOutcome = roll < row.successChance ? 'success' : 'failure';
    if (outcome === 'success') {
      // A second, independent draw. Exceptional is a *promotion* of a success,
      // never its own path from failure — so a mission that failed cannot
      // accidentally become exceptional, whatever this draw says.
      const exceptionalRoll = expeditionDrawFraction(row.id, 'exceptional');
      if (exceptionalRoll < row.exceptionalChance) outcome = 'exceptional';
    }

    const rewards = rollExpeditionRewards({
      outcome,
      expeditionId: row.id,
      successTable: plan.successTable,
      bonusTable: plan.bonusTable,
      failureTable: plan.failureTable,
    });
    for (const warning of rewards.warnings) {
      logger.warn(
        { expeditionId: row.id, tableId: warning.tableId, groupId: warning.groupId },
        warning.message,
      );
    }

    const [claimed] = await tx
      .update(playerExpeditions)
      .set({
        status: 'resolved',
        resolvedAt: sql`now()`,
        outcome,
        resolutionRoll: roll,
        rewards: rewards as unknown as Record<string, unknown>,
        resolutionPlan: {
          planVersion: plan.planVersion,
          definition: plan.definition,
          successTable: null,
          bonusTable: null,
          failureTable: null,
        } as unknown as Record<string, unknown>,
      })
      .where(
        and(
          eq(playerExpeditions.id, row.id),
          eq(playerExpeditions.status, 'active'),
          sql`${playerExpeditions.completesAt} <= now()`,
        ),
      )
      .returning();

    if (claimed) return claimed;

    // Somebody else resolved it between our read and our write. Their result
    // is authoritative — and, because the derivation is deterministic, it is
    // also identical to the one we just computed.
    const [current] = await tx
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.id, row.id));
    return current ?? row;
  }

  /**
   * Read a player's **open** missions, resolving anything due.
   *
   * "Open" is `active` or `resolved`: a resolved mission still holds its
   * region until it is collected, which is what stops a player queueing a
   * second mission on top of an uncollected reward and losing track of it.
   *
   * `region` scopes the read to one region — which is the eligibility question
   * `deploy` asks, and the only question it asks, because a mission in another
   * region is none of its business.
   *
   * Ordered by region and then by start, so a screen listing several missions
   * shows them in the same order every time rather than in whatever order the
   * planner felt like.
   */
  async function readOpenMissions(
    tx: DbOrTx,
    playerId: number,
    region?: string,
  ): Promise<PlayerExpeditionRow[]> {
    const rows = await tx
      .select()
      .from(playerExpeditions)
      .where(
        and(
          eq(playerExpeditions.playerId, playerId),
          inArray(playerExpeditions.status, ['active', 'resolved']),
          ...(region == null ? [] : [eq(playerExpeditions.region, region)]),
        ),
      )
      .orderBy(playerExpeditions.region, playerExpeditions.startedAt);

    const out: PlayerExpeditionRow[] = [];
    for (const row of rows) {
      // The due test is the database's, via the conditional UPDATE — this is
      // only a cheap pre-filter so a not-yet-due mission costs no write.
      if (row.status === 'active' && row.completesAt.getTime() <= Date.now()) {
        out.push(await resolveRow(tx, row));
      } else {
        out.push(row);
      }
    }
    return out;
  }

  return {
    async getBoard(playerId) {
      const cfg = config();
      const at = now();
      // The canonical answer, defaulting included. This service never reads
      // `players.current_region` itself — one resolver, one default, one place
      // a future "you are in transit" state would have to be handled.
      const regionId = await getCurrentRegion(playerId);

      // Resolves anything due in passing, so opening the board is as much of a
      // trigger as opening the active list — and so `canDeploy` below is
      // computed against post-resolution state rather than stale rows.
      const open = await db.transaction((tx) => readOpenMissions(tx, playerId));
      const names = await waifuNames(db, open.map((r) => r.waifuId));
      const views = open.map((row) => toView(row, at, names.get(row.waifuId)));
      const here = views.find((v) => v.region === regionId) ?? null;

      return {
        regionId,
        // A switched-off feature shows an empty board rather than a stale one.
        // Selection first, presentation second: `buildBoard` decides *which*
        // missions this window shows, then they are laid out shortest first.
        entries: cfg.enabled
          ? orderBoardForDisplay(
              buildBoard({
                playerId,
                regionId,
                expeditions: getContent().expeditions,
                durations: Object.values(cfg.durations),
                boardSize: cfg.boardSize,
                rotationHours: cfg.rotationHours,
                now: at,
              }),
            ).map((definition) => ({ definition }))
          : [],
        rotatesAt: rotationEndsAt(at, cfg.rotationHours),
        // What the player already has going on. `here` is the one that gates
        // deployment; `elsewhere` exists purely so the board can say which
        // regions are already busy without a second round trip.
        regionMission: here,
        elsewhere: views.filter((v) => v.region !== regionId),
        canDeploy: cfg.enabled && here == null,
        enabled: cfg.enabled,
      };
    },

    async getCandidates(playerId, expeditionKey) {
      const definition = findDefinition(expeditionKey);
      if (!definition) throw new ExpeditionNotFoundError(expeditionKey);
      const cfg = config();
      const content = getContent();

      const owned = await ownedCopies(db, playerId);
      const reasons = await availability.reasonsForMany(
        db,
        playerId,
        owned.map((o) => o.waifu.id),
      );

      return owned
        .map(({ waifu, species: speciesRow }) => {
          const input = {
            definition,
            waifu: {
              level: waifu.level,
              affinity: speciesRow.affinity as never,
              race: resolveRace(speciesRow),
            },
            config: cfg,
            affinityConfig: content.tables.buddyAffinity,
          };
          const suitability = evaluateSuitability(input);
          const blocking = (reasons.get(waifu.id) ?? []).filter((r) =>
            // The Buddy is only blocked when content says so, which is what
            // makes `buddyDeployable` a real switch rather than decoration.
            r === 'buddy' ? !cfg.buddyDeployable : true,
          );
          return {
            waifuId: waifu.id,
            name: waifu.nickname?.trim() || speciesRow.name,
            level: waifu.level,
            match: evaluateMatch(input),
            // The same values the chance was computed from, handed onward so a
            // UI explains the match instead of re-deriving it.
            affinity: normalizeAffinity(speciesRow.affinity),
            race: resolveRace(speciesRow),
            unavailableReasons: blocking,
            successChance: suitability.successChance,
            factors: suitability.factors,
          };
        })
        // Best fit first: the player opened this list to find the right copy,
        // and Discord's 25-option menu only has room for the top of it. See
        // `compareCandidates` for the full, total order.
        .sort(compareCandidates);
    },

    async deploy(playerId, expeditionKey, waifuId) {
      const cfg = config();
      // The kill switch stops *new* deployments only. Missions already in
      // flight are untouched — see `getActive`, which never consults it.
      if (!cfg.enabled) throw new ExpeditionsDisabledError();

      const definition = findDefinition(expeditionKey);
      if (!definition) throw new ExpeditionNotFoundError(expeditionKey);
      if (!definition.enabled) throw new ExpeditionNotFoundError(expeditionKey);

      const content = getContent();

      /**
       * Location is checked here, and only here.
       *
       * Reading it before the transaction is deliberate: the player's region
       * is not the racy part of a deployment — the region *slot* is, and the
       * unique index below settles that. Someone who travels between this read
       * and the insert has, at worst, started a mission in the region they
       * were standing in a millisecond ago, which is the mission they asked
       * for. Nothing downstream ever asks about location again.
       */
      const currentRegion = await getCurrentRegion(playerId);
      if (definition.region !== currentRegion) {
        throw new ExpeditionWrongRegionError(definition.region, currentRegion);
      }

      return db.transaction(async (tx) => {
        // Lock the copy for the duration: this is what serialises a
        // double-clicked Deploy long enough for the unique index below to be
        // the thing that refuses the second one, rather than a duplicate row
        // being written and cleaned up afterwards.
        const [waifu] = await tx
          .select()
          .from(playerWaifus)
          .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
          .for('update');
        if (!waifu || waifu.releasedAt != null) {
          throw new WaifuUnavailableError(['released']);
        }
        const [speciesRow] = await tx
          .select()
          .from(species)
          .where(eq(species.id, waifu.speciesId));
        if (!speciesRow) throw new WaifuUnavailableError(['released']);

        const blocking = (await availability.reasonsFor(tx, playerId, waifuId)).filter((r) =>
          r === 'buddy' ? !cfg.buddyDeployable : true,
        );
        if (blocking.length > 0) {
          throw new WaifuUnavailableError(
            blocking,
            waifu.nickname?.trim() || speciesRow.name,
          );
        }

        /**
         * Is this *region* free?
         *
         * Scoped to `definition.region` and nothing wider: what the player has
         * running in Twin Peeks has no bearing on whether they may take a job
         * in Waifu Valley. The read resolves anything due in this region in
         * passing, so a mission that finished while the player was away frees
         * its region on the very press that needed it free.
         *
         * This is the *courteous* refusal, not the guarantee — it also covers
         * a `resolved` mission, which no index does. The guarantee against two
         * simultaneous presses is `player_expeditions_player_region_active_uq`
         * on the insert below.
         */
        const openHere = await readOpenMissions(tx, playerId, definition.region);
        if (openHere.length > 0) {
          const busyNames = await waifuNames(tx, [openHere[0]!.waifuId]);
          throw new ExpeditionRegionBusyError(
            definition.region,
            busyNames.get(openHere[0]!.waifuId),
          );
        }

        const plan = buildPlan(definition);
        const input = {
          definition,
          waifu: {
            level: waifu.level,
            affinity: speciesRow.affinity as never,
            race: resolveRace(speciesRow),
          },
          config: cfg,
          affinityConfig: content.tables.buddyAffinity,
        };
        const suitability = evaluateSuitability(input);
        const match = evaluateMatch(input);

        const [inserted] = await tx
          .insert(playerExpeditions)
          .values({
            playerId,
            // Always 1 while a region holds one mission. Written explicitly
            // rather than left to the column default so the day a per-region
            // ladder arrives, this is the line that changes.
            slotIndex: 1,
            expeditionKey: definition.key,
            region: definition.region,
            waifuId,
            status: 'active',
            // Computed by the database from the database's own clock, so the
            // finish line is set by the same clock that will judge it.
            completesAt: sql`now() + make_interval(mins => ${definition.durationMinutes})`,
            successChance: suitability.successChance,
            exceptionalChance: suitability.exceptionalChance,
            // The column keeps its name: it is still "the label the player was
            // shown". The value is now a match quality, never a success band.
            suitabilityBand: match.quality,
            resolutionPlan: plan as unknown as Record<string, unknown>,
            logicVersion: EXPEDITION_LOGIC_VERSION,
          })
          .returning();

        return toView(inserted!, now(), waifu.nickname?.trim() || speciesRow.name);
      });
    },

    async getActive(playerId) {
      // Deliberately does not consult `expeditions.enabled`. A kill switch
      // must not eat somebody's eighteen hours: missions already in flight
      // resolve and pay whatever content says about new ones.
      const rows = await db.transaction((tx) => readOpenMissions(tx, playerId));
      const at = now();
      const names = await waifuNames(db, rows.map((r) => r.waifuId));
      return rows.map((row) => toView(row, at, names.get(row.waifuId)));
    },

    async claim(playerId, expeditionId) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(playerExpeditions)
          .where(
            and(
              eq(playerExpeditions.id, expeditionId),
              eq(playerExpeditions.playerId, playerId),
            ),
          );
        if (!existing) throw new ExpeditionNotActiveError();
        if (existing.status === 'cancelled') throw new ExpeditionNotCancellableError('cancelled');

        // Resolve first if it is due, so "collect" works on the first press
        // rather than needing a read to have happened earlier.
        const row =
          existing.status === 'active' ? await resolveRow(tx, existing) : existing;

        if (row.status === 'active') {
          throw new ExpeditionNotCompleteError(
            (row.completesAt.getTime() - Date.now()) / 1000,
          );
        }
        if (row.status === 'claimed') throw new ExpeditionAlreadyClaimedError();

        // The conditional claim. Exactly one caller can move a row out of
        // `resolved`, and every grant below happens only for that caller —
        // inside this same transaction, so a failure anywhere rolls back the
        // claim along with the payout.
        const [won] = await tx
          .update(playerExpeditions)
          .set({ status: 'claimed', claimedAt: sql`now()` })
          .where(
            and(
              eq(playerExpeditions.id, row.id),
              eq(playerExpeditions.status, 'resolved'),
              isNull(playerExpeditions.claimedAt),
            ),
          )
          .returning();
        if (!won) throw new ExpeditionAlreadyClaimedError();

        const rewards = (won.rewards as ExpeditionRewardPayload | null) ?? {
          waifubux: 0,
          essence: 0,
          waifuXp: 0,
          playerXp: 0,
          items: [],
          sources: [],
          warnings: [],
        };

        // Lock the currency row before any credit, exactly as the shop does,
        // so concurrent grants to this player serialise.
        await currency.lockCurrencies(tx, playerId);

        let waifubuxAfter = (await currency.getBalances(playerId)).waifubux;
        if (rewards.waifubux > 0) {
          waifubuxAfter = (await currency.grantWaifubux(tx, playerId, rewards.waifubux))
            .waifubux;
        }

        // Essence goes through `essenceAward`, never `grantEssence`, so the
        // Buddy Bonus applies here exactly as it does to every other Essence
        // reward in the game. `awardEssence` throws on a non-positive base, so
        // zero is checked here rather than delegated.
        let essenceGranted = 0;
        if (rewards.essence > 0) {
          const award = await essenceAward.awardEssence(tx, playerId, rewards.essence);
          essenceGranted = award.essenceGranted;
        }
        const essenceAfter = (await currency.getBalances(playerId)).essence;

        // XP to the copy that was actually sent — read from the row, not from
        // whoever happens to be Buddy now.
        let waifuLeveledUp = false;
        if (rewards.waifuXp > 0) {
          const result = await collection.awardWaifuXp(tx, playerId, won.waifuId, rewards.waifuXp);
          // `awardWaifuXp` reports levels rather than a flag, and returns null
          // for a max-level copy — which is a legitimate no-op, not a failure.
          waifuLeveledUp = result != null && result.toLevel > result.fromLevel;
        }
        if (rewards.playerXp > 0 && progression) {
          await progression.grantXp(tx, playerId, {
            eventType: 'expedition_claim',
            xpDelta: rewards.playerXp,
            refId: won.id,
            metadata: { expeditionKey: won.expeditionKey, outcome: won.outcome },
          });
        }

        const itemsGranted: { slug: string; name: string; quantity: number }[] = [];
        if (rewards.items.length > 0) {
          const slugs = rewards.items.map((i) => i.slug);
          const rows = await tx.select().from(items).where(inArray(items.slug, slugs));
          const bySlug = new Map(rows.map((r) => [r.slug, r]));
          for (const grant of rewards.items) {
            const item = bySlug.get(grant.slug);
            if (!item) {
              // Unreachable in practice — the seeder disables items, never
              // deletes them — but a missing row must not cost the player the
              // rest of their payout.
              logger.error(
                { expeditionId: won.id, slug: grant.slug },
                'expedition reward names an item that is not in the database — skipped',
              );
              continue;
            }
            await inventory.addItem(tx, playerId, item.id, grant.quantity);
            itemsGranted.push({ slug: item.slug, name: item.name, quantity: grant.quantity });
          }
        }

        const claimedNames = await waifuNames(tx, [won.waifuId]);
        return {
          expedition: toView(won, now(), claimedNames.get(won.waifuId)),
          outcome: won.outcome as ExpeditionOutcome,
          rewards,
          waifubuxAfter,
          essenceAfter,
          essenceGranted,
          itemsGranted,
          waifuLeveledUp,
        };
      });
    },

    async cancel(playerId, expeditionId) {
      /**
       * Cancellation is an *abandonment*, not an early resolution.
       *
       * It never rolls the outcome, never writes `rewards`, and never grants
       * anything — so there is no way to use it to peek at a result, and no
       * way for a cancelled mission to become a payout later. The copy comes
       * home immediately because the partial unique index only covers `active`
       * rows, so moving the status is the whole of "release the WaifuMon".
       *
       * No additional penalty in V1. One is easy to add here later; taking one
       * away after players have planned around it is not.
       */
      return db.transaction(async (tx) => {
        const [cancelled] = await tx
          .update(playerExpeditions)
          .set({
            status: 'cancelled',
            cancelledAt: sql`now()`,
            // Same trim as resolution: the tables are dead weight once nothing
            // can roll them, but history still has to name the mission.
            resolutionPlan: sql`jsonb_build_object(
              'planVersion', ${playerExpeditions.resolutionPlan} -> 'planVersion',
              'definition', ${playerExpeditions.resolutionPlan} -> 'definition',
              'successTable', 'null'::jsonb,
              'bonusTable', 'null'::jsonb,
              'failureTable', 'null'::jsonb
            )`,
          })
          .where(
            and(
              eq(playerExpeditions.id, expeditionId),
              eq(playerExpeditions.playerId, playerId),
              eq(playerExpeditions.status, 'active'),
            ),
          )
          .returning();
        if (cancelled) {
          const names = await waifuNames(tx, [cancelled.waifuId]);
          return toView(cancelled, now(), names.get(cancelled.waifuId));
        }

        // Lost the race, or it was never cancellable. Distinguish the two so
        // the message is about what actually happened.
        const [current] = await tx
          .select()
          .from(playerExpeditions)
          .where(
            and(
              eq(playerExpeditions.id, expeditionId),
              eq(playerExpeditions.playerId, playerId),
            ),
          );
        if (!current) throw new ExpeditionNotActiveError();
        throw new ExpeditionNotCancellableError(current.status);
      });
    },

    async getHistory(playerId, limit = 10) {
      const rows = await db
        .select()
        .from(playerExpeditions)
        .where(
          and(
            eq(playerExpeditions.playerId, playerId),
            inArray(playerExpeditions.status, ['claimed', 'cancelled']),
          ),
        )
        .orderBy(desc(playerExpeditions.startedAt))
        .limit(limit);
      const at = now();
      const names = await waifuNames(db, rows.map((r) => r.waifuId));
      return rows.map((row) => toView(row, at, names.get(row.waifuId)));
    },

    async unavailabilityFor(tx, playerId, waifuIds) {
      const result = new Map<number, WaifuUnavailabilityReason[]>();
      if (waifuIds.length === 0) return result;
      const rows = await tx
        .select({ waifuId: playerExpeditions.waifuId })
        .from(playerExpeditions)
        .where(
          and(
            eq(playerExpeditions.playerId, playerId),
            eq(playerExpeditions.status, 'active'),
            inArray(playerExpeditions.waifuId, [...waifuIds]),
          ),
        );
      for (const row of rows) result.set(row.waifuId, ['on_expedition']);
      return result;
    },
  };
}
