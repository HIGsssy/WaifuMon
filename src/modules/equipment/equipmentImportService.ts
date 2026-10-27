/**
 * Applying and exporting equipment packages — the only place a package plan
 * is written. Split from the pure `equipmentPackage.ts` exactly as
 * `encounterImportService.ts` is split from `encounterPackage.ts`.
 *
 * ## One transaction, or nothing
 *
 * `applyImport` validates the whole package, then opens one transaction,
 * locks the definitions it names, **recomputes the plan inside the
 * transaction** (a preview is a read of a moment that has passed), refuses the
 * whole package if the plan has any issue, writes every create and update, and
 * writes the `equipment_import_log` row. The log row therefore exists if and
 * only if the content landed.
 *
 * Two imports creating the same *new* key cannot both win: the loser's insert
 * waits on the key's unique index and fails when the winner commits. That is
 * reported as `EquipmentImportConflictError` — the whole losing import has
 * rolled back, so the caller previews again and retries — never as a raw
 * duplicate-key error.
 *
 * ## What import never does
 *
 * It never deletes, and it never rewrites a definition the plan found
 * `unchanged` — so re-importing an identical package touches nothing, not even
 * `updated_at`.
 *
 * ## Admin Equipment Catalogue (E3-D)
 *
 * With `catalogueDefaults`, new definitions start disabled and updated ones
 * keep their enabled state (`applyCatalogueImportDefaults`). A preview
 * returns a `planHash`; applying with `expectedPlanHash` refuses with
 * `EquipmentImportStaleError` if the catalogue moved in between. Every write
 * increments the definition's `revision` and appends an `imported`
 * `equipment_admin_events` row beside the `equipment_import_log` row.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  equipmentDefinitions,
  equipmentImportLog,
  playerEquipment,
  type EquipmentDefinitionRow,
} from '../../db/schema';
import {
  AppError,
  EquipmentImportConflictError,
  EquipmentImportStaleError,
  uniqueViolationConstraint,
  type EquipmentIssue,
} from '../../shared/errors';
import { definitionColumnValues, definitionInputFromRow } from './definitionSchema';
import { readPublishedRollRules, recordEquipmentAdminEvent } from './equipmentRollRulesService';
import {
  applyCatalogueImportDefaults,
  buildEquipmentPackage,
  importPlanHash,
  parseEquipmentPackage,
  planEquipmentImport,
  type EquipmentImportPlan,
  type EquipmentPackage,
  type ImportStatusNote,
  type ImportTargetDefinition,
} from './equipmentPackage';

/** The unique constraint on `equipment_definitions.key` (see 0045). */
const DEFINITION_KEY_CONSTRAINT = 'equipment_definitions_key_unique';

/** A valid package this server refuses to apply (see `plan.issues`). */
export class EquipmentImportRejectedError extends AppError {
  readonly plan: EquipmentImportPlan;
  readonly issues: EquipmentIssue[];
  constructor(plan: EquipmentImportPlan) {
    const issues = plan?.issues ?? [];
    const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    super(
      'EQUIPMENT_IMPORT_REJECTED',
      `Equipment package refused: ${summary}`,
      summary || 'That equipment package cannot be applied here.',
    );
    this.plan = plan;
    this.issues = issues;
  }
}

export interface ApplyImportResult {
  plan: EquipmentImportPlan;
  logId: number;
  planHash: string;
  /** Enabled values the Catalogue defaults overrode. */
  statusNotes: ImportStatusNote[];
}

/** A plan, the package it planned (after any defaults) and its fingerprint. */
export interface ImportPreview extends EquipmentImportPlan {
  planHash: string;
  statusNotes: ImportStatusNote[];
  /** The package as it would be applied. */
  package: EquipmentPackage;
}

export interface ImportOptions {
  /** New definitions start disabled; updated ones keep their enabled state (E3-D). */
  catalogueDefaults?: boolean;
}

