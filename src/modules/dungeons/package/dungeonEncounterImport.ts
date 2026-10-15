/** Target-side review. Export evidence never authorizes a grant or installs policy. */
import type { DungeonDefinition, DungeonSpeciesAccess } from '../content/dungeonDefinition';
import { encounterSpecies } from '../content/dungeonDefinition';
import {
  dungeonSpeciesUnavailableReason,
  type DungeonEncounterValidationSource,
} from '../validation/dungeonEncounterValidation';
import type { DungeonIssue } from '../validation/dungeonValidation';
import type { DungeonIssueDetail } from '../../../shared/errors';
import type { DungeonPackage } from './dungeonPackage';
import { canonicalJson } from '../../rewardTables/rewardTableCore';
import { reachableEncounterActions, type PackageSpeciesEvidence } from './dungeonEncounterDependencies';

export interface EncounterImportCatalogue {
  source: DungeonEncounterValidationSource;
  species: Array<PackageSpeciesEvidence & { name: string }>;
  items: Array<{
    slug: string;
    name: string;
    enabled: boolean;
    category: string;
    captureRarities: string[] | null;
    isGuaranteedCapture: boolean;
  }>;
}
export const INCOMPLETE_ENCOUNTER_CODES = [
  'species_missing',
  'species_disabled',
  'species_not_permitted',
  'rescue_direct_not_permitted',
  'rescue_direct_limit_missing',
  'capture_item_missing',
  'capture_item_disabled',
  'capture_item_not_capture',
  'capture_item_incompatible',
  'capture_no_usable_item',
] as const;
/** Publication checks explicit item definitions as well as per-species usable-item checks.
 * This does not change runtime capture eligibility or the capture formula.
 */
export function explicitCaptureDependencyIssues(
  definition: DungeonDefinition,
  source: DungeonEncounterValidationSource,
): DungeonIssue[] {
  const issues: DungeonIssue[] = [];
  for (const action of reachableEncounterActions(definition)) {
    if (action.type === 'rescue' && action.mode === 'direct') continue;
    const r = definition.rooms.findIndex((room) => room.actions.includes(action));
    const a = definition.rooms[r]!.actions.indexOf(action);
    for (const [i, key] of (action.capture?.allowedItems ?? []).entries()) {
      const item = source.item(key);
      const slugs = encounterSpecies(definition, action).filter((slug) => source.species(slug));
      const code = !item
        ? 'capture_item_missing'
        : !item.capture
          ? 'capture_item_not_capture'
          : !item.enabled
            ? 'capture_item_disabled'
            : slugs.length &&
                !slugs.some((slug) =>
                  source.hasUsableCaptureItem(slug, {
                    ...action.capture!,
                    allowedItems: [key],
                  }),
                )
              ? 'capture_item_incompatible'
              : null;
      if (code)
        issues.push({
          code,
          severity: 'error',
          path: `rooms[${r}].actions[${a}].capture.allowedItems[${i}]`,
          message: `Capture item “${key}” is unavailable or incompatible for encounter “${action.id}”. Repair its explicit permission before publication.`,
        });
    }
  }
  return issues;
}

