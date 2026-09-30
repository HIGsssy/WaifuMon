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
  EquipmentLockedError,
  EquipmentNotOwnedError,
  EquipmentSlotMismatchError,
  EquipmentValidationError,
  FeatureLockedError,
  LoadoutConflictError,
} from '../../shared/errors';
import { recordDomainAdminAction } from '../admin/adminActionAudit';
import type { FeatureUnlockService } from '../features/featureUnlockService';
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
}

export interface GrantEquipmentResult {
  definition: EquipmentDefinitionView;
  /** Every instance this grant covers — newly created or found by grant key. */
  instances: EquipmentInstanceView[];
  newInstanceIds: number[];
  /** True when the grant key had already been applied and nothing was created. */
  alreadyGranted: boolean;
}

export type EquipmentSort = 'acquired' | 'multiplier' | 'rarity' | 'name';

export interface EquipmentFilters {
  slot?: EquipmentSlot;
  rarity?: string;
  /** Case-insensitive substring of the name or key. */
  q?: string;
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
 * Identical owned gear, grouped. V1 equipment has fixed stats, so every copy
 * of one definition is mechanically the same and grouping by definition is
 * exact; once rolled properties exist, groups will split on them too.
 */
export interface EquipmentGroup {
  definition: EquipmentDefinitionView;
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
}

export interface EquipmentServiceDeps {
  db: Db;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
}

// ── Sorting and cursors ───────────────────────────────────────────────────

/** The instance's own-slot multiplier, as SQL. */
const OWN_MULTIPLIER_SQL = sql<number>`(case ${playerEquipment.slot}
  when 'attack' then ${equipmentDefinitions.attackBp}
  when 'defense' then ${equipmentDefinitions.defenseBp}
  else ${equipmentDefinitions.healthBp} end)`;

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

const SORTS: Record<EquipmentSort, SortSpec> = {
  // Newest first. The identity id *is* acquisition order, and unlike
  // `acquired_at` it has no sub-millisecond precision for a JS Date to lose
  // inside a cursor.
  acquired: { expr: null, direction: 'desc', cast: 'int', valueOf: (r) => r.instance.id },
  multiplier: {
    expr: OWN_MULTIPLIER_SQL,
    direction: 'desc',
    cast: 'int',
    valueOf: (r) => ownMultiplier(r.instance, r.definition),
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

function ownMultiplier(instance: PlayerEquipmentRow, definition: EquipmentDefinitionRow): number {
  return instance.slot === 'attack'
    ? definition.attackBp
    : instance.slot === 'defense'
      ? definition.defenseBp
      : definition.healthBp;
}

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
        .groupBy(equipmentDefinitions.id);

      const groups: (EquipmentGroup & { newest: number })[] = rows.map((r) => ({
        definition: toDefinitionView(r.definition),
        count: r.count,
        equippedCount: r.equippedCount,
        favoriteCount: r.favoriteCount,
        lockedCount: r.lockedCount,
        representativeId: Number(r.firstUnequipped ?? r.firstAny),
        instanceIds: (r.instanceIds ?? []).map(Number),
        newest: Number(r.newest),
      }));
      const rank = (g: EquipmentGroup) => (RARITIES as readonly string[]).indexOf(g.definition.rarity);
      const sort = opts.sort ?? 'multiplier';
      groups.sort((a, b) => {
        switch (sort) {
          case 'acquired':
            return b.newest - a.newest;
          case 'rarity':
            return rank(b) - rank(a) || a.definition.key.localeCompare(b.definition.key);
          case 'name':
            return a.definition.name.localeCompare(b.definition.name) || a.definition.key.localeCompare(b.definition.key);
          case 'multiplier':
          default:
            return b.definition.multiplierBp - a.definition.multiplierBp || a.definition.key.localeCompare(b.definition.key);
        }
      });
      return groups.map(({ newest: _newest, ...group }) => group);
    })();
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
      const values = Array.from({ length: quantity }, (_, i) => ({
        playerId: input.playerId,
        definitionId: definition.id,
        slot: definition.slot,
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
          metadata: {
            definitionKey: definition.key,
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
        instances: covered.map((row) => toInstanceView(row, definition, false)),
        newInstanceIds: inserted.map((row) => row.id),
        alreadyGranted: inserted.length === 0,
      };
    },

    async listEquipment(playerId, opts = {}) {
      const sort = opts.sort ?? 'acquired';
      const spec = SORTS[sort];
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
        items: page.map((r) => toInstanceView(r.instance, r.definition, r.equippedId != null)),
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
      return toInstanceView(owned.instance, owned.definition, equipped);
    },

    async getActiveLoadout(playerId) {
      return readActiveLoadoutView(db, playerId);
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
          return { changed: false, previousEquipmentId: currentId, loadout: await readActiveLoadoutView(tx, playerId) };
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
          metadata: { definitionKey: owned.definition.key },
        });
        return { changed: true, previousEquipmentId: currentId, loadout: await readActiveLoadoutView(tx, playerId) };
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
          return { changed: false, previousEquipmentId: null, loadout: await readActiveLoadoutView(tx, playerId) };
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
        return { changed: true, previousEquipmentId: currentId, loadout: await readActiveLoadoutView(tx, playerId) };
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
        return toInstanceView(updated!, owned.definition, equipped);
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
  };

  // The two methods that take a caller's `tx` run as one unit of their own —
  // see `atomically`. Every other writer opens its own `db.transaction`.
  return {
    ...methods,
    grantEquipment: (tx, input) => atomically(tx, (inner) => methods.grantEquipment(inner, input)),
    adminRemove: (tx, input) => atomically(tx, (inner) => methods.adminRemove(inner, input)),
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
