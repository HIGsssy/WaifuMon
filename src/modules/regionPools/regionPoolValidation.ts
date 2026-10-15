/**
 * Region Pool validation (RP1 §8). Pure: every fact it judges is passed in.
 *
 * Two levels, one function:
 *
 *   - **draft** — refuses only what can never become a valid pool (unknown
 *     region or species, duplicates, bad weights, too many entries, any
 *     dungeon-exclusive species). Everything else is a warning, so a draft can
 *     hold work in progress.
 *   - **publish** — the draft rules plus the live ones: a region-exclusive
 *     species already in another region's published pool, and a released
 *     region with nobody huntable, are errors. The remaining warnings must be
 *     acknowledged by id.
 *
 * Issue ids are stable — `code` or `code:species` / `code:rarity` — so an
 * acknowledgement names exactly the warning that was reviewed. Runtime
 * eligibility is not decided here: the hunt still filters every draw.
 */
import { DUNGEON_EXCLUSIVE_TAG, REGION_EXCLUSIVE_TAG } from '../locations/regions';
import type { RegionCatalogueEntry } from './regionCatalogue';

export const REGION_POOL_MAX_ENTRIES = 500;
export const REGION_POOL_ENTRY_MAX_WEIGHT = 1_000_000;
const SLUG = /^[a-z0-9_]+$/;

/** One pool entry as drafts store it: a stable species slug, never a database id. */
export interface RegionPoolEntry {
  species: string;
  weight: number;
}

/** What validation and analysis need to know about one species, from `species` and content. */
export interface PoolSpeciesFacts {
  slug: string;
  name: string;
  rarity: string;
  enabled: boolean;
  tags: string[];
  /** In the loaded content set. A row content dropped stays in the table, disabled. */
  inContent: boolean;
  race: string;
  affinity: string;
  perSpeciesWeight: number;
  imagePath: string;
}

export const REGION_POOL_ISSUE_CODES = [
  'region_unknown',
  'entries_not_array',
  'entry_invalid',
  'too_many_entries',
  'species_unknown',
  'species_duplicate',
  'weight_invalid',
  'species_dungeon_exclusive',
  'region_exclusive_conflict',
  'pool_has_no_eligible_species',
  'species_disabled',
  'species_not_in_content',
  'species_not_huntable',
  'rarity_tier_empty',
  'region_not_released',
  'draft_unchanged',
  'revision_already_published',
  'draft_replaced_by_rollback',
] as const;
export type RegionPoolIssueCode = (typeof REGION_POOL_ISSUE_CODES)[number];

export interface RegionPoolIssue {
  /** Stable: `code`, `code:species` or `code:rarity`. What an acknowledgement names. */
  id: string;
  code: RegionPoolIssueCode;
  severity: 'error' | 'warning';
  message: string;
  /** Publishing is refused until this warning's id is acknowledged. */
  acknowledgementRequired: boolean;
  species?: string;
  rarity?: string;
  /** Position in the submitted entries, for a field-level message. */
  index?: number;
  /** Other regions involved (exclusive conflicts). */
  regions?: string[];
}

export type ValidationPurpose = 'draft' | 'publish';

export interface ValidateRegionPoolInput {
  regionId: string;
  region: RegionCatalogueEntry | null;
  entries: readonly RegionPoolEntry[];
  facts: ReadonlyMap<string, PoolSpeciesFacts>;
  /** Rarities the hunt can roll (a positive weight in the rarity table). */
  huntedRarities: readonly string[];
  /** Every *other* region's published pool, as slugs. */
  otherPublished: ReadonlyMap<string, ReadonlySet<string>>;
  /** Name of the region hunts fall back to at an empty rarity, or null when this is it. */
  fallbackRegionName: string | null;
  purpose: ValidationPurpose;
}

function issue(
  code: RegionPoolIssueCode,
  severity: 'error' | 'warning',
  message: string,
  extra: Partial<Omit<RegionPoolIssue, 'id' | 'code' | 'severity' | 'message'>> = {},
): RegionPoolIssue {
  const key = extra.species ?? extra.rarity;
  return {
    id: key === undefined ? code : `${code}:${key}`,
    code,
    severity,
    message,
    acknowledgementRequired: false,
    ...extra,
  };
}

/**
 * Structural parse of a submitted entry list. Never throws: anything malformed
 * is an error issue at its index, and only well-formed entries come back.
 */
export function parseRegionPoolEntries(raw: unknown): { entries: RegionPoolEntry[]; issues: RegionPoolIssue[] } {
  if (!Array.isArray(raw)) {
    return {
      entries: [],
      issues: [issue('entries_not_array', 'error', 'Entries must be a list of { species, weight }.')],
    };
  }
  const entries: RegionPoolEntry[] = [];
  const issues: RegionPoolIssue[] = [];
  raw.forEach((value, index) => {
    const v = value as { species?: unknown; weight?: unknown } | null;
    const ok =
      typeof v === 'object' &&
      v !== null &&
      Object.keys(v).every((k) => k === 'species' || k === 'weight') &&
      typeof v.species === 'string' &&
      SLUG.test(v.species) &&
      v.species.length <= 64;
    if (!ok) {
      issues.push({
        ...issue('entry_invalid', 'error', `Entry ${index + 1} must be { species: "<slug>", weight: <integer> }.`, { index }),
        id: `entry_invalid:${index}`,
      });
      return;
    }
    entries.push({ species: v.species as string, weight: v.weight as number });
  });
  return { entries, issues };
}

