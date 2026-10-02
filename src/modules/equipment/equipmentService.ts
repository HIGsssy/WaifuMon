/**
 * Equipment — the one writer of owned instances and loadouts.
 *
 * Every path that creates, equips, flags or removes player equipment goes
 * through this service; `tests/unit/equipmentBoundary.test.ts` fails the build
 * if anything outside `modules/equipment` writes these tables. Reward systems
 * (onboarding, encounters, expeditions, shops, admin grants) will all call
 * {@link EquipmentService.grantEquipment} inside their own transaction.
 *
 * ## Rules this service enforces
 *
 *  - **Rewards never equip.** `grantEquipment` creates instances and nothing
 *    else; it never reads or writes a loadout.
 *  - **Owning is independent of unlocking.** Gear can be granted before the
 *    Equipment feature is unlocked and waits in the gear bag. Changing what is
 *    equipped, and flagging gear, requires the unlock.
 *  - **Disabled definitions stop acquisition, not use.** A grant of a disabled
 *    definition is refused (unless the caller is paying out something already
 *    won); equipping an instance of one is allowed.
 *  - **An instance owns its roll.** `grantEquipment` decides each copy's
 *    multiplier and affix exactly once — rolled from the definition's range
 *    (`equipmentRoll.ts`) or dictated and validated for a fixed grant — and
 *    stores them on the row. Nothing ever recalculates them, and a retried
 *    grant reads the original copies back instead of rolling again.
 *  - **Ownership is always re-validated.** An id from a client is looked up
 *    together with the player id and `removed_at IS NULL`; missing, foreign
 *    and removed instances all fail with the same `EquipmentNotOwnedError`.
 *    The slot table's composite foreign keys are the backstop.
 *
 * ## Locking
 *
 * Lock order is always **loadout, then instance**, in every path that takes
 * both, so equip and admin removal cannot deadlock. Equip locks the player's
 * active loadout `FOR UPDATE` (serialising every equip/unequip for that
 * player) and the instance `FOR SHARE`; admin removal locks every loadout the
 * player has `FOR UPDATE`, then the instance `FOR UPDATE`.
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  equipmentDefinitions,
  equipmentEvents,
  playerEquipment,
  playerLoadoutSlots,
  playerLoadouts,
  RARITIES,
  type EquipmentDefinitionRow,
  type PlayerEquipmentRow,
  type PlayerLoadoutRow,
} from '../../db/schema';
import {
  EquipmentDefinitionDisabledError,
  EquipmentDefinitionNotFoundError,
  EquipmentDismantleRefusedError,
  EquipmentDismantleSelectionError,
  EquipmentLockedError,
  EquipmentNotOwnedError,
  EquipmentSlotMismatchError,
  EquipmentValidationError,
  FeatureLockedError,
  LoadoutConflictError,
  type DismantleProblem,
} from '../../shared/errors';
import { defaultRng, type Rng } from '../../shared/random';
import { recordDomainAdminAction } from '../admin/adminActionAudit';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import type { EquipmentAffixCatalogue } from './affixCatalogue';
import {
  equipmentDisplayName,
  multiplierRangeIssues,
  rollEquipmentInstance,
  UNKNOWN_AFFIX_LABEL,
  validateFixedRoll,
  type EquipmentRoll,
} from './equipmentRoll';
import {
  readActiveLoadoutRow,
  readActiveLoadoutView,
  readOwnedInstance,
  toDefinitionView,
  toInstanceView,
  type EquipmentDefinitionView,
  type EquipmentInstanceView,
  type LoadoutView,
} from './equipmentQueries';
import {
  EQUIPMENT_SLOTS,
  EQUIPMENT_SOURCE_TYPES,
  isEquipmentSlot,
  type EquipmentEventKind,
  type EquipmentSlot,
  type EquipmentSourceType,
} from './vocabulary';

/** Most copies one grant call may create. Rewards hand out one or two. */
export const MAX_GRANT_QUANTITY = 5;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_LOADOUT_NAME = 'Default';

// ── Inputs and results ────────────────────────────────────────────────────

/**
 * How a grant decides its copies' rolled properties.
 *
 *  - `random` (the default) — normal loot. Each copy rolls its own multiplier
 *    from the definition's range and its own affix from the catalogue.
 *  - `fixed` — the caller dictates the exact multiplier and affix (or null)
 *    for every copy: onboarding, admin tools, compensation. Validated against
 *    the definition's current range and the catalogue; anything else is
 *    refused with `EquipmentValidationError`, never clamped.
 */
export type EquipmentRollSpec =
  | { kind: 'random' }
  | { kind: 'fixed'; rolledMultiplierBp: number; affixKey: string | null };

export interface GrantEquipmentInput {
  playerId: number;
  definitionKey: string;
  /** 1…{@link MAX_GRANT_QUANTITY}; defaults to 1. */
  quantity?: number;
  source: { type: EquipmentSourceType; key?: string | null };
  /**
   * Idempotency key for this grant. Copy `i` is stored as `${grantKey}:${i}`,
   * so a retry of the same grant with the same key creates nothing new and
   * reads the original instances back. Omit only for grants that are not
   * retryable (a manual admin action).
   */
  grantKey?: string | null;
  actorDiscordId?: string | null;
  /**
   * Grant even though the definition is disabled. Only for paying out a
   * reward that was already won while it was enabled (an expedition resolved
   * before an admin disabled the gear). Never for a fresh roll.
   */
  allowDisabled?: boolean;
  /** Defaults to `{ kind: 'random' }`. */
  roll?: EquipmentRollSpec;
}

export interface GrantEquipmentResult {
  definition: EquipmentDefinitionView;
  /** Every instance this grant covers — newly created or found by grant key. */
  instances: EquipmentInstanceView[];
  newInstanceIds: number[];
  /** True when the grant key had already been applied and nothing was created. */
  alreadyGranted: boolean;
}

/**
 * `acquired` is newest first and `oldest` its reverse; `slot` is slot order
 * (Attack, Defense, Health); `quality` is roll quality, best first
 * (`rollQualityPercent`). Every sort ties on the instance id, so paging is
 * stable.
 */
export type EquipmentSort = 'acquired' | 'oldest' | 'multiplier' | 'rarity' | 'name' | 'slot' | 'quality';
export const EQUIPMENT_SORTS: readonly EquipmentSort[] = [
  'acquired',
  'oldest',
  'multiplier',
  'rarity',
  'name',
  'slot',
  'quality',
];

export interface EquipmentFilters {
  slot?: EquipmentSlot;
  rarity?: string;
  /** Case-insensitive substring of the name or key. */
  q?: string;
  /**
   * Case-insensitive substring of the player-facing display name — base name
   * plus affix suffix, exactly as `equipmentDisplayName` renders it. Never
   * matches a definition or affix key.
   */
  search?: string;
  definitionKey?: string;
  /** Filter on membership of the *active* loadout. */
  equipped?: boolean;
  favorite?: boolean;
  locked?: boolean;
}

export interface ListEquipmentOptions extends EquipmentFilters {
  sort?: EquipmentSort;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  limit?: number;
}

export interface EquipmentPage {
  items: EquipmentInstanceView[];
  nextCursor: string | null;
}

