/**
 * Admin-panel content service (Admin Milestone 1).
 *
 * The JSON files under `CONTENT_DIR` stay the source of truth; this service is
 * the only writer. Every mutation follows the same path:
 *
 *   read raw JSON → apply the edit in memory → re-validate the *whole* content
 *   set with the bot's own schemas → back up the original → write a temp file →
 *   re-read and re-validate the temp file → rename it into place.
 *
 * Nothing is written unless validation of the full candidate set passes, so a
 * bad edit can never leave the bot with content it would refuse to boot on.
 *
 * Reads deliberately bypass `loadContent`: that helper auto-disables species
 * whose art is missing, and writing that derived state back to disk would
 * silently flip `enabled` on cards the admin never touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { AFFINITIES, RARITIES, type Rarity } from '../../db/schema';
import { ContentValidationError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { listSpeciesFiles, readContentFiles, validateContentSet } from './loader';
import type { ContentReloader, ReloadResult } from './reloadService';
import {
  ItemContentSchema,
  ItemsFileSchema,
  SpeciesContentSchema,
  SpeciesFileSchema,
  TablesFileSchema,
  type ItemContent,
  type LoadedContent,
  type SpeciesContent,
  type TablesContent,
} from './schemas';

/** Species JSON file new cards land in when the admin does not pick one. */
export const DEFAULT_NEW_SPECIES_FILE = 'custom.json';

const SPECIES_FILE_RE = /^[a-z0-9_-]+\.json$/;

/** Top-level tables.json sections the panel exposes as editable blocks. */
export const TABLE_SECTIONS: readonly string[] = [
  'energy',
  'inventory',
  'dailyPackage',
  'hunt',
  'capture',
  'buddyAffinity',
  'duplicate',
  'progression',
  'waifuProgression',
  'dailyQuests',
  'uiFlavor',
  'uiSplash',
  'session',
];

export interface SpeciesFileGroup {
  /** Basename inside `content/species/`, e.g. `starter.json`. */
  file: string;
  species: SpeciesContent[];
}

export interface RawContent {
  items: ItemContent[];
  speciesFiles: SpeciesFileGroup[];
  /** All species flattened, in file order. */
  species: SpeciesContent[];
  tables: TablesContent;
}

export interface RarityBucketSummary {
  rarity: Rarity;
  total: number;
  enabled: number;
  /** Encounter weight from `hunt.rarityTable`; 0 when the bucket is absent. */
  weight: number;
}

export interface ContentSummary {
  speciesTotal: number;
  speciesEnabled: number;
  speciesDisabled: number;
  byRarity: RarityBucketSummary[];
  byAffinity: { affinity: string; count: number }[];
  itemsTotal: number;
  itemsEnabled: number;
  questsTotal: number;
  questsEnabled: boolean;
  speciesFiles: { file: string; count: number }[];
  highlights: { label: string; value: string }[];
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: ContentSummary | null;
  checkedAt: string;
}

export interface SaveResult {
  file: string;
  backup: string | null;
}

export interface AdminContentServiceDeps {
  contentDir: string;
  assetsDir: string;
  logger: Logger;
  /** Injected so tests can assert the shared reloader is the one being called. */
  reload?: ContentReloader | undefined;
}

/** A validation failure carrying per-field messages for the edit form. */
export class AdminValidationError extends ContentValidationError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join('; '));
    this.issues = issues;
  }
}

function formatIssues(prefix: string, err: z.ZodError): string[] {
  return err.issues.map((i) => `${prefix}${i.path.join('.') || '(root)'}: ${i.message}`);
}

function timestamp(now: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * Rejects anything that is not a plain relative path inside the assets root:
 * absolute paths, drive letters, `..` segments, backslashes, and URLs.
 */
export function assertSafeRelativeAssetPath(assetsDir: string, imagePath: string): void {
  const value = imagePath.trim();
  if (value.length === 0) throw new AdminValidationError(['imagePath: must not be empty']);
  if (value.includes('\\')) {
    throw new AdminValidationError(['imagePath: use forward slashes, not backslashes']);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new AdminValidationError(['imagePath: must be a relative path, not a URL']);
  }
  if (value.startsWith('/') || path.isAbsolute(value)) {
    throw new AdminValidationError(['imagePath: must be relative to the assets directory']);
  }
  if (value.split('/').some((seg) => seg === '..')) {
    throw new AdminValidationError(['imagePath: must not contain ".." segments']);
  }
  const root = path.resolve(assetsDir);
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AdminValidationError(['imagePath: resolves outside the assets directory']);
  }
}

