/**
 * The live species policy a dungeon encounter is judged by, read from the
 * database and loaded content.
 *
 * Two halves, deliberately from two sources:
 *
 *   - `species.enabled` and `species.tags` come from the **database row** the
 *     seeder keeps in step with content, so a species disabled by a reload is
 *     seen at once;
 *   - `dungeonAccess` comes from **loaded content** through a getter, because
 *     it has no column: exclusivity is content, identical in every environment
 *     running the same build, and a package can neither carry nor change it.
 *
 * The rule itself is `dungeonSpeciesUnavailableReason`, which is pure. This
 * module only fetches what it needs, and is the one place publication,
 * rollback, the live offer and the live grant all read policy from.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { dungeonSpeciesAcquisitions, items, species, type SpeciesRow } from '../../db/schema';
import { isCaptureItemEligible } from '../capture/captureService';
import { isDungeonRestricted } from '../locations/regions';
import {
  encounterSpecies,
  isEncounterAction,
  type DungeonDefinition,
  type DungeonSpeciesAccess,
} from './content/dungeonDefinition';
import type {
  DungeonEncounterValidationSource,
  DungeonSpeciesPolicy,
} from './validation/dungeonEncounterValidation';

/** A species' `dungeonAccess`, from loaded content. Undefined for a species with none (or unknown). */
export type DungeonSpeciesAccessLookup = (slug: string) => readonly DungeonSpeciesAccess[] | undefined;

/** The policy of one species row; undefined (which the rule reads as `missing`) for no row. */
export function dungeonSpeciesPolicy(
  row: Pick<SpeciesRow, 'slug' | 'enabled' | 'tags'> | undefined,
  access: DungeonSpeciesAccessLookup | undefined,
): DungeonSpeciesPolicy | undefined {
  if (!row) return undefined;
  const listed = access?.(row.slug);
  return {
    enabled: row.enabled,
    restricted: isDungeonRestricted(row.tags),
    ...(listed ? { access: listed } : {}),
  };
}

/** Every species slug any encounter of the definition can present, sorted. */
export function dungeonEncounterSpeciesSlugs(definition: DungeonDefinition): string[] {
  const slugs = new Set<string>();
  for (const room of definition.rooms) {
    for (const action of room.actions) {
      if (isEncounterAction(action)) for (const slug of encounterSpecies(definition, action)) slugs.add(slug);
    }
  }
  return [...slugs].sort();
}

export async function loadSpeciesBySlug(tx: DbOrTx, slugs: readonly string[]): Promise<Map<string, SpeciesRow>> {
  if (slugs.length === 0) return new Map();
  const rows = await tx.select().from(species).where(inArray(species.slug, [...slugs]));
  return new Map(rows.map((r) => [r.slug, r]));
}

/**
 * How many copies of each species this dungeon has granted this player, over
 * every run. Counted from the acquisition ledger; a caller that will grant on
 * the strength of it holds the player's run row, and with it every other
 * dungeon step of that player.
 */
export async function dungeonAcquisitionCounts(
  tx: DbOrTx,
  playerId: number,
  dungeonKey: string,
): Promise<Map<number, number>> {
  const rows = await tx
    .select({ speciesId: dungeonSpeciesAcquisitions.speciesId, count: sql<number>`count(*)::int` })
    .from(dungeonSpeciesAcquisitions)
    .where(and(eq(dungeonSpeciesAcquisitions.playerId, playerId), eq(dungeonSpeciesAcquisitions.dungeonKey, dungeonKey)))
    .groupBy(dungeonSpeciesAcquisitions.speciesId);
  return new Map(rows.map((r) => [r.speciesId, r.count]));
}

/**
 * The catalogue as content validation sees it: current species policy and
 * current capture items. Read in the caller's transaction, at validate,
 * publish and rollback.
 */
export async function loadDungeonEncounterValidationSource(
  tx: DbOrTx,
  access: DungeonSpeciesAccessLookup | undefined,
  artwork?: (row: Pick<SpeciesRow, 'slug' | 'imagePath'>) => boolean,
): Promise<DungeonEncounterValidationSource> {
  // Both catalogues whole: they are small, and the context is built before
  // the definition it will judge is known.
  const bySlug = new Map(
    (
      await tx
        .select({ slug: species.slug, enabled: species.enabled, tags: species.tags, rarity: species.rarity, imagePath: species.imagePath })
        .from(species)
    ).map((r) => [r.slug, r]),
  );
  const allItems = await tx.select().from(items);
  const itemBySlug = new Map(allItems.map((i) => [i.slug, i]));
  const captureItems = allItems.filter((i) => i.enabled && i.category === 'capture');
  return {
    ...(artwork ? { speciesArtwork: (slug: string) => { const row = bySlug.get(slug); return !row || artwork(row); } } : {}),
    species: (slug) => dungeonSpeciesPolicy(bySlug.get(slug), access),
    item: (slug) => {
      const item = itemBySlug.get(slug);
      return item && { enabled: item.enabled, capture: item.category === 'capture' };
    },
    hasUsableCaptureItem: (slug, rules) => {
      const row = bySlug.get(slug);
      // A missing species is reported as such; it is not also a charm problem.
      if (!row) return true;
      return captureItems.some(
        (item) =>
          isCaptureItemEligible(item, row.rarity) &&
          (!rules.allowedItems || rules.allowedItems.includes(item.slug)) &&
          (rules.allowGuaranteedItems || !item.isGuaranteedCapture),
      );
    },
  };
}
