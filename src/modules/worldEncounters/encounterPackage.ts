/**
 * World Encounter promotion packages — export on staging, import on
 * production.
 *
 * The problem this solves is that encounter content lives in Postgres rather
 * than in `content/*.json`, so the ordinary way to move it between
 * environments would be a database dump. That is the wrong tool: a dump
 * carries surrogate keys, player rows, live encounter state and staging's own
 * guild ids, and restoring one would overwrite production's *runtime* along
 * with its content. A package is the opposite: authored fields only, keyed by
 * slug, readable in a diff, and safe to apply to a live server.
 *
 * ## Three rules the format obeys
 *
 *  1. **Nothing numeric identifies anything.** No `id`, no `encounterId`, no
 *     `playerId`. Encounters, vendors, items, species, regions and routes are
 *     all named by the identifier an author typed, which is the only kind of
 *     identity that means the same thing in two databases.
 *  2. **No runtime state.** `active_world_encounters`, history, player
 *     cooldowns and vendor *instances* are the record of what has happened on
 *     one server; they are meaningless on another and destructive to copy.
 *     What travels is the definition: a vendor's `stockTemplate`, never its
 *     instantiated `remaining` counts.
 *  3. **One interpretation of the rules.** Import validates through the same
 *     {@link EncounterInputSchema} and the same `parseEncounterInput`
 *     cross-field checks the Portal editor uses. There is no second, laxer
 *     definition of a valid encounter that exists only for imports.
 *
 * ## Versioning
 *
 * `format` identifies the package kind and `version` its shape. An importer
 * refuses a version it does not implement rather than guessing: a package
 * from a future release may carry fields whose absence changes behaviour, and
 * silently dropping them would import an encounter that plays differently
 * from the one that was tested.
 */
import { z } from 'zod';
import { REGIONS } from '../locations/regions';
import {
  EncounterInputSchema,
  normalizeWaifumonSelection,
  type EncounterInput,
  type LoadedEncounter,
} from './types';
import {
  matchesSpeciesFilter,
  type RandomSpeciesSelection,
} from '../encounters/speciesSelection';
import { VendorStockTemplateSchema, type VendorStockTemplate } from './vendorService';
import type { WorldEncounterVendorRow } from '../../db/schema';

/** Identifies the package kind. Present so a stray JSON file is refused early. */
export const PACKAGE_FORMAT = 'waifumon-world-encounters' as const;
/** The only shape this build can read or write. */
export const PACKAGE_VERSION = 1 as const;

/**
 * A vendor as it travels.
 *
 * `stockTemplate` is the *authored* template. A vendor instance — the row a
 * player is currently shopping from, with its `remaining` counts — is runtime
 * state and never appears in a package.
 */
export const PackagedVendorSchema = z.object({
  vendorKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'vendorKey must be lowercase snake_case'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  stockTemplate: VendorStockTemplateSchema.default([]),
});
export type PackagedVendor = z.infer<typeof PackagedVendorSchema>;

/**
 * An encounter as it travels: exactly {@link EncounterInputSchema}.
 *
 * Reusing the editor's own schema is the point — the package cannot express
 * an encounter the editor could not author, and a field added to the editor
 * is carried by exports without a second definition to update.
 */
export const PackagedEncounterSchema = EncounterInputSchema;
export type PackagedEncounter = EncounterInput;

export const EncounterPackageSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  /**
   * Checked as a number rather than `z.literal(1)` so an unsupported version
   * is reported as "this build cannot read version N" rather than as a schema
   * error on an unrelated field.
   */
  version: z.number().int().positive(),
  exportedAt: z.string().min(1),
  /** Free-form provenance for the audit log: "staging", a ticket id, anything. */
  label: z.string().max(200).nullable().default(null),
  vendors: z.array(PackagedVendorSchema).default([]),
  encounters: z.array(PackagedEncounterSchema).min(1),
});
export type EncounterPackage = z.infer<typeof EncounterPackageSchema>;

/* ─────────────────────── Export ─────────────────────── */

/**
 * Project a loaded encounter down to its authored fields.
 *
 * The explicit field list is deliberate: spreading `...encounter` would carry
 * `id`, and every choice's `id` and `sortOrder`, into the package the moment
 * someone widened `LoadedEncounter`. Ordering is preserved positionally —
 * `sortOrder` is re-derived from array index on import — so a choice's
 * identity is its position, not a number that means nothing elsewhere.
 */