export interface EquipmentPromotionService {
  exportPackage(opts?: { keys?: readonly string[]; label?: string | null; now?: Date }): Promise<EquipmentPackage>;
  /**
   * Validate and plan without writing anything.
   * @throws {EquipmentValidationError} for a malformed package.
   */
  previewImport(raw: unknown, opts?: ImportOptions): Promise<ImportPreview>;
  /**
   * @throws {EquipmentValidationError} for a malformed package.
   * @throws {EquipmentImportRejectedError} when the plan has issues.
   * @throws {EquipmentImportStaleError} when `expectedPlanHash` no longer matches.
   */
  applyImport(
    raw: unknown,
    opts?: ImportOptions & { actorDiscordId?: string | null; sourceFilename?: string | null; expectedPlanHash?: string },
  ): Promise<ApplyImportResult>;
}

/** What the target holds for the given keys, locked when `lock` is set. */
async function readTarget(
  tx: DbOrTx,
  keys: readonly string[],
  lock: boolean,
): Promise<{ rows: Map<string, EquipmentDefinitionRow>; target: Map<string, ImportTargetDefinition> }> {
  const rows = new Map<string, EquipmentDefinitionRow>();
  const target = new Map<string, ImportTargetDefinition>();
  if (keys.length === 0) return { rows, target };

  const query = tx.select().from(equipmentDefinitions).where(inArray(equipmentDefinitions.key, [...keys]));
  const found = lock ? await query.for('update') : await query;
  if (found.length === 0) return { rows, target };

  const counts = await tx
    .select({ definitionId: playerEquipment.definitionId, n: sql<number>`count(*)::int` })
    .from(playerEquipment)
    .where(inArray(playerEquipment.definitionId, found.map((r) => r.id)))
    .groupBy(playerEquipment.definitionId);
  const countById = new Map(counts.map((c) => [c.definitionId, c.n]));

  for (const row of found) {
    rows.set(row.key, row);
    target.set(row.key, {
      input: definitionInputFromRow(row),
      instanceCount: countById.get(row.id) ?? 0,
      revision: row.revision,
    });
  }
  return { rows, target };
}