/** Draft and publish validation. See the module comment for which rule applies when. */
export function validateRegionPool(input: ValidateRegionPoolInput): RegionPoolIssue[] {
  const { entries, facts, purpose } = input;
  const publishing = purpose === 'publish';
  const issues: RegionPoolIssue[] = [];

  if (!input.region) {
    issues.push(issue('region_unknown', 'error', `"${input.regionId}" is not a region.`));
    return issues;
  }
  if (entries.length > REGION_POOL_MAX_ENTRIES) {
    issues.push(
      issue('too_many_entries', 'error', `A pool may list at most ${REGION_POOL_MAX_ENTRIES} species (${entries.length} given).`),
    );
  }

  const seen = new Map<string, number>();
  const eligibleRarities = new Set<string>();
  let eligible = 0;
  entries.forEach((entry, index) => {
    const slug = entry.species;
    const first = seen.get(slug);
    if (first !== undefined) {
      issues.push({
        ...issue('species_duplicate', 'error', `"${slug}" is listed twice (entries ${first + 1} and ${index + 1}).`, {
          species: slug,
          index,
        }),
        id: `species_duplicate:${slug}:${index}`,
      });
      return;
    }
    seen.set(slug, index);

    if (!Number.isInteger(entry.weight) || entry.weight < 1 || entry.weight > REGION_POOL_ENTRY_MAX_WEIGHT) {
      issues.push(
        issue(
          'weight_invalid',
          'error',
          `"${slug}" needs a whole-number weight from 1 to ${REGION_POOL_ENTRY_MAX_WEIGHT.toLocaleString('en-US')}.`,
          { species: slug, index },
        ),
      );
    }

    const fact = facts.get(slug);
    if (!fact) {
      issues.push(issue('species_unknown', 'error', `No Waifumon "${slug}" exists.`, { species: slug, index }));
      return;
    }
    if (fact.tags.includes(DUNGEON_EXCLUSIVE_TAG)) {
      issues.push(
        issue(
          'species_dungeon_exclusive',
          'error',
          `${fact.name} is dungeon-exclusive and can never be met by hunting. Remove her from this pool.`,
          { species: slug, index },
        ),
      );
      return;
    }

    if (!fact.inContent) {
      issues.push(
        issue(
          'species_not_in_content',
          'warning',
          `${fact.name} is no longer in the loaded content, so she is disabled and hunts skip her.`,
          { species: slug, index, acknowledgementRequired: publishing },
        ),
      );
    } else if (!fact.enabled) {
      issues.push(
        issue('species_disabled', 'warning', `${fact.name} is disabled; hunts skip her until she is enabled again.`, {
          species: slug,
          index,
          acknowledgementRequired: publishing,
        }),
      );
    }
    if (!input.huntedRarities.includes(fact.rarity)) {
      issues.push(
        issue(
          'species_not_huntable',
          'warning',
          `${fact.name} is ${fact.rarity}, a rarity the hunt never rolls, so she can never be met here.`,
          { species: slug, index, acknowledgementRequired: publishing },
        ),
      );
    }

    if (fact.tags.includes(REGION_EXCLUSIVE_TAG)) {
      const elsewhere = [...input.otherPublished.entries()]
        .filter(([regionId, slugs]) => regionId !== input.regionId && slugs.has(slug))
        .map(([regionId]) => regionId)
        .sort();
      if (elsewhere.length > 0) {
        issues.push(
          issue(
            'region_exclusive_conflict',
            publishing ? 'error' : 'warning',
            `${fact.name} is region-exclusive and already published in ${elsewhere.join(', ')}. ` +
              'An exclusive belongs to one region; remove her from one of the pools.',
            { species: slug, index, regions: elsewhere },
          ),
        );
      }
    }

    if (fact.enabled && input.huntedRarities.includes(fact.rarity)) {
      eligible += 1;
      eligibleRarities.add(fact.rarity);
    }
  });

  if (eligible === 0 && input.region.released) {
    issues.push(
      issue(
        'pool_has_no_eligible_species',
        publishing ? 'error' : 'warning',
        `${input.region.name} is released but this pool has nobody a hunt can meet.`,
      ),
    );
  }

  for (const rarity of input.huntedRarities) {
    if (eligibleRarities.has(rarity)) continue;
    const fallback = input.fallbackRegionName
      ? `${input.fallbackRegionName}'s ${rarity} species, then any non-exclusive ${rarity} species`
      : `any non-exclusive ${rarity} species in the game`;
    issues.push(
      issue('rarity_tier_empty', 'warning', `No huntable ${rarity} species here: ${rarity} rolls will draw ${fallback} instead.`, {
        rarity,
        acknowledgementRequired: publishing,
      }),
    );
  }

  if (!input.region.released) {
    issues.push(
      issue(
        'region_not_released',
        'warning',
        `${input.region.name} is not released; a published pool reaches hunts only once the region is.`,
      ),
    );
  }
  return issues;
}

/** Errors that refuse the action. */
export function blockingIssues(issues: readonly RegionPoolIssue[]): RegionPoolIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

/** Warning ids that must be acknowledged before publishing. */
export function requiredAcknowledgements(issues: readonly RegionPoolIssue[]): string[] {
  return issues.filter((i) => i.severity === 'warning' && i.acknowledgementRequired).map((i) => i.id);
}