/**
 * Identical owned gear, grouped. Copies group only when everything a player
 * can see about them matches — the definition, the rolled multiplier **and**
 * the affix — so two Rusty Pipes at ×0.40 and ×0.60, or with different
 * suffixes, are separate groups. Per-copy state (favourite, lock, equipped)
 * is counted, never merged.
 */
export interface EquipmentGroup {
  definition: EquipmentDefinitionView;
  /** Shared by every copy in the group. */
  rolledMultiplierBp: number;
  affixKey: string | null;
  displayName: string;
  count: number;
  equippedCount: number;
  favoriteCount: number;
  lockedCount: number;
  /**
   * The copy a "use one of these" action should pick: the oldest unequipped
   * copy when there is one, otherwise the oldest.
   */
  representativeId: number;
  instanceIds: number[];
}

export interface SlotChangeResult {
  changed: boolean;
  previousEquipmentId: number | null;
  loadout: LoadoutView;
}

export interface EquipInput {
  slot: EquipmentSlot;
  equipmentId: number;
  /**
   * What the caller believes the slot holds now (null = empty). When given
   * and wrong, the change is refused with `LoadoutConflictError` rather than
   * silently overwriting something the caller never saw.
   */
  expectedCurrentId?: number | null;
}

export interface UnequipInput {
  slot: EquipmentSlot;
  expectedCurrentId?: number | null;
}

export interface AdminRemoveInput {
  playerId: number;
  equipmentId: number;
  reason: string;
  actorDiscordId: string;
  /** Remove a locked instance anyway. Recorded in the audit row. */
  overrideLock?: boolean;
}

export interface AdminRemoveResult {
  equipmentId: number;
  definitionKey: string;
  /** Loadouts (active or preset) the instance was cleared from. */
  clearedLoadoutIds: number[];
}

/** One instance found by its stored grant key. Removed instances are included. */
export interface GrantKeyRecord {
  /** The stored key (`${grantKey}:${copy}`). */
  grantKey: string;
  equipmentId: number;
  slot: EquipmentSlot;
  sourceType: string;
  definition: EquipmentDefinitionView;
  rolledMultiplierBp: number;
  affixKey: string | null;
  removed: boolean;
}

export type OnboardingEquipSkipReason = 'not_owned' | 'removed' | 'slot_mismatch' | 'not_onboarding';

/** What {@link EquipmentService.equipForOnboarding} did, slot by slot. */
export interface OnboardingEquipResult {
  /** Slots this call filled. */
  equipped: { slot: EquipmentSlot; equipmentId: number }[];
  /** Slots that already held exactly this instance (a replayed completion). */
  alreadyEquipped: { slot: EquipmentSlot; equipmentId: number }[];
  /** Slots that held something else, left exactly as they were. */
  kept: { slot: EquipmentSlot; equipmentId: number }[];
  /** Instances that could not be equipped, and why. Never thrown. */
  skipped: { slot: EquipmentSlot; equipmentId: number; reason: OnboardingEquipSkipReason }[];
}

export interface ReleaseGrantKeysInput {
  playerId: number;
  /** Stored grant keys (`${grantKey}:${copy}`). */
  grantKeys: readonly string[];
  actorDiscordId: string;
  reason: string;
}

/** Most copies one dismantle may destroy. Selection is always explicit. */
export const MAX_DISMANTLE_BATCH = 50;

export interface DismantleInput {
  playerId: number;
  /** Explicit instance ids, as the player selected them. */
  equipmentIds: readonly number[];
  /**
   * Components a copy of this rarity is worth, or null when the rarity cannot
   * be salvaged. The caller's configuration; this service only applies it.
   */
  yieldOf(rarity: string): number | null;
  actorDiscordId?: string | null;
  /** Non-authoritative audit detail copied into every `dismantled` event. */
  metadata?: Record<string, unknown>;
}

/** One copy a dismantle covers, as it was the moment it was checked. */
export interface DismantleCopy {
  equipmentId: number;
  slot: EquipmentSlot;
  definition: EquipmentDefinitionView;
  rolledMultiplierBp: number;
  affixKey: string | null;
  displayName: string;
  components: number;
}

export interface DismantleAssessment {
  /** The copies that could go, in selection order. */
  copies: DismantleCopy[];
  /** Every copy that cannot, and why. Empty means the batch is valid. */
  problems: DismantleProblem[];
  totalComponents: number;
}

export interface DismantleResult {
  copies: DismantleCopy[];
  totalComponents: number;
}

export interface EquipmentService {
  grantEquipment(tx: DbOrTx, input: GrantEquipmentInput): Promise<GrantEquipmentResult>;
  listEquipment(playerId: number, opts?: ListEquipmentOptions): Promise<EquipmentPage>;
  listEquipmentGroups(
    playerId: number,
    opts?: EquipmentFilters & { sort?: EquipmentSort },
  ): Promise<EquipmentGroup[]>;
  /** One owned, unremoved instance, or null. */
  getOwned(playerId: number, equipmentId: number): Promise<EquipmentInstanceView | null>;
  /** Pure read; a virtual empty loadout (`loadoutId: null`) when none exists yet. */
  getActiveLoadout(playerId: number): Promise<LoadoutView>;
  /** Idempotently create the player's active loadout and return it. Write paths only. */
  ensureActiveLoadout(tx: DbOrTx, playerId: number): Promise<PlayerLoadoutRow>;
  equip(playerId: number, input: EquipInput, opts?: { actorDiscordId?: string | null }): Promise<SlotChangeResult>;
  unequip(playerId: number, input: UnequipInput, opts?: { actorDiscordId?: string | null }): Promise<SlotChangeResult>;
  setFlags(
    playerId: number,
    equipmentId: number,
    flags: { isFavorite?: boolean; isLocked?: boolean },
  ): Promise<EquipmentInstanceView>;
  adminRemove(tx: DbOrTx, input: AdminRemoveInput): Promise<AdminRemoveResult>;
  /**
   * Whether a dismantle of exactly these copies would go through, and what it
   * would pay — a pure read, no locks. The same checks
   * {@link EquipmentService.dismantle} repeats under its locks.
   */
  assessDismantle(tx: DbOrTx, input: DismantleInput): Promise<DismantleAssessment>;
  /**
   * Player dismantling (Patch's Workshop): soft-remove every selected copy and
   * record a `dismantled` event for each — **all or nothing**. Requires the
   * `equipment` unlock. Refuses the whole batch with
   * `EquipmentDismantleRefusedError` if any copy is missing / foreign /
   * removed, selected twice, equipped in any loadout, favourite, locked, or of
   * a rarity `yieldOf` cannot value. There is no override: admin removal is
   * {@link EquipmentService.adminRemove}.
   *
   * Pays nothing itself — the caller credits `totalComponents` in the same
   * transaction. Locks loadouts, then instances, like every other path.
   */
  dismantle(tx: DbOrTx, input: DismantleInput): Promise<DismantleResult>;
  /**
   * The player's instances carrying any of these stored grant keys, removed
   * ones included, keyed by grant key. A pure read through `tx`. Lets a
   * scripted flow recover the exact copies it granted.
   */
  findByGrantKeys(tx: DbOrTx, playerId: number, grantKeys: readonly string[]): Promise<Map<string, GrantKeyRecord>>;
  /**
   * The Equipment onboarding's scripted equip, and the only equip that runs
   * inside a caller's transaction. Normal rewards never equip; this exists so
   * the onboarding can put its three starters on in the same transaction that
   * unlocks the feature. Callable only from `modules/onboarding`
   * (`equipmentBoundary.test.ts`).
   *
   *  - Requires the `equipment` unlock to be visible through `tx` — the
   *    caller unlocks first, in the same transaction.
   *  - Accepts only owned, unremoved instances granted by the onboarding
   *    (`source_type = 'onboarding'`) in their own slot; anything else is
   *    reported as skipped, never thrown.
   *  - Fills **empty** slots only. An occupied slot is never overwritten.
   *  - Idempotent: a replay reports every slot as already equipped or kept.
   */
  equipForOnboarding(
    tx: DbOrTx,
    playerId: number,
    items: Partial<Record<EquipmentSlot, number>>,
  ): Promise<OnboardingEquipResult>;
  /**
   * Staging reset only: clear the grant key from this player's **already
   * removed** instances, so a fixed-key grant can create a fresh copy. Never
   * touches a live instance. Audited. Callable only from `modules/testControls`.
   */
  adminReleaseGrantKeys(tx: DbOrTx, input: ReleaseGrantKeysInput): Promise<{ released: { equipmentId: number; grantKey: string }[] }>;
}

