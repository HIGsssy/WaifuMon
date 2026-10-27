/**
 * Equipment content packages — export on one environment, import on another,
 * and the startup seed file format.
 *
 * Definitions live in Postgres, so moving them between staging and production
 * is a package, not a database dump — the reasoning `encounterPackage.ts`
 * records for world encounters, and the same three rules:
 *
 *  1. **Nothing numeric identifies anything.** Definitions are named by `key`.
 *     A package entry carrying an `id` is refused, not ignored.
 *  2. **No runtime state.** Owned instances, loadouts and events describe one
 *     server's players and never travel.
 *  3. **One interpretation of the rules.** Every entry is validated by the same
 *     `EquipmentDefinitionInputSchema` the editor and the seed use.
 *
 * This module is pure — it parses, builds and plans with no database — so the
 * planner can be tested exhaustively. `equipmentImportService.ts` is the only
 * place a plan is applied.
 *
 * Import never deletes. A definition on the target that the package does not
 * mention is left exactly as it is.
 */
import type { EquipmentDefinitionRow } from '../../db/schema';
import { EquipmentValidationError, type EquipmentIssue } from '../../shared/errors';
import { definitionRollPolicyIssues } from './highRarityRoll';
import { contentHash, type RollRules } from './rollRules';
import {
  changedDefinitionFields,
  definitionInputFromRow,
  validateEquipmentDefinition,
  type EquipmentDefinitionInput,
} from './definitionSchema';

/** Identifies the package kind, so a stray JSON file is refused early. */
export const EQUIPMENT_PACKAGE_FORMAT = 'waifumon-equipment' as const;
/**
 * The version this build writes.
 *
 * Version 2 replaced each definition's fixed `attackBp` / `defenseBp` /
 * `healthBp` with a rolled range (`multiplierMinBp`, `multiplierMaxBp`,
 * `multiplierStepBp`). A version-1 package is refused rather than converted:
 * it predates ranges, so re-export it from a server that has migrated.
 *
 * Version 3 (Equipment 3.0) adds the high-rarity roll policy,
 * `primarySpEligible` and `maxAdditionalBonuses`. Version 2 is still read —
 * the startup seed is one — and its entries take the defaults (`false`,
 * `null`), which is exactly what every definition rolled before 3.0; a v2
 * entry naming either field is refused, since v2 has no such fields.
 *
 * The affix catalogue is deployed content (`content/equipment/affixes.json`),
 * not database content, so it is not part of a package.
 */
export const EQUIPMENT_PACKAGE_VERSION = 3 as const;
/** Every version this build reads. */
export const EQUIPMENT_PACKAGE_READABLE_VERSIONS = [2, 3] as const;
export type EquipmentPackageVersion = (typeof EQUIPMENT_PACKAGE_READABLE_VERSIONS)[number];
/** Fields version 3 introduced; refused in a version-2 entry. */
const V3_DEFINITION_FIELDS = ['primarySpEligible', 'maxAdditionalBonuses'] as const;
/** A sanity ceiling, far above any real catalogue. */
export const EQUIPMENT_PACKAGE_MAX_DEFINITIONS = 1000;

const PACKAGE_FIELDS = new Set(['format', 'version', 'exportedAt', 'label', 'definitions']);

export interface EquipmentPackage {
  format: typeof EQUIPMENT_PACKAGE_FORMAT;
  /** As read; a package this build builds is always {@link EQUIPMENT_PACKAGE_VERSION}. */
  version: EquipmentPackageVersion;
  exportedAt: string | null;
  label: string | null;
  definitions: EquipmentDefinitionInput[];
}

/**
 * Parse and validate a package, collecting every problem before failing.
 *
 * @throws {EquipmentValidationError} naming each issue by path — a malformed
 * envelope, an unsupported version, an invalid entry, a duplicate key.
 */
