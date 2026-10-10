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
 * `schemaVersion` is the format's version. Later content (dungeon events,
 * encounters, dungeon loot tables, bundled asset bytes) is added as new
 * optional members; a reader refuses a version it does not know and — because
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
import { validateDungeonDefinition, type DungeonIssue } from '../validation/dungeonValidation';

export const DUNGEON_PACKAGE_FORMAT = 'waifumon-dungeon-package' as const;
export const DUNGEON_PACKAGE_SCHEMA_VERSION = 1 as const;
/** The versions this build can read. */
export const DUNGEON_PACKAGE_SUPPORTED_VERSIONS: readonly number[] = [1];
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

export const DungeonPackageSchema = z
  .object({
    format: z.literal(DUNGEON_PACKAGE_FORMAT),
    schemaVersion: z.literal(DUNGEON_PACKAGE_SCHEMA_VERSION),
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
  return DungeonPackageSchema.parse({
    format: DUNGEON_PACKAGE_FORMAT,
    schemaVersion: DUNGEON_PACKAGE_SCHEMA_VERSION,
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
  });
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
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
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
  const bundledKeys = new Set<string>();
  pkg.bundled.enemies.forEach((enemy, i) => {
    const path = `bundled.enemies[${i}]`;
    if (bundledKeys.has(enemy.key)) error('package_bundle_duplicate', path, `enemy "${enemy.key}" is bundled more than once`);
    bundledKeys.add(enemy.key);
    if (!declaredEnemy.has(enemy.key)) {
      error('package_bundle_unreferenced', path, `bundled enemy "${enemy.key}" is not one the dungeon names`);
      return;
    }
    const hash = declaredEnemy.get(enemy.key);
    if (hash != null && hash !== packagedEnemyHash(enemy)) {
      error('package_bundle_hash_mismatch', path, `bundled enemy "${enemy.key}" does not match the hash in the dependency manifest`);
    }
  });

  return { package: pkg, issues, ok: issues.every((i) => i.severity !== 'error') };
}
