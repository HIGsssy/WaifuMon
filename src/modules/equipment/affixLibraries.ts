/**
 * Managed affix libraries (Equipment 3.0) — pure: entry schema, validation,
 * the read-only view of the shipped catalogue, the export/import format and
 * the suffix snapshot an owned copy carries. Storage and lifecycle are
 * `equipmentAffixLibraryService.ts`.
 *
 * ## Two sources, one rule each
 *
 *  - **Legacy (N/R/SR)** — `content/equipment/affixes.json`, unchanged. Rolls
 *    draw from it exactly as before (`affixCatalogue.rollable(pool)`) and
 *    owned copies resolve their `affix_key` through it. It is *shown* as three
 *    read-only libraries (`legacy_n`, `legacy_r`, `legacy_sr`) by
 *    {@link legacyAffixLibraries}; nothing is copied or rewritten.
 *  - **Managed (SSR/UR/LR)** — named libraries in the database, assigned to a
 *    rarity by the published roll rules (shared, dedicated, or none). Empty
 *    until authored; nothing rolls from them before E3-C.
 *
 * ## Keys are global and forever
 *
 * An affix key is unique across the legacy file and every managed library,
 * and so is its suffix (case-insensitively) — the same rule `affixes.json`
 * already applies within itself — so a key on an owned copy can never be
 * ambiguous, and two different affixes never render the same name.
 *
 * ## Names survive library edits
 *
 * A copy rolled from a managed library stores its rendered suffix in
 * `rolled_properties.affixSuffix` ({@link AFFIX_SUFFIX_PROPERTY}) beside
 * `affix_key`; display prefers the snapshot (`equipmentDisplayName`). Editing,
 * disabling or replacing an entry, or reassigning a library, therefore never
 * renames gear a player owns. Legacy copies carry no snapshot and keep
 * resolving through the unchanged file.
 */
import { z } from 'zod';
import type { EquipmentIssue } from '../../shared/errors';
import type { EquipmentAffixCatalogue } from './affixCatalogue';
import { canonicalJson, contentHash } from './rollRules';
import { EQUIPMENT_KEY_MAX_LENGTH, EQUIPMENT_KEY_PATTERN, EQUIPMENT_SLOTS, type EquipmentSlot } from './vocabulary';

/** Longest suffix — the legacy limit, so a Discord select label still fits. */
export const AFFIX_SUFFIX_MAX_LENGTH = 60;
/** Most entries one managed library may hold. */
export const MAX_LIBRARY_ENTRIES = 5000;

/** `legacy`, `legacy_*` name the shipped catalogue's read-only libraries. */
export const LEGACY_LIBRARY_PREFIX = 'legacy';
export function isReservedLibraryKey(key: string): boolean {
  return key === LEGACY_LIBRARY_PREFIX || key.startsWith(`${LEGACY_LIBRARY_PREFIX}_`);
}

export const LibraryKeySchema = z
  .string()
  .min(1)
  .max(EQUIPMENT_KEY_MAX_LENGTH)
  .regex(EQUIPMENT_KEY_PATTERN, 'library key must be lowercase snake_case')
  .refine((key) => !isReservedLibraryKey(key), 'legacy keys are reserved for the shipped catalogue');

export const LibraryMetaSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(1000).default(''),
  })
  .strict();
export type LibraryMeta = z.infer<typeof LibraryMetaSchema>;

export const ManagedAffixEntrySchema = z
  .object({
    key: z.string().min(1).max(EQUIPMENT_KEY_MAX_LENGTH).regex(EQUIPMENT_KEY_PATTERN, 'key must be lowercase snake_case'),
    /** Complete display text, `of …` included — code never prepends anything. */
    suffix: z
      .string()
      .min(1)
      .max(AFFIX_SUFFIX_MAX_LENGTH)
      .refine((s) => s === s.trim(), 'must not start or end with whitespace'),
    /** Slots whose gear may roll this affix. */
    slots: z.array(z.enum(EQUIPMENT_SLOTS)).min(1).max(EQUIPMENT_SLOTS.length),
    /** False retires it from new rolls; copies that have it keep their snapshot. */
    enabled: z.boolean(),
  })
  .strict();
