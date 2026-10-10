/** Draft-only imports. Review is read-only; application re-plans under locks and records a receipt in the same transaction. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../../db/client';
import {
  artworkAssets,
  combatEnemies,
  dungeonContentEvents,
  dungeonDefinitions,
  dungeonImportHistory,
  equipmentDefinitions,
  progressionCurrencies,
  rewardTables,
} from '../../../db/schema';
import { DungeonImportError, uniqueViolationConstraint, type DungeonIssueDetail } from '../../../shared/errors';
import type { ArtworkStorage } from '../../artworkAssets/artworkStorage';
import { enemyColumnsOf, enemyDefinitionOf } from '../../enemies/enemyStore';
import { canonicalJson, validateRewardTable } from '../../rewardTables/rewardTableCore';
import { dungeonDependencies } from '../content/dungeonDefinition';
import { pruneDungeonLayout } from '../content/dungeonLayout';
import { validateDungeonDefinition, type DungeonValidationContext } from '../validation/dungeonValidation';
import { packagedEnemyHash, readDungeonPackage, type ReadDungeonPackageResult } from './dungeonPackage';

const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const importIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string(),
});
export const DungeonImportPlanSchema = z.object({
  validPackage: z.boolean(),
  packageId: z.string().uuid().nullable(),
  packageHash: hashSchema.nullable(),
  sourceEnvironment: z.string().nullable(),
  dungeonKey: z.string().nullable(),
  contentHash: hashSchema.nullable(),
  planHash: hashSchema.nullable(),
  target: z
    .object({
      status: z.enum(['new', 'different', 'identical']),
      expectedRevision: z.number().int().positive().nullable(),
      currentContentHash: z.string().nullable(),
      changedFields: z.array(z.string()),
    })
    .nullable(),
  enemies: z.array(
    z.object({
      key: z.string(),
      status: z.enum(['identical', 'different', 'existing_unverified', 'missing_bundled', 'missing']),
      currentRevision: z.number().int().positive().nullable(),
      currentHash: z.string().nullable(),
      incomingHash: z.string().nullable(),
      changedFields: z.array(z.string()),
    }),
  ),
  issues: z.array(importIssueSchema),
  publishable: z.boolean(),
});
export const DungeonImportResultSchema = z.object({
  importId: z.number().int().positive(),
  dungeonKey: z.string(),
  result: z.enum(['created', 'replaced', 'unchanged']),
  draftRevision: z.number().int().positive(),
  createdEnemies: z.array(z.string()),
  issues: z.array(importIssueSchema),
  publishable: z.boolean(),
  replayed: z.boolean(),
});
export const DungeonImportHistorySchema = z.object({
  imports: z.array(
    z.object({
      id: z.number().int().positive(),
      packageId: z.string().uuid(),
      packageHash: hashSchema,
      sourceEnvironment: z.string(),
      dungeonKey: z.string(),
      actor: z.string().nullable(),
      importedAt: z.string().datetime(),
      decisions: z.record(z.unknown()),
      result: z.record(z.unknown()),
    }),
  ),
});
export const DungeonImportDecisionsSchema = z
  .object({
    dungeon: z.enum(['create', 'replace', 'unchanged']),
    enemies: z.record(z.string(), z.enum(['create', 'use_existing', 'leave_missing'])),
    /** Explicitly accept a draft that still needs global enemies/tables/regions/currencies installed. */
    allowMissingDependencies: z.boolean(),
  })
  .strict();
export const DungeonImportApplySchema = z
  .object({
    package: z.unknown(),
    requestId: z.string().uuid(),
    expectedPlanHash: hashSchema,
    expectedRevision: z.number().int().positive().nullable(),
    decisions: DungeonImportDecisionsSchema,
  })
  .strict();