export function parseEquipmentPackage(raw: unknown): EquipmentPackage {
  const issues: EquipmentIssue[] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EquipmentValidationError([{ path: '', message: 'a package must be a JSON object' }]);
  }
  const body = raw as Record<string, unknown>;

  if (body.format !== EQUIPMENT_PACKAGE_FORMAT) {
    issues.push({ path: 'format', message: `must be "${EQUIPMENT_PACKAGE_FORMAT}"` });
  }
  // A number check rather than a literal, so a future package is reported as
  // "this build cannot read version N" rather than as a generic shape error.
  const readable = (EQUIPMENT_PACKAGE_READABLE_VERSIONS as readonly unknown[]).includes(body.version);
  const versions = EQUIPMENT_PACKAGE_READABLE_VERSIONS.join(' or ');
  if (!readable) {
    issues.push({
      path: 'version',
      message:
        body.version === 1
          ? `version 1 packages predate rolled multiplier ranges; re-export it from a migrated server (this build reads version ${versions})`
          : typeof body.version === 'number'
            ? `this build reads version ${versions} only, got ${body.version}`
            : `must be ${versions}`,
    });
  }
  const unknown = Object.keys(body).filter((k) => !PACKAGE_FIELDS.has(k));
  if (unknown.length > 0) issues.push({ path: '', message: `unknown field(s): ${unknown.join(', ')}` });
  for (const field of ['exportedAt', 'label'] as const) {
    if (body[field] != null && typeof body[field] !== 'string') {
      issues.push({ path: field, message: 'must be a string' });
    }
  }

  const definitions: EquipmentDefinitionInput[] = [];
  if (!Array.isArray(body.definitions)) {
    issues.push({ path: 'definitions', message: 'must be an array' });
  } else if (body.definitions.length > EQUIPMENT_PACKAGE_MAX_DEFINITIONS) {
    issues.push({
      path: 'definitions',
      message: `at most ${EQUIPMENT_PACKAGE_MAX_DEFINITIONS} definitions per package`,
    });
  } else {
    const seen = new Map<string, number>();
    body.definitions.forEach((entry, i) => {
      if (body.version === 2 && entry != null && typeof entry === 'object') {
        const v3 = V3_DEFINITION_FIELDS.filter((f) => Object.hasOwn(entry as object, f));
        if (v3.length > 0) {
          issues.push({ path: `definitions[${i}]`, message: `${v3.join(', ')} require a version 3 package` });
          return;
        }
      }
      const result = validateEquipmentDefinition(entry, `definitions[${i}]`);
      if (!result.ok) {
        issues.push(...result.issues);
        return;
      }
      const first = seen.get(result.value.key);
      if (first !== undefined) {
        issues.push({
          path: `definitions[${i}].key`,
          message: `duplicate key "${result.value.key}" (also definitions[${first}])`,
        });
        return;
      }
      seen.set(result.value.key, i);
      definitions.push(result.value);
    });
  }

  if (issues.length > 0) throw new EquipmentValidationError(issues);
  return {
    format: EQUIPMENT_PACKAGE_FORMAT,
    version: body.version as EquipmentPackageVersion,
    exportedAt: (body.exportedAt as string | undefined) ?? null,
    label: (body.label as string | undefined) ?? null,
    definitions,
  };
}

/** Build a package from stored rows, ordered by key so a diff reads cleanly. */
export function buildEquipmentPackage(
  rows: readonly EquipmentDefinitionRow[],
  opts: { exportedAt: string; label?: string | null },
): EquipmentPackage {
  return {
    format: EQUIPMENT_PACKAGE_FORMAT,
    version: EQUIPMENT_PACKAGE_VERSION,
    exportedAt: opts.exportedAt,
    label: opts.label ?? null,
    definitions: [...rows]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(definitionInputFromRow),
  };
}

// ── Planning ──────────────────────────────────────────────────────────────

/** What the target server holds for one key. */
export interface ImportTargetDefinition {
  input: EquipmentDefinitionInput;
  /** Instances referencing it, removed ones included. */
  instanceCount: number;
  /** The stored revision (migration 0073), for the plan hash. */
  revision?: number;
}

export type EquipmentImportAction = 'create' | 'update' | 'unchanged';

export interface EquipmentImportPlanEntry {
  key: string;
  action: EquipmentImportAction;
  /** Authored fields that differ; empty for `create` and `unchanged`. */
  changedFields: string[];
}

export interface EquipmentImportPlan {
  entries: EquipmentImportPlanEntry[];
  /** Refusals. A plan with any issue is not applied at all. */
  issues: EquipmentIssue[];
  counts: { create: number; update: number; unchanged: number };
  ok: boolean;
}

/** An `enabled` value the Catalogue import overrode, so the preview can say so. */
export interface ImportStatusNote {
  key: string;
  /** What the package said. */
  packageEnabled: boolean;
  /** What will be stored. */
  enabled: boolean;
  reason: 'new_definitions_start_disabled' | 'existing_status_kept';
}