export type ManagedAffixEntry = z.infer<typeof ManagedAffixEntrySchema>;

/** Who already holds a key or suffix, for collision messages: `legacy` or a library key. */
export interface AffixNamespace {
  keys: ReadonlyMap<string, string>;
  /** Lower-cased suffix → owner. */
  suffixes: ReadonlyMap<string, string>;
}

export interface LibraryEntriesValidation {
  ok: boolean;
  value: ManagedAffixEntry[] | null;
  errors: EquipmentIssue[];
}

/**
 * Everything wrong with a library's entries: shape, duplicates within the
 * library, and collisions with any other library or the legacy catalogue
 * (`taken`, which must not include this library's own entries).
 */
export function validateLibraryEntries(raw: unknown, taken: AffixNamespace): LibraryEntriesValidation {
  const parsed = z.array(ManagedAffixEntrySchema).max(MAX_LIBRARY_ENTRIES).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      errors: parsed.error.issues.map((i) => ({ path: ['entries', ...i.path].join('.'), message: i.message })),
    };
  }
  const errors: EquipmentIssue[] = [];
  const keys = new Map<string, number>();
  const suffixes = new Map<string, number>();
  parsed.data.forEach((entry, i) => {
    const at = `entries[${i}]`;
    if (new Set(entry.slots).size !== entry.slots.length) errors.push({ path: `${at}.slots`, message: 'contains duplicates' });
    const k = keys.get(entry.key);
    if (k !== undefined) errors.push({ path: `${at}.key`, message: `duplicate affix key "${entry.key}" (also entries[${k}])` });
    else keys.set(entry.key, i);
    const owner = taken.keys.get(entry.key);
    if (owner) errors.push({ path: `${at}.key`, message: `affix key "${entry.key}" is already used by ${owner}` });
    const folded = entry.suffix.toLowerCase();
    const s = suffixes.get(folded);
    if (s !== undefined) errors.push({ path: `${at}.suffix`, message: `duplicate suffix "${entry.suffix}" (also entries[${s}])` });
    else suffixes.set(folded, i);
    const suffixOwner = taken.suffixes.get(folded);
    if (suffixOwner) errors.push({ path: `${at}.suffix`, message: `suffix "${entry.suffix}" is already used by ${suffixOwner}` });
  });
  return { ok: errors.length === 0, value: parsed.data, errors };
}

/** Slots with at least one enabled entry — what a rarity assignment needs covered. */
export function slotsCovered(entries: readonly ManagedAffixEntry[]): Set<EquipmentSlot> {
  return new Set(entries.filter((e) => e.enabled).flatMap((e) => e.slots));
}

/** The canonical hash of a library's published content. */
export function libraryContentHash(meta: LibraryMeta, entries: readonly ManagedAffixEntry[]): string {
  return contentHash({ name: meta.name, description: meta.description, entries });
}

export function entriesEqual(a: readonly ManagedAffixEntry[], b: readonly ManagedAffixEntry[]): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ── the shipped catalogue, read-only ──────────────────────────────────────

export interface ReadOnlyAffixLibrary {
  key: string;
  name: string;
  description: string;
  readOnly: true;
  rarity: 'N' | 'R' | 'SR';
  /** In file order — the order the legacy roll draws from. */
  entries: ManagedAffixEntry[];
}

const LEGACY_LIBRARY_RARITIES = ['N', 'R', 'SR'] as const;

/**
 * The shipped N/R/SR catalogue presented as three read-only libraries, one
 * per rarity, each entry carrying the slot of its `<slot>.<rarity>` pool.
 * A view only: rolls keep reading `affixCatalogue.rollable(pool)` directly.
 */
export function legacyAffixLibraries(catalogue: EquipmentAffixCatalogue): ReadOnlyAffixLibrary[] {
  return LEGACY_LIBRARY_RARITIES.map((rarity) => ({
    key: `${LEGACY_LIBRARY_PREFIX}_${rarity.toLowerCase()}`,
    name: `Shipped ${rarity} affixes`,
    description: `content/equipment/affixes.json — read-only; ${rarity} rolls draw from it unchanged.`,
    readOnly: true as const,
    rarity,
    entries: catalogue
      .all()
      .filter((a) => a.pool.endsWith(`.${rarity}`))
      .map((a) => ({ key: a.key, suffix: a.suffix, slots: [a.pool.split('.')[0] as EquipmentSlot], enabled: a.enabled })),
  }));
}