export type DungeonImportApplyInput = z.infer<typeof DungeonImportApplySchema>;
export type DungeonImportDecisions = z.infer<typeof DungeonImportDecisionsSchema>;
export interface DungeonImportEnemyPlan {
  key: string;
  status: 'identical' | 'different' | 'existing_unverified' | 'missing_bundled' | 'missing';
  currentRevision: number | null;
  currentHash: string | null;
  incomingHash: string | null;
  changedFields: string[];
}
export interface DungeonImportPlan {
  validPackage: boolean;
  packageId: string | null;
  packageHash: string | null;
  sourceEnvironment: string | null;
  dungeonKey: string | null;
  contentHash: string | null;
  planHash: string | null;
  target: {
    status: 'new' | 'different' | 'identical';
    expectedRevision: number | null;
    currentContentHash: string | null;
    changedFields: string[];
  } | null;
  enemies: DungeonImportEnemyPlan[];
  issues: DungeonIssueDetail[];
  publishable: boolean;
}
export interface DungeonImportResult {
  importId: number;
  dungeonKey: string;
  result: 'created' | 'replaced' | 'unchanged';
  draftRevision: number;
  createdEnemies: string[];
  issues: DungeonIssueDetail[];
  publishable: boolean;
  replayed: boolean;
}
export interface DungeonImportService {
  planImport(raw: unknown): Promise<DungeonImportPlan>;
  applyImport(input: DungeonImportApplyInput, actor: string | null): Promise<DungeonImportResult>;
  importHistory(
    key: string,
    limit?: number,
  ): Promise<
    {
      id: number;
      packageId: string;
      packageHash: string;
      sourceEnvironment: string;
      dungeonKey: string;
      actor: string | null;
      importedAt: Date;
      decisions: Record<string, unknown>;
      result: Record<string, unknown>;
    }[]
  >;
}
export interface DungeonImportDeps {
  db: Db;
  reservedKeys: ReadonlySet<string>;
  getRegions: () => readonly { id: string; enabled: boolean }[];
  getItemSlugs?: (() => readonly string[]) | undefined;
  assetsDir?: string | undefined;
  artworkStorage?: Pick<ArtworkStorage, 'exists'> | undefined;
}
export function importHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
/** Bound nesting before recursive schema parsing; JSON routes already bound bytes. */
export function readImportPackage(raw: unknown): ReadDungeonPackageResult {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return readDungeonPackage(raw);
    }
  }
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 64 || ++nodes > 200_000)
      return {
        package: null,
        ok: false,
        issues: [
          {
            code: 'package_schema',
            severity: 'error',
            path: '',
            message: 'Package nesting or node count exceeds the import parsing limit.',
          },
        ],
      };
    if (current.value && typeof current.value === 'object')
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
  }
  return readDungeonPackage(value);
}
function changedFields(before: unknown, after: unknown): string[] {
  const a = before as Record<string, unknown>,
    b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((k) => canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null));
}
function refused(
  code: 'DUNGEON_IMPORT_INVALID' | 'DUNGEON_IMPORT_STALE' | 'DUNGEON_IMPORT_REQUEST_CONFLICT',
  path: string,
  message: string,
): never {
  throw new DungeonImportError(code, [{ code: code.toLowerCase(), severity: 'error', path, message }]);
}
const MISSING_DEPENDENCIES = new Set(['enemy_missing', 'reward_table_missing', 'region_missing', 'currency_missing']);