export interface EquipmentServiceDeps {
  db: Db;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
  /** The affix catalogue, read live so a content reload is followed. */
  getAffixes(): EquipmentAffixCatalogue;
  /** The RNG random grants roll with. Injected by tests; `Math.random` otherwise. */
  rng?: Rng;
}

// ── Sorting and cursors ───────────────────────────────────────────────────

/** The instance's rolled multiplier — the only multiplier there is to sort by. */
const OWN_MULTIPLIER_SQL = sql<number>`${playerEquipment.rolledMultiplierBp}`;

/** Rarity ladder position, as SQL — N lowest, EX highest. */
const RARITY_RANK_SQL = sql<number>`(case ${equipmentDefinitions.rarity} ${sql.raw(
  RARITIES.map((r, i) => `when '${r}' then ${i}`).join(' '),
)} else -1 end)`;

interface SortSpec {
  /** Primary key expression; `null` means the instance id alone. */
  expr: SQL | null;
  direction: 'asc' | 'desc';
  cast: 'int' | 'text';
  valueOf(row: { instance: PlayerEquipmentRow; definition: EquipmentDefinitionRow }): number | string;
}

/** Slot order, as SQL — Attack, Defense, Health. */
const SLOT_RANK_SQL = sql<number>`(case ${playerEquipment.slot} ${sql.raw(
  EQUIPMENT_SLOTS.map((slot, i) => `when '${slot}' then ${i}`).join(' '),
)} else -1 end)`;

/**
 * Roll quality in basis points of the range (0–10000), as SQL — the same
 * formula as `rollQualityPercent`, at finer resolution and in integers so a
 * keyset cursor compares exactly. A single-value range is the top; a roll a
 * retune left outside the range is clamped.
 */
const ROLL_QUALITY_SQL = sql<number>`(case when ${equipmentDefinitions.multiplierMaxBp} <= ${equipmentDefinitions.multiplierMinBp} then 10000 else greatest(0, least(10000, ((${playerEquipment.rolledMultiplierBp} - ${equipmentDefinitions.multiplierMinBp}) * 10000) / (${equipmentDefinitions.multiplierMaxBp} - ${equipmentDefinitions.multiplierMinBp}))) end)`;

function rollQualityBp(r: { instance: PlayerEquipmentRow; definition: EquipmentDefinitionRow }): number {
  const { multiplierMinBp: min, multiplierMaxBp: max } = r.definition;
  if (max <= min) return 10_000;
  // Postgres integer division truncates toward zero; so does Math.trunc.
  return Math.max(0, Math.min(10_000, Math.trunc(((r.instance.rolledMultiplierBp - min) * 10_000) / (max - min))));
}

const SORTS: Record<EquipmentSort, SortSpec> = {
  // Newest first. The identity id *is* acquisition order, and unlike
  // `acquired_at` it has no sub-millisecond precision for a JS Date to lose
  // inside a cursor.
  acquired: { expr: null, direction: 'desc', cast: 'int', valueOf: (r) => r.instance.id },
  oldest: { expr: null, direction: 'asc', cast: 'int', valueOf: (r) => r.instance.id },
  slot: {
    expr: SLOT_RANK_SQL,
    direction: 'asc',
    cast: 'int',
    valueOf: (r) => (EQUIPMENT_SLOTS as readonly string[]).indexOf(r.instance.slot),
  },
  quality: { expr: ROLL_QUALITY_SQL, direction: 'desc', cast: 'int', valueOf: rollQualityBp },
  multiplier: {
    expr: OWN_MULTIPLIER_SQL,
    direction: 'desc',
    cast: 'int',
    valueOf: (r) => r.instance.rolledMultiplierBp,
  },
  rarity: {
    expr: RARITY_RANK_SQL,
    direction: 'desc',
    cast: 'int',
    valueOf: (r) => (RARITIES as readonly string[]).indexOf(r.definition.rarity),
  },
  name: {
    expr: sql`lower(${equipmentDefinitions.name})`,
    direction: 'asc',
    cast: 'text',
    valueOf: (r) => r.definition.name.toLowerCase(),
  },
};