/**
 * The Admin Equipment Catalogue's import rules (E3-D), applied before
 * planning: a definition the import **creates** starts disabled whatever the
 * file says, and one it **updates** keeps its current enabled state — an
 * import never switches a definition on (or off). Enabling is its own
 * reviewed action. Pure; returns the adjusted package and what changed.
 */
export function applyCatalogueImportDefaults(
  pkg: EquipmentPackage,
  target: ReadonlyMap<string, ImportTargetDefinition>,
): { pkg: EquipmentPackage; notes: ImportStatusNote[] } {
  const notes: ImportStatusNote[] = [];
  const definitions = pkg.definitions.map((definition) => {
    const existing = target.get(definition.key);
    const enabled = existing ? existing.input.enabled : false;
    if (enabled !== definition.enabled) {
      notes.push({
        key: definition.key,
        packageEnabled: definition.enabled,
        enabled,
        reason: existing ? 'existing_status_kept' : 'new_definitions_start_disabled',
      });
    }
    return { ...definition, enabled };
  });
  return { pkg: { ...pkg, definitions }, notes };
}

/**
 * A fingerprint of what an import would do *and* of the catalogue it was
 * planned against: the (adjusted) definitions, and for every key they name,
 * the target's revision and copy count — or its absence. A preview returns
 * it; applying with `expectedPlanHash` re-plans under lock and refuses if it
 * moved (someone edited, created or granted one of those definitions).
 */
export function importPlanHash(
  pkg: EquipmentPackage,
  target: ReadonlyMap<string, ImportTargetDefinition & { revision?: number }>,
): string {
  return contentHash({
    definitions: pkg.definitions,
    target: pkg.definitions.map((d) => {
      const t = target.get(d.key);
      return t ? { key: d.key, revision: t.revision ?? null, instanceCount: t.instanceCount } : { key: d.key, absent: true };
    }),
  });
}

/**
 * Plan applying `pkg` to a target. Pure: the caller reads the target state and
 * the import service recomputes this inside its transaction before applying.
 *
 * The refusals beyond validation are a **slot or rarity change on a
 * referenced definition** (removed copies count): owned instances copied the
 * slot at grant time, and changing it underneath them would break the loadout
 * foreign key's premise; they were rolled, named and valued as their rarity,
 * and reward snapshots promised them as it.
 *
 * With the published roll `rules`, an **enabled** SSR/UR/LR entry whose
 * `maxAdditionalBonuses` leaves no rollable bonus count is refused too
 * (`definitionRollPolicyIssues`) — it could never roll.
 */
export function planEquipmentImport(
  pkg: EquipmentPackage,
  target: ReadonlyMap<string, ImportTargetDefinition>,
  rules?: RollRules | null,
): EquipmentImportPlan {
  const entries: EquipmentImportPlanEntry[] = [];
  const issues: EquipmentIssue[] = [];
  const counts = { create: 0, update: 0, unchanged: 0 };

  pkg.definitions.forEach((definition, i) => {
    if (rules && definition.enabled) {
      for (const issue of definitionRollPolicyIssues(definition, rules)) {
        issues.push({ path: `definitions[${i}].${issue.path}`, message: issue.message });
      }
    }
    const existing = target.get(definition.key);
    if (!existing) {
      entries.push({ key: definition.key, action: 'create', changedFields: [] });
      counts.create += 1;
      return;
    }
    const changedFields = changedDefinitionFields(existing.input, definition);
    if (changedFields.includes('slot') && existing.instanceCount > 0) {
      issues.push({
        path: `definitions[${i}].slot`,
        message:
          `"${definition.key}" is owned by players (${existing.instanceCount} instance(s)); ` +
          `its slot cannot change from ${existing.input.slot} to ${definition.slot}`,
      });
    }
    if (changedFields.includes('rarity') && existing.instanceCount > 0) {
      issues.push({
        path: `definitions[${i}].rarity`,
        message:
          `"${definition.key}" is owned by players (${existing.instanceCount} instance(s)); ` +
          `its rarity cannot change from ${existing.input.rarity} to ${definition.rarity}`,
      });
    }
    const action: EquipmentImportAction = changedFields.length > 0 ? 'update' : 'unchanged';
    entries.push({ key: definition.key, action, changedFields: changedFields.map(String) });
    counts[action] += 1;
  });

  return { entries, issues, counts, ok: issues.length === 0 };
}
