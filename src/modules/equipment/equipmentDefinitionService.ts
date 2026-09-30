/**
 * Equipment definitions — authoring operations on the catalogue.
 *
 * The database is authoritative for definitions (the world-encounter model):
 * this service is how an admin surface creates and edits them, the startup
 * seed only ever inserts missing keys, and packages move them between
 * environments. Every write validates through the shared
 * `EquipmentDefinitionInputSchema`.
 *
 * Two rules protect owned instances:
 *
 *  - **Keys never change.** A key is the identity content and logs use; an
 *    update names the definition by key and may not rename it.
 *  - **A referenced definition keeps its slot and cannot be deleted.** Owned
 *    instances copied the slot at grant time and the loadout foreign key
 *    depends on the two agreeing, so the slot is frozen once anyone owns one.
 *    Deletion is refused with the blocker count (disable it instead); the
 *    `ON DELETE RESTRICT` foreign key is the backstop.
 */
import { and, asc, count, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  equipmentDefinitions,
  playerEquipment,
  type EquipmentDefinitionRow,
} from '../../db/schema';
import {
  EquipmentDefinitionNotFoundError,
  EquipmentDefinitionReferencedError,
  EquipmentKeyTakenError,
  EquipmentSlotLockedError,
  EquipmentValidationError,
  isUniqueViolation,
} from '../../shared/errors';
import {
  definitionColumnValues,
  parseEquipmentDefinition,
  type EquipmentDefinitionInput,
} from './definitionSchema';
import type { EquipmentSlot } from './vocabulary';

export interface DefinitionFilters {
  slot?: EquipmentSlot;
  rarity?: string;
  enabled?: boolean;
  regionId?: string;
  /** Case-insensitive substring of the name or key. */
  q?: string;
}

export interface DefinitionSummary {
  definition: EquipmentDefinitionRow;
  /** Instances players currently own (removed ones excluded). */
  ownedCount: number;
}

export interface DefinitionBlockers {
  /** Every instance ever granted, removed ones included — all of them reference the row. */
  instanceCount: number;
}

export interface EquipmentDefinitionService {
  listDefinitions(filters?: DefinitionFilters): Promise<DefinitionSummary[]>;
  getByKey(key: string): Promise<EquipmentDefinitionRow | null>;
  create(input: unknown, opts?: { actorDiscordId?: string | null }): Promise<EquipmentDefinitionRow>;
  update(
    key: string,
    input: unknown,
    opts?: { actorDiscordId?: string | null },
  ): Promise<EquipmentDefinitionRow>;
  setEnabled(
    key: string,
    enabled: boolean,
    opts?: { actorDiscordId?: string | null },
  ): Promise<EquipmentDefinitionRow>;
  /** What stops `key` being deleted. */
  referenceBlockers(key: string): Promise<DefinitionBlockers>;
  delete(key: string): Promise<void>;
}

/** Instances (removed included) that reference a definition. */
export async function countDefinitionInstances(tx: DbOrTx, definitionId: number): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(playerEquipment)
    .where(eq(playerEquipment.definitionId, definitionId));
  return row?.n ?? 0;
}

/**
 * Refuse a slot change on a definition that owned instances reference. Shared
 * by update, import and the reset seed so the rule has one implementation.
 */
export async function assertSlotChangeAllowed(
  tx: DbOrTx,
  existing: EquipmentDefinitionRow,
  nextSlot: string,
): Promise<void> {
  if (existing.slot === nextSlot) return;
  if ((await countDefinitionInstances(tx, existing.id)) > 0) {
    throw new EquipmentSlotLockedError(existing.key);
  }
}