interface CursorPayload {
  s: EquipmentSort;
  v: number | string;
  id: number;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, sort: EquipmentSort): CursorPayload {
  const invalid = () => new EquipmentValidationError([{ path: 'cursor', message: 'invalid cursor' }]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const p = parsed as Partial<CursorPayload> | null;
  if (
    !p ||
    p.s !== sort ||
    !Number.isInteger(p.id) ||
    (typeof p.v !== 'number' && typeof p.v !== 'string')
  ) {
    throw invalid();
  }
  return p as CursorPayload;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function assertSlot(slot: unknown): asserts slot is EquipmentSlot {
  if (!isEquipmentSlot(slot)) {
    throw new EquipmentValidationError([{ path: 'slot', message: `unknown slot "${String(slot)}"` }]);
  }
}

// ── Service ───────────────────────────────────────────────────────────────

export function createEquipmentService(deps: EquipmentServiceDeps): EquipmentService {
  const { db, featureUnlocks } = deps;
  const rng = deps.rng ?? defaultRng();

  async function requireUnlocked(tx: DbOrTx, playerId: number): Promise<void> {
    if (!(await featureUnlocks.isUnlocked(playerId, 'equipment', tx))) {
      throw new FeatureLockedError('equipment');
    }
  }

  async function writeEvent(
    tx: DbOrTx,
    event: {
      playerId: number;
      kind: EquipmentEventKind;
      equipmentId?: number | null;
      loadoutId?: number | null;
      slot?: EquipmentSlot | null;
      previousEquipmentId?: number | null;
      actorDiscordId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(equipmentEvents).values({
      playerId: event.playerId,
      kind: event.kind,
      equipmentId: event.equipmentId ?? null,
      loadoutId: event.loadoutId ?? null,
      slot: event.slot ?? null,
      previousEquipmentId: event.previousEquipmentId ?? null,
      actorDiscordId: event.actorDiscordId ?? null,
      metadata: event.metadata ?? {},
    });
  }

  async function ensureActiveLoadout(tx: DbOrTx, playerId: number): Promise<PlayerLoadoutRow> {
    // No conflict target: the partial "one active per player" index is the one
    // that fires in V1. A concurrent creator waits on it and then does nothing.
    await tx
      .insert(playerLoadouts)
      .values({ playerId, name: DEFAULT_LOADOUT_NAME, isActive: true })
      .onConflictDoNothing();
    const row = await readActiveLoadoutRow(tx, playerId);
    if (!row) {
      // Only reachable once presets exist: an inactive loadout already holds
      // the default name and nothing is active. Presets must activate one.
      throw new Error(`player ${playerId} has no active loadout and the default name is taken`);
    }
    return row;
  }

  /** Ensure, then lock, the active loadout — the per-player equip mutex. */
  async function lockActiveLoadout(tx: DbOrTx, playerId: number): Promise<PlayerLoadoutRow> {
    const ensured = await ensureActiveLoadout(tx, playerId);
    const [locked] = await tx
      .select()
      .from(playerLoadouts)
      .where(and(eq(playerLoadouts.id, ensured.id), eq(playerLoadouts.isActive, true)))
      .for('update');
    if (!locked) throw new Error(`active loadout ${ensured.id} vanished while locking`);
    return locked;
  }

  async function currentSlotEquipmentId(
    tx: DbOrTx,
    loadoutId: number,
    slot: EquipmentSlot,
  ): Promise<number | null> {
    const [row] = await tx
      .select({ equipmentId: playerLoadoutSlots.equipmentId })
      .from(playerLoadoutSlots)
      .where(and(eq(playerLoadoutSlots.loadoutId, loadoutId), eq(playerLoadoutSlots.slot, slot)));
    return row?.equipmentId ?? null;
  }

  /**
   * The display name as SQL: `equipmentDisplayName`, evaluated per row. The
   * affix catalogue is deployed content rather than a table, so its suffixes
   * travel as bound parameters of a CASE — keys never reach the comparison,
   * only the text a player sees.
   */
  function displayNameSql(): SQL {
    const affixes = deps.getAffixes().all();
    const suffix =
      affixes.length === 0
        ? sql`${UNKNOWN_AFFIX_LABEL}::text`
        : sql`(case ${playerEquipment.affixKey} ${sql.join(
            affixes.map((a) => sql`when ${a.key}::text then ${a.suffix}::text`),
            sql` `,
          )} else ${UNKNOWN_AFFIX_LABEL}::text end)`;
    return sql`(case when ${playerEquipment.affixKey} is null then ${equipmentDefinitions.name} else ${equipmentDefinitions.name} || ' ' || ${suffix} end)`;
  }

  function filterConditions(
    playerId: number,
    filters: EquipmentFilters,
    activeLoadoutId: number | null,
  ): SQL[] {
    const conditions: SQL[] = [eq(playerEquipment.playerId, playerId), isNull(playerEquipment.removedAt)];
    if (filters.slot !== undefined) {
      assertSlot(filters.slot);
      conditions.push(eq(playerEquipment.slot, filters.slot));
    }
    if (filters.rarity !== undefined) conditions.push(eq(equipmentDefinitions.rarity, filters.rarity));
    if (filters.definitionKey !== undefined) {
      conditions.push(eq(equipmentDefinitions.key, filters.definitionKey));
    }
    if (filters.favorite !== undefined) conditions.push(eq(playerEquipment.isFavorite, filters.favorite));
    if (filters.locked !== undefined) conditions.push(eq(playerEquipment.isLocked, filters.locked));
    const search = filters.search?.trim();
    if (search) conditions.push(ilike(displayNameSql(), `%${escapeLike(search)}%`));
    const q = filters.q?.trim();
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      conditions.push(
        or(ilike(equipmentDefinitions.name, pattern), ilike(equipmentDefinitions.key, pattern))!,
      );
    }
    if (filters.equipped !== undefined) {
      if (activeLoadoutId == null) {
        // Nothing can be equipped without a loadout.
        if (filters.equipped) conditions.push(sql`false`);
      } else {
        conditions.push(
          filters.equipped ? isNotNull(playerLoadoutSlots.equipmentId) : isNull(playerLoadoutSlots.equipmentId),
        );
      }
    }
    return conditions;
  }

  /** Left join onto the active loadout's slots, so `equipped` is one column. */
  function activeSlotJoin(activeLoadoutId: number | null): SQL {
    return activeLoadoutId == null
      ? sql`false`
      : and(
          eq(playerLoadoutSlots.equipmentId, playerEquipment.id),
          eq(playerLoadoutSlots.loadoutId, activeLoadoutId),
        )!;
  }

  /**
   * Each copy's rolled properties, decided once per grant. Random copies roll
   * independently; fixed copies all get the validated, dictated roll.
   */
  function rollCopies(
    definition: EquipmentDefinitionRow,
    spec: EquipmentRollSpec | undefined,
    quantity: number,
  ): EquipmentRoll[] {
    const affixes = deps.getAffixes();
    const kind: unknown = spec?.kind ?? 'random';
    if (kind === 'random') {
      // A definition that reached the table another way with a range
      // validation would reject is refused, not rolled from. An empty or
      // unsupported affix pool throws `EquipmentAffixPoolEmptyError` from the
      // roll itself — never an unaffixed item, never another pool.
      const issues = multiplierRangeIssues(definition.slot, definition);
      if (issues.length > 0) throw new EquipmentValidationError(issues);
      return Array.from({ length: quantity }, () => rollEquipmentInstance(definition, { rng, affixes }));
    }
    if (kind !== 'fixed') {
      throw new EquipmentValidationError([{ path: 'roll.kind', message: `unknown roll kind "${String(kind)}"` }]);
    }
    const { kind: _kind, ...fixed } = spec as Extract<EquipmentRollSpec, { kind: 'fixed' }>;
    const issues = validateFixedRoll(definition, fixed, affixes);
    if (issues.length > 0) throw new EquipmentValidationError(issues);
    return Array.from({ length: quantity }, () => ({
      rolledMultiplierBp: fixed.rolledMultiplierBp,
      affixKey: fixed.affixKey,
    }));
  }

  function listEquipmentGroupsImpl(
    playerId: number,
    opts: EquipmentFilters & { sort?: EquipmentSort } = {},
  ): Promise<EquipmentGroup[]> {
    return (async () => {
      const active = await readActiveLoadoutRow(db, playerId);
      const activeLoadoutId = active?.id ?? null;
      const rows = await db
        .select({
          definition: equipmentDefinitions,
          rolledMultiplierBp: playerEquipment.rolledMultiplierBp,
          affixKey: playerEquipment.affixKey,
          count: sql<number>`count(*)::int`,
          equippedCount: sql<number>`count(${playerLoadoutSlots.equipmentId})::int`,
          favoriteCount: sql<number>`count(*) filter (where ${playerEquipment.isFavorite})::int`,
          lockedCount: sql<number>`count(*) filter (where ${playerEquipment.isLocked})::int`,
          firstUnequipped: sql<number | null>`min(${playerEquipment.id}) filter (where ${playerLoadoutSlots.equipmentId} is null)`,
          firstAny: sql<number>`min(${playerEquipment.id})`,
          newest: sql<number>`max(${playerEquipment.id})`,
          instanceIds: sql<number[]>`array_agg(${playerEquipment.id} order by ${playerEquipment.id})`,
        })
        .from(playerEquipment)
        .innerJoin(equipmentDefinitions, eq(playerEquipment.definitionId, equipmentDefinitions.id))
        .leftJoin(playerLoadoutSlots, activeSlotJoin(activeLoadoutId))
        .where(and(...filterConditions(playerId, opts, activeLoadoutId)))
        // Everything a player can see about a copy, so materially different
        // loot never collapses into one line.
        .groupBy(equipmentDefinitions.id, playerEquipment.rolledMultiplierBp, playerEquipment.affixKey);

      const affixes = deps.getAffixes();
      const groups: (EquipmentGroup & { newest: number })[] = rows.map((r) => ({
        definition: toDefinitionView(r.definition),
        rolledMultiplierBp: r.rolledMultiplierBp,
        affixKey: r.affixKey,
        displayName: equipmentDisplayName(r.definition.name, r.affixKey, affixes),
        count: r.count,
        equippedCount: r.equippedCount,
        favoriteCount: r.favoriteCount,
        lockedCount: r.lockedCount,
        representativeId: Number(r.firstUnequipped ?? r.firstAny),
        instanceIds: (r.instanceIds ?? []).map(Number),
        newest: Number(r.newest),
      }));
      const rank = (g: EquipmentGroup) => (RARITIES as readonly string[]).indexOf(g.definition.rarity);
      // Key, then roll, then affix: a total order over group identity, so
      // ties in the chosen sort never shuffle between reads.
      const identity = (a: EquipmentGroup, b: EquipmentGroup) =>
        a.definition.key.localeCompare(b.definition.key) ||
        b.rolledMultiplierBp - a.rolledMultiplierBp ||
        (a.affixKey ?? '').localeCompare(b.affixKey ?? '');
      const sort = opts.sort ?? 'multiplier';
      groups.sort((a, b) => {
        switch (sort) {
          case 'acquired':
            return b.newest - a.newest;
          case 'rarity':
            return rank(b) - rank(a) || identity(a, b);
          case 'name':
            return a.displayName.localeCompare(b.displayName) || identity(a, b);
          case 'multiplier':
          default:
            return b.rolledMultiplierBp - a.rolledMultiplierBp || identity(a, b);
        }
      });
      return groups.map(({ newest: _newest, ...group }) => group);
    })();
  }

  function validateSelection(ids: readonly number[]): void {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new EquipmentDismantleSelectionError('Select at least one item to dismantle.');
    }
    if (ids.length > MAX_DISMANTLE_BATCH) {
      throw new EquipmentDismantleSelectionError(`Dismantle at most ${MAX_DISMANTLE_BATCH} items at a time.`);
    }
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new EquipmentDismantleSelectionError('That selection is not valid.');
    }
  }

  /**
   * The checks behind both `assessDismantle` and `dismantle`. With `lock`, the
   * player's loadouts and then the selected instances are locked `FOR UPDATE`
   * first — the equip / admin-removal order — so a concurrent equip, flag
   * change or second dismantle waits, and this sees what it will change.
   */
  async function assess(tx: DbOrTx, input: DismantleInput, lock: boolean): Promise<DismantleAssessment> {
    validateSelection(input.equipmentIds);
    const ids = [...input.equipmentIds];
    const unique = [...new Set(ids)];
    if (lock) {
      await tx
        .select({ id: playerLoadouts.id })
        .from(playerLoadouts)
        .where(eq(playerLoadouts.playerId, input.playerId))
        .orderBy(asc(playerLoadouts.id))
        .for('update');
    }
    const query = tx
      .select({ instance: playerEquipment, definition: equipmentDefinitions })
      .from(playerEquipment)
      .innerJoin(equipmentDefinitions, eq(playerEquipment.definitionId, equipmentDefinitions.id))
      .where(
        and(
          inArray(playerEquipment.id, unique),
          eq(playerEquipment.playerId, input.playerId),
          isNull(playerEquipment.removedAt),
        ),
      )
      .orderBy(asc(playerEquipment.id));
    const rows = lock ? await query.for('update', { of: playerEquipment }) : await query;
    const slotted = await tx
      .select({ equipmentId: playerLoadoutSlots.equipmentId })
      .from(playerLoadoutSlots)
      .where(and(eq(playerLoadoutSlots.playerId, input.playerId), inArray(playerLoadoutSlots.equipmentId, unique)));
    const equipped = new Set(slotted.map((r) => r.equipmentId));
    const byId = new Map(rows.map((r) => [r.instance.id, r]));

    const problems: DismantleProblem[] = [];
    const copies: DismantleCopy[] = [];
    const seen = new Set<number>();
    const affixes = deps.getAffixes();
    for (const id of ids) {
      if (seen.has(id)) {
        problems.push({ equipmentId: id, reason: 'duplicate' });
        continue;
      }
      seen.add(id);
      const row = byId.get(id);
      if (!row) {
        problems.push({ equipmentId: id, reason: 'not_owned' });
        continue;
      }
      // Protection first, so the player is told the flag they can change.
      if (equipped.has(id)) problems.push({ equipmentId: id, reason: 'equipped' });
      else if (row.instance.isFavorite) problems.push({ equipmentId: id, reason: 'favorite' });
      else if (row.instance.isLocked) problems.push({ equipmentId: id, reason: 'locked' });
      else {
        const components = input.yieldOf(row.definition.rarity);
        if (components == null || !Number.isInteger(components) || components <= 0) {
          problems.push({ equipmentId: id, reason: 'unsupported_rarity' });
        } else {
          copies.push({
            equipmentId: id,
            slot: row.instance.slot as EquipmentSlot,
            definition: toDefinitionView(row.definition),
            rolledMultiplierBp: row.instance.rolledMultiplierBp,
            affixKey: row.instance.affixKey,
            displayName: equipmentDisplayName(row.definition.name, row.instance.affixKey, affixes),
            components,
          });
        }
      }
    }
    return { copies, problems, totalComponents: copies.reduce((sum, c) => sum + c.components, 0) };
  }

  const methods: EquipmentService = {
    async grantEquipment(tx, input) {
      const quantity = input.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_GRANT_QUANTITY) {
        throw new RangeError(`Equipment grant quantity must be 1–${MAX_GRANT_QUANTITY}, got ${quantity}`);
      }
      if (!(EQUIPMENT_SOURCE_TYPES as readonly string[]).includes(input.source?.type)) {
        throw new RangeError(`Unknown equipment source type "${String(input.source?.type)}"`);
      }
      const grantKey = input.grantKey ?? null;
      if (grantKey !== null && grantKey.trim() === '') {
        throw new RangeError('grantKey must not be blank');
      }

      // FOR SHARE: a concurrent definition update (which takes FOR UPDATE)
      // cannot change the slot underneath the copy we are about to make.
      const [definition] = await tx
        .select()
        .from(equipmentDefinitions)
        .where(eq(equipmentDefinitions.key, input.definitionKey))
        .for('share');
      if (!definition) throw new EquipmentDefinitionNotFoundError(input.definitionKey);
      if (!definition.enabled && !input.allowDisabled) {
        throw new EquipmentDefinitionDisabledError(input.definitionKey);
      }

      const copyKeys = grantKey === null ? null : Array.from({ length: quantity }, (_, i) => `${grantKey}:${i}`);

      let rolls: EquipmentRoll[];
      try {
        rolls = rollCopies(definition, input.roll, quantity);
      } catch (err) {
        // A retry must return what the grant created the first time, even if
        // the definition's range has since moved and the dictated roll no
        // longer fits it. Only a complete replay is let through: if any copy
        // is still missing, the refusal stands and nothing is created.
        if (!(err instanceof EquipmentValidationError) || copyKeys === null) throw err;
        const existing = await tx.select().from(playerEquipment).where(inArray(playerEquipment.grantKey, copyKeys));
        if (existing.length < quantity) throw err;
        // Placeholders only: every insert below conflicts and is discarded.
        rolls = existing.map((row) => ({ rolledMultiplierBp: row.rolledMultiplierBp, affixKey: row.affixKey }));
      }
      // On a retry the insert below conflicts and these freshly rolled values
      // are discarded: the copies read back carry the roll they were first
      // granted with. A grant key therefore pins the roll, not just the count.
      const values = Array.from({ length: quantity }, (_, i) => ({
        playerId: input.playerId,
        definitionId: definition.id,
        slot: definition.slot,
        rolledMultiplierBp: rolls[i]!.rolledMultiplierBp,
        affixKey: rolls[i]!.affixKey,
        sourceType: input.source.type,
        sourceKey: input.source.key ?? null,
        grantKey: copyKeys?.[i] ?? null,
        grantedBy: input.actorDiscordId ?? null,
      }));

      const inserted =
        copyKeys === null
          ? await tx.insert(playerEquipment).values(values).returning()
          : await tx
              .insert(playerEquipment)
              .values(values)
              .onConflictDoNothing({
                target: playerEquipment.grantKey,
                where: sql`grant_key is not null`,
              })
              .returning();

      let covered = inserted;
      if (copyKeys !== null && inserted.length < quantity) {
        // Some or all copies already existed: this grant (or a racing twin)
        // ran before. Read every copy the key covers back, and make sure the
        // key really did name *this* grant rather than colliding with another.
        covered = await tx
          .select()
          .from(playerEquipment)
          .where(inArray(playerEquipment.grantKey, copyKeys))
          .orderBy(asc(playerEquipment.id));
        for (const row of covered) {
          if (row.playerId !== input.playerId || row.definitionId !== definition.id) {
            throw new Error(
              `grant key "${row.grantKey}" was already used for a different player or definition`,
            );
          }
        }
      }

      for (const row of inserted) {
        await writeEvent(tx, {
          playerId: input.playerId,
          kind: 'granted',
          equipmentId: row.id,
          slot: row.slot as EquipmentSlot,
          actorDiscordId: input.actorDiscordId ?? null,
          // Observability only — the row is the authoritative roll.
          metadata: {
            definitionKey: definition.key,
            rolledMultiplierBp: row.rolledMultiplierBp,
            affixKey: row.affixKey,
            rollKind: input.roll?.kind ?? 'random',
            sourceType: input.source.type,
            sourceKey: input.source.key ?? null,
            grantKey: row.grantKey,
          },
        });
      }

      // A freshly granted instance is never equipped — rewards never equip.
      // A replayed grant reads the same way: whatever the player did with the
      // copies since is a question for `listEquipment`, not for a payout.
      return {
        definition: toDefinitionView(definition),
        instances: covered.map((row) => toInstanceView(row, definition, false, deps.getAffixes())),
        newInstanceIds: inserted.map((row) => row.id),
        alreadyGranted: inserted.length === 0,
      };
    },

    async listEquipment(playerId, opts = {}) {
      const sort = opts.sort ?? 'acquired';
      // Own keys only: a client-supplied `constructor` is not a sort.
      const spec = Object.hasOwn(SORTS, sort) ? SORTS[sort] : undefined;
      if (!spec) throw new EquipmentValidationError([{ path: 'sort', message: `unknown sort "${String(sort)}"` }]);
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);

      const active = await readActiveLoadoutRow(db, playerId);
      const activeLoadoutId = active?.id ?? null;
      const conditions = filterConditions(playerId, opts, activeLoadoutId);

      if (opts.cursor) {
        const cursor = decodeCursor(opts.cursor, sort);
        const op = sql.raw(spec.direction === 'desc' ? '<' : '>');
        if (spec.expr === null) {
          conditions.push(sql`${playerEquipment.id} ${op} ${cursor.id}`);
        } else {
          const value = sql`${cursor.v}::${sql.raw(spec.cast)}`;
          conditions.push(sql`(${spec.expr}, ${playerEquipment.id}) ${op} (${value}, ${cursor.id}::bigint)`);
        }
      }

      const order = spec.direction === 'desc' ? desc : asc;
      const orderBy = spec.expr === null
        ? [order(playerEquipment.id)]
        : [order(spec.expr), order(playerEquipment.id)];

      const rows = await db
        .select({
          instance: playerEquipment,
          definition: equipmentDefinitions,
          equippedId: playerLoadoutSlots.equipmentId,
        })
        .from(playerEquipment)
        .innerJoin(equipmentDefinitions, eq(playerEquipment.definitionId, equipmentDefinitions.id))
        .leftJoin(playerLoadoutSlots, activeSlotJoin(activeLoadoutId))
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => toInstanceView(r.instance, r.definition, r.equippedId != null, deps.getAffixes())),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ s: sort, v: spec.valueOf(last), id: last.instance.id })
            : null,
      };
    },

    listEquipmentGroups: listEquipmentGroupsImpl,

    async getOwned(playerId, equipmentId) {
      const owned = await readOwnedInstance(db, playerId, equipmentId);
      if (!owned) return null;
      const active = await readActiveLoadoutRow(db, playerId);
      const equipped =
        active != null &&
        (await currentSlotEquipmentId(db, active.id, owned.instance.slot as EquipmentSlot)) ===
          owned.instance.id;
      return toInstanceView(owned.instance, owned.definition, equipped, deps.getAffixes());
    },

    async getActiveLoadout(playerId) {
      return readActiveLoadoutView(db, playerId, deps.getAffixes());
    },

    ensureActiveLoadout,

    async equip(playerId, input, opts = {}) {
      assertSlot(input.slot);
      return db.transaction(async (tx) => {
        await requireUnlocked(tx, playerId);
        const loadout = await lockActiveLoadout(tx, playerId);
        const owned = await readOwnedInstance(tx, playerId, input.equipmentId, { lock: 'share' });
        if (!owned) throw new EquipmentNotOwnedError(input.equipmentId);
        if (owned.instance.slot !== input.slot) {
          throw new EquipmentSlotMismatchError(input.equipmentId, input.slot, owned.instance.slot);
        }
        // Deliberately no `definition.enabled` check: disabled gear stops
        // dropping, it does not stop working.

        const currentId = await currentSlotEquipmentId(tx, loadout.id, input.slot);
        if (input.expectedCurrentId !== undefined && input.expectedCurrentId !== currentId) {
          throw new LoadoutConflictError(input.slot);
        }
        if (currentId === input.equipmentId) {
          return { changed: false, previousEquipmentId: currentId, loadout: await readActiveLoadoutView(tx, playerId, deps.getAffixes()) };
        }

        await tx
          .insert(playerLoadoutSlots)
          .values({ loadoutId: loadout.id, playerId, slot: input.slot, equipmentId: input.equipmentId })
          .onConflictDoUpdate({
            target: [playerLoadoutSlots.loadoutId, playerLoadoutSlots.slot],
            set: { equipmentId: input.equipmentId, equippedAt: sql`now()` },
          });
        await tx.update(playerLoadouts).set({ updatedAt: sql`now()` }).where(eq(playerLoadouts.id, loadout.id));
        await writeEvent(tx, {
          playerId,
          kind: 'equipped',
          equipmentId: input.equipmentId,
          loadoutId: loadout.id,
          slot: input.slot,
          previousEquipmentId: currentId,
          actorDiscordId: opts.actorDiscordId ?? null,
          metadata: { definitionKey: owned.definition.key, rolledMultiplierBp: owned.instance.rolledMultiplierBp },
        });
        return { changed: true, previousEquipmentId: currentId, loadout: await readActiveLoadoutView(tx, playerId, deps.getAffixes()) };
      });
    },

    async unequip(playerId, input, opts = {}) {
      assertSlot(input.slot);
      return db.transaction(async (tx) => {
        await requireUnlocked(tx, playerId);
        const loadout = await lockActiveLoadout(tx, playerId);
        const currentId = await currentSlotEquipmentId(tx, loadout.id, input.slot);
        if (input.expectedCurrentId !== undefined && input.expectedCurrentId !== currentId) {
          throw new LoadoutConflictError(input.slot);
        }
        if (currentId === null) {
          return { changed: false, previousEquipmentId: null, loadout: await readActiveLoadoutView(tx, playerId, deps.getAffixes()) };
        }
        await tx
          .delete(playerLoadoutSlots)
          .where(and(eq(playerLoadoutSlots.loadoutId, loadout.id), eq(playerLoadoutSlots.slot, input.slot)));
        await tx.update(playerLoadouts).set({ updatedAt: sql`now()` }).where(eq(playerLoadouts.id, loadout.id));
        await writeEvent(tx, {
          playerId,
          kind: 'unequipped',
          equipmentId: currentId,
          loadoutId: loadout.id,
          slot: input.slot,
          previousEquipmentId: currentId,
          actorDiscordId: opts.actorDiscordId ?? null,
        });
        return { changed: true, previousEquipmentId: currentId, loadout: await readActiveLoadoutView(tx, playerId, deps.getAffixes()) };
      });
    },

    async setFlags(playerId, equipmentId, flags) {
      if (flags.isFavorite === undefined && flags.isLocked === undefined) {
        throw new EquipmentValidationError([{ path: '', message: 'nothing to change' }]);
      }
      return db.transaction(async (tx) => {
        await requireUnlocked(tx, playerId);
        const owned = await readOwnedInstance(tx, playerId, equipmentId, { lock: 'update' });
        if (!owned) throw new EquipmentNotOwnedError(equipmentId);
        const before = { isFavorite: owned.instance.isFavorite, isLocked: owned.instance.isLocked };
        const after = {
          isFavorite: flags.isFavorite ?? before.isFavorite,
          isLocked: flags.isLocked ?? before.isLocked,
        };
        const [updated] = await tx
          .update(playerEquipment)
          .set({ ...after, updatedAt: sql`now()` })
          .where(eq(playerEquipment.id, equipmentId))
          .returning();
        if (before.isFavorite !== after.isFavorite || before.isLocked !== after.isLocked) {
          await writeEvent(tx, {
            playerId,
            kind: 'flag_changed',
            equipmentId,
            slot: owned.instance.slot as EquipmentSlot,
            metadata: { before, after },
          });
        }
        const active = await readActiveLoadoutRow(tx, playerId);
        const equipped =
          active != null &&
          (await currentSlotEquipmentId(tx, active.id, owned.instance.slot as EquipmentSlot)) === equipmentId;
        return toInstanceView(updated!, owned.definition, equipped, deps.getAffixes());
      });
    },

    async adminRemove(tx, input) {
      if (!input.actorDiscordId) throw new RangeError('An equipment removal must name the acting admin');
      if (!input.reason?.trim()) throw new RangeError('An equipment removal must give a reason');

      // Loadouts first — every one the player has, active or preset — so this
      // serialises against equip exactly as equip serialises against it.
      await tx
        .select({ id: playerLoadouts.id })
        .from(playerLoadouts)
        .where(eq(playerLoadouts.playerId, input.playerId))
        .orderBy(asc(playerLoadouts.id))
        .for('update');
      const owned = await readOwnedInstance(tx, input.playerId, input.equipmentId, { lock: 'update' });
      if (!owned) throw new EquipmentNotOwnedError(input.equipmentId);
      if (owned.instance.isLocked && !input.overrideLock) throw new EquipmentLockedError(input.equipmentId);

      const cleared = await tx
        .delete(playerLoadoutSlots)
        .where(
          and(
            eq(playerLoadoutSlots.equipmentId, input.equipmentId),
            eq(playerLoadoutSlots.playerId, input.playerId),
          ),
        )
        .returning({ loadoutId: playerLoadoutSlots.loadoutId });
      const reason = input.reason.trim();
      await tx
        .update(playerEquipment)
        .set({ removedAt: sql`now()`, removedReason: reason, updatedAt: sql`now()` })
        .where(eq(playerEquipment.id, input.equipmentId));

      const clearedLoadoutIds = cleared.map((c) => c.loadoutId).sort((a, b) => a - b);
      await writeEvent(tx, {
        playerId: input.playerId,
        kind: 'removed',
        equipmentId: input.equipmentId,
        slot: owned.instance.slot as EquipmentSlot,
        actorDiscordId: input.actorDiscordId,
        metadata: {
          reason,
          definitionKey: owned.definition.key,
          wasLocked: owned.instance.isLocked,
          overrideLock: input.overrideLock === true,
          clearedLoadoutIds,
        },
      });
      await recordDomainAdminAction(tx, {
        playerId: input.playerId,
        action: 'remove_equipment',
        adminDiscordId: input.actorDiscordId,
        before: { equipmentId: input.equipmentId, removed: false, equippedIn: clearedLoadoutIds },
        after: { equipmentId: input.equipmentId, removed: true, equippedIn: [] },
        detail: {
          reason,
          definitionKey: owned.definition.key,
          wasLocked: owned.instance.isLocked,
          overrideLock: input.overrideLock === true,
        },
      });

      return { equipmentId: input.equipmentId, definitionKey: owned.definition.key, clearedLoadoutIds };
    },

    async assessDismantle(tx, input) {
      return assess(tx, input, false);
    },

    async dismantle(tx, input) {
      await requireUnlocked(tx, input.playerId);
      const { copies, problems, totalComponents } = await assess(tx, input, true);
      if (problems.length > 0) throw new EquipmentDismantleRefusedError(problems);

      const ids = copies.map((c) => c.equipmentId);
      // Conditional on still being live and unprotected: the rows are locked,
      // so this can only fall short if a caller bypassed the lock — and then
      // nothing is half-destroyed, because the whole call throws.
      const removed = await tx
        .update(playerEquipment)
        .set({ removedAt: sql`now()`, removedReason: 'dismantled', updatedAt: sql`now()` })
        .where(
          and(
            inArray(playerEquipment.id, ids),
            eq(playerEquipment.playerId, input.playerId),
            isNull(playerEquipment.removedAt),
            eq(playerEquipment.isFavorite, false),
            eq(playerEquipment.isLocked, false),
          ),
        )
        .returning({ id: playerEquipment.id });
      if (removed.length !== ids.length) {
        throw new Error(`dismantle of ${ids.length} copies removed ${removed.length}; refusing a partial batch`);
      }
      for (const copy of copies) {
        await writeEvent(tx, {
          playerId: input.playerId,
          kind: 'dismantled',
          equipmentId: copy.equipmentId,
          slot: copy.slot,
          actorDiscordId: input.actorDiscordId ?? null,
          // Observability only.
          metadata: {
            ...(input.metadata ?? {}),
            definitionKey: copy.definition.key,
            rarity: copy.definition.rarity,
            rolledMultiplierBp: copy.rolledMultiplierBp,
            affixKey: copy.affixKey,
            components: copy.components,
          },
        });
      }
      return { copies, totalComponents };
    },

    async findByGrantKeys(tx, playerId, grantKeys) {
      const found = new Map<string, GrantKeyRecord>();
      if (grantKeys.length === 0) return found;
      const rows = await tx
        .select({ instance: playerEquipment, definition: equipmentDefinitions })
        .from(playerEquipment)
        .innerJoin(equipmentDefinitions, eq(playerEquipment.definitionId, equipmentDefinitions.id))
        .where(and(eq(playerEquipment.playerId, playerId), inArray(playerEquipment.grantKey, [...grantKeys])));
      for (const { instance, definition } of rows) {
        found.set(instance.grantKey!, {
          grantKey: instance.grantKey!,
          equipmentId: instance.id,
          slot: instance.slot as EquipmentSlot,
          sourceType: instance.sourceType,
          definition: toDefinitionView(definition),
          rolledMultiplierBp: instance.rolledMultiplierBp,
          affixKey: instance.affixKey,
          removed: instance.removedAt != null,
        });
      }
      return found;
    },

    async equipForOnboarding(tx, playerId, items) {
      for (const slot of Object.keys(items)) assertSlot(slot);
      await requireUnlocked(tx, playerId);
      const loadout = await lockActiveLoadout(tx, playerId);
      const result: OnboardingEquipResult = { equipped: [], alreadyEquipped: [], kept: [], skipped: [] };

      for (const slot of EQUIPMENT_SLOTS) {
        const equipmentId = items[slot];
        if (equipmentId == null) continue;
        // Read without the `removed_at` filter so a removed starter can be
        // reported as removed rather than as someone else's.
        const [row] = await tx
          .select({ instance: playerEquipment, definition: equipmentDefinitions })
          .from(playerEquipment)
          .innerJoin(equipmentDefinitions, eq(playerEquipment.definitionId, equipmentDefinitions.id))
          .where(and(eq(playerEquipment.id, equipmentId), eq(playerEquipment.playerId, playerId)))
          .for('share', { of: playerEquipment });
        const reason: OnboardingEquipSkipReason | null = !row
          ? 'not_owned'
          : row.instance.removedAt != null
            ? 'removed'
            : row.instance.slot !== slot
              ? 'slot_mismatch'
              : row.instance.sourceType !== 'onboarding'
                ? 'not_onboarding'
                : null;
        if (reason) {
          result.skipped.push({ slot, equipmentId, reason });
          continue;
        }

        const currentId = await currentSlotEquipmentId(tx, loadout.id, slot);
        if (currentId === equipmentId) {
          result.alreadyEquipped.push({ slot, equipmentId });
          continue;
        }
        if (currentId !== null) {
          // The player's own choice. Never overwritten, never compared.
          result.kept.push({ slot, equipmentId: currentId });
          continue;
        }

        await tx.insert(playerLoadoutSlots).values({ loadoutId: loadout.id, playerId, slot, equipmentId });
        await writeEvent(tx, {
          playerId,
          kind: 'equipped',
          equipmentId,
          loadoutId: loadout.id,
          slot,
          previousEquipmentId: null,
          metadata: { definitionKey: row!.definition.key, reason: 'onboarding' },
        });
        result.equipped.push({ slot, equipmentId });
      }

      if (result.equipped.length > 0) {
        await tx.update(playerLoadouts).set({ updatedAt: sql`now()` }).where(eq(playerLoadouts.id, loadout.id));
      }
      return result;
    },

    async adminReleaseGrantKeys(tx, input) {
      if (!input.actorDiscordId) throw new RangeError('A grant-key release must name the acting admin');
      if (!input.reason?.trim()) throw new RangeError('A grant-key release must give a reason');
      if (input.grantKeys.length === 0) return { released: [] };

      // Only instances that are already removed: a live instance keeps its key,
      // so releasing can never let a grant create a second live copy.
      const targets = await tx
        .select({ id: playerEquipment.id, grantKey: playerEquipment.grantKey })
        .from(playerEquipment)
        .where(
          and(
            eq(playerEquipment.playerId, input.playerId),
            inArray(playerEquipment.grantKey, [...input.grantKeys]),
            isNotNull(playerEquipment.removedAt),
          ),
        )
        .orderBy(asc(playerEquipment.id))
        .for('update');
      if (targets.length === 0) return { released: [] };

      await tx
        .update(playerEquipment)
        .set({ grantKey: null, updatedAt: sql`now()` })
        .where(inArray(playerEquipment.id, targets.map((t) => t.id)));
      const released = targets.map((t) => ({ equipmentId: t.id, grantKey: t.grantKey! }));
      await recordDomainAdminAction(tx, {
        playerId: input.playerId,
        action: 'release_equipment_grant_keys',
        adminDiscordId: input.actorDiscordId,
        before: released,
        after: released.map((r) => ({ equipmentId: r.equipmentId, grantKey: null })),
        detail: { reason: input.reason.trim() },
      });
      return { released };
    },
  };

  // The methods that write through a caller's `tx` run as one unit of their own —
  // see `atomically`. Every other writer opens its own `db.transaction`.
  return {
    ...methods,
    grantEquipment: (tx, input) => atomically(tx, (inner) => methods.grantEquipment(inner, input)),
    adminRemove: (tx, input) => atomically(tx, (inner) => methods.adminRemove(inner, input)),
    dismantle: (tx, input) => atomically(tx, (inner) => methods.dismantle(inner, input)),
    equipForOnboarding: (tx, playerId, items) =>
      atomically(tx, (inner) => methods.equipForOnboarding(inner, playerId, items)),
    adminReleaseGrantKeys: (tx, input) => atomically(tx, (inner) => methods.adminReleaseGrantKeys(inner, input)),
  };
}

/**
 * Run `fn` as one atomic unit on `tx`.
 *
 * `DbOrTx` admits the bare `Db`, so a caller can hand these methods either.
 * Given the `Db`, this opens a real transaction — without it each statement
 * would autocommit, dropping the row locks the method relies on and letting a
 * failure part-way leave earlier writes behind. Given a transaction, it opens
 * a savepoint, so the caller's transaction still commits or rolls back as a
 * whole, and a caller that catches an equipment failure (a reward path that
 * records it and carries on) is not left holding an aborted transaction.
 */
function atomically<T>(tx: DbOrTx, fn: (inner: DbOrTx) => Promise<T>): Promise<T> {
  return (tx as Db).transaction(fn);
}