export function toPackagedEncounter(encounter: LoadedEncounter): PackagedEncounter {
  return {
    slug: encounter.slug,
    name: encounter.name,
    description: encounter.description,
    type: encounter.type,
    rarity: encounter.rarity,
    weight: encounter.weight,
    lifecycle: encounter.lifecycle,
    huntEligible: encounter.huntEligible,
    travelEligible: encounter.travelEligible,
    cooldownSeconds: encounter.cooldownSeconds,
    artworkPath: encounter.artworkPath,
    chainedEncounterSlug: encounter.chainedEncounterSlug,
    choicesRequired: encounter.choicesRequired,
    // `LoadedEncounter` widens these to `string` because DB rows are untyped;
    // the schema parse below narrows them back, and rejects a region this
    // build does not know.
    regions: encounter.regions as PackagedEncounter['regions'],
    routes: encounter.routes as PackagedEncounter['routes'],
    choices: encounter.choices.map((choice) => ({
      label: choice.label,
      emoji: choice.emoji,
      requirements: choice.requirements,
      check: choice.check,
      successEffects: choice.successEffects,
      failureEffects: choice.failureEffects,
      // Only when authored: a legacy encounter exports exactly the keys it
      // always did, so its package — and "unchanged" detection — is stable.
      ...(choice.outcomeText ? { outcomeText: choice.outcomeText } : {}),
      ...(choice.successText ? { successText: choice.successText } : {}),
      ...(choice.failureText ? { failureText: choice.failureText } : {}),
    })),
    metadata: encounter.metadata,
  };
}

export function toPackagedVendor(row: WorldEncounterVendorRow): PackagedVendor {
  return {
    vendorKey: row.vendorKey,
    name: row.name,
    description: row.description,
    // Parsed rather than cast: a template that fails validation would
    // otherwise be exported as-is and fail on the far side, where it is much
    // harder to diagnose.
    stockTemplate: VendorStockTemplateSchema.parse(row.stockTemplateJson ?? []),
  };
}

/**
 * Every vendor key an encounter's effects reference, so an export can carry
 * the vendor definitions its encounters actually need without shipping the
 * whole vendor catalogue.
 */
export function vendorKeysReferencedBy(
  encounters: readonly PackagedEncounter[],
): Set<string> {
  const keys = new Set<string>();
  for (const encounter of encounters) {
    for (const choice of encounter.choices) {
      for (const effect of [...choice.successEffects, ...choice.failureEffects]) {
        if (effect.type === 'open_vendor') keys.add(effect.vendorKey);
      }
    }
  }
  return keys;
}

export interface BuildPackageOptions {
  encounters: readonly LoadedEncounter[];
  /** Candidate vendor rows; only those actually referenced are included. */
  vendors: readonly WorldEncounterVendorRow[];
  exportedAt?: Date;
  label?: string | null;
}

/**
 * Assemble a package, then parse it through the schema before handing it back.
 *
 * The parse is not ceremony: it is the guarantee that an export is a package
 * an import would accept. Failing here, on the server that owns the content,
 * is far better than shipping a file that fails on the far side.
 */
export function buildEncounterPackage(opts: BuildPackageOptions): EncounterPackage {
  const encounters = opts.encounters.map(toPackagedEncounter);
  const referenced = vendorKeysReferencedBy(encounters);
  const vendors = opts.vendors
    .filter((v) => referenced.has(v.vendorKey))
    .map(toPackagedVendor)
    .sort((a, b) => a.vendorKey.localeCompare(b.vendorKey));

  return EncounterPackageSchema.parse({
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: (opts.exportedAt ?? new Date()).toISOString(),
    label: opts.label ?? null,
    vendors,
    // Sorted so two exports of the same content are byte-identical and a diff
    // between environments shows only real differences.
    encounters: [...encounters].sort((a, b) => a.slug.localeCompare(b.slug)),
  });
}

/* ─────────────────────── Import planning ─────────────────────── */

export type PlanIssueSeverity = 'error' | 'warning';

