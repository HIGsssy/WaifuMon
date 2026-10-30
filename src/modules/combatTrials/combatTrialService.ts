/**
 * Combat Trials — the first game feature built on the combat engine.
 *
 * A Trial is a fight against one content-defined enemy (see
 * `trialDefinitions.ts`). This service owns everything about Trials that is
 * not presentation:
 *
 *   - the gate: the permanent `equipment` feature unlock, checked on every
 *     read and every fight, so a stale or forged button from a locked player
 *     reaches nothing;
 *   - the read models a screen needs (list, detail), neutral enough for
 *     Discord today and the Portal later — no embeds, no prose;
 *   - resolving a fight, recording it, first-clear tracking and the one-time
 *     first-clear reward;
 *   - retiring the introductory curriculum (`trialCurriculum.ts`) once the
 *     player has cleared it: its Trials leave the list and are refused on
 *     open and fight, which is also what opens Delve. Before that, every
 *     Trial — cleared or not — can be fought again, as it always could.
 *
 * It never calculates a stat. The player's ATK / DEF / HP and combat
 * modifiers come from `combatStatsService` (the one place Equipment
 * multipliers are applied and bonuses aggregated), the
 * enemy's from its content definition, and the fight from the existing
 * engine: `createCombatState` → `simulateCombat` with basic-attack
 * controllers. V1 auto combat is a client of the same action resolver a
 * future interactive Trial will drive one button at a time.
 *
 * ## Fight transaction
 *
 * One transaction per Fight, serialised per player by a `FOR UPDATE` lock on
 * the player row:
 *
 *   1. unlock check;
 *   2. idempotency: an attempt with this `requestKey` already exists → read it
 *      back (`replayed: true`); nothing is fought or paid again;
 *   3. a curriculum Trial is refused once the curriculum is complete (after
 *      the replay check, so a retried final clear still shows its result);
 *   4. Trial and enemy still enabled;
 *   5. stats snapshotted inside the transaction (`snapshotCombatStats`);
 *   6. engine runs on `seededRng(combatTrialSeed(...))`; the attempt row is
 *      written with a snapshot of both sides, the player's modifiers (inside
 *      `initial_state`) and the seed;
 *   7. on a first `player_victory`, `first_clear = true` and the reward is
 *      paid in the same transaction. The partial unique index on
 *      `(player_id, trial_key) WHERE first_clear` backs the row lock: a
 *      second first-clear cannot commit.
 *
 * Any failure rolls the whole thing back — no attempt, no reward.
 *
 * ## Determinism
 *
 * Every random draw of a fight — damage variance, Crits, Double Attacks —
 * comes from one seed, {@link combatTrialSeed}: a hash of the player, the
 * Trial and the request key. Nothing about it is random, so an attempt that
 * failed to commit and is retried with the same key fights the *same* fight,
 * and a stored attempt can be reproduced from `initial_state` + `combat_seed`
 * ({@link replayCombatTrialAttempt}). A request key resolves once: a retry
 * reads the stored attempt back and can never re-roll for a better result.
 */
