/**
 * Admin authoring for boss and expedition reward tables.
 *
 * One service for both kinds: they share the group/entry shape and differ only
 * at the table level, which the kind's schema already knows.
 *
 *   - **Validation** happens on every write, inside the writing transaction:
 *     the kind's schema, item references, every Equipment selector against the
 *     definitions in this database, and what pays from the table
 *     (`validateRewardTable`). Errors refuse the save; warnings ride along.
 *   - **Concurrency** is optimistic. Every row has an integer `revision`; a
 *     save names the revision it edited and the update applies only while that
 *     is still current. A stale save is refused with the current revision,
 *     never merged and never overwritten.
 *   - **Lifecycle** is enable/disable. A table content pays from, or one that
 *     ships in Git, cannot be deleted — the first would break a boss or a
 *     mission, the second would be seeded straight back at the next start.
 *   - **Export/import** move tables between environments and back into Git.
 *     Export writes the file format exactly; import is planned first, then
 *     applied all-or-nothing against the revisions the plan saw.
 *
 * Nothing here touches a boss already spawned or a mission already deployed:
 * both snapshot their table, so an edit reaches only what starts afterwards.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { rewardTables, type RewardTableRow } from '../../db/schema';
import {
  AppError,
  RewardTableDeleteRefusedError,
  RewardTableIdTakenError,
  RewardTableInvalidError,
  RewardTableStaleError,
} from '../../shared/errors';
import type { LoadedContent } from '../content/schemas';
import { listRewardableDefinitions } from '../equipment/equipmentRewardService';
import {
  EquipmentRewardSelectorSchema,
  equipmentSelectorIssues,
  eligibleRewardDefinitions,
  type RewardableDefinition,
} from '../equipment/rewardSelector';
import type { EquipmentIssue } from '../../shared/errors';
import {
  rewardTableFile,
  rewardTableHash,
  rewardTableReferences,
  validateRewardTable,
  type AnyRewardTable,
  type EquipmentRewardCandidate,
  type RewardTableIssue,
  type RewardTableKind,
  type RewardTableReference,
} from './rewardTableCore';
import type { ShippedRewardTable } from './rewardTableStore';

/** Where a row stands relative to Git. */
export type RewardTableOrigin =
  /** Holds exactly what was last seeded from the shipped file. */
  | 'shipped'
  /** Seeded from Git, then changed by an admin or an import. */
  | 'edited'
  /** Never shipped: created in the Portal or imported. */
  | 'custom';

export interface RewardTableSummary {
  kind: RewardTableKind;
  id: string;
  enabled: boolean;
  version: string | null;
  revision: number;
  origin: RewardTableOrigin;
  /**
   * Whether the row equals the table in this build's shipped file — null when
   * the file has no such table. `false` on an `edited` row is the divergence
   * a deploy will not overwrite; export it to promote the edit into Git.
   */
  matchesShipped: boolean | null;
  groupCount: number;
  itemRowCount: number;
  equipmentRowCount: number;
  references: RewardTableReference[];
  updatedAt: Date;
  updatedBy: string | null;
}

export interface RewardTableDetail extends RewardTableSummary {
  /** The stored document, as the file format writes it. */
  table: Record<string, unknown>;
  /** Problems with the stored table against this server right now (e.g. a definition since disabled). */
  issues: RewardTableIssue[];
}

export interface EquipmentSelectorPreview {
  eligible: EquipmentRewardCandidate[];
  issues: EquipmentIssue[];
}

export type RewardTableImportAction = 'create' | 'update' | 'unchanged' | 'invalid';

export interface RewardTableImportPlanEntry {
  id: string;
  action: RewardTableImportAction;
  /** The revision the plan saw; null for a create. Apply refuses if it moved. */
  currentRevision: number | null;
  issues: RewardTableIssue[];
}

export interface RewardTableImportPlan {
  kind: RewardTableKind;
  entries: RewardTableImportPlanEntry[];
  /** Problems with the package as a whole (not an array, duplicate ids). */
  issues: RewardTableIssue[];
  /** True when every entry and the package are free of errors. */
  canApply: boolean;
}