export interface PlanIssue {
  severity: PlanIssueSeverity;
  /** Machine-readable cause, for tests and for the Portal's grouping. */
  code: string;
  /** Encounter or vendor key the issue belongs to; null for package-level. */
  subject: string | null;
  message: string;
  /** Region ids the issue concerns, when it is about specific regions. */
  regions?: string[];
}

export interface EncounterPlanEntry {
  slug: string;
  name: string;
  status: 'create' | 'update' | 'unchanged';
}

export interface VendorPlanEntry {
  vendorKey: string;
  status: 'create' | 'update' | 'unchanged';
}

export interface ImportPlan {
  ok: boolean;
  format: string;
  version: number;
  exportedAt: string | null;
  label: string | null;
  encounters: EncounterPlanEntry[];
  vendors: VendorPlanEntry[];
  issues: PlanIssue[];
  counts: {
    created: number;
    updated: number;
    unchanged: number;
    vendorsCreated: number;
    vendorsUpdated: number;
    vendorsUnchanged: number;
    errors: number;
    warnings: number;
  };
}

/** What the planner needs to know about the *target* environment. */
export interface ImportTargetState {
  /** Existing encounters, by slug. */
  existingEncounters: Map<string, LoadedEncounter>;
  /** Existing vendor definitions, by key. */
  existingVendors: Map<string, PackagedVendor>;
  /** Canonical item slugs from the target's content. */
  itemSlugs: ReadonlySet<string>;
  /** Canonical species slugs from the target's content. */
  speciesSlugs: ReadonlySet<string>;
  /**
   * Whether the artwork file exists. Optional: a target that cannot check the
   * filesystem simply never warns, and a missing image is never an error —
   * assets deploy separately from content.
   */
  artworkExists?: (relativePath: string) => boolean;
  /**
   * Species facts a random selector is matched against. Optional, together
   * with {@link regionPools}: a target that omits them skips the
   * empty-candidate proof rather than guessing.
   */
  speciesCatalog?: ReadonlyArray<CatalogSpecies>;
  /** Species slugs in each *enabled* region's encounter pool. */
  regionPools?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One species as the selector check sees it. `race` is already resolved. */
export interface CatalogSpecies {
  slug: string;
  rarity: string;
  affinity: string;
  race: string;
  enabled: boolean;
  regionExclusive: boolean;
}

const REGION_SET: ReadonlySet<string> = new Set(REGIONS);

/**
 * The regions an encounter can fire in *directly* (hunt regions, travel
 * destinations). Empty lists mean "anywhere", as does an encounter reachable
 * only by chaining — a chained node inherits its parent's region.
 */
export function directRegions(
  encounter: {
    huntEligible: boolean;
    travelEligible: boolean;
    regions: readonly string[];
    routes: ReadonlyArray<{ toRegion: string }>;
  },
  allRegions: readonly string[],
): string[] {
  const out = new Set<string>();
  let anywhere = !encounter.huntEligible && !encounter.travelEligible;
  if (encounter.huntEligible) {
    if (encounter.regions.length === 0) anywhere = true;
    else encounter.regions.forEach((r) => out.add(r));
  }
  if (encounter.travelEligible) {
    // A travel encounter resolves in the destination, which travel has
    // already committed before the roll.
    if (encounter.routes.length === 0) anywhere = true;
    else encounter.routes.forEach((r) => out.add(r.toRegion));
  }
  return anywhere ? [...allRegions] : [...out];
}

/**
 * Proves what can be proved about a random selector's candidate set, using
 * the same {@link matchesSpeciesFilter} the runtime uses.
 *
 *   - **error** `selector_no_candidates`: nothing matches in *any* enabled
 *     region (and, for `global`, nothing matches outside the pools either).
 *     This selector can never produce a sighting anywhere.
 *   - **warning** `selector_region_no_candidates`: it matches somewhere, but
 *     not in some region this encounter can fire in directly. Only a warning,
 *     because a chain can carry the encounter into a region that does match.
 */
function selectorIssues(
  selection: RandomSpeciesSelection,
  encounter: PackagedEncounter,
  choiceIndex: number,
  target: ImportTargetState,
): PlanIssue[] {
  const { speciesCatalog, regionPools } = target;
  if (!speciesCatalog || !regionPools) return [];

  const matching = speciesCatalog.filter((s) => s.enabled && matchesSpeciesFilter(s, selection));
  if (selection.poolScope === 'global' && matching.some((s) => !s.regionExclusive)) return [];

  const pooledMatches = (region: string): number =>
    matching.filter((s) => regionPools.get(region)?.has(s.slug)).length;
  const allRegions = [...regionPools.keys()];
  const describe = `choice[${choiceIndex}] random selector (${selection.poolScope}` +
    `${selection.rarities ? `, rarities ${selection.rarities.join('/')}` : ''}` +
    `${selection.races ? `, races ${selection.races.join('/')}` : ''}` +
    `${selection.affinities ? `, affinities ${selection.affinities.join('/')}` : ''})`;

  if (allRegions.every((r) => pooledMatches(r) === 0)) {
    return [
      issue(
        'error',
        'selector_no_candidates',
        encounter.slug,
        `${describe} matches no species on this server — it can never produce a sighting.`,
      ),
    ];
  }
  const empty = directRegions(encounter, allRegions).filter((r) => pooledMatches(r) === 0);
  if (empty.length === 0) return [];
  return [
    {
      ...issue(
        'warning',
        'selector_region_no_candidates',
        encounter.slug,
        `${describe} matches no species in ${empty.join(', ')}; resolving there will ` +
          'produce no sighting (there is no fallback).',
      ),
      regions: empty,
    },
  ];
}

function issue(
  severity: PlanIssueSeverity,
  code: string,
  subject: string | null,
  message: string,
): PlanIssue {
  return { severity, code, subject, message };
}

/**
 * Is this packaged encounter identical to what the target already holds?
 *
 * Compared as canonicalised JSON of the *authored projection*, so ordering of
 * object keys cannot make an unchanged encounter look changed, and a
 * difference in surrogate ids cannot make a changed one look unchanged.
 */
function isUnchanged(incoming: PackagedEncounter, existing: LoadedEncounter): boolean {
  return stableJson(incoming) === stableJson(toPackagedEncounter(existing));
}

function vendorUnchanged(incoming: PackagedVendor, existing: PackagedVendor): boolean {
  return stableJson(incoming) === stableJson(existing);
}

/** Deterministic JSON: object keys sorted recursively, arrays left in order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * Validate a package against a target environment and describe what applying
 * it would do. **Performs no writes and opens no transaction.**
 *
 * Dependency resolution is package-aware: a reference to something the same
 * package also carries resolves, even though the target has never seen it.
 * That is what lets a chain of encounters — or an encounter and the vendor it
 * opens — be promoted together in one file.
 */
export function planImport(raw: unknown, target: ImportTargetState): ImportPlan {
  const issues: PlanIssue[] = [];
  const empty = (): ImportPlan => ({
    ok: false,
    format: typeof (raw as { format?: unknown })?.format === 'string'
      ? String((raw as { format: string }).format)
      : '(unknown)',
    version: Number((raw as { version?: unknown })?.version ?? 0) || 0,
    exportedAt: null,
    label: null,
    encounters: [],
    vendors: [],
    issues,
    counts: {
      created: 0,
      updated: 0,
      unchanged: 0,
      vendorsCreated: 0,
      vendorsUpdated: 0,
      vendorsUnchanged: 0,
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: 0,
    },
  });

  // Version before shape. A version this build does not implement is not a
  // malformed package — it is a package from another release — and reporting
  // it as forty schema errors would hide that.
  const envelope = raw as { format?: unknown; version?: unknown } | null;
  if (!envelope || typeof envelope !== 'object') {
    issues.push(issue('error', 'malformed_package', null, 'The file is not a JSON object.'));
    return empty();
  }
  if (envelope.format !== PACKAGE_FORMAT) {
    issues.push(
      issue(
        'error',
        'wrong_format',
        null,
        `Not a world-encounter package (format: ${String(envelope.format)}).`,
      ),
    );
    return empty();
  }
  if (envelope.version !== PACKAGE_VERSION) {
    issues.push(
      issue(
        'error',
        'unsupported_version',
        null,
        `Package version ${String(envelope.version)} is not supported by this server ` +
          `(expected ${PACKAGE_VERSION}).`,
      ),
    );
    return empty();
  }

  const parsed = EncounterPackageSchema.safeParse(raw);
  if (!parsed.success) {
    for (const zi of parsed.error.issues) {
      const path = zi.path.join('.') || '<root>';
      issues.push(issue('error', 'schema', path, `${path}: ${zi.message}`));
    }
    return empty();
  }
  const pkg = parsed.data;

  /* Duplicate keys — checked before anything resolves against them, so a
     package that names one slug twice is rejected rather than silently having
     its last entry win. */
  const seenEncounter = new Set<string>();
  for (const encounter of pkg.encounters) {
    if (seenEncounter.has(encounter.slug)) {
      issues.push(
        issue(
          'error',
          'duplicate_slug',
          encounter.slug,
          `Encounter slug "${encounter.slug}" appears more than once in the package.`,
        ),
      );
    }
    seenEncounter.add(encounter.slug);
  }
  const seenVendor = new Set<string>();
  for (const vendor of pkg.vendors) {
    if (seenVendor.has(vendor.vendorKey)) {
      issues.push(
        issue(
          'error',
          'duplicate_vendor_key',
          vendor.vendorKey,
          `Vendor key "${vendor.vendorKey}" appears more than once in the package.`,
        ),
      );
    }
    seenVendor.add(vendor.vendorKey);
  }

  /* Reference resolution. "Known" = in the package OR already in the target. */
  const knownEncounters = new Set<string>([
    ...seenEncounter,
    ...target.existingEncounters.keys(),
  ]);
  const knownVendors = new Set<string>([...seenVendor, ...target.existingVendors.keys()]);

  for (const encounter of pkg.encounters) {
    const subject = encounter.slug;

    if (encounter.chainedEncounterSlug != null) {
      if (encounter.chainedEncounterSlug === encounter.slug) {
        issues.push(
          issue('error', 'chain_self_reference', subject, 'chainedEncounterSlug points at itself.'),
        );
      } else if (!knownEncounters.has(encounter.chainedEncounterSlug)) {
        issues.push(
          issue(
            'error',
            'missing_chained_encounter',
            subject,
            `chainedEncounterSlug "${encounter.chainedEncounterSlug}" is neither in this ` +
              'package nor on this server.',
          ),
        );
      }
    }

    for (const region of encounter.regions) {
      if (!REGION_SET.has(region)) {
        issues.push(
          issue('error', 'unknown_region', subject, `Unknown region "${region}".`),
        );
      }
    }
    for (const route of encounter.routes) {
      for (const endpoint of [route.fromRegion, route.toRegion]) {
        if (!REGION_SET.has(endpoint)) {
          issues.push(
            issue('error', 'unknown_region', subject, `Route references unknown region "${endpoint}".`),
          );
        }
      }
    }

    if (encounter.artworkPath != null) {
      if (encounter.artworkPath.includes('..')) {
        issues.push(
          issue('error', 'invalid_artwork_path', subject, 'artworkPath contains path traversal.'),
        );
      } else if (target.artworkExists && !target.artworkExists(encounter.artworkPath)) {
        // A warning, never an error: images deploy on their own schedule, and
        // an encounter with a missing file renders text-only rather than
        // failing. Blocking promotion on it would couple content to assets.
        issues.push(
          issue(
            'warning',
            'missing_artwork',
            subject,
            `Artwork "${encounter.artworkPath}" is not deployed here yet — the encounter ` +
              'will render text-only until it is.',
          ),
        );
      }
    }

    for (const [i, choice] of encounter.choices.entries()) {
      for (const effect of [...choice.successEffects, ...choice.failureEffects]) {
        switch (effect.type) {
          case 'give_item':
          case 'consume_item':
            if (!target.itemSlugs.has(effect.slug)) {
              issues.push(
                issue(
                  'error',
                  'missing_item',
                  subject,
                  `choice[${i}] references unknown item "${effect.slug}".`,
                ),
              );
            }
            break;
          case 'trigger_encounter':
            if (effect.encounterSlug === encounter.slug) {
              issues.push(
                issue(
                  'error',
                  'chain_self_reference',
                  subject,
                  `choice[${i}] triggers this same encounter.`,
                ),
              );
            } else if (!knownEncounters.has(effect.encounterSlug)) {
              issues.push(
                issue(
                  'error',
                  'missing_chained_encounter',
                  subject,
                  `choice[${i}] triggers "${effect.encounterSlug}", which is neither in this ` +
                    'package nor on this server.',
                ),
              );
            }
            break;
          case 'trigger_waifumon_encounter': {
            // Legacy "any" is always valid. A named species — legacy
            // `speciesSlug` or `selection.mode: 'specific'` — must exist. A
            // random selector names no species, so it has no species
            // dependency; it is checked for provably-empty candidate sets.
            const selection = normalizeWaifumonSelection(effect);
            if (selection.mode === 'specific') {
              if (!target.speciesSlugs.has(selection.speciesSlug)) {
                issues.push(
                  issue(
                    'error',
                    'missing_species',
                    subject,
                    `choice[${i}] references unknown species "${selection.speciesSlug}".`,
                  ),
                );
              }
            } else if (selection.mode === 'random') {
              issues.push(...selectorIssues(selection, encounter, i, target));
            }
            break;
          }
          case 'open_vendor':
            if (!knownVendors.has(effect.vendorKey)) {
              issues.push(
                issue(
                  'error',
                  'missing_vendor',
                  subject,
                  `choice[${i}] opens vendor "${effect.vendorKey}", which is neither in this ` +
                    'package nor on this server.',
                ),
              );
            }
            break;
          default:
            break;
        }
      }
      if (choice.requirements.requiresItem != null) {
        if (!target.itemSlugs.has(choice.requirements.requiresItem)) {
          issues.push(
            issue(
              'error',
              'missing_item',
              subject,
              `choice[${i}] requires unknown item "${choice.requirements.requiresItem}".`,
            ),
          );
        }
      }
    }

    // Reachability, mirroring the editor's own rule: an encounter with no
    // source and nothing chaining into it can never fire.
    const chainedIntoByPackage = pkg.encounters.some(
      (other) =>
        other.slug !== encounter.slug &&
        (other.chainedEncounterSlug === encounter.slug ||
          other.choices.some((c) =>
            [...c.successEffects, ...c.failureEffects].some(
              (e) => e.type === 'trigger_encounter' && e.encounterSlug === encounter.slug,
            ),
          )),
    );
    if (
      !encounter.huntEligible &&
      !encounter.travelEligible &&
      !chainedIntoByPackage &&
      !target.existingEncounters.has(encounter.slug)
    ) {
      issues.push(
        issue(
          'warning',
          'unreachable',
          subject,
          'Not hunt- or travel-eligible and nothing in this package chains into it. It will ' +
            'import, but nothing can trigger it until something references it.',
        ),
      );
    }
  }

  for (const vendor of pkg.vendors) {
    for (const entry of vendor.stockTemplate) {
      if (!target.itemSlugs.has(entry.itemSlug)) {
        issues.push(
          issue(
            'error',
            'missing_item',
            vendor.vendorKey,
            `Vendor stocks unknown item "${entry.itemSlug}".`,
          ),
        );
      }
    }
  }

  /* Per-record disposition. */
  const encounterEntries: EncounterPlanEntry[] = pkg.encounters.map((encounter) => {
    const existing = target.existingEncounters.get(encounter.slug);
    return {
      slug: encounter.slug,
      name: encounter.name,
      status: !existing ? 'create' : isUnchanged(encounter, existing) ? 'unchanged' : 'update',
    };
  });
  const vendorEntries: VendorPlanEntry[] = pkg.vendors.map((vendor) => {
    const existing = target.existingVendors.get(vendor.vendorKey);
    return {
      vendorKey: vendor.vendorKey,
      status: !existing ? 'create' : vendorUnchanged(vendor, existing) ? 'unchanged' : 'update',
    };
  });

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return {
    ok: errors === 0,
    format: pkg.format,
    version: pkg.version,
    exportedAt: pkg.exportedAt,
    label: pkg.label,
    encounters: encounterEntries,
    vendors: vendorEntries,
    issues,
    counts: {
      created: encounterEntries.filter((e) => e.status === 'create').length,
      updated: encounterEntries.filter((e) => e.status === 'update').length,
      unchanged: encounterEntries.filter((e) => e.status === 'unchanged').length,
      vendorsCreated: vendorEntries.filter((v) => v.status === 'create').length,
      vendorsUpdated: vendorEntries.filter((v) => v.status === 'update').length,
      vendorsUnchanged: vendorEntries.filter((v) => v.status === 'unchanged').length,
      errors,
      warnings,
    },
  };
}

/** Re-exported for callers that only import this module. */
export type { VendorStockTemplate };
