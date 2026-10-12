/** Mutable dungeon-only catalogue with authoring issues. No publication or reward delivery. */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../db/client';
import {
  dungeonLootTables,
  dungeonLootTableEvents,
  dungeonDefinitions,
  dungeonRevisions,
  DUNGEON_LOOT_TABLE_TIERS,
  DUNGEON_LOOT_TABLE_ORIGINS,
  type DungeonLootTableRow,
  type DungeonLootTableEventRow,
  type DungeonLootTableEventAction,
  type DungeonLootTableTier,
} from '../../db/schema';
import { AppError } from '../../shared/errors';
import { loadDungeonRewardContext } from './dungeonRewardContext';
import {
  validateDungeonLootTableBody,
  type DungeonRewardEquipmentPools,
} from './validation/dungeonRewardValidation';
import {
  hasErrors,
  type DungeonIssue,
  type DungeonValidationContext,
} from './validation/dungeonValidation';
import { canonicalJson } from '../rewardTables/rewardTableCore';
import { DungeonDefinitionSchema, dungeonDependencies } from './content/dungeonDefinition';
import { DungeonKeySchema } from './content/dungeonIdentifiers';
import { readDungeonRewardSnapshot } from './content/dungeonRewardSnapshot';
import { DungeonLootTableBodySchema, type DungeonLootTableBody } from './content/dungeonRewards';

const metadata = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(600),
  tier: z.enum(DUNGEON_LOOT_TABLE_TIERS).nullable(),
};
export const DungeonLootTableCreateSchema = z
  .object({
    key: DungeonKeySchema,
    name: metadata.name,
    description: metadata.description.default(''),
    tier: metadata.tier.default(null),
    body: DungeonLootTableBodySchema,
    origin: z.enum(DUNGEON_LOOT_TABLE_ORIGINS).default('portal'),
  })
  .strict();
export type DungeonLootTableCreateInput = z.input<typeof DungeonLootTableCreateSchema>;

export const DungeonLootTableUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    name: metadata.name.optional(),
    description: metadata.description.optional(),
    tier: metadata.tier.optional(),
    body: DungeonLootTableBodySchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      ['name', 'description', 'tier', 'body'].some(
        (key) => input[key as keyof typeof input] !== undefined,
      ),
    'supply at least one field to update',
  );
export type DungeonLootTableUpdateInput = z.input<typeof DungeonLootTableUpdateSchema>;
export const DungeonLootTableRevisionSchema = z
  .object({ expectedRevision: z.number().int().min(1) })
  .strict();
export type DungeonLootTableRevisionInput = z.infer<typeof DungeonLootTableRevisionSchema>;
export const DungeonLootTableDuplicateSchema = z
  .object({ key: DungeonKeySchema, name: metadata.name.optional() })
  .strict();
export type DungeonLootTableDuplicateInput = z.infer<typeof DungeonLootTableDuplicateSchema>;

export interface DungeonLootTableRecord extends Omit<DungeonLootTableRow, 'tableKey'> {
  key: string;
  issues: DungeonIssue[];
  equipmentPools: DungeonRewardEquipmentPools;
}
export interface DungeonLootTableValidationReport {
  valid: boolean;
  body: DungeonLootTableBody | null;
  contentHash: string | null;
  issues: DungeonIssue[];
  equipmentPools: DungeonRewardEquipmentPools;
}
export interface DungeonLootTableDraftReference {
  kind: 'draft';
  dungeonKey: string;
  name: string;
  enabled: boolean;
  draftRevision: number;
}
export interface DungeonLootTablePublishedReference {
  kind: 'published';
  dungeonKey: string;
  name: string;
  enabled: boolean;
  revisionId: number;
  revision: number;
  current: boolean;
  /**
   * `embedded`: the revision carries a verified reward snapshot holding this
   * table's body, so it no longer needs the catalogue row. `not_embedded`: it
   * has none (published before snapshots existed, or unreadable) and does.
   */
  snapshotStatus: 'embedded' | 'not_embedded';
}
export interface DungeonLootTableUsage {
  drafts: DungeonLootTableDraftReference[];
  published: DungeonLootTablePublishedReference[];
}