import { createHash } from 'node:crypto';
import { and, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { combatTrialAttempts, items, players, type CombatTrialAttemptRow } from '../../db/schema';
import {
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  CombatTrialRequestConflictError,
  CombatTrialsCompletedError,
  CombatTrialUnavailableError,
  ContentValidationError,
  FeatureLockedError,
  PlayerNotFoundError,
} from '../../shared/errors';
import { seededRng, type Rng } from '../../shared/random';
import type { LoadedContent } from '../content/schemas';
import type { CurrencyService } from '../currency/currencyService';
import type { CombatStatsService } from '../equipment/combatStatsService';
import type { CombatStats } from '../equipment/equipmentMath';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import type { InventoryService } from '../inventory/inventoryService';
import { basicAttackController } from '../combat/combatController';
import { ZERO_COMBAT_MODIFIERS, clampCombatModifiers } from '../combat/combatMath';
import { simulateCombat } from '../combat/combatSimulator';
import { createCombatState } from '../combat/combatState';
import type {
  CombatEndReason,
  CombatEvent,
  CombatModifiers,
  CombatResult,
  CombatResultKind,
  CombatState,
} from '../combat/combatTypes';
import {
  createCombatEnemyCatalogue,
  enemyCombatantInput,
  type CombatEnemyDefinition,
} from '../combat/enemyDefinitions';
import { playerCombatantInput } from '../combat/playerCombatant';
import {
  createCombatTrialCatalogue,
  type CombatTrialCatalogue,
  type CombatTrialDefinition,
  type CombatTrialReward,
} from '../combat/trialDefinitions';
import { COMBAT_TRIAL_CURRICULUM, readCurriculumProgress, type TrialCurriculumProgress } from './trialCurriculum';

/** The feature that gates Trials: no Equipment means no combat stats. */
export const COMBAT_TRIAL_FEATURE = 'equipment' as const;

/** Longest accepted idempotency key. Discord nonces are far shorter. */
export const COMBAT_TRIAL_REQUEST_KEY_MAX_LENGTH = 128;

/**
 * Versioned salt for a Trial fight's seed. Frozen: changing it would make a
 * retried request fight differently than its first try would have.
 */
export const COMBAT_TRIAL_SEED_SALT = 'waifumon.trial.combat.v1';

/**
 * The seed of one Trial attempt: the first 32 bits of
 * `md5("<player id>:<trial key>:<request key>:combat:<salt>")`. Stable request
 * data only — the same request always fights the same fight.
 */
export function combatTrialSeed(
  playerId: number,
  trialKey: string,
  requestKey: string,
  salt: string = COMBAT_TRIAL_SEED_SALT,
): number {
  const digest = createHash('md5').update(`${playerId}:${trialKey}:${requestKey}:combat:${salt}`, 'utf8').digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16);
}

/** Run a Trial fight from its starting state and seed. Pure. */
export function runCombatTrialFight(initial: CombatState, combatSeed: number, rngOf: (seed: number) => Rng = seededRng): CombatResult {
  return simulateCombat(
    initial,
    { player: basicAttackController, enemy: basicAttackController },
    { rng: rngOf(combatSeed) },
  );
}

/**
 * Re-fight a stored attempt from its `initial_state` and `combat_seed` — the
 * audit path. Returns null for an attempt recorded before Trials were seeded
 * (no seed), which can only be replayed from its stored `events`.
 */
export function replayCombatTrialAttempt(
  row: Pick<CombatTrialAttemptRow, 'initialState' | 'combatSeed'>,
): CombatResult | null {
  if (row.combatSeed == null) return null;
  return runCombatTrialFight(row.initialState as unknown as CombatState, row.combatSeed);
}

// ── read models ───────────────────────────────────────────────────────────

/** A player's standing in one Trial. */
export interface CombatTrialProgress {
  /** At least one `player_victory`. Draws and losses never count. */
  cleared: boolean;
  firstClearedAt: Date | null;
  attempts: number;
  /** The most recent attempt, if any. */
  latest: { result: CombatResultKind; completedAt: Date } | null;
}

export interface CombatTrialSummary {
  trial: CombatTrialDefinition;
  enemy: CombatEnemyDefinition;
  progress: CombatTrialProgress;
}

export interface CombatTrialListView {
  /** Fightable Trials, in authored order. Curriculum Trials are left out once it is complete. */
  trials: CombatTrialSummary[];
  /** How far the player is through the curriculum that opens Delve. */
  curriculum: { required: number; cleared: number; complete: boolean };
}

/** Why the Fight action is refused before it is pressed. */
export type CombatTrialBlocker = 'no_buddy' | 'incomplete_loadout';

export interface CombatTrialDetailView extends CombatTrialSummary {
  /** The live, authoritative calculation — exactly `calculateCombatStats`. */
  stats: CombatStats;
  /** Null when the player can fight now. */
  blocker: CombatTrialBlocker | null;
}

/** One side of a recorded attempt, as it was when the fight started and ended. */
export interface CombatTrialSideSnapshot {
  name: string;
  attack: number;
  defense: number;
  maxHp: number;
  remainingHp: number;
  /**
   * The combat modifiers this side fought with — the aggregated, capped
   * totals frozen at fight start. All zero for an enemy and for an attempt
   * recorded before modifiers existed.
   */
  modifiers: CombatModifiers;
}

