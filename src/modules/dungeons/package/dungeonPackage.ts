/**
 * The Dungeon Content Package — one dungeon as a portable, versioned file.
 *
 * A package is what an operator downloads from one environment and uploads to
 * another. The two never connect, so the package is self-describing: what
 * dungeon it is, what it needs to already exist where it lands, and a hash of
 * exactly the content that affects gameplay.
 *
 * ## What is in it
 *
 *   dungeon       the definition: metadata, rooms, connections, sequences
 *   editor        the layout document — carried along, never hashed
 *   dependencies  everything the dungeon names that lives outside it, always
 *                 *recomputed* from the content and compared on read, so a
 *                 hand-edited package cannot understate what it needs
 *   assets        the artwork it references (shipped path, or managed hash)
 *   bundled       global definitions carried along for the importer to create
 *                 when missing — enemies today. Never authoritative: an
 *                 importer must not overwrite a differing enemy without an
 *                 explicit decision, which is why each carries its hash
 *
 * Species, items and Equipment are referenced by slug only and are never
 * copied in: they are authoritative global definitions.
 *
 * ## Identity and hashing
 *
 * No environment-specific id appears anywhere. `contentHash` is the sha256 of
 * the *parsed* definition in canonical JSON (keys sorted, array order kept),
 * so reformatting or re-exporting a file does not change it, and neither does
 * dragging a room: layout is outside the hash. `packageId` names one export.
 *
 * ## Versioning
 *
 * `schemaVersion` is the format's version. V1 retains its original shape and bytes; v2 adds
 * required reward evidence and manifests. A reader refuses a version it does not know and — because
 * the envelope is strict — a member it does not understand, rather than
 * importing half a dungeon.
 *
 * ## Phase boundary
 *
 * This module is the format: build, serialise, read, verify. Applying a
 * package to a database (plan, conflicts, apply, import log) is Phase 1B and
 * is built on `readDungeonPackage`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CombatEnemyDefinitionSchema, type CombatEnemyDefinition } from '../../combat/enemyDefinitions';
import { canonicalJson } from '../../rewardTables/rewardTableCore';
import {
  DungeonArtworkRefSchema,
  DungeonDefinitionSchema,
  dungeonDependencies,
  type DungeonDefinition,
} from '../content/dungeonDefinition';
import { DungeonLayoutSchema, EMPTY_DUNGEON_LAYOUT, pruneDungeonLayout, type DungeonLayout } from '../content/dungeonLayout';
import { eligibleRewardDefinitions, equipmentSelectorKey } from '../../equipment/rewardSelector';
import {
  DungeonRewardSnapshotSchema, dungeonLootBodyHash, hasDungeonRewardBundles,
  readDungeonRewardSnapshot, resolveDungeonRewardDependencies, type DungeonRewardSnapshot,
} from '../content/dungeonRewardSnapshot';
import { validateDungeonRewards } from '../validation/dungeonRewardValidation';
import { validateDungeonDefinition, type DungeonIssue } from '../validation/dungeonValidation';

export const DUNGEON_PACKAGE_FORMAT = 'waifumon-dungeon-package' as const;
export const DUNGEON_PACKAGE_SCHEMA_VERSION = 2 as const;
/** The versions this build can read. */
export const DUNGEON_PACKAGE_SUPPORTED_VERSIONS: readonly number[] = [1, 2];
export const DUNGEON_PACKAGE_MAX_BUNDLED_ENEMIES = 2000;

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'must be "sha256:" and 64 hex digits');
const key = z.string().trim().min(1).max(100);