export function reviewEncounterDependencies(
  pkg: Extract<DungeonPackage, { schemaVersion: 4 }>,
  definition: DungeonDefinition,
  catalogue: EncounterImportCatalogue,
) {
  const issues: DungeonIssueDetail[] = [];
  const requiredSpecies = pkg.dependencies.requiredSpecies.map((incoming) => {
    const row = catalogue.species.find((s) => s.slug === incoming.slug);
    const direct = incoming.modes.includes('direct');
    const policy = catalogue.source.species(incoming.slug);
    const reason = dungeonSpeciesUnavailableReason(policy, definition.key, direct);
    const status =
      reason === 'missing'
        ? ('missing' as const)
        : reason === 'disabled'
          ? ('disabled' as const)
          : reason === 'not_permitted'
            ? ('restricted' as const)
            : reason === 'direct_not_permitted'
              ? ('direct_rescue_not_permitted' as const)
              : reason === 'direct_limit_missing'
                ? ('direct_limit_missing' as const)
                : ('available' as const);
    const path = `dependencies.requiredSpecies.${incoming.slug}`;
    const codes = {
      missing: 'species_missing',
      disabled: 'species_disabled',
      restricted: 'species_not_permitted',
      direct_rescue_not_permitted: 'rescue_direct_not_permitted',
      direct_limit_missing: 'rescue_direct_limit_missing',
    };
    if (status !== 'available')
      issues.push({
        code: codes[status],
        severity: 'error',
        path,
        message: `Species “${row?.name ?? incoming.slug}” is ${status.replaceAll('_', ' ')} for dungeon “${definition.key}” here. Repair before publication; a package cannot authorize species access.`,
      });
    const changes: string[] = [];
    if (row && row.rarity !== incoming.rarity) {
      changes.push(`Rarity: ${incoming.rarity} → ${row.rarity}`);
      issues.push({
        code: 'package_species_rarity_changed',
        severity: 'warning',
        path,
        message: `Species “${row.name}” has rarity ${row.rarity} here, exported as ${incoming.rarity}. Destination rarity and capture rules remain authoritative.`,
      });
    }
    const evidencePolicy = (s: PackageSpeciesEvidence) => ({
      enabled: s.enabled,
      regionExclusive: s.regionExclusive,
      dungeonExclusive: s.dungeonExclusive,
      dungeonAccess: [...s.dungeonAccess].sort((a, b) => (a.dungeon < b.dungeon ? -1 : a.dungeon > b.dungeon ? 1 : 0)),
    });
    if (row && canonicalJson(evidencePolicy(row)) !== canonicalJson(evidencePolicy(incoming))) {
      changes.push('Availability, exclusivity or dungeon-access policy differs');
      issues.push({
        code: 'package_species_policy_changed',
        severity: 'warning',
        path,
        message: `Species “${row.name}” has different central availability/access policy here. Imported policy is never applied; current destination policy controls publication and acquisition.`,
      });
    }
    const access: DungeonSpeciesAccess | undefined = row?.dungeonAccess.find((a) => a.dungeon === definition.key);
    return {
      slug: incoming.slug,
      name: row?.name ?? incoming.slug,
      status,
      modes: incoming.modes,
      sourceRarity: incoming.rarity,
      targetRarity: row?.rarity ?? null,
      changes,
      perPlayerLimit: access?.perPlayerLimit ?? null,
      directRescue: access?.directRescue ?? false,
    };
  });
  const actions = reachableEncounterActions(definition);
  const captureItems = pkg.dependencies.captureItems.map((key) => {
    const item = catalogue.items.find((i) => i.slug === key);
    const uses = actions.filter((a) => a.capture?.allowedItems?.includes(key));
    const compatible = uses.every((action) => {
      const known = encounterSpecies(definition, action).filter((slug) => catalogue.source.species(slug));
      return (
        !known.length ||
        known.some((slug) =>
          catalogue.source.hasUsableCaptureItem(slug, {
            ...action.capture!,
            allowedItems: [key],
          }),
        )
      );
    });
    const status = !item
      ? ('missing' as const)
      : item.category !== 'capture'
        ? ('not_capture' as const)
        : !item.enabled
          ? ('disabled' as const)
          : !compatible
            ? ('incompatible' as const)
            : ('available' as const);
    if (status !== 'available')
      issues.push({
        code: `capture_item_${status}`,
        severity: 'error',
        path: `dependencies.captureItems.${key}`,
        message: `Capture item “${item?.name ?? key}” is ${status.replaceAll('_', ' ')} here. It must exist, be enabled, and work under the authored rarity/guaranteed-item rules. Repair before publication.`,
      });
    return {
      key,
      name: item?.name ?? key,
      status,
      rarities: item?.captureRarities ?? null,
      guaranteed: item?.isGuaranteedCapture ?? null,
    };
  });
  return {
    dependencies: {
      encounterCount: actions.length,
      poolCount: definition.speciesPools?.length ?? 0,
      requiredSpecies,
      captureItems,
    },
    issues,
  };
}