function isForeignKeyViolation(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; cause?: unknown };
    if (e.code === '23503') return true;
    if (e.cause) return isForeignKeyViolation(e.cause);
  }
  return false;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createEquipmentDefinitionService(db: Db): EquipmentDefinitionService {
  async function lockByKey(tx: DbOrTx, key: string): Promise<EquipmentDefinitionRow> {
    const [row] = await tx
      .select()
      .from(equipmentDefinitions)
      .where(eq(equipmentDefinitions.key, key))
      .for('update');
    if (!row) throw new EquipmentDefinitionNotFoundError(key);
    return row;
  }

  async function getByKey(key: string): Promise<EquipmentDefinitionRow | null> {
    const [row] = await db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, key));
    return row ?? null;
  }

  return {
    async listDefinitions(filters = {}) {
      const conditions: SQL[] = [];
      if (filters.slot !== undefined) conditions.push(eq(equipmentDefinitions.slot, filters.slot));
      if (filters.rarity !== undefined) conditions.push(eq(equipmentDefinitions.rarity, filters.rarity));
      if (filters.enabled !== undefined) conditions.push(eq(equipmentDefinitions.enabled, filters.enabled));
      if (filters.regionId !== undefined) conditions.push(eq(equipmentDefinitions.regionId, filters.regionId));
      const q = filters.q?.trim();
      if (q) {
        const pattern = `%${escapeLike(q)}%`;
        conditions.push(or(ilike(equipmentDefinitions.name, pattern), ilike(equipmentDefinitions.key, pattern))!);
      }
      const rows = await db
        .select({
          definition: equipmentDefinitions,
          ownedCount: sql<number>`count(${playerEquipment.id}) filter (where ${playerEquipment.removedAt} is null)::int`,
        })
        .from(equipmentDefinitions)
        .leftJoin(playerEquipment, eq(playerEquipment.definitionId, equipmentDefinitions.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(equipmentDefinitions.id)
        .orderBy(asc(equipmentDefinitions.slot), asc(equipmentDefinitions.key));
      return rows.map((r) => ({ definition: r.definition, ownedCount: r.ownedCount }));
    },

    getByKey,

    async create(input, opts = {}) {
      const parsed = parseEquipmentDefinition(input);
      try {
        const [row] = await db
          .insert(equipmentDefinitions)
          .values({ ...definitionColumnValues(parsed), updatedBy: opts.actorDiscordId ?? null })
          .returning();
        return row!;
      } catch (err) {
        if (isUniqueViolation(err)) throw new EquipmentKeyTakenError(parsed.key);
        throw err;
      }
    },

    async update(key, input, opts = {}) {
      const parsed: EquipmentDefinitionInput = parseEquipmentDefinition(input);
      if (parsed.key !== key) {
        throw new EquipmentValidationError([
          { path: 'key', message: `keys never change (editing "${key}", got "${parsed.key}")` },
        ]);
      }
      return db.transaction(async (tx) => {
        const existing = await lockByKey(tx, key);
        await assertSlotChangeAllowed(tx, existing, parsed.slot);
        const [row] = await tx
          .update(equipmentDefinitions)
          .set({
            ...definitionColumnValues(parsed),
            updatedAt: sql`now()`,
            updatedBy: opts.actorDiscordId ?? null,
          })
          .where(eq(equipmentDefinitions.id, existing.id))
          .returning();
        return row!;
      });
    },

    async setEnabled(key, enabled, opts = {}) {
      const [row] = await db
        .update(equipmentDefinitions)
        .set({ enabled, updatedAt: sql`now()`, updatedBy: opts.actorDiscordId ?? null })
        .where(eq(equipmentDefinitions.key, key))
        .returning();
      if (!row) throw new EquipmentDefinitionNotFoundError(key);
      return row;
    },

    async referenceBlockers(key) {
      const definition = await getByKey(key);
      if (!definition) throw new EquipmentDefinitionNotFoundError(key);
      return { instanceCount: await countDefinitionInstances(db, definition.id) };
    },

    async delete(key) {
      await db.transaction(async (tx) => {
        const existing = await lockByKey(tx, key);
        const instanceCount = await countDefinitionInstances(tx, existing.id);
        if (instanceCount > 0) throw new EquipmentDefinitionReferencedError(key, instanceCount);
        try {
          await tx.delete(equipmentDefinitions).where(eq(equipmentDefinitions.id, existing.id));
        } catch (err) {
          // The FK backstop: an instance granted between the count and the
          // delete (the grant's FOR SHARE makes this unreachable in practice).
          if (isForeignKeyViolation(err)) {
            throw new EquipmentDefinitionReferencedError(key, instanceCount + 1);
          }
          throw err;
        }
      });
    },
  };
}
