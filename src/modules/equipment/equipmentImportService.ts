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
  uniqueViolationConstraint,
  type EquipmentIssue,
} from '../../shared/errors';
import { definitionColumnValues, definitionInputFromRow } from './definitionSchema';
import {
  buildEquipmentPackage,
  parseEquipmentPackage,
  planEquipmentImport,
  type EquipmentImportPlan,
  type EquipmentPackage,
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
}

export interface EquipmentPromotionService {
  exportPackage(opts?: { keys?: readonly string[]; label?: string | null; now?: Date }): Promise<EquipmentPackage>;
  /**
   * Validate and plan without writing anything.
   * @throws {EquipmentValidationError} for a malformed package.
   */
  previewImport(raw: unknown): Promise<EquipmentImportPlan>;
  /**
   * @throws {EquipmentValidationError} for a malformed package.
   * @throws {EquipmentImportRejectedError} when the plan has issues.
   */
  applyImport(
    raw: unknown,
    opts?: { actorDiscordId?: string | null; sourceFilename?: string | null },
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
    target.set(row.key, { input: definitionInputFromRow(row), instanceCount: countById.get(row.id) ?? 0 });
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
  function applyInTransaction(
    pkg: EquipmentPackage,
    opts: { actorDiscordId?: string | null; sourceFilename?: string | null },
    onCreate: (key: string) => void,
  ): Promise<ApplyImportResult> {
    return db.transaction(async (tx) => {
      const { rows, target } = await readTarget(tx, pkg.definitions.map((d) => d.key), true);
      const plan = planEquipmentImport(pkg, target);
      if (!plan.ok) throw new EquipmentImportRejectedError(plan);

      const touched: string[] = [];
      for (const definition of pkg.definitions) {
        const entry = plan.entries.find((e) => e.key === definition.key)!;
        if (entry.action === 'create') {
          onCreate(definition.key);
          await tx
            .insert(equipmentDefinitions)
            .values({ ...definitionColumnValues(definition), updatedBy: opts.actorDiscordId ?? null });
          touched.push(definition.key);
        } else if (entry.action === 'update') {
          await tx
            .update(equipmentDefinitions)
            .set({
              ...definitionColumnValues(definition),
              updatedAt: sql`now()`,
              updatedBy: opts.actorDiscordId ?? null,
            })
            .where(eq(equipmentDefinitions.id, rows.get(definition.key)!.id));
          touched.push(definition.key);
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
      return { plan, logId: log!.id };
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

    async previewImport(raw) {
      const pkg = parseEquipmentPackage(raw);
      const { target } = await readTarget(db, pkg.definitions.map((d) => d.key), false);
      return planEquipmentImport(pkg, target);
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