/** A recorded attempt. Every number is the stored snapshot, never recomputed. */
export interface CombatTrialAttemptView {
  id: number;
  trialKey: string;
  enemyKey: string;
  result: CombatResultKind;
  endReason: CombatEndReason;
  rounds: number;
  actions: number;
  buddyWaifuId: number;
  player: CombatTrialSideSnapshot;
  enemy: CombatTrialSideSnapshot;
  firstClear: boolean;
  /** What this attempt paid; null when it paid nothing. */
  rewards: CombatTrialReward | null;
  events: CombatEvent[];
  /** The seed the fight's draws came from; null for a pre-seeding attempt. */
  combatSeed: number | null;
  startedAt: Date;
  completedAt: Date;
}

export interface CombatTrialFightOutcome {
  attempt: CombatTrialAttemptView;
  /** True when the request key had already resolved: nothing new happened. */
  replayed: boolean;
  /** The Trial's current definition, for display; null if it has since been removed. */
  trial: CombatTrialDefinition | null;
  /** False once the curriculum is complete and this is one of its Trials. */
  canFightAgain: boolean;
  /** Whether the Trial list still has anything to fight. */
  trialsOpen: boolean;
  /** True on exactly the attempt whose first clear completed the curriculum (opening Delve). */
  completedCurriculum: boolean;
}

// ── service ───────────────────────────────────────────────────────────────

export interface CombatTrialService {
  /** Whether the player may use Combat Trials at all. Never throws for a locked player. */
  isAvailable(playerId: number): Promise<boolean>;
  /**
   * Whether navigation should offer Combat Trials: unlocked, and something is
   * left to fight — the curriculum until it is cleared, then only Trials
   * outside it. Never throws for a locked player.
   */
  entryVisible(playerId: number): Promise<boolean>;
  /** @throws {FeatureLockedError} {CombatTrialsCompletedError} */
  list(playerId: number): Promise<CombatTrialListView>;
  /** @throws {FeatureLockedError} {CombatTrialUnavailableError} {CombatTrialsCompletedError} */
  detail(playerId: number, trialKey: string): Promise<CombatTrialDetailView>;
  /**
   * Resolve one fight. `requestKey` is the caller's idempotency key: the same
   * key always returns the same attempt, fought and paid once.
   *
   * @throws {FeatureLockedError} {CombatTrialUnavailableError} {CombatTrialsCompletedError}
   *         {CombatBuddyRequiredError} {CombatLoadoutIncompleteError}
   *         {CombatTrialRequestConflictError} {CombatStateInvalidError}
   */
  fight(playerId: number, trialKey: string, requestKey: string): Promise<CombatTrialFightOutcome>;
}

export interface CombatTrialServiceDeps {
  db: Db;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
  combatStats: Pick<CombatStatsService, 'calculateCombatStats' | 'snapshotCombatStats'>;
  currency: Pick<CurrencyService, 'grantWaifubux'>;
  inventory: Pick<InventoryService, 'addItem'>;
  /**
   * Read on every call, never cached here: the Trials are shipped content
   * (a reload is followed) and the enemies come from the Enemy Catalogue (an
   * edit in Portal Admin reaches the next fight). May be async for that read.
   */
  getCatalogue(): CombatTrialCatalogue | Promise<CombatTrialCatalogue>;
  /** The Trials that open Delve. Defaults to the shipped {@link COMBAT_TRIAL_CURRICULUM}. */
  curriculum?: readonly string[];
  /**
   * The generator for a fight's seed. Defaults to `seededRng`; injected only
   * by tests that need to script draws. Production never overrides it — a
   * fight must be a function of its stored seed.
   */
  rngForSeed?: (seed: number) => Rng;
}

const catalogueCache = new WeakMap<LoadedContent, CombatTrialCatalogue>();

/**
 * The Trial catalogue joined to the **Enemy Catalogue** — what the running
 * game uses. `enemies` is read from the database on each call, so the stats a
 * fight uses are the ones an admin last saved.
 */
export async function combatTrialCatalogueFromEnemies(
  trials: readonly CombatTrialDefinition[] | undefined,
  enemies: { definitions(): Promise<CombatEnemyDefinition[]> },
): Promise<CombatTrialCatalogue> {
  return createCombatTrialCatalogue(trials ?? [], createCombatEnemyCatalogue(await enemies.definitions()));
}

/**
 * The Trial catalogue for a content snapshot alone, built once per snapshot:
 * shipped Trials against shipped enemies. For content checks and tests; the
 * running game uses {@link combatTrialCatalogueFromEnemies}.
 */