export class DungeonLootTableInvalidError extends AppError {
  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super(
      'DUNGEON_LOOT_TABLE_INVALID',
      issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      'Fix the dungeon loot table fields before saving.',
    );
  }
}
export class DungeonLootTableKeyTakenError extends AppError {
  constructor(readonly key: string) {
    super(
      'DUNGEON_LOOT_TABLE_KEY_TAKEN',
      `Dungeon loot table "${key}" already exists`,
      'Another dungeon loot table already uses that key.',
    );
  }
}
export class DungeonLootTableNotFoundError extends AppError {
  constructor(readonly key: string) {
    super(
      'DUNGEON_LOOT_TABLE_NOT_FOUND',
      `Dungeon loot table "${key}" not found`,
      'That dungeon loot table could not be found.',
    );
  }
}
export class DungeonLootTableStaleError extends AppError {
  constructor(
    readonly key: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
    readonly updatedBy: string | null,
    readonly updatedAt: Date,
  ) {
    super(
      'DUNGEON_LOOT_TABLE_STALE',
      `Dungeon loot table "${key}" is at revision ${currentRevision}, not ${expectedRevision}`,
      'This loot table changed since you opened it. Reload to see the latest version.',
    );
  }
}
export class DungeonLootTableDeleteRefusedError extends AppError {
  constructor(
    readonly key: string,
    readonly reason: 'not_archived' | 'in_use',
    readonly usage: DungeonLootTableUsage,
  ) {
    const names = [
      ...new Set([...usage.drafts, ...usage.published].map((r) => `${r.name} (${r.dungeonKey})`)),
    ];
    super(
      'DUNGEON_LOOT_TABLE_DELETE_REFUSED',
      `Cannot delete "${key}": ${reason}${names.length ? `; used by ${names.join(', ')}` : ''}`,
      reason === 'not_archived'
        ? 'Archive the loot table before deleting it.'
        : `This table is still needed by ${names.join(', ')}.`,
    );
  }
}

export interface DungeonLootTableListFilter {
  includeArchived?: boolean;
  tier?: DungeonLootTableTier | null;
  search?: string;
}
export interface DungeonLootTableService {
  validate(body: unknown): Promise<DungeonLootTableValidationReport>;
  create(input: DungeonLootTableCreateInput, actor: string | null): Promise<DungeonLootTableRecord>;
  get(key: string): Promise<DungeonLootTableRecord | null>;
  list(filter?: DungeonLootTableListFilter): Promise<DungeonLootTableRecord[]>;
  update(
    key: string,
    input: DungeonLootTableUpdateInput,
    actor: string | null,
  ): Promise<DungeonLootTableRecord>;
  archive(
    key: string,
    input: DungeonLootTableRevisionInput,
    actor: string | null,
  ): Promise<DungeonLootTableRecord>;
  restore(
    key: string,
    input: DungeonLootTableRevisionInput,
    actor: string | null,
  ): Promise<DungeonLootTableRecord>;
  delete(key: string, input: DungeonLootTableRevisionInput, actor: string | null): Promise<boolean>;
  duplicate(
    sourceKey: string,
    input: DungeonLootTableDuplicateInput,
    actor: string | null,
  ): Promise<DungeonLootTableRecord>;
  whereUsed(key: string): Promise<DungeonLootTableUsage>;
  history(key: string, limit?: number): Promise<DungeonLootTableEventRow[]>;
}

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown, prefix = ''): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new DungeonLootTableInvalidError(
      result.error.issues.map((i) => ({
        path: [prefix, ...i.path].filter((p) => p !== '').join('.'),
        message: i.message,
      })),
    );
  return result.data;
}
/** Canonical keys, authored array order; metadata never enters this hash. */
export function dungeonLootTableContentHash(body: DungeonLootTableBody): string {
  return createHash('sha256')
    .update(canonicalJson(parse(DungeonLootTableBodySchema, body, 'body')))
    .digest('hex');
}
function record(
  row: DungeonLootTableRow,
): Omit<DungeonLootTableRecord, 'issues' | 'equipmentPools'> {
  const { tableKey, ...rest } = row;
  return {
    ...rest,
    key: tableKey,
    body: parse(DungeonLootTableBodySchema, row.body, `tables.${tableKey}.body`),
  };
}
const actorSchema = z.string().trim().min(1).max(100).nullable();