export interface RewardTableImportResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface RewardTableExport {
  kind: RewardTableKind;
  /** `bossRewards.json` / `expeditionRewards.json` — where these go in Git. */
  file: string;
  tables: Record<string, unknown>[];
}

export interface RewardTableService {
  list(kind?: RewardTableKind): Promise<RewardTableSummary[]>;
  get(kind: RewardTableKind, id: string): Promise<RewardTableDetail | null>;
  /** Dry run: every issue a save of `table` would raise, without writing. */
  validate(kind: RewardTableKind, table: unknown, id?: string): Promise<RewardTableIssue[]>;
  create(kind: RewardTableKind, table: unknown, actor: string | null): Promise<RewardTableDetail>;
  update(
    kind: RewardTableKind,
    id: string,
    input: { table: unknown; expectedRevision: number },
    actor: string | null,
  ): Promise<RewardTableDetail | null>;
  /** Replace the row with this build's shipped table, so it counts as shipped again. */
  resetToShipped(
    kind: RewardTableKind,
    id: string,
    expectedRevision: number,
    actor: string | null,
  ): Promise<RewardTableDetail | null>;
  delete(kind: RewardTableKind, id: string, expectedRevision: number): Promise<boolean>;
  /** Every Equipment definition, enabled or not — what the editor's selector offers. */
  listEquipmentDefinitions(): Promise<RewardableDefinition[]>;
  /** The definitions each selector may pay right now, from the database. */
  previewEquipment(selectors: readonly unknown[]): Promise<EquipmentSelectorPreview[]>;
  export(kind: RewardTableKind): Promise<RewardTableExport>;
  planImport(kind: RewardTableKind, tables: unknown): Promise<RewardTableImportPlan>;
  applyImport(
    kind: RewardTableKind,
    tables: unknown,
    expectedRevisions: Readonly<Record<string, number | null>>,
    actor: string | null,
  ): Promise<RewardTableImportResult>;
}

export interface RewardTableServiceDeps {
  db: Db;
  /** Items, bosses and missions — for item checks and references. */
  getContent: () => Pick<LoadedContent, 'items' | 'bosses' | 'expeditions'>;
  /** This build's shipped tables. */
  getShipped: () => readonly ShippedRewardTable[];
}

/**
 * Ids a new table may not take: they are path segments of the admin routes
 * (`/:kind/export`, `/:kind/validate`) and the Portal's `/:kind/new` page, so
 * a table named one of them could not be opened.
 */
export const RESERVED_REWARD_TABLE_IDS: ReadonlySet<string> = new Set([
  'new',
  'export',
  'import',
  'validate',
  'reference',
  'equipment-preview',
]);