export function combatTrialCatalogueFromContent(content: LoadedContent): CombatTrialCatalogue {
  let catalogue = catalogueCache.get(content);
  if (!catalogue) {
    catalogue = createCombatTrialCatalogue(
      content.combatTrials ?? [],
      createCombatEnemyCatalogue(content.combatEnemies ?? []),
    );
    catalogueCache.set(content, catalogue);
  }
  return catalogue;
}

function emptyProgress(): CombatTrialProgress {
  return { cleared: false, firstClearedAt: null, attempts: 0, latest: null };
}

function hasReward(reward: CombatTrialReward | null): reward is CombatTrialReward {
  return reward != null && (reward.waifubux > 0 || reward.items.length > 0);
}

/** A side's snapshotted modifiers out of a stored `initial_state`; zero when it has none. */
function storedModifiers(row: CombatTrialAttemptRow, side: 'player' | 'enemy'): CombatModifiers {
  const state = row.initialState as { player?: { modifiers?: unknown }; enemy?: { modifiers?: unknown } } | null;
  const stored = state?.[side]?.modifiers;
  if (stored == null || typeof stored !== 'object') return { ...ZERO_COMBAT_MODIFIERS };
  try {
    return clampCombatModifiers(stored as Partial<CombatModifiers>);
  } catch {
    return { ...ZERO_COMBAT_MODIFIERS };
  }
}