/** The legacy catalogue's keys and suffixes, as the namespace managed entries must avoid. */
export function legacyNamespace(catalogue: EquipmentAffixCatalogue): AffixNamespace {
  return {
    keys: new Map(catalogue.all().map((a) => [a.key, 'the shipped affix catalogue'])),
    suffixes: new Map(catalogue.all().map((a) => [a.suffix.toLowerCase(), 'the shipped affix catalogue'])),
  };
}

// ── owned-copy snapshot ───────────────────────────────────────────────────

/** The `rolled_properties` key holding a managed-library copy's rendered suffix. */
export const AFFIX_SUFFIX_PROPERTY = 'affixSuffix';
/** The `rolled_properties` key naming the managed library it came from (diagnostics only). */
export const AFFIX_LIBRARY_PROPERTY = 'affixLibrary';

/**
 * A copy's snapshotted suffix, or null — every legacy copy, and anything
 * malformed. Never throws: an owned item must always load.
 */
export function readAffixSuffixSnapshot(rolledProperties: unknown): string | null {
  if (rolledProperties == null || typeof rolledProperties !== 'object' || Array.isArray(rolledProperties)) return null;
  const value = (rolledProperties as Record<string, unknown>)[AFFIX_SUFFIX_PROPERTY];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The `rolled_properties` fields a copy rolled from a managed library stores
 * (E3-C calls this at grant): the suffix as rendered now, and the library.
 */
export function affixSnapshotProperties(libraryKey: string, entry: Pick<ManagedAffixEntry, 'suffix'>): Record<string, string> {
  return { [AFFIX_SUFFIX_PROPERTY]: entry.suffix, [AFFIX_LIBRARY_PROPERTY]: libraryKey };
}

// ── export / import ───────────────────────────────────────────────────────

export const AFFIX_LIBRARY_EXPORT_FORMAT = 'waifumon-equipment-affix-library' as const;
export const AFFIX_LIBRARY_EXPORT_VERSION = 1 as const;

/**
 * A portable library. `kind`/`revision` describe what was exported and are
 * informational on import: an import always lands in the library's draft.
 * Identified by its stable `library.key`, never by a path or database id.
 */
export interface AffixLibraryExport {
  format: typeof AFFIX_LIBRARY_EXPORT_FORMAT;
  version: typeof AFFIX_LIBRARY_EXPORT_VERSION;
  kind: 'published' | 'draft';
  revision: number;
  exportedAt: string;
  library: { key: string; name: string; description: string };
  affixes: ManagedAffixEntry[];
}

const AffixLibraryExportSchema = z
  .object({
    format: z.literal(AFFIX_LIBRARY_EXPORT_FORMAT),
    version: z.literal(AFFIX_LIBRARY_EXPORT_VERSION),
    kind: z.enum(['published', 'draft']),
    revision: z.number().int().min(1),
    exportedAt: z.string(),
    library: z.object({ key: LibraryKeySchema }).merge(LibraryMetaSchema).strict(),
    affixes: z.unknown(),
  })
  .strict();

export function buildAffixLibraryExport(
  library: { key: string } & LibraryMeta,
  entries: readonly ManagedAffixEntry[],
  meta: { kind: 'published' | 'draft'; revision: number; exportedAt: string },
): AffixLibraryExport {
  return {
    format: AFFIX_LIBRARY_EXPORT_FORMAT,
    version: AFFIX_LIBRARY_EXPORT_VERSION,
    kind: meta.kind,
    revision: meta.revision,
    exportedAt: meta.exportedAt,
    library: { key: library.key, name: library.name, description: library.description },
    affixes: [...entries],
  };
}

/** The library and (unvalidated) entries inside an export file. */
export function readAffixLibraryExport(
  raw: unknown,
): { ok: true; library: { key: string } & LibraryMeta; affixes: unknown } | { ok: false; issues: EquipmentIssue[] } {
  const parsed = AffixLibraryExportSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'file', message: i.message })) };
  }
  return { ok: true, library: parsed.data.library, affixes: parsed.data.affixes };
}