export function createDungeonLootTableService({ db }: { db: Db }): DungeonLootTableService {
  function withIssues(
    row: DungeonLootTableRow,
    context: DungeonValidationContext,
  ): DungeonLootTableRecord {
    const table = record(row);
    const validation = validateDungeonLootTableBody(
      table.body,
      context,
      `Loot table "${table.name}"`,
    );
    return { ...table, issues: validation.issues, equipmentPools: validation.equipmentPools };
  }
  async function inspect(row: DungeonLootTableRow, tx: DbOrTx = db) {
    return withIssues(row, await loadDungeonRewardContext(tx, { lootTableKeys: [] }));
  }
  async function requireRow(
    tx: DbOrTx,
    key: string,
    lock: 'update' | 'share' = 'update',
  ): Promise<DungeonLootTableRow> {
    const [row] = await tx
      .select()
      .from(dungeonLootTables)
      .where(eq(dungeonLootTables.tableKey, key))
      .for(lock);
    if (!row) throw new DungeonLootTableNotFoundError(key);
    return row;
  }
  function assertRevision(row: DungeonLootTableRow, expected: number) {
    if (row.revision !== expected)
      throw new DungeonLootTableStaleError(
        row.tableKey,
        expected,
        row.revision,
        row.updatedBy,
        row.updatedAt,
      );
  }
  async function event(
    tx: DbOrTx,
    row: DungeonLootTableRow,
    action: DungeonLootTableEventAction,
    actor: string | null,
    previousContentHash: string | null,
    newContentHash: string | null,
    details: Record<string, unknown> = {},
  ) {
    await tx.insert(dungeonLootTableEvents).values({
      tableKey: row.tableKey,
      revision: row.revision,
      origin: row.origin,
      action,
      actor,
      previousContentHash,
      newContentHash,
      details,
    });
  }
  async function insert(
    tx: DbOrTx,
    input: z.infer<typeof DungeonLootTableCreateSchema>,
    actor: string | null,
    action: DungeonLootTableEventAction,
    details: Record<string, unknown> = {},
  ) {
    const [row] = await tx
      .insert(dungeonLootTables)
      .values({
        tableKey: input.key,
        name: input.name,
        description: input.description,
        tier: input.tier,
        body: input.body,
        contentHash: dungeonLootTableContentHash(input.body),
        origin: input.origin,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({ target: dungeonLootTables.tableKey })
      .returning();
    if (!row) throw new DungeonLootTableKeyTakenError(input.key);
    await event(tx, row, action, actor, null, row.contentHash, details);
    return inspect(row, tx);
  }
  async function usageOf(tx: DbOrTx, key: string): Promise<DungeonLootTableUsage> {
    const drafts = await tx
      .select()
      .from(dungeonDefinitions)
      .orderBy(asc(dungeonDefinitions.dungeonKey));
    const revisions = await tx
      .select({ revision: dungeonRevisions, dungeon: dungeonDefinitions })
      .from(dungeonRevisions)
      .innerJoin(dungeonDefinitions, eq(dungeonRevisions.dungeonKey, dungeonDefinitions.dungeonKey))
      .orderBy(asc(dungeonRevisions.dungeonKey), asc(dungeonRevisions.number));
    const usage: DungeonLootTableUsage = { drafts: [], published: [] };
    for (const row of drafts) {
      // Fail closed on unreadable persisted definitions rather than overlooking possible references.
      const definition = parse(
        DungeonDefinitionSchema,
        row.draft,
        `dungeons.${row.dungeonKey}.draft`,
      );
      if (dungeonDependencies(definition).lootTables.includes(key))
        usage.drafts.push({
          kind: 'draft',
          dungeonKey: row.dungeonKey,
          name: definition.name,
          enabled: row.enabled,
          draftRevision: row.draftRevision,
        });
    }
    for (const { revision, dungeon } of revisions) {
      const definition = parse(
        DungeonDefinitionSchema,
        revision.content,
        `dungeons.${dungeon.dungeonKey}.revisions.${revision.number}`,
      );
      if (dungeonDependencies(definition).lootTables.includes(key))
        usage.published.push({
          kind: 'published',
          dungeonKey: dungeon.dungeonKey,
          name: definition.name,
          enabled: dungeon.enabled,
          revisionId: revision.id,
          revision: revision.number,
          current: revision.id === dungeon.publishedRevisionId,
          snapshotStatus: readDungeonRewardSnapshot(revision.rewardSnapshot)?.tables[key]
            ? 'embedded'
            : 'not_embedded',
        });
    }
    return usage;
  }
  async function setArchived(
    key: string,
    raw: DungeonLootTableRevisionInput,
    actor: string | null,
    archived: boolean,
  ) {
    key = parse(DungeonKeySchema, key, 'key');
    const input = parse(DungeonLootTableRevisionSchema, raw);
    actor = parse(actorSchema, actor, 'actor');
    return db.transaction(async (tx) => {
      const row = await requireRow(tx, key);
      assertRevision(row, input.expectedRevision);
      // Idempotent status requests do not invent authoring revisions or events.
      if ((row.archivedAt !== null) === archived) return inspect(row, tx);
      const [updated] = await tx
        .update(dungeonLootTables)
        .set({
          archivedAt: archived ? new Date() : null,
          revision: row.revision + 1,
          updatedAt: new Date(),
          updatedBy: actor,
        })
        .where(eq(dungeonLootTables.tableKey, key))
        .returning();
      await event(
        tx,
        updated!,
        archived ? 'archived' : 'restored',
        actor,
        row.contentHash,
        row.contentHash,
      );
      return inspect(updated!, tx);
    });
  }
  return {
    async validate(raw) {
      const result = validateDungeonLootTableBody(
        raw,
        await loadDungeonRewardContext(db, { lootTableKeys: [] }),
      );
      return {
        ...result,
        valid: result.body !== null && !hasErrors(result.issues),
        contentHash: result.body ? dungeonLootTableContentHash(result.body) : null,
      };
    },
    async create(raw, actor) {
      const input = parse(DungeonLootTableCreateSchema, raw);
      actor = parse(actorSchema, actor, 'actor');
      const action =
        input.origin === 'import'
          ? 'imported'
          : input.origin === 'converted'
            ? 'converted'
            : 'created';
      return db.transaction((tx) => insert(tx, input, actor, action));
    },
    async get(key) {
      key = parse(DungeonKeySchema, key, 'key');
      const [row] = await db
        .select()
        .from(dungeonLootTables)
        .where(eq(dungeonLootTables.tableKey, key));
      return row ? inspect(row) : null;
    },
    async list(raw = {}) {
      const filter = parse(
        z
          .object({
            includeArchived: z.boolean().default(false),
            tier: metadata.tier.optional(),
            search: z.string().trim().max(200).optional(),
          })
          .strict(),
        raw,
      );
      const search = filter.search ? `%${filter.search.replace(/[\\%_]/g, '\\$&')}%` : null;
      const rows = await db
        .select()
        .from(dungeonLootTables)
        .where(
          and(
            filter.includeArchived ? undefined : isNull(dungeonLootTables.archivedAt),
            filter.tier === undefined
              ? undefined
              : filter.tier === null
                ? isNull(dungeonLootTables.tier)
                : eq(dungeonLootTables.tier, filter.tier),
            search
              ? or(
                  ilike(dungeonLootTables.tableKey, search),
                  ilike(dungeonLootTables.name, search),
                  ilike(dungeonLootTables.description, search),
                )
              : undefined,
          ),
        )
        .orderBy(asc(dungeonLootTables.name), asc(dungeonLootTables.tableKey));
      const context = await loadDungeonRewardContext(db, { lootTableKeys: [] });
      return rows.map((row) => withIssues(row, context));
    },
    async update(key, raw, actor) {
      key = parse(DungeonKeySchema, key, 'key');
      const input = parse(DungeonLootTableUpdateSchema, raw);
      actor = parse(actorSchema, actor, 'actor');
      return db.transaction(async (tx) => {
        const row = await requireRow(tx, key);
        assertRevision(row, input.expectedRevision);
        const body = input.body ?? row.body;
        const [updated] = await tx
          .update(dungeonLootTables)
          .set({
            name: input.name ?? row.name,
            description: input.description ?? row.description,
            tier: input.tier === undefined ? row.tier : input.tier,
            body,
            contentHash: dungeonLootTableContentHash(body),
            revision: row.revision + 1,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(dungeonLootTables.tableKey, key))
          .returning();
        await event(tx, updated!, 'updated', actor, row.contentHash, updated!.contentHash, {
          fields: ['name', 'description', 'tier', 'body'].filter(
            (field) => input[field as keyof typeof input] !== undefined,
          ),
        });
        return inspect(updated!, tx);
      });
    },
    archive: (key, input, actor) => setArchived(key, input, actor, true),
    restore: (key, input, actor) => setArchived(key, input, actor, false),
    async delete(key, raw, actor) {
      key = parse(DungeonKeySchema, key, 'key');
      const input = parse(DungeonLootTableRevisionSchema, raw);
      actor = parse(actorSchema, actor, 'actor');
      return db.transaction(async (tx) => {
        // Draft writers take no loot-table lock, and a publish share-locks the loot rows only after its dungeon row.
        // Acquire these before the loot row to serialize the complete reference check with their writes.
        // Plain SELECTs remain allowed; only this rare hard-delete operation takes these coarse locks.
        await tx.execute(sql`LOCK TABLE dungeon_definitions, dungeon_revisions IN EXCLUSIVE MODE`);
        const row = await requireRow(tx, key);
        assertRevision(row, input.expectedRevision);
        if (!row.archivedAt)
          throw new DungeonLootTableDeleteRefusedError(key, 'not_archived', {
            drafts: [],
            published: [],
          });
        const usage = await usageOf(tx, key);
        // A revision with a complete embedded snapshot reads this table from itself.
        // Drafts, and revisions without one, still need the catalogue row.
        if (usage.drafts.length || usage.published.some((r) => r.snapshotStatus !== 'embedded'))
          throw new DungeonLootTableDeleteRefusedError(key, 'in_use', usage);
        await tx.delete(dungeonLootTables).where(eq(dungeonLootTables.tableKey, key));
        await event(tx, row, 'deleted', actor, row.contentHash, null, { name: row.name });
        return true;
      });
    },
    async duplicate(sourceKey, raw, actor) {
      sourceKey = parse(DungeonKeySchema, sourceKey, 'sourceKey');
      const input = parse(DungeonLootTableDuplicateSchema, raw);
      actor = parse(actorSchema, actor, 'actor');
      return db.transaction(async (tx) => {
        const source = await requireRow(tx, sourceKey, 'share');
        const copy = parse(DungeonLootTableCreateSchema, {
          key: input.key,
          name: input.name ?? source.name,
          description: source.description,
          tier: source.tier,
          body: source.body,
          origin: 'portal',
        });
        return insert(tx, copy, actor, 'duplicated', {
          sourceKey,
          sourceRevision: source.revision,
          sourceContentHash: source.contentHash,
          sourceOrigin: source.origin,
        });
      });
    },
    async whereUsed(key) {
      key = parse(DungeonKeySchema, key, 'key');
      return db.transaction((tx) => usageOf(tx, key), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    },
    async history(key, limit = 100) {
      key = parse(DungeonKeySchema, key, 'key');
      limit = parse(z.number().int().min(1).max(500), limit, 'limit');
      return db
        .select()
        .from(dungeonLootTableEvents)
        .where(eq(dungeonLootTableEvents.tableKey, key))
        .orderBy(desc(dungeonLootTableEvents.id))
        .limit(limit);
    },
  };
}