export function createRewardTableService(deps: RewardTableServiceDeps): RewardTableService {
  const { db } = deps;

  function shippedFor(kind: RewardTableKind, id: string): ShippedRewardTable | undefined {
    return deps.getShipped().find((t) => t.kind === kind && t.id === id);
  }

  function referencesOf(kind: RewardTableKind, id: string): RewardTableReference[] {
    return rewardTableReferences(kind, id, deps.getContent());
  }

  function validationContext(kind: RewardTableKind, id: string, definitions: readonly RewardableDefinition[]) {
    return {
      itemSlugs: new Set(deps.getContent().items.map((i) => i.slug)),
      definitions,
      references: referencesOf(kind, id),
    };
  }

  function originOf(row: RewardTableRow): RewardTableOrigin {
    if (row.seedHash === null) return 'custom';
    return row.contentHash === row.seedHash ? 'shipped' : 'edited';
  }

  function summaryOf(row: RewardTableRow): RewardTableSummary {
    const kind = row.kind as RewardTableKind;
    const def = row.definition as {
      version?: unknown;
      groups?: { entries?: unknown[]; equipment?: unknown[] }[];
    };
    const groups = Array.isArray(def.groups) ? def.groups : [];
    const shipped = shippedFor(kind, row.tableId);
    return {
      kind,
      id: row.tableId,
      enabled: row.enabled,
      version: typeof def.version === 'string' ? def.version : null,
      revision: row.revision,
      origin: originOf(row),
      matchesShipped: shipped ? shipped.hash === row.contentHash : null,
      groupCount: groups.length,
      itemRowCount: groups.reduce((n, g) => n + (g.entries?.length ?? 0), 0),
      equipmentRowCount: groups.reduce((n, g) => n + (g.equipment?.length ?? 0), 0),
      references: referencesOf(kind, row.tableId),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  function detailOf(row: RewardTableRow, definitions: readonly RewardableDefinition[]): RewardTableDetail {
    const kind = row.kind as RewardTableKind;
    return {
      ...summaryOf(row),
      table: row.definition,
      issues: validateRewardTable(kind, row.definition, validationContext(kind, row.tableId, definitions)).issues,
    };
  }

  async function readRow(tx: DbOrTx, kind: RewardTableKind, id: string, lock = false) {
    const query = tx
      .select()
      .from(rewardTables)
      .where(and(eq(rewardTables.kind, kind), eq(rewardTables.tableId, id)));
    const [row] = lock ? await query.for('update') : await query;
    return row;
  }

  /**
   * Validate for a write and return the parsed table, or throw with every
   * issue. The table's own id must be `id` — ids are immutable, because
   * content references them by value.
   */
  function assertWritable(
    kind: RewardTableKind,
    id: string,
    input: unknown,
    definitions: readonly RewardableDefinition[],
  ): { table: AnyRewardTable; issues: RewardTableIssue[] } {
    const { table, issues } = validateRewardTable(kind, input, validationContext(kind, id, definitions));
    if (table && table.id !== id) {
      issues.unshift({ path: 'id', message: `the table id is "${id}" and cannot be changed`, severity: 'error' });
    }
    if (!table || issues.some((i) => i.severity === 'error')) throw new RewardTableInvalidError(issues);
    return { table, issues };
  }

  function assertRevision(row: RewardTableRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new RewardTableStaleError(
        row.kind,
        row.tableId,
        expectedRevision,
        row.revision,
        row.updatedBy,
        row.updatedAt,
      );
    }
  }

  /** The conditional write every edit goes through. */
  async function writeRow(
    tx: DbOrTx,
    row: RewardTableRow,
    definition: Record<string, unknown>,
    hash: string,
    actor: string | null,
    extra: { seedHash?: string } = {},
  ): Promise<RewardTableRow> {
    const [updated] = await tx
      .update(rewardTables)
      .set({
        definition,
        enabled: definition.enabled !== false,
        contentHash: hash,
        revision: sql`${rewardTables.revision} + 1`,
        updatedAt: new Date(),
        updatedBy: actor,
        ...extra,
      })
      .where(
        and(
          eq(rewardTables.kind, row.kind),
          eq(rewardTables.tableId, row.tableId),
          eq(rewardTables.revision, row.revision),
        ),
      )
      .returning();
    // The row is locked, so this only fails if the lock was not taken — still
    // answered as stale rather than as a silent no-op.
    if (!updated) throw new RewardTableStaleError(row.kind, row.tableId, row.revision, -1, null, new Date());
    return updated;
  }

  async function nextPosition(tx: DbOrTx, kind: RewardTableKind): Promise<number> {
    const [row] = await tx
      .select({ max: sql<number | null>`max(${rewardTables.position})` })
      .from(rewardTables)
      .where(eq(rewardTables.kind, kind));
    return (row?.max ?? -1) + 1;
  }

  async function insertRow(
    tx: DbOrTx,
    kind: RewardTableKind,
    definition: Record<string, unknown>,
    hash: string,
    actor: string | null,
  ): Promise<RewardTableRow> {
    const id = String(definition.id);
    const shipped = shippedFor(kind, id);
    const [inserted] = await tx
      .insert(rewardTables)
      .values({
        kind,
        tableId: id,
        enabled: definition.enabled !== false,
        definition,
        contentHash: hash,
        // A table that ships in Git but was missing here (only before the
        // seed has run) is tracked against the shipped copy from the start.
        seedHash: shipped?.hash ?? null,
        position: shipped?.position ?? (await nextPosition(tx, kind)),
        updatedBy: actor,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw new RewardTableIdTakenError(kind, id);
    return inserted;
  }

  function idOf(input: unknown): string | null {
    if (input && typeof input === 'object' && typeof (input as { id?: unknown }).id === 'string') {
      return (input as { id: string }).id;
    }
    return null;
  }

  return {
    async list(kind) {
      const rows = await db
        .select()
        .from(rewardTables)
        .where(kind ? eq(rewardTables.kind, kind) : undefined)
        .orderBy(asc(rewardTables.kind), asc(rewardTables.position), asc(rewardTables.tableId));
      return rows.map(summaryOf);
    },

    async get(kind, id) {
      const row = await readRow(db, kind, id);
      if (!row) return null;
      return detailOf(row, await listRewardableDefinitions(db));
    },

    async validate(kind, table, id) {
      const definitions = await listRewardableDefinitions(db);
      const tableId = id ?? idOf(table) ?? '';
      const { issues, table: parsed } = validateRewardTable(kind, table, validationContext(kind, tableId, definitions));
      if (id && parsed && parsed.id !== id) {
        issues.unshift({ path: 'id', message: `the table id is "${id}" and cannot be changed`, severity: 'error' });
      }
      return issues;
    },

    async create(kind, input, actor) {
      return db.transaction(async (tx) => {
        const definitions = await listRewardableDefinitions(tx);
        const id = idOf(input) ?? '';
        if (RESERVED_REWARD_TABLE_IDS.has(id)) {
          throw new RewardTableInvalidError([
            { path: 'id', message: `"${id}" is reserved — choose another table id`, severity: 'error' },
          ]);
        }
        assertWritable(kind, id, input, definitions);
        if (await readRow(tx, kind, id)) throw new RewardTableIdTakenError(kind, id);
        const definition = input as Record<string, unknown>;
        const row = await insertRow(tx, kind, definition, rewardTableHash(kind, definition), actor);
        return detailOf(row, definitions);
      });
    },

    async update(kind, id, { table: input, expectedRevision }, actor) {
      return db.transaction(async (tx) => {
        const row = await readRow(tx, kind, id, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const definitions = await listRewardableDefinitions(tx);
        assertWritable(kind, id, input, definitions);
        const definition = input as Record<string, unknown>;
        const updated = await writeRow(tx, row, definition, rewardTableHash(kind, definition), actor);
        return detailOf(updated, definitions);
      });
    },

    async resetToShipped(kind, id, expectedRevision, actor) {
      const shipped = shippedFor(kind, id);
      if (!shipped) {
        throw new AppError(
          'NOT_FOUND',
          `Reward table ${kind}/"${id}" is not in this build's ${rewardTableFile(kind)}`,
          'This reward table does not ship with this build, so there is nothing to reset it to.',
        );
      }
      return db.transaction(async (tx) => {
        const row = await readRow(tx, kind, id, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const definitions = await listRewardableDefinitions(tx);
        assertWritable(kind, id, shipped.definition, definitions);
        const updated = await writeRow(tx, row, shipped.definition, shipped.hash, actor, {
          seedHash: shipped.hash,
        });
        return detailOf(updated, definitions);
      });
    },

    async delete(kind, id, expectedRevision) {
      return db.transaction(async (tx) => {
        const row = await readRow(tx, kind, id, true);
        if (!row) return false;
        assertRevision(row, expectedRevision);
        const refs = referencesOf(kind, id);
        if (refs.length > 0) {
          throw new RewardTableDeleteRefusedError(
            kind,
            id,
            `it is used by ${refs.map((r) => `${r.role === 'boss' ? 'boss' : 'mission'} "${r.key}"`).join(', ')}`,
          );
        }
        if (shippedFor(kind, id) || row.seedHash !== null) {
          throw new RewardTableDeleteRefusedError(kind, id, `it ships in ${rewardTableFile(kind)}`);
        }
        await tx
          .delete(rewardTables)
          .where(and(eq(rewardTables.kind, kind), eq(rewardTables.tableId, id)));
        return true;
      });
    },

    async listEquipmentDefinitions() {
      return listRewardableDefinitions(db);
    },

    async previewEquipment(selectors) {
      const definitions = await listRewardableDefinitions(db);
      return selectors.map((selector) => {
        const issues = equipmentSelectorIssues(selector, definitions);
        if (issues.length > 0) return { eligible: [], issues };
        const eligible = eligibleRewardDefinitions(EquipmentRewardSelectorSchema.parse(selector), definitions);
        return {
          eligible: eligible.map((d) => ({
            key: d.key,
            name: d.name,
            slot: d.slot as EquipmentRewardCandidate['slot'],
            rarity: d.rarity,
          })),
          issues: [],
        };
      });
    },

    async export(kind) {
      const rows = await db
        .select()
        .from(rewardTables)
        .where(eq(rewardTables.kind, kind))
        .orderBy(asc(rewardTables.position), asc(rewardTables.tableId));
      return { kind, file: rewardTableFile(kind), tables: rows.map((r) => r.definition) };
    },

    async planImport(kind, tables) {
      return planWith(db, kind, tables);
    },

    async applyImport(kind, tables, expectedRevisions, actor) {
      return db.transaction(async (tx) => {
        const plan = await planWith(tx, kind, tables, true);
        if (!plan.canApply) {
          throw new RewardTableInvalidError([
            ...plan.issues,
            ...plan.entries.flatMap((e) =>
              e.issues.map((i) => ({ ...i, path: `${e.id}.${i.path}` })),
            ),
          ]);
        }
        const result: RewardTableImportResult = { created: [], updated: [], unchanged: [] };
        for (const [index, entry] of plan.entries.entries()) {
          const expected = Object.prototype.hasOwnProperty.call(expectedRevisions, entry.id)
            ? expectedRevisions[entry.id]
            : undefined;
          // The plan the admin reviewed must be the plan being applied: a table
          // created or edited in between makes the whole import stale.
          if (expected === undefined || expected !== entry.currentRevision) {
            const row = await readRow(tx, kind, entry.id);
            throw new RewardTableStaleError(
              kind,
              entry.id,
              expected ?? -1,
              row?.revision ?? 0,
              row?.updatedBy ?? null,
              row?.updatedAt ?? new Date(),
            );
          }
          const definition = (tables as Record<string, unknown>[])[index]!;
          const hash = rewardTableHash(kind, definition);
          if (entry.action === 'unchanged') {
            result.unchanged.push(entry.id);
          } else if (entry.action === 'create') {
            await insertRow(tx, kind, definition, hash, actor);
            result.created.push(entry.id);
          } else {
            const row = (await readRow(tx, kind, entry.id, true))!;
            await writeRow(tx, row, definition, hash, actor);
            result.updated.push(entry.id);
          }
        }
        return result;
      });
    },
  };

  async function planWith(
    tx: DbOrTx,
    kind: RewardTableKind,
    tables: unknown,
    lock = false,
  ): Promise<RewardTableImportPlan> {
    const issues: RewardTableIssue[] = [];
    if (!Array.isArray(tables)) {
      issues.push({ path: 'tables', message: `expected the contents of ${rewardTableFile(kind)}: an array of tables`, severity: 'error' });
      return { kind, entries: [], issues, canApply: false };
    }
    if (tables.length === 0) {
      issues.push({ path: 'tables', message: 'the package contains no tables', severity: 'error' });
    }
    const definitions = await listRewardableDefinitions(tx);
    const seen = new Set<string>();
    const entries: RewardTableImportPlanEntry[] = [];
    for (const [index, input] of tables.entries()) {
      const id = idOf(input) ?? `#${index}`;
      if (seen.has(id)) {
        issues.push({ path: `tables[${index}].id`, message: `"${id}" appears twice in the package`, severity: 'error' });
      }
      seen.add(id);
      const { table, issues: tableIssues } = validateRewardTable(kind, input, validationContext(kind, id, definitions));
      const row = table ? await readRow(tx, kind, id, lock) : undefined;
      const invalid = !table || tableIssues.some((i) => i.severity === 'error');
      const action: RewardTableImportAction = invalid
        ? 'invalid'
        : !row
          ? 'create'
          : row.contentHash === rewardTableHash(kind, input)
            ? 'unchanged'
            : 'update';
      entries.push({ id, action, currentRevision: row?.revision ?? null, issues: tableIssues });
    }
    const canApply =
      !issues.some((i) => i.severity === 'error') && entries.every((e) => e.action !== 'invalid');
    return { kind, entries, issues, canApply };
  }
}