/**
 * Resolves a request path under a root directory, refusing traversal. Used by
 * the authenticated asset-preview route — the panel must never become an
 * arbitrary file reader.
 */
export function resolveWithinRoot(root: string, relative: string): string | null {
  if (relative.includes('\0')) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

export interface AdminContentService {
  readonly contentDir: string;
  readonly assetsDir: string;
  readRaw(): RawContent;
  loadContent(): LoadedContent;
  validateContent(): ValidationReport;
  getContentSummary(): ContentSummary;
  listSpeciesFileNames(): string[];
  findSpecies(slug: string): { species: SpeciesContent; file: string } | undefined;
  createSpecies(input: unknown, file?: string): SaveResult;
  updateSpecies(slug: string, input: unknown): SaveResult;
  toggleSpeciesEnabled(slug: string): { result: SaveResult; enabled: boolean };
  findItem(slug: string): ItemContent | undefined;
  createItem(input: unknown): SaveResult;
  updateItem(slug: string, input: unknown): SaveResult;
  toggleItemEnabled(slug: string): { result: SaveResult; enabled: boolean };
  findItemReferences(slug: string): string[];
  saveTablesSection(section: string, value: unknown): SaveResult;
  saveTables(value: unknown): SaveResult;
  reloadContent(): Promise<ReloadResult>;
  reloadAvailable(): boolean;
}

export function createAdminContentService(deps: AdminContentServiceDeps): AdminContentService {
  const { contentDir, assetsDir, logger } = deps;
  const speciesDir = path.join(contentDir, 'species');
  const backupsDir = path.join(contentDir, 'backups');

  function readRaw(): RawContent {
    if (!fs.existsSync(speciesDir)) {
      throw new ContentValidationError(`Species content directory missing: ${speciesDir}`);
    }
    const items = parseFile(path.join(contentDir, 'items.json'), ItemsFileSchema).items;
    const tables = parseFile(path.join(contentDir, 'tables.json'), TablesFileSchema);
    const speciesFiles = listSpeciesFiles(speciesDir).map((file) => ({
      file,
      species: parseFile(path.join(speciesDir, file), SpeciesFileSchema),
    }));
    return {
      items,
      speciesFiles,
      species: speciesFiles.flatMap((g) => g.species),
      tables,
    };
  }

  function parseFile<T>(filePath: string, schema: ZodType<T, ZodTypeDef, unknown>): T {
    if (!fs.existsSync(filePath)) {
      throw new ContentValidationError(`Content file missing: ${filePath}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new ContentValidationError(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AdminValidationError(formatIssues(`${path.basename(filePath)} → `, parsed.error));
    }
    return parsed.data;
  }

  /** `content/backups/<label>-YYYYMMDD-HHMMSS.json`; null when nothing to back up. */
  function backupFile(absolutePath: string, label: string): string | null {
    if (!fs.existsSync(absolutePath)) return null;
    fs.mkdirSync(backupsDir, { recursive: true });
    const target = path.join(backupsDir, `${label}-${timestamp()}.json`);
    fs.copyFileSync(absolutePath, target);
    return path.relative(contentDir, target).split(path.sep).join('/');
  }

  /**
   * Validates the candidate set, then writes one file atomically:
   * backup → temp → re-validate temp → rename. The original is only replaced
   * once the bytes on disk have themselves parsed clean.
   */
  function writeFileAtomic<T>(
    absolutePath: string,
    label: string,
    value: unknown,
    schema: ZodType<T, ZodTypeDef, unknown>,
    candidate: LoadedContent,
  ): SaveResult {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new AdminValidationError(formatIssues('', parsed.error));
    }
    try {
      validateContentSet(candidate);
    } catch (err) {
      throw new AdminValidationError([(err as Error).message]);
    }

    const backup = backupFile(absolutePath, label);
    const tmp = `${absolutePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      // Re-read what actually landed on disk before it becomes the live file.
      const roundTrip = schema.safeParse(JSON.parse(fs.readFileSync(tmp, 'utf8')));
      if (!roundTrip.success) {
        throw new AdminValidationError(formatIssues('temp file → ', roundTrip.error));
      }
      fs.renameSync(tmp, absolutePath);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* best effort — the original file was never touched */
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        // Almost always a container that cannot write its content mount.
        throw new AdminValidationError([
          `The content directory is not writable (${code}). The edit was valid but could not ` +
            'be saved. Under Docker, bind-mount content/ read-write and make sure the ' +
            'container user owns it — see docs/admin-web.md.',
        ]);
      }
      throw err;
    }

    const relative = path.relative(contentDir, absolutePath).split(path.sep).join('/');
    logger.info({ file: relative, backup }, 'admin content file saved');
    return { file: relative, backup };
  }

  function candidateFrom(raw: RawContent, overrides: Partial<LoadedContent>): LoadedContent {
    return {
      items: overrides.items ?? raw.items,
      species: overrides.species ?? raw.species,
      tables: overrides.tables ?? raw.tables,
    };
  }

  // ── species ────────────────────────────────────────────────────────────────

  function findSpecies(slug: string): { species: SpeciesContent; file: string } | undefined {
    const raw = readRaw();
    for (const group of raw.speciesFiles) {
      const hit = group.species.find((s) => s.slug === slug);
      if (hit) return { species: hit, file: group.file };
    }
    return undefined;
  }

  function parseSpeciesInput(input: unknown): SpeciesContent {
    const parsed = SpeciesContentSchema.safeParse(input);
    if (!parsed.success) throw new AdminValidationError(formatIssues('', parsed.error));
    assertSafeRelativeAssetPath(assetsDir, parsed.data.imagePath);
    return parsed.data;
  }

  function writeSpeciesGroup(raw: RawContent, file: string, next: SpeciesContent[]): SaveResult {
    const known = raw.speciesFiles.some((g) => g.file === file);
    const allSpecies = known
      ? raw.speciesFiles.flatMap((g) => (g.file === file ? next : g.species))
      : [...raw.species, ...next];
    return writeFileAtomic(
      path.join(speciesDir, file),
      `species-${path.basename(file, '.json')}`,
      next,
      SpeciesFileSchema,
      candidateFrom(raw, { species: allSpecies }),
    );
  }

  function createSpecies(input: unknown, file = DEFAULT_NEW_SPECIES_FILE): SaveResult {
    if (!SPECIES_FILE_RE.test(file)) {
      throw new AdminValidationError([
        `file: "${file}" is not a valid species filename (lowercase, ending in .json)`,
      ]);
    }
    const species = parseSpeciesInput(input);
    const raw = readRaw();
    if (raw.species.some((s) => s.slug === species.slug)) {
      throw new AdminValidationError([`slug: "${species.slug}" already exists`]);
    }
    const group = raw.speciesFiles.find((g) => g.file === file);
    return writeSpeciesGroup(raw, file, [...(group?.species ?? []), species]);
  }

  function updateSpecies(slug: string, input: unknown): SaveResult {
    const species = parseSpeciesInput(input);
    const raw = readRaw();
    const group = raw.speciesFiles.find((g) => g.species.some((s) => s.slug === slug));
    if (!group) throw new AdminValidationError([`slug: "${slug}" not found`]);
    if (species.slug !== slug && raw.species.some((s) => s.slug === species.slug)) {
      throw new AdminValidationError([`slug: "${species.slug}" already exists`]);
    }
    const next = group.species.map((s) => (s.slug === slug ? species : s));
    return writeSpeciesGroup(raw, group.file, next);
  }

  function toggleSpeciesEnabled(slug: string): { result: SaveResult; enabled: boolean } {
    const raw = readRaw();
    const group = raw.speciesFiles.find((g) => g.species.some((s) => s.slug === slug));
    if (!group) throw new AdminValidationError([`slug: "${slug}" not found`]);
    let enabled = false;
    const next = group.species.map((s) => {
      if (s.slug !== slug) return s;
      enabled = !s.enabled;
      return { ...s, enabled };
    });
    return { result: writeSpeciesGroup(raw, group.file, next), enabled };
  }

  // ── items ──────────────────────────────────────────────────────────────────

  function findItem(slug: string): ItemContent | undefined {
    return readRaw().items.find((i) => i.slug === slug);
  }

  function parseItemInput(input: unknown): ItemContent {
    const parsed = ItemContentSchema.safeParse(input);
    if (!parsed.success) throw new AdminValidationError(formatIssues('', parsed.error));
    return parsed.data;
  }

  function writeItems(raw: RawContent, next: ItemContent[]): SaveResult {
    return writeFileAtomic(
      path.join(contentDir, 'items.json'),
      'items',
      { items: next },
      ItemsFileSchema,
      candidateFrom(raw, { items: next }),
    );
  }

  function createItem(input: unknown): SaveResult {
    const item = parseItemInput(input);
    const raw = readRaw();
    if (raw.items.some((i) => i.slug === item.slug)) {
      throw new AdminValidationError([`slug: "${item.slug}" already exists`]);
    }
    return writeItems(raw, [...raw.items, item]);
  }

  function updateItem(slug: string, input: unknown): SaveResult {
    const item = parseItemInput(input);
    const raw = readRaw();
    if (!raw.items.some((i) => i.slug === slug)) {
      throw new AdminValidationError([`slug: "${slug}" not found`]);
    }
    if (item.slug !== slug) {
      if (raw.items.some((i) => i.slug === item.slug)) {
        throw new AdminValidationError([`slug: "${item.slug}" already exists`]);
      }
      const refs = referencesForItem(raw, slug);
      if (refs.length > 0) {
        throw new AdminValidationError([
          `slug: cannot rename "${slug}" — still referenced by ${refs.join(', ')}. ` +
            'Update those references first, or disable the item instead.',
        ]);
      }
    }
    return writeItems(
      raw,
      raw.items.map((i) => (i.slug === slug ? item : i)),
    );
  }

  function toggleItemEnabled(slug: string): { result: SaveResult; enabled: boolean } {
    const raw = readRaw();
    if (!raw.items.some((i) => i.slug === slug)) {
      throw new AdminValidationError([`slug: "${slug}" not found`]);
    }
    let enabled = false;
    const next = raw.items.map((i) => {
      if (i.slug !== slug) return i;
      enabled = !i.enabled;
      return { ...i, enabled };
    });
    return { result: writeItems(raw, next), enabled };
  }

  /** Human-readable list of every config location pointing at an item slug. */
  function referencesForItem(raw: RawContent, slug: string): string[] {
    const refs: string[] = [];
    const t = raw.tables;
    if (Object.hasOwn(t.dailyPackage.items, slug)) refs.push('dailyPackage.items');
    if (t.hunt.itemFind.sub.some((s) => s.slug === slug)) refs.push('hunt.itemFind');
    if (t.hunt.rareItemFind.sub.some((s) => s.slug === slug)) refs.push('hunt.rareItemFind');
    if (t.progression.dailyBonusItems.some((b) => b.slug === slug)) {
      refs.push('progression.dailyBonusItems');
    }
    if (t.progression.dailyRareItemChance.slug === slug) {
      refs.push('progression.dailyRareItemChance');
    }
    for (const quest of t.dailyQuests.pool) {
      if (quest.rewards.items.some((i) => i.slug === slug)) {
        refs.push(`dailyQuests.pool[${quest.slug}]`);
      }
    }
    if (t.dailyQuests.allCompleteBonus?.items.some((i) => i.slug === slug)) {
      refs.push('dailyQuests.allCompleteBonus');
    }
    return refs;
  }

  // ── tables ─────────────────────────────────────────────────────────────────

  function saveTables(value: unknown): SaveResult {
    const parsed = TablesFileSchema.safeParse(value);
    if (!parsed.success) throw new AdminValidationError(formatIssues('', parsed.error));
    const raw = readRaw();
    return writeFileAtomic(
      path.join(contentDir, 'tables.json'),
      'tables',
      value,
      TablesFileSchema,
      candidateFrom(raw, { tables: parsed.data }),
    );
  }

  /**
   * Replaces one top-level key of tables.json. Everything else on disk is
   * preserved byte-for-byte in shape, so a section edit can never drop an
   * unrelated block.
   */
  function saveTablesSection(section: string, value: unknown): SaveResult {
    const current = JSON.parse(
      fs.readFileSync(path.join(contentDir, 'tables.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (!Object.hasOwn(current, section) && !TABLE_SECTIONS.includes(section)) {
      throw new AdminValidationError([`section: unknown tables.json section "${section}"`]);
    }
    return saveTables({ ...current, [section]: value });
  }

  // ── validation / summary ───────────────────────────────────────────────────

  function getContentSummary(raw = readRaw()): ContentSummary {
    const rarityWeights = new Map(raw.tables.hunt.rarityTable.map((r) => [r.rarity, r.weight]));
    const byRarity: RarityBucketSummary[] = RARITIES.map((rarity) => ({
      rarity,
      total: raw.species.filter((s) => s.rarity === rarity).length,
      enabled: raw.species.filter((s) => s.rarity === rarity && s.enabled).length,
      weight: rarityWeights.get(rarity) ?? 0,
    }));
    const byAffinity = AFFINITIES.map((affinity) => ({
      affinity,
      count: raw.species.filter((s) => s.affinity === affinity).length,
    }));
    const t = raw.tables;
    return {
      speciesTotal: raw.species.length,
      speciesEnabled: raw.species.filter((s) => s.enabled).length,
      speciesDisabled: raw.species.filter((s) => !s.enabled).length,
      byRarity,
      byAffinity,
      itemsTotal: raw.items.length,
      itemsEnabled: raw.items.filter((i) => i.enabled).length,
      questsTotal: t.dailyQuests.pool.length,
      questsEnabled: t.dailyQuests.enabled,
      speciesFiles: raw.speciesFiles.map((g) => ({ file: g.file, count: g.species.length })),
      highlights: [
        { label: 'Hunt result table', value: `${t.hunt.resultTable.length} entries` },
        { label: 'Rarity table', value: `${t.hunt.rarityTable.length} buckets` },
        { label: 'Hunt cooldown', value: `${t.hunt.cooldownSeconds}s` },
        { label: 'Session timeout', value: `${t.session.inactiveTimeoutMinutes} min` },
        {
          label: 'Care mode',
          value: t.energy.careMode.enabled
            ? `on — every ${t.energy.careMode.intervalMinutes} min`
            : 'off',
        },
        {
          label: 'Buddy affinity',
          value:
            Object.keys(t.buddyAffinity.wheel).length > 0
              ? `${Object.keys(t.buddyAffinity.wheel).length} wheel edges`
              : 'wheel empty (all matchups neutral)',
        },
        {
          label: 'Daily quests',
          value: t.dailyQuests.enabled
            ? `on — ${t.dailyQuests.questsPerDay}/day from ${t.dailyQuests.pool.length}`
            : 'off',
        },
        { label: 'Splash screen', value: t.uiSplash.enabled ? 'on' : 'off' },
      ],
    };
  }

  /** Non-fatal problems worth surfacing: the bot boots, but content is off. */
  function collectWarnings(raw: RawContent): string[] {
    const warnings: string[] = [];
    const enabledItems = new Set(raw.items.filter((i) => i.enabled).map((i) => i.slug));

    for (const s of raw.species) {
      const resolved = resolveWithinRoot(assetsDir, s.imagePath);
      if (!resolved || !fs.existsSync(resolved)) {
        warnings.push(
          `species "${s.slug}": image "${s.imagePath}" not found — it will be auto-disabled on load`,
        );
      }
    }

    // Shop-facing item problems: a disabled item never reaches the shop, and a
    // usable item nobody can obtain is almost always an editing mistake.
    for (const item of raw.items) {
      if (item.purchasable && !item.enabled) {
        warnings.push(
          `items: "${item.slug}" is purchasable but disabled — it will not appear in the shop`,
        );
      }
      if (item.effectType != null && !['capture', 'consumable'].includes(item.category)) {
        warnings.push(
          `items: "${item.slug}" has effectType "${item.effectType}" but category "${item.category}" — ` +
            'only capture and consumable items are listed in the shop',
        );
      }
    }

    const t = raw.tables;
    const resultWeight = t.hunt.resultTable.reduce((a, r) => a + r.weight, 0);
    if (resultWeight <= 0) warnings.push('hunt.resultTable: total weight is 0 — hunts cannot roll');
    const rarityWeight = t.hunt.rarityTable.reduce((a, r) => a + r.weight, 0);
    if (rarityWeight <= 0) {
      warnings.push('hunt.rarityTable: total weight is 0 — encounters cannot pick a rarity');
    }
    for (const bucket of t.hunt.rarityTable) {
      if (bucket.weight <= 0) continue;
      const enabled = raw.species.filter((s) => s.rarity === bucket.rarity && s.enabled).length;
      if (enabled === 0) {
        warnings.push(
          `hunt.rarityTable: rarity "${bucket.rarity}" has weight ${bucket.weight} but 0 enabled species`,
        );
      }
    }
    for (const [name, table] of [
      ['hunt.itemFind', t.hunt.itemFind],
      ['hunt.rareItemFind', t.hunt.rareItemFind],
    ] as const) {
      const total = table.sub.reduce((a, s) => a + s.weight, 0);
      if (total <= 0) warnings.push(`${name}: total weight is 0 — nothing can drop`);
      for (const sub of table.sub) {
        if (!enabledItems.has(sub.slug)) {
          warnings.push(`${name}: references disabled item "${sub.slug}"`);
        }
      }
    }
    for (const slug of Object.keys(t.dailyPackage.items)) {
      if (!enabledItems.has(slug)) {
        warnings.push(`dailyPackage.items: references disabled item "${slug}"`);
      }
    }
    if (t.dailyQuests.enabled && t.dailyQuests.pool.length === 0) {
      warnings.push('dailyQuests: enabled but the pool is empty — no quests can be assigned');
    }
    if (t.uiSplash.enabled && t.uiSplash.imagePath) {
      const resolved = resolveWithinRoot(assetsDir, t.uiSplash.imagePath);
      if (!resolved || !fs.existsSync(resolved)) {
        warnings.push(
          `uiSplash.imagePath: "${t.uiSplash.imagePath}" not found — the splash renders text-only`,
        );
      }
    }
    return warnings;
  }

  function validateContent(): ValidationReport {
    const checkedAt = new Date().toISOString();
    let raw: RawContent;
    try {
      raw = readRaw();
    } catch (err) {
      const issues = err instanceof AdminValidationError ? err.issues : [(err as Error).message];
      return { ok: false, errors: issues, warnings: [], summary: null, checkedAt };
    }
    const errors: string[] = [];
    try {
      validateContentSet({ items: raw.items, species: raw.species, tables: raw.tables });
    } catch (err) {
      errors.push((err as Error).message);
    }
    return {
      ok: errors.length === 0,
      errors,
      warnings: collectWarnings(raw),
      summary: getContentSummary(raw),
      checkedAt,
    };
  }

  return {
    contentDir,
    assetsDir,
    readRaw,
    loadContent: () => readContentFiles(contentDir),
    validateContent,
    getContentSummary: () => getContentSummary(),
    listSpeciesFileNames: () =>
      fs.existsSync(speciesDir) ? listSpeciesFiles(speciesDir) : [],
    findSpecies,
    createSpecies,
    updateSpecies,
    toggleSpeciesEnabled,
    findItem,
    createItem,
    updateItem,
    toggleItemEnabled,
    findItemReferences: (slug) => referencesForItem(readRaw(), slug),
    saveTablesSection,
    saveTables,
    reloadAvailable: () => deps.reload != null,
    reloadContent: async () => {
      if (!deps.reload) {
        throw new ContentValidationError(
          'Content reload is unavailable — the admin panel has no database connection',
        );
      }
      return deps.reload();
    },
  };
}