export const DungeonPackageDependenciesSchema = z
  .object({
    /** Each enemy with the hash of its portable definition where the package was made. */
    enemies: z.array(z.object({ key, contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).default([]),
    rewardTables: z.array(z.object({ kind: z.literal('expedition'), id: key }).strict()).default([]),
    regions: z.array(key).default([]),
    currencies: z.array(key).default([]),
    /** Reserved for the phases that reference them; always present so a reader can rely on the shape. */
    species: z.array(key).default([]),
    items: z.array(key).default([]),
    equipment: z.array(key).default([]),
  })
  .strict();
export type DungeonPackageDependencies = z.infer<typeof DungeonPackageDependenciesSchema>;

export const DungeonPackageV1Schema = z
  .object({
    format: z.literal(DUNGEON_PACKAGE_FORMAT),
    schemaVersion: z.literal(1),
    packageId: z.string().uuid(),
    exportedAt: z.string().datetime(),
    source: z
      .object({
        /** Where it was exported: `staging`, `production`, `development`. Informational. */
        environment: z.string().trim().max(40),
        dungeonKey: key,
        /** Which content was exported: the working draft, or a published revision. */
        origin: z.enum(['draft', 'revision']),
        draftRevision: z.number().int().min(1).nullable(),
        publishedRevision: z.number().int().min(1).nullable(),
      })
      .strict(),
    /** sha256 of the gameplay content alone. See {@link dungeonContentHash}. */
    contentHash: sha256,
    dungeon: DungeonDefinitionSchema,
    editor: z.object({ layout: DungeonLayoutSchema }).strict().default({ layout: EMPTY_DUNGEON_LAYOUT }),
    dependencies: DungeonPackageDependenciesSchema,
    assets: z.array(DungeonArtworkRefSchema).max(2000).default([]),
    bundled: z
      .object({ enemies: z.array(CombatEnemyDefinitionSchema).max(DUNGEON_PACKAGE_MAX_BUNDLED_ENEMIES).default([]) })
      .strict()
      .default({ enemies: [] }),
  })
  .strict();
/** All v2 manifest members are required: defaults must not conceal an incomplete file. */
export const DungeonPackageV2DependenciesSchema = DungeonPackageDependenciesSchema.extend({
  enemies: DungeonPackageDependenciesSchema.shape.enemies.removeDefault(),
  rewardTables: DungeonPackageDependenciesSchema.shape.rewardTables.removeDefault(),
  regions: z.array(key), currencies: z.array(key), species: z.array(key), items: z.array(key),
  dungeonLootTables: z.array(z.object({ key, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  equipment: z.array(z.object({ selectorKey: z.string(), candidateKeys: z.array(key).min(1) }).strict()),
});
export const DungeonPackageV2Schema = DungeonPackageV1Schema.extend({
  schemaVersion: z.literal(DUNGEON_PACKAGE_SCHEMA_VERSION),
  dependencies: DungeonPackageV2DependenciesSchema,
  bundled: z.object({
    enemies: z.array(CombatEnemyDefinitionSchema).max(DUNGEON_PACKAGE_MAX_BUNDLED_ENEMIES),
    dungeonLootTables: z.array(DungeonRewardSnapshotSchema.shape.tables.valueSchema.extend({
      /** T6 did not pin these fields. Unknown for revision exports. */
      description: z.string().nullable(),
      origin: z.enum(['portal', 'import', 'seed', 'converted']).nullable(),
    })),
  }).strict(),
  /** Complete T6 evidence, including resolver version, candidate metadata and provenance. */
  rewardSnapshot: DungeonRewardSnapshotSchema,
  rewardSnapshotHash: sha256.nullable(),
});
export const DungeonPackageSchema = z.discriminatedUnion('schemaVersion', [DungeonPackageV1Schema, DungeonPackageV2Schema]);
export type DungeonPackage = z.infer<typeof DungeonPackageSchema>;

// ── hashing ─────────────────────────────────────────────────────────────────

/**
 * What a dungeon *means*, as a hash: the parsed definition (defaults filled
 * in), canonical JSON, sha256. Room, action and connection order is
 * significant — it is the order they run and are offered in — so reordering
 * is a change. Reformatting is not, and layout is not part of it at all.
 */
export function dungeonContentHash(definition: DungeonDefinition): string {
  const parsed = DungeonDefinitionSchema.parse(definition);
  return `sha256:${createHash('sha256').update(canonicalJson(parsed)).digest('hex')}`;
}

/** The hash of an enemy's portable definition — the same function the Enemy Catalogue seeds by. */
export function packagedEnemyHash(enemy: CombatEnemyDefinition): string {
  return createHash('sha256').update(canonicalJson(CombatEnemyDefinitionSchema.parse(enemy))).digest('hex');
}

// ── build ───────────────────────────────────────────────────────────────────

export interface BuildDungeonPackageInput {
  definition: DungeonDefinition;
  layout?: DungeonLayout | undefined;
  source: { environment: string; origin: 'draft' | 'revision'; draftRevision: number | null; publishedRevision: number | null };
  /**
   * The exporting environment's enemies, by key. Each one the dungeon names is
   * bundled and its hash recorded; one that is absent is still listed as a
   * dependency, with a null hash.
   */
  enemies?: ReadonlyMap<string, CombatEnemyDefinition> | undefined;
  /** Required for v2: resolved current dependencies for drafts, pinned T6 evidence for revisions. */
  rewardSnapshot?: DungeonRewardSnapshot | undefined;
  /** Current catalogue display/provenance fields for a draft; never used for revisions. */
  lootTableMetadata?: ReadonlyMap<string, { description: string; origin: 'portal' | 'import' | 'seed' | 'converted' }> | undefined;
  /** Defaults to now. */
  exportedAt?: Date | undefined;
  /** Defaults to a fresh UUID. */
  packageId?: string | undefined;
}

/** The dependency manifest of a definition, given what the environment knows of its enemies. */
export function packageDependencies(
  definition: DungeonDefinition,
  enemies?: ReadonlyMap<string, CombatEnemyDefinition>,
): DungeonPackageDependencies {
  const deps = dungeonDependencies(definition);
  return {
    enemies: deps.enemies.map((enemyKey) => {
      const enemy = enemies?.get(enemyKey);
      return { key: enemyKey, contentHash: enemy ? packagedEnemyHash(enemy) : null };
    }),
    rewardTables: deps.rewardTables.map((id) => ({ kind: 'expedition' as const, id })),
    regions: deps.regions,
    currencies: deps.currencies,
    species: [],
    items: [],
    equipment: [],
  };
}

export function buildDungeonPackage(input: BuildDungeonPackageInput): DungeonPackage {
  const definition = DungeonDefinitionSchema.parse(input.definition);
  const deps = dungeonDependencies(definition);
  const layout = pruneDungeonLayout(
    DungeonLayoutSchema.parse(input.layout ?? EMPTY_DUNGEON_LAYOUT),
    definition.rooms.map((r) => r.id),
  );
  // Parsed once more on the way out, so members are in the schema's own order
  // and a package reads back byte for byte the way it was written.
  const legacy = {
    format: DUNGEON_PACKAGE_FORMAT,
    schemaVersion: 1,
    packageId: input.packageId ?? randomUUID(),
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    source: { ...input.source, dungeonKey: definition.key },
    contentHash: dungeonContentHash(definition),
    dungeon: definition,
    editor: { layout },
    dependencies: packageDependencies(definition, input.enemies),
    assets: deps.artwork,
    bundled: {
      enemies: deps.enemies.flatMap((enemyKey) => {
        const enemy = input.enemies?.get(enemyKey);
        return enemy ? [CombatEnemyDefinitionSchema.parse(enemy)] : [];
      }),
    },
  };
  if (!hasDungeonRewardBundles(definition)) return DungeonPackageV1Schema.parse(legacy);
  const snapshot = readDungeonRewardSnapshot(input.rewardSnapshot);
  if (!snapshot) throw new Error('Cannot export v2 rewards: reward snapshot is missing, invalid or unsupported.');
  const pkg = DungeonPackageV2Schema.parse({
    ...legacy,
    schemaVersion: 2,
    dependencies: { ...legacy.dependencies, ...rewardManifests(snapshot) },
    bundled: { ...legacy.bundled, dungeonLootTables: Object.keys(snapshot.tables).sort().map((key) => ({
      ...snapshot.tables[key],
      description: input.source.origin === 'draft' ? input.lootTableMetadata?.get(key)?.description ?? null : null,
      origin: input.source.origin === 'draft' ? input.lootTableMetadata?.get(key)?.origin ?? null : null,
    })) },
    rewardSnapshot: snapshot,
    rewardSnapshotHash: input.source.origin === 'revision' ? snapshot.hash : null,
  });
  const read = readDungeonPackage(pkg);
  if (!read.ok) throw new Error(`Cannot export v2 rewards: ${read.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  return pkg;
}

function rewardManifests(snapshot: DungeonRewardSnapshot) {
  return {
    dungeonLootTables: Object.keys(snapshot.tables).sort().map((key) => ({ key, contentHash: dungeonLootBodyHash(snapshot.tables[key]!.body) })),
    items: Object.keys(snapshot.items).sort(),
    equipment: Object.keys(snapshot.equipmentPools).sort().map((selectorKey) => ({
      selectorKey, candidateKeys: snapshot.equipmentPools[selectorKey]!.map((c) => c.key).sort(),
    })),
  };
}

/**
 * The file's text. Members are written in the envelope's own order and the
 * definition as authored, so two exports of the same content differ only in
 * `packageId` and `exportedAt` — a readable diff.
 */
export function serializeDungeonPackage(pkg: DungeonPackage): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function dungeonPackageFilename(pkg: Pick<DungeonPackage, 'source' | 'contentHash'>): string {
  return `${pkg.source.dungeonKey}.${pkg.contentHash.slice(7, 19)}.dungeon.json`;
}

// ── read ────────────────────────────────────────────────────────────────────

export const DUNGEON_PACKAGE_ISSUE_CODES = [
  'package_not_json',
  'package_format',
  'package_schema_version',
  'package_schema',
  'package_key_mismatch',
  'package_hash_mismatch',
  'package_dependencies_mismatch',
  'package_assets_mismatch',
  'package_bundle_unreferenced',
  'package_bundle_hash_mismatch',
  'package_bundle_duplicate',
  'package_bundle_missing',
  'package_reward_snapshot_invalid',
] as const;
export type DungeonPackageIssueCode = (typeof DUNGEON_PACKAGE_ISSUE_CODES)[number];

export interface DungeonPackageIssue {
  /** A package-level code, or a definition issue's own code. */
  code: DungeonPackageIssueCode | DungeonIssue['code'];
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ReadDungeonPackageResult {
  /** The package, when its envelope could be read at all. */
  package: DungeonPackage | null;
  issues: DungeonPackageIssue[];
  /** No error-severity issue: the package is internally sound. Says nothing about a target environment. */
  ok: boolean;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((key, index) => key === sortedB[index]);
}

/**
 * Read and verify a package on its own terms: format, version, shape, that
 * its hash matches its content, that its manifest matches what the content
 * really names, and that the dungeon inside is structurally valid.
 *
 * Environment-independent by design — it never asks whether an enemy or a
 * table exists anywhere. That is the importer's plan step.
 */
export function readDungeonPackage(raw: unknown): ReadDungeonPackageResult {
  const issues: DungeonPackageIssue[] = [];
  const fail = (code: DungeonPackageIssueCode, path: string, message: string): ReadDungeonPackageResult => {
    issues.push({ code, severity: 'error', path, message });
    return { package: null, issues, ok: false };
  };

  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return fail('package_not_json', '', `the file is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('package_format', '', 'a dungeon package is a JSON object');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== DUNGEON_PACKAGE_FORMAT) {
    return fail('package_format', 'format', `not a dungeon package: format is ${JSON.stringify(envelope.format)}, expected "${DUNGEON_PACKAGE_FORMAT}"`);
  }
  if (typeof envelope.schemaVersion !== 'number' || !DUNGEON_PACKAGE_SUPPORTED_VERSIONS.includes(envelope.schemaVersion)) {
    return fail(
      'package_schema_version',
      'schemaVersion',
      `package schema version ${JSON.stringify(envelope.schemaVersion)} is not supported by this build (supported: ${DUNGEON_PACKAGE_SUPPORTED_VERSIONS.join(', ')})`,
    );
  }

  // The dungeon is validated first and on its own, so its problems carry
  // their own codes and paths instead of one opaque schema error.
  const dungeon = validateDungeonDefinition(envelope.dungeon);
  for (const issue of dungeon.issues) issues.push({ ...issue, path: issue.path ? `dungeon.${issue.path}` : 'dungeon' });
  if (!dungeon.definition) return { package: null, issues, ok: false };

  const parsed = DungeonPackageSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: 'package_schema',
        severity: 'error',
        path: issue.path.map(String).join('.'),
        message: issue.message,
      });
    }
    return { package: null, issues, ok: false };
  }
  const pkg = parsed.data;
  const error = (code: DungeonPackageIssueCode, path: string, message: string) => issues.push({ code, severity: 'error', path, message });

  if (pkg.source.dungeonKey !== pkg.dungeon.key) {
    error('package_key_mismatch', 'source.dungeonKey', `the package says it holds "${pkg.source.dungeonKey}" but the dungeon inside is "${pkg.dungeon.key}"`);
  }
  const actualHash = dungeonContentHash(pkg.dungeon);
  if (actualHash !== pkg.contentHash) {
    error('package_hash_mismatch', 'contentHash', 'the content hash does not match the dungeon inside: the package was edited after it was exported');
  }

  const actual = dungeonDependencies(pkg.dungeon);
  const declared = pkg.dependencies;
  const mismatches: [string, boolean][] = [
    ['enemies', sameSet(declared.enemies.map((e) => e.key), actual.enemies)],
    ['rewardTables', sameSet(declared.rewardTables.map((t) => t.id), actual.rewardTables)],
    ['regions', sameSet(declared.regions, actual.regions)],
    ['currencies', sameSet(declared.currencies, actual.currencies)],
  ];
  for (const [name, same] of mismatches) {
    if (!same) error('package_dependencies_mismatch', `dependencies.${name}`, `the declared ${name} do not match what the dungeon actually names`);
  }
  if (canonicalJson(pkg.assets) !== canonicalJson(actual.artwork)) {
    error('package_assets_mismatch', 'assets', 'the declared assets do not match the artwork the dungeon actually references');
  }

  const declaredEnemy = new Map(declared.enemies.map((e) => [e.key, e.contentHash]));
  const referencedEnemies = new Set(actual.enemies);
  const bundledKeys = new Set<string>();
  pkg.bundled.enemies.forEach((enemy, i) => {
    const path = `bundled.enemies[${i}]`;
    if (bundledKeys.has(enemy.key)) error('package_bundle_duplicate', path, `enemy "${enemy.key}" is bundled more than once`);
    bundledKeys.add(enemy.key);
    if (!referencedEnemies.has(enemy.key)) {
      error('package_bundle_unreferenced', path, `bundled enemy "${enemy.key}" is not one the dungeon names`);
      return;
    }
    const hash = declaredEnemy.get(enemy.key);
    if (hash != null && hash !== packagedEnemyHash(enemy)) {
      error('package_bundle_hash_mismatch', path, `bundled enemy "${enemy.key}" does not match the hash in the dependency manifest`);
    }
  });

  if (pkg.schemaVersion === 2) {
    const snapshot = pkg.rewardSnapshot;
    if (!hasDungeonRewardBundles(pkg.dungeon))
      error('package_reward_snapshot_invalid', 'dungeon', 'v2 requires a Phase 2 reward bundle');
    if (!readDungeonRewardSnapshot(snapshot) ||
        pkg.rewardSnapshotHash !== (pkg.source.origin === 'revision' ? snapshot.hash : null))
      error('package_reward_snapshot_invalid', 'rewardSnapshotHash', 'reward snapshot hash or origin does not match the exported snapshot');

    const referenced = new Set(pkg.dungeon.rooms.flatMap((room) => room.actions.flatMap((action) =>
      'rewards' in action && action.rewards ? action.rewards.tables.map((ref) => ref.table) : [],
    )));
    const bundled = new Map<string, DungeonRewardSnapshot['tables'][string]>();
    pkg.bundled.dungeonLootTables.forEach((table, i) => {
      const path = `bundled.dungeonLootTables[${i}]`;
      if (bundled.has(table.key)) error('package_bundle_duplicate', path, `loot table "${table.key}" is bundled more than once`);
      bundled.set(table.key, table);
      if (!referenced.has(table.key)) error('package_bundle_unreferenced', path, `loot table "${table.key}" is not referenced by the dungeon`);
      if (dungeonLootBodyHash(table.body) !== table.contentHash)
        error('package_bundle_hash_mismatch', path, `loot table "${table.key}" body does not match its content hash`);
      const { description: _description, origin: _origin, ...pinned } = table;
      if (!snapshot.tables[table.key] || canonicalJson(snapshot.tables[table.key]) !== canonicalJson(pinned))
        error('package_reward_snapshot_invalid', path, `loot table "${table.key}" differs from the reward snapshot`);
    });
    for (const key of referenced)
      if (!bundled.has(key)) error('package_bundle_missing', 'bundled.dungeonLootTables', `required loot table "${key}" is missing`);
    if (!sameSet(Object.keys(snapshot.tables), [...referenced]))
      error('package_dependencies_mismatch', 'rewardSnapshot.tables', 'snapshot tables do not match the dungeon references');
    for (const [key, table] of Object.entries(snapshot.tables))
      if (key !== table.key || dungeonLootBodyHash(table.body) !== table.contentHash)
        error('package_reward_snapshot_invalid', `rewardSnapshot.tables.${key}`, 'snapshot table key or content hash is incorrect');

    const context = {
      lootTables: new Map([...bundled].map(([key, t]) => [key, { ...t, archivedAt: null, revision: t.sourceRevision }])),
      items: new Map(Object.entries(snapshot.items).map(([key, item]) => [key, { ...item, enabled: true, maxOwned: null }])),
      resolveEquipmentSelector: (selector: Parameters<typeof equipmentSelectorKey>[0]) => {
        const candidates = (snapshot.equipmentPools[equipmentSelectorKey(selector)] ?? []).map((c) => ({ ...c, enabled: true }));
        if (new Set(candidates.map((c) => c.key)).size !== candidates.length) throw new Error('duplicate candidates');
        const eligible = eligibleRewardDefinitions(selector, candidates);
        if (eligible.length !== candidates.length) throw new Error('ineligible candidate');
        return eligible;
      },
    };
    const resolved = resolveDungeonRewardDependencies(pkg.dungeon, context);
    if (!resolved.snapshot || !sameSet(Object.keys(resolved.items), Object.keys(snapshot.items)) ||
        !sameSet(Object.keys(resolved.equipment), Object.keys(snapshot.equipmentPools)))
      error('package_reward_snapshot_invalid', 'rewardSnapshot', 'reward snapshot has missing, extra or invalid item/equipment dependencies');
    const expected = rewardManifests(snapshot);
    for (const member of ['dungeonLootTables', 'items', 'equipment'] as const) {
      // Canonical sorted manifests also reject duplicate keys and candidate identities.
      if (canonicalJson(pkg.dependencies[member]) !== canonicalJson(expected[member]))
        error('package_dependencies_mismatch', `dependencies.${member}`, `the declared ${member} do not match the exported rewards`);
    }
    if (pkg.dependencies.species.length)
      error('package_dependencies_mismatch', 'dependencies.species', 'dungeon rewards do not reference species');
    for (const issue of validateDungeonRewards(pkg.dungeon, context).issues)
      issues.push({ ...issue, path: `dungeon.${issue.path}` });
  }

  return { package: pkg, issues, ok: issues.every((i) => i.severity !== 'error') };
}