export function createEquipmentPromotionService(deps: { db: Db }): EquipmentPromotionService {
  const { db } = deps;

  /**
   * The import itself: lock what exists, re-plan, refuse or write everything,
   * log. `onCreate` reports each key just before it is inserted, so a unique
   * violation can be attributed to the definition that lost the race.
   */
  /** Plan `parsed` against `target`, with the Catalogue defaults when asked. */
  function planAgainst(
    parsed: EquipmentPackage,
    target: Map<string, ImportTargetDefinition>,
    rules: Parameters<typeof planEquipmentImport>[2],
    opts: ImportOptions,
  ) {
    const adjusted = opts.catalogueDefaults ? applyCatalogueImportDefaults(parsed, target) : { pkg: parsed, notes: [] };
    return {
      pkg: adjusted.pkg,
      statusNotes: adjusted.notes,
      plan: planEquipmentImport(adjusted.pkg, target, rules),
      planHash: importPlanHash(adjusted.pkg, target),
    };
  }

  function applyInTransaction(
    parsed: EquipmentPackage,
    opts: ImportOptions & { actorDiscordId?: string | null; sourceFilename?: string | null; expectedPlanHash?: string },
    onCreate: (key: string) => void,
  ): Promise<ApplyImportResult> {
    return db.transaction(async (tx) => {
      const { rows, target } = await readTarget(tx, parsed.definitions.map((d) => d.key), true);
      const { pkg, plan, planHash, statusNotes } = planAgainst(
        parsed,
        target,
        (await readPublishedRollRules(tx))?.rules ?? null,
        opts,
      );
      if (opts.expectedPlanHash !== undefined && opts.expectedPlanHash !== planHash) throw new EquipmentImportStaleError();
      if (!plan.ok) throw new EquipmentImportRejectedError(plan);

      const actor = opts.actorDiscordId ?? null;
      const touched: string[] = [];
      const audits: { key: string; action: 'create' | 'update'; changedFields: string[]; revision: number }[] = [];
      for (const definition of pkg.definitions) {
        const entry = plan.entries.find((e) => e.key === definition.key)!;
        if (entry.action === 'create') {
          onCreate(definition.key);
          await tx
            .insert(equipmentDefinitions)
            .values({ ...definitionColumnValues(definition), updatedBy: actor });
          touched.push(definition.key);
          audits.push({ key: definition.key, action: 'create', changedFields: [], revision: 1 });
        } else if (entry.action === 'update') {
          const existing = rows.get(definition.key)!;
          await tx
            .update(equipmentDefinitions)
            .set({
              ...definitionColumnValues(definition),
              revision: existing.revision + 1,
              updatedAt: sql`now()`,
              updatedBy: actor,
            })
            .where(eq(equipmentDefinitions.id, existing.id));
          touched.push(definition.key);
          audits.push({ key: definition.key, action: 'update', changedFields: entry.changedFields, revision: existing.revision + 1 });
        }
      }

      const [log] = await tx
        .insert(equipmentImportLog)
        .values({
          actorDiscordUserId: opts.actorDiscordId ?? null,
          packageFormat: pkg.format,
          packageVersion: pkg.version,
          packageExportedAt: pkg.exportedAt,
          packageLabel: pkg.label,
          sourceFilename: opts.sourceFilename ?? null,
          createdCount: plan.counts.create,
          updatedCount: plan.counts.update,
          unchangedCount: plan.counts.unchanged,
          definitionKeys: touched,
        })
        .returning({ id: equipmentImportLog.id });
      for (const audit of audits) {
        await recordEquipmentAdminEvent(
          tx,
          'definition',
          audit.key,
          'imported',
          {
            importAction: audit.action,
            importLogId: log!.id,
            revision: audit.revision,
            changedFields: audit.changedFields,
            packageVersion: pkg.version,
            packageLabel: pkg.label,
          },
          actor,
        );
      }
      return { plan, logId: log!.id, planHash, statusNotes };
    });
  }

  return {
    async exportPackage(opts = {}) {
      const rows =
        opts.keys && opts.keys.length > 0
          ? await db.select().from(equipmentDefinitions).where(inArray(equipmentDefinitions.key, [...opts.keys]))
          : await db.select().from(equipmentDefinitions);
      return buildEquipmentPackage(rows, {
        exportedAt: (opts.now ?? new Date()).toISOString(),
        label: opts.label ?? null,
      });
    },

    async previewImport(raw, opts = {}) {
      const parsed = parseEquipmentPackage(raw);
      const { target } = await readTarget(db, parsed.definitions.map((d) => d.key), false);
      const { pkg, plan, planHash, statusNotes } = planAgainst(
        parsed,
        target,
        (await readPublishedRollRules(db))?.rules ?? null,
        opts,
      );
      return { ...plan, planHash, statusNotes, package: pkg };
    },

    async applyImport(raw, opts = {}) {
      const pkg = parseEquipmentPackage(raw);
      let creating: string | null = null;
      try {
        return await applyInTransaction(pkg, opts, (key) => {
          creating = key;
        });
      } catch (err) {
        // The planner locks only definitions that already exist, so two
        // imports creating the same *new* key both plan a create; the second
        // waits on the unique index and fails once the first commits. Its
        // whole transaction has rolled back — nothing from the package landed
        // and no log row was written — so this is a "the catalogue changed,
        // preview and retry" refusal, not a server fault.
        if (uniqueViolationConstraint(err) === DEFINITION_KEY_CONSTRAINT) {
          throw new EquipmentImportConflictError(creating);
        }
        throw err;
      }
    },
  };
}