export function toAttemptView(row: CombatTrialAttemptRow): CombatTrialAttemptView {
  return {
    id: row.id,
    trialKey: row.trialKey,
    enemyKey: row.enemyKey,
    result: row.result as CombatResultKind,
    endReason: row.endReason as CombatEndReason,
    rounds: row.rounds,
    actions: row.actions,
    buddyWaifuId: row.buddyWaifuId,
    player: {
      name: row.playerName,
      attack: row.playerAttack,
      defense: row.playerDefense,
      maxHp: row.playerMaxHp,
      remainingHp: row.playerRemainingHp,
      modifiers: storedModifiers(row, 'player'),
    },
    enemy: {
      name: row.enemyName,
      attack: row.enemyAttack,
      defense: row.enemyDefense,
      maxHp: row.enemyMaxHp,
      remainingHp: row.enemyRemainingHp,
      modifiers: storedModifiers(row, 'enemy'),
    },
    firstClear: row.firstClear,
    rewards: (row.rewards as CombatTrialReward | null) ?? null,
    events: row.events as unknown as CombatEvent[],
    combatSeed: row.combatSeed ?? null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function createCombatTrialService(deps: CombatTrialServiceDeps): CombatTrialService {
  const { db } = deps;
  const rngForSeed = deps.rngForSeed ?? seededRng;
  const curriculum = deps.curriculum ?? COMBAT_TRIAL_CURRICULUM;
  const inCurriculum = (trialKey: string) => curriculum.includes(trialKey);

  async function requireUnlocked(playerId: number, tx: DbOrTx = db): Promise<void> {
    if (!(await deps.featureUnlocks.isUnlocked(playerId, COMBAT_TRIAL_FEATURE, tx))) {
      throw new FeatureLockedError(COMBAT_TRIAL_FEATURE);
    }
  }

  /** What the list offers: everything fightable, less the curriculum once it is cleared. */
  function openTrials<T extends { trial: CombatTrialDefinition }>(available: T[], progress: TrialCurriculumProgress): T[] {
    return progress.complete ? available.filter((a) => !inCurriculum(a.trial.key)) : available;
  }

  /** The player's standing after a fight, for the result screen's buttons. */
  async function standing(tx: DbOrTx, playerId: number, trialKey: string, attemptId: number) {
    const progress = await readCurriculumProgress(tx, playerId, curriculum);
    const trialsOpen = !progress.complete || openTrials((await deps.getCatalogue()).available(), progress).length > 0;
    return {
      canFightAgain: !(progress.complete && inCurriculum(trialKey)),
      trialsOpen,
      completedCurriculum: progress.completedByAttemptId === attemptId,
    };
  }

  async function resolveOrThrow(trialKey: string) {
    const resolved = (await deps.getCatalogue()).resolve(trialKey);
    if (resolved.status === 'unavailable') throw new CombatTrialUnavailableError(trialKey, resolved.reason);
    return resolved;
  }

  async function progressFor(
    tx: DbOrTx,
    playerId: number,
    trialKeys: readonly string[],
  ): Promise<Map<string, CombatTrialProgress>> {
    const out = new Map<string, CombatTrialProgress>(trialKeys.map((k) => [k, emptyProgress()]));
    if (trialKeys.length === 0) return out;
    const t = combatTrialAttempts;
    const where = and(eq(t.playerId, playerId), inArray(t.trialKey, [...trialKeys]));
    const totals = await tx
      .select({
        trialKey: t.trialKey,
        attempts: count(),
        firstClearedAt: sql<Date | null>`max(${t.completedAt}) filter (where ${t.firstClear})`.mapWith(
          (v: string | Date | null) => (v == null ? null : new Date(v)),
        ),
        latestId: max(t.id),
      })
      .from(t)
      .where(where)
      .groupBy(t.trialKey);
    const latestIds = totals.flatMap((r) => (r.latestId == null ? [] : [Number(r.latestId)]));
    const latest = latestIds.length
      ? await tx
          .select({ id: t.id, result: t.result, completedAt: t.completedAt })
          .from(t)
          .where(inArray(t.id, latestIds))
      : [];
    const latestById = new Map(latest.map((r) => [r.id, r]));
    for (const row of totals) {
      const last = row.latestId == null ? undefined : latestById.get(Number(row.latestId));
      out.set(row.trialKey, {
        cleared: row.firstClearedAt != null,
        firstClearedAt: row.firstClearedAt,
        attempts: row.attempts,
        latest: last ? { result: last.result as CombatResultKind, completedAt: last.completedAt } : null,
      });
    }
    return out;
  }

  async function lockPlayer(tx: DbOrTx, playerId: number): Promise<void> {
    const [row] = await tx.select({ id: players.id }).from(players).where(eq(players.id, playerId)).for('update');
    if (!row) throw new PlayerNotFoundError(playerId);
  }

  async function payReward(tx: DbOrTx, playerId: number, reward: CombatTrialReward): Promise<void> {
    if (reward.waifubux > 0) await deps.currency.grantWaifubux(tx, playerId, reward.waifubux);
    if (reward.items.length === 0) return;
    const slugs = [...new Set(reward.items.map((i) => i.slug))];
    const rows = await tx.select({ id: items.id, slug: items.slug }).from(items).where(inArray(items.slug, slugs));
    const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
    for (const grant of reward.items) {
      const itemId = idBySlug.get(grant.slug);
      // Content validation checks slugs against items.json at load; a slug the
      // database lacks is a deploy mismatch. Throwing rolls the fight back.
      if (itemId === undefined) {
        throw new ContentValidationError(`Combat Trial reward names item "${grant.slug}", which is not in the database`);
      }
      await deps.inventory.addItem(tx, playerId, itemId, grant.quantity);
    }
  }

  return {
    async isAvailable(playerId) {
      return deps.featureUnlocks.isUnlocked(playerId, COMBAT_TRIAL_FEATURE);
    },

    async entryVisible(playerId) {
      if (!(await deps.featureUnlocks.isUnlocked(playerId, COMBAT_TRIAL_FEATURE))) return false;
      const progress = await readCurriculumProgress(db, playerId, curriculum);
      if (!progress.complete) return true;
      return openTrials((await deps.getCatalogue()).available(), progress).length > 0;
    },

    async list(playerId) {
      await requireUnlocked(playerId);
      const standing = await readCurriculumProgress(db, playerId, curriculum);
      const available = openTrials((await deps.getCatalogue()).available(), standing);
      if (standing.complete && available.length === 0) throw new CombatTrialsCompletedError();
      const progress = await progressFor(
        db,
        playerId,
        available.map((a) => a.trial.key),
      );
      return {
        trials: available.map(({ trial, enemy }) => ({
          trial,
          enemy,
          progress: progress.get(trial.key) ?? emptyProgress(),
        })),
        curriculum: { required: standing.required.length, cleared: standing.cleared.length, complete: standing.complete },
      };
    },

    async detail(playerId, trialKey) {
      await requireUnlocked(playerId);
      if (inCurriculum(trialKey) && (await readCurriculumProgress(db, playerId, curriculum)).complete) {
        throw new CombatTrialsCompletedError();
      }
      const { trial, enemy } = await resolveOrThrow(trialKey);
      const [stats, progress] = await Promise.all([
        deps.combatStats.calculateCombatStats(playerId),
        progressFor(db, playerId, [trial.key]),
      ]);
      return {
        trial,
        enemy,
        progress: progress.get(trial.key) ?? emptyProgress(),
        stats,
        blocker: stats.unavailableReason,
      };
    },

    async fight(playerId, trialKey, requestKey) {
      if (
        typeof requestKey !== 'string' ||
        requestKey.length === 0 ||
        requestKey.length > COMBAT_TRIAL_REQUEST_KEY_MAX_LENGTH
      ) {
        throw new RangeError('fight requires a non-empty request key');
      }
      return db.transaction(async (tx) => {
        await requireUnlocked(playerId, tx);
        await lockPlayer(tx, playerId);

        const [existing] = await tx
          .select()
          .from(combatTrialAttempts)
          .where(and(eq(combatTrialAttempts.playerId, playerId), eq(combatTrialAttempts.requestKey, requestKey)));
        if (existing) {
          if (existing.trialKey !== trialKey) throw new CombatTrialRequestConflictError(requestKey);
          return {
            attempt: toAttemptView(existing),
            replayed: true,
            trial: (await deps.getCatalogue()).get(existing.trialKey) ?? null,
            ...(await standing(tx, playerId, existing.trialKey, existing.id)),
          };
        }

        // Read under the player lock: a concurrent final clear has either
        // committed (and this is refused) or has not started.
        if (inCurriculum(trialKey) && (await readCurriculumProgress(tx, playerId, curriculum)).complete) {
          throw new CombatTrialsCompletedError();
        }

        const { trial, enemy } = await resolveOrThrow(trialKey);

        const stats = await deps.combatStats.snapshotCombatStats(tx, playerId);
        if (stats.buddy == null) throw new CombatBuddyRequiredError();
        if (!stats.isComplete) throw new CombatLoadoutIncompleteError();

        // Numbers only from here on: the engine never sees Equipment.
        const initial = createCombatState({
          player: playerCombatantInput({
            buddy: stats.buddy,
            stats: stats.stats,
            modifiers: stats.combatModifiers,
          }),
          enemy: enemyCombatantInput(enemy),
        });
        // Seeded from the request, never from the clock or Math.random: the
        // same request is the same fight, however often it is tried.
        const combatSeed = combatTrialSeed(playerId, trial.key, requestKey);
        const outcome = runCombatTrialFight(initial, combatSeed, rngForSeed);

        let firstClear = false;
        if (outcome.result === 'player_victory') {
          const [prior] = await tx
            .select({ id: combatTrialAttempts.id })
            .from(combatTrialAttempts)
            .where(
              and(
                eq(combatTrialAttempts.playerId, playerId),
                eq(combatTrialAttempts.trialKey, trial.key),
                eq(combatTrialAttempts.firstClear, true),
              ),
            )
            .limit(1);
          firstClear = prior == null;
        }
        const reward = firstClear && hasReward(trial.firstClearRewards) ? trial.firstClearRewards : null;

        const end = outcome.finalState;
        const [row] = await tx
          .insert(combatTrialAttempts)
          .values({
            playerId,
            trialKey: trial.key,
            enemyKey: enemy.key,
            requestKey,
            result: outcome.result,
            endReason: outcome.reason,
            rounds: outcome.rounds,
            actions: outcome.actions,
            buddyWaifuId: stats.buddy.waifuId,
            playerName: initial.player.name,
            playerAttack: initial.player.attack,
            playerDefense: initial.player.defense,
            playerMaxHp: initial.player.maxHp,
            playerRemainingHp: end.player.currentHp,
            enemyName: initial.enemy.name,
            enemyAttack: initial.enemy.attack,
            enemyDefense: initial.enemy.defense,
            enemyMaxHp: initial.enemy.maxHp,
            enemyRemainingHp: end.enemy.currentHp,
            initialState: initial as unknown as Record<string, unknown>,
            events: outcome.events as unknown as Record<string, unknown>[],
            combatSeed,
            firstClear,
            rewards: reward as unknown as Record<string, unknown> | null,
          })
          .returning();

        if (reward) await payReward(tx, playerId, reward);

        return { attempt: toAttemptView(row!), replayed: false, trial, ...(await standing(tx, playerId, trial.key, row!.id)) };
      });
    },
  };
}