export function createDungeonImportService(deps: DungeonImportDeps): DungeonImportService {
  const { db } = deps;
  async function inspect(tx: DbOrTx, raw: unknown, lock = false) {
    const read = readImportPackage(raw);
    const pkg = read.package;
    const empty: DungeonImportPlan = {
      validPackage: read.ok,
      packageId: pkg?.packageId ?? null,
      packageHash: pkg ? importHash(pkg) : null,
      sourceEnvironment: pkg?.source.environment ?? null,
      dungeonKey: pkg?.dungeon.key ?? null,
      contentHash: pkg?.contentHash ?? null,
      planHash: null,
      target: null,
      enemies: [],
      issues: [...read.issues],
      publishable: false,
    };
    if (!pkg || !read.ok)
      return {
        plan: empty,
        pkg,
        context: {} as DungeonValidationContext,
        dependencyIssues: [] as DungeonIssueDetail[],
      };
    const dependency = dungeonDependencies(pkg.dungeon);
    const key = pkg.dungeon.key;
    if (lock) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dungeon_import:key:${key}`}, 0))`);
      for (const enemy of [...dependency.enemies].sort())
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dungeon_import:enemy:${enemy}`}, 0))`);
    }
    const targetQuery = tx.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
    const [targetRow] = lock ? await targetQuery.for('update') : await targetQuery;
    const enemyQuery = tx
      .select()
      .from(combatEnemies)
      .where(inArray(combatEnemies.enemyKey, dependency.enemies))
      .orderBy(asc(combatEnemies.enemyKey));
    const enemies = dependency.enemies.length ? (lock ? await enemyQuery.for('share') : await enemyQuery) : [];
    const tableQuery = tx
      .select()
      .from(rewardTables)
      .where(and(eq(rewardTables.kind, 'expedition'), inArray(rewardTables.tableId, dependency.rewardTables)))
      .orderBy(asc(rewardTables.tableId));
    const tables = dependency.rewardTables.length ? (lock ? await tableQuery.for('share') : await tableQuery) : [];
    const currencyQuery = tx
      .select()
      .from(progressionCurrencies)
      .where(inArray(progressionCurrencies.currencyKey, dependency.currencies))
      .orderBy(asc(progressionCurrencies.currencyKey));
    const currencies = dependency.currencies.length
      ? lock
        ? await currencyQuery.for('share')
        : await currencyQuery
      : [];
    const managedRefs = dependency.artwork.filter((a) => a.kind === 'managed');
    const managedQuery = tx
      .select()
      .from(artworkAssets)
      .where(
        and(
          eq(artworkAssets.status, 'active'),
          or(
            ...managedRefs.map((a) =>
              and(sql`${artworkAssets.category} = ${a.category}`, eq(artworkAssets.contentHash, a.contentHash)),
            ),
          ),
        ),
      )
      .orderBy(asc(artworkAssets.id));
    const managed = managedRefs.length ? (lock ? await managedQuery.for('share') : await managedQuery) : [];
    const managedState = await Promise.all(
      managed.map(async (a) => ({
        id: a.id,
        category: a.category,
        hash: a.contentHash,
        version: a.version,
        storageKey: a.storageKey,
        present: deps.artworkStorage ? await deps.artworkStorage.exists(a.storageKey) : true,
      })),
    );
    const ship = (relative: string) => {
      if (!deps.assetsDir) return false;
      try {
        const root = fs.realpathSync(deps.assetsDir);
        const file = fs.realpathSync(path.resolve(root, relative));
        return file.startsWith(`${root}${path.sep}`) && fs.statSync(file).isFile();
      } catch {
        return false;
      }
    };
    const regions = deps.getRegions().filter((r) => dependency.regions.includes(r.id));
    const itemSlugs = [...(deps.getItemSlugs?.() ?? [])].sort();
    const context: DungeonValidationContext = {
      enemies: new Map(enemies.map((e) => [e.enemyKey, { enabled: e.enabled }])),
      rewardTables: new Map(tables.map((t) => [t.tableId, { enabled: t.enabled }])),
      currencies: new Map(currencies.map((c) => [c.currencyKey, { enabled: c.enabled }])),
      regions: new Map(regions.map((r) => [r.id, { enabled: r.enabled }])),
      managedArtwork: new Set(managedState.filter((a) => a.present).map((a) => `${a.category}:${a.hash}`)),
      shippedArtworkExists: ship,
    };
    // Gear selectors may name keys or whole pools. Lock the selector catalogue only when a table uses gear.
    const gearNeeded = tables.some((t) => (JSON.stringify(t.definition?.groups) ?? '').includes('"equipment"'));
    const gearQuery = tx
      .select({
        key: equipmentDefinitions.key,
        name: equipmentDefinitions.name,
        slot: equipmentDefinitions.slot,
        rarity: equipmentDefinitions.rarity,
        enabled: equipmentDefinitions.enabled,
      })
      .from(equipmentDefinitions)
      .orderBy(asc(equipmentDefinitions.key));
    const gear = gearNeeded ? (lock ? await gearQuery.for('share') : await gearQuery) : [];
    const dependencyIssues: DungeonIssueDetail[] = tables.flatMap((t) =>
      validateRewardTable('expedition', t.definition, {
        itemSlugs: new Set(itemSlugs),
        definitions: gear,
        references: [],
      }).issues.map((i) => ({
        ...i,
        code: i.path.endsWith('.itemId') ? 'item_missing' : 'reward_dependency_invalid',
        path: `dependencies.rewardTables.${t.tableId}.${i.path}`,
      })),
    );
    const issues: DungeonIssueDetail[] = [
      ...read.issues,
      ...dependencyIssues,
      ...validateDungeonDefinition(pkg.dungeon, context).issues.map((i) => ({
        ...i,
        path: `dungeon.${i.path}`,
      })),
    ];
    if (deps.reservedKeys.has(key))
      issues.push({
        code: 'reserved_dungeon_key',
        severity: 'error',
        path: 'dungeon.key',
        message: `Dungeon key "${key}" is reserved.`,
      });
    for (const member of ['species', 'items', 'equipment'] as const)
      if (pkg.dependencies[member].length)
        issues.push({
          code: 'package_dependencies_mismatch',
          severity: 'error',
          path: `dependencies.${member}`,
          message: `Phase 1A dungeons do not reference ${member} directly; this reserved manifest member must be empty.`,
        });
    if (managed.length && !deps.artworkStorage)
      issues.push({
        code: 'artwork_unverified',
        severity: 'warning',
        path: 'assets',
        message: 'Managed artwork rows exist, but byte storage was not configured for verification.',
      });
    if (dependency.rewardTables.length || dependency.currencies.length || dependency.regions.length)
      issues.push({
        code: 'dependency_hash_unavailable',
        severity: 'warning',
        path: 'dependencies',
        message:
          'This package records only keys for reward tables, regions and currencies. Their target availability is checked, but source definitions cannot be compared; promote those shared definitions separately when needed.',
      });
    const enemyPlans: DungeonImportEnemyPlan[] = pkg.dependencies.enemies.map((incoming) => {
      const current = enemies.find((e) => e.enemyKey === incoming.key);
      const bundled = pkg.bundled.enemies.find((e) => e.key === incoming.key);
      const currentHash = current ? packagedEnemyHash(enemyDefinitionOf(current)) : null;
      const incomingHash = incoming.contentHash ?? (bundled ? packagedEnemyHash(bundled) : null);
      const status = current
        ? incomingHash === null
          ? 'existing_unverified'
          : currentHash === incomingHash
            ? 'identical'
            : 'different'
        : bundled
          ? 'missing_bundled'
          : 'missing';
      if (status === 'different' || status === 'existing_unverified')
        issues.push({
          code: 'enemy_conflict',
          severity: 'warning',
          path: `dependencies.enemies.${incoming.key}`,
          message: `Enemy "${incoming.key}" ${status === 'different' ? 'differs from the source' : 'has no source hash'}. Explicitly keep the target definition, or reconcile it separately; import cannot overwrite it.`,
        });
      return {
        key: incoming.key,
        status,
        currentRevision: current?.revision ?? null,
        currentHash,
        incomingHash,
        changedFields: current && bundled ? changedFields(enemyDefinitionOf(current), bundled) : [],
      };
    });
    const layout = pruneDungeonLayout(
      pkg.editor.layout,
      pkg.dungeon.rooms.map((r) => r.id),
    );
    const fields = targetRow
      ? [
          ...changedFields(targetRow.draft, pkg.dungeon),
          ...(canonicalJson(targetRow.layout) === canonicalJson(layout) ? [] : ['editor.layout']),
        ]
      : [];
    const target: NonNullable<DungeonImportPlan['target']> = {
      status: targetRow ? (fields.length ? 'different' : 'identical') : 'new',
      expectedRevision: targetRow?.draftRevision ?? null,
      currentContentHash: targetRow?.draftHash ?? null,
      changedFields: fields,
    };
    const shippedPaths = new Set(dependency.artwork.flatMap((a) => (a.kind === 'shipped' ? [a.path] : [])));
    for (const enemy of pkg.bundled.enemies)
      for (const relative of [enemy.artworkPath, enemy.spriteArtworkPath])
        if (relative) {
          shippedPaths.add(relative);
          if (!ship(relative))
            issues.push({
              code: 'artwork_missing',
              severity: 'warning',
              path: `bundled.enemies.${enemy.key}`,
              message: `Enemy artwork "${relative}" is missing; deploy it separately.`,
            });
        }
    const packageHash = importHash(pkg);
    const planHash = importHash({
      packageHash,
      target: targetRow
        ? {
            revision: targetRow.draftRevision,
            hash: targetRow.draftHash,
            layout: targetRow.layout,
            published: targetRow.publishedRevisionId,
            enabled: targetRow.enabled,
          }
        : null,
      enemies: enemies.map((e) => ({
        key: e.enemyKey,
        revision: e.revision,
        hash: packagedEnemyHash(enemyDefinitionOf(e)),
        artworkAssetId: e.artworkAssetId,
        spriteAssetId: e.spriteAssetId,
      })),
      tables: tables.map((t) => ({
        id: t.tableId,
        revision: t.revision,
        definition: t.definition,
      })),
      currencies: currencies.map((c) => ({
        key: c.currencyKey,
        enabled: c.enabled,
        revision: c.revision,
      })),
      regions,
      managed: managedState,
      shipped: [...shippedPaths].sort().map((p) => ({ path: p, present: ship(p) })),
      gear,
      items: tables.length ? itemSlugs : [],
      issues,
    });
    return {
      pkg,
      context,
      dependencyIssues,
      plan: {
        ...empty,
        target,
        planHash,
        enemies: enemyPlans,
        issues,
        publishable: !issues.some((i) => i.severity === 'error'),
      },
    };
  }
  return {
    async planImport(raw) {
      return db.transaction(async (tx) => (await inspect(tx, raw)).plan, {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    },
    async applyImport(rawInput, actor) {
      const parsedInput = DungeonImportApplySchema.safeParse(rawInput);
      if (!parsedInput.success)
        throw new DungeonImportError(
          'DUNGEON_IMPORT_INVALID',
          parsedInput.error.issues.map((i) => ({
            code: 'schema',
            severity: 'error',
            path: i.path.join('.'),
            message: i.message,
          })),
        );
      const input = parsedInput.data;
      const read = readImportPackage(input.package);
      if (!read.package || !read.ok) throw new DungeonImportError('DUNGEON_IMPORT_INVALID', read.issues);
      const pkg = read.package;
      const requestHash = importHash({
        packageHash: importHash(pkg),
        expectedPlanHash: input.expectedPlanHash,
        expectedRevision: input.expectedRevision,
        decisions: input.decisions,
        actor,
      });
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`dungeon_import:request:${input.requestId}`}, 0))`,
          );
          const [receipt] = await tx
            .select()
            .from(dungeonImportHistory)
            .where(eq(dungeonImportHistory.requestId, input.requestId));
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              refused(
                'DUNGEON_IMPORT_REQUEST_CONFLICT',
                'requestId',
                'This request ID already belongs to a different package, decision, plan or administrator.',
              );
            return {
              ...(receipt.result as unknown as DungeonImportResult),
              importId: receipt.id,
              replayed: true,
            };
          }
          const { plan, context, dependencyIssues } = await inspect(tx, pkg, true);
          if (plan.planHash !== input.expectedPlanHash || plan.target?.expectedRevision !== input.expectedRevision)
            refused(
              'DUNGEON_IMPORT_STALE',
              'expectedPlanHash',
              'The target draft or a reviewed dependency changed; plan again.',
            );
          const target = plan.target!;
          const requiredDecision =
            target.status === 'new' ? 'create' : target.status === 'identical' ? 'unchanged' : 'replace';
          if (input.decisions.dungeon !== requiredDecision)
            refused(
              'DUNGEON_IMPORT_INVALID',
              'decisions.dungeon',
              `This plan requires the explicit "${requiredDecision}" decision.`,
            );
          for (const key of Object.keys(input.decisions.enemies))
            if (!plan.enemies.some((e) => e.key === key))
              refused(
                'DUNGEON_IMPORT_INVALID',
                `decisions.enemies.${key}`,
                'This enemy is not referenced by the package.',
              );
          const createdEnemies: string[] = [];
          for (const enemy of plan.enemies) {
            const decision = Object.prototype.hasOwnProperty.call(input.decisions.enemies, enemy.key)
              ? input.decisions.enemies[enemy.key]
              : undefined;
            if (enemy.status === 'identical') {
              if (decision && decision !== 'use_existing')
                refused(
                  'DUNGEON_IMPORT_INVALID',
                  `decisions.enemies.${enemy.key}`,
                  'An existing enemy cannot be created or replaced by import.',
                );
            } else if (enemy.currentRevision !== null) {
              if (decision !== 'use_existing')
                refused(
                  'DUNGEON_IMPORT_INVALID',
                  `decisions.enemies.${enemy.key}`,
                  'Explicitly keep the differing target enemy or reconcile it separately before import.',
                );
            } else if (decision === 'create' && enemy.status === 'missing_bundled') {
              const definition = pkg.bundled.enemies.find((e) => e.key === enemy.key)!;
              const [{ position } = { position: 0 }] = await tx
                .select({
                  position: sql<number>`coalesce(max(${combatEnemies.position}), -1) + 1`,
                })
                .from(combatEnemies);
              const [inserted] = await tx
                .insert(combatEnemies)
                .values({
                  enemyKey: enemy.key,
                  ...enemyColumnsOf(definition),
                  contentHash: packagedEnemyHash(definition),
                  position: Number(position),
                  updatedBy: actor,
                })
                .onConflictDoNothing()
                .returning();
              if (!inserted)
                refused(
                  'DUNGEON_IMPORT_STALE',
                  `dependencies.enemies.${enemy.key}`,
                  'An enemy was created after planning.',
                );
              createdEnemies.push(enemy.key);
              (context.enemies as Map<string, { enabled: boolean }>).set(enemy.key, { enabled: definition.enabled });
            } else if (!(decision === 'leave_missing' && input.decisions.allowMissingDependencies))
              refused(
                'DUNGEON_IMPORT_INVALID',
                `decisions.enemies.${enemy.key}`,
                'Explicitly create a bundled missing enemy, or accept an incomplete draft with leave_missing.',
              );
          }
          const issues: DungeonIssueDetail[] = [
            ...new Map(
              [
                ...plan.issues.filter((i) => i.severity === 'warning'),
                ...dependencyIssues,
                ...validateDungeonDefinition(pkg.dungeon, context).issues.map((i) => ({
                  ...i,
                  path: `dungeon.${i.path}`,
                })),
              ].map((i) => [`${i.code}:${i.path}:${i.message}`, i]),
            ).values(),
          ];
          const fatal = [
            ...plan.issues.filter(
              (i) => i.code === 'reserved_dungeon_key' || i.code === 'package_dependencies_mismatch',
            ),
            ...issues.filter(
              (i) =>
                i.severity === 'error' &&
                !(input.decisions.allowMissingDependencies && MISSING_DEPENDENCIES.has(i.code)),
            ),
          ];
          if (fatal.length) throw new DungeonImportError('DUNGEON_IMPORT_INVALID', fatal);
          const layout = pruneDungeonLayout(
            pkg.editor.layout,
            pkg.dungeon.rooms.map((r) => r.id),
          );
          const result =
            requiredDecision === 'create' ? 'created' : requiredDecision === 'replace' ? 'replaced' : 'unchanged';
          let draftRevision = target.expectedRevision ?? 1;
          if (result === 'created') {
            const [{ position } = { position: 0 }] = await tx
              .select({
                position: sql<number>`coalesce(max(${dungeonDefinitions.position}), -1) + 1`,
              })
              .from(dungeonDefinitions);
            await tx.insert(dungeonDefinitions).values({
              dungeonKey: pkg.dungeon.key,
              enabled: false,
              draft: pkg.dungeon as unknown as Record<string, unknown>,
              layout: layout as unknown as Record<string, unknown>,
              draftHash: pkg.contentHash,
              position: Number(position),
              updatedBy: actor,
            });
          } else if (result === 'replaced') {
            draftRevision++;
            await tx
              .update(dungeonDefinitions)
              .set({
                draft: pkg.dungeon as unknown as Record<string, unknown>,
                layout: layout as unknown as Record<string, unknown>,
                draftHash: pkg.contentHash,
                draftRevision,
                updatedAt: new Date(),
                updatedBy: actor,
              })
              .where(eq(dungeonDefinitions.dungeonKey, pkg.dungeon.key));
          }
          const out: Omit<DungeonImportResult, 'importId'> = {
            dungeonKey: pkg.dungeon.key,
            result,
            draftRevision,
            createdEnemies,
            issues,
            publishable: !issues.some((i) => i.severity === 'error'),
            replayed: false,
          };
          const [history] = await tx
            .insert(dungeonImportHistory)
            .values({
              requestId: input.requestId,
              requestHash,
              packageId: pkg.packageId,
              packageHash: importHash(pkg),
              sourceEnvironment: pkg.source.environment,
              dungeonKey: pkg.dungeon.key,
              actor,
              decisions: input.decisions,
              result: out,
            })
            .returning({ id: dungeonImportHistory.id });
          await tx.insert(dungeonContentEvents).values({
            dungeonKey: pkg.dungeon.key,
            action: 'imported',
            actor,
            details: {
              importId: history!.id,
              packageId: pkg.packageId,
              packageHash: importHash(pkg),
              result,
              draftRevision,
              createdEnemies,
              decisions: input.decisions,
            },
          });
          return { ...out, importId: history!.id };
        });
      } catch (err) {
        if (uniqueViolationConstraint(err))
          refused('DUNGEON_IMPORT_STALE', 'package', 'An import target was created concurrently. Review a new plan.');
        throw err;
      }
    },
    async importHistory(key, limit = 100) {
      return db
        .select({
          id: dungeonImportHistory.id,
          packageId: dungeonImportHistory.packageId,
          packageHash: dungeonImportHistory.packageHash,
          sourceEnvironment: dungeonImportHistory.sourceEnvironment,
          dungeonKey: dungeonImportHistory.dungeonKey,
          actor: dungeonImportHistory.actor,
          importedAt: dungeonImportHistory.importedAt,
          decisions: dungeonImportHistory.decisions,
          result: dungeonImportHistory.result,
        })
        .from(dungeonImportHistory)
        .where(eq(dungeonImportHistory.dungeonKey, key))
        .orderBy(desc(dungeonImportHistory.id))
        .limit(Math.min(500, Math.max(1, limit)));
    },
  };
}
