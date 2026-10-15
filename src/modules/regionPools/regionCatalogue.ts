/**
 * The Region Catalogue boundary: the one place Region Pools learn which
 * regions exist, what they are called, whether they are released and what
 * their shipped file says.
 *
 * Today regions are a closed code list (`locations/regions.ts`) described by
 * region files, so {@link contentRegionCatalogue} answers from those. Region
 * Pool code asks only this interface — never `REGIONS`, `isRegion` or
 * `content.regions` directly — so a later database-backed Region Catalogue is
 * a new implementation of it, not a hunt through the service for hardcoded
 * region checks.
 */
import type { LoadedContent, RegionContent } from '../content/schemas';
import { DEFAULT_REGION, isRegion, REGIONS, regionLabel } from '../locations/regions';

export interface RegionCatalogueEntry {
  id: string;
  name: string;
  /** Released to players. Only a released region's pool is projected. */
  released: boolean;
  /** The region the hunt falls back to at an empty rarity. */
  isDefault: boolean;
  /** The region file's `encounterPool`, or null when this content set ships no file for it. */
  shippedPool: RegionContent['encounterPool'] | null;
}

export interface RegionCatalogue {
  /** Every region a pool may exist for, in display order. */
  list(): RegionCatalogueEntry[];
  /** One region, or null when the id is not a region at all. */
  get(regionId: string): RegionCatalogueEntry | null;
  /** The starting region: the hunt's tier-2 fallback pool. */
  defaultRegionId(): string;
}

/** The catalogue as content and the canonical code list define it today. */
export function contentRegionCatalogue(getContent: () => LoadedContent): RegionCatalogue {
  const entries = (): RegionCatalogueEntry[] => {
    const content = getContent();
    const files = new Map(content.regions.map((r) => [r.id as string, r]));
    const ordered = [...REGIONS].sort(
      (a, b) => (files.get(a)?.order ?? Number.MAX_SAFE_INTEGER) - (files.get(b)?.order ?? Number.MAX_SAFE_INTEGER),
    );
    return ordered.map((id) => {
      const file = files.get(id);
      return {
        id,
        name: file?.name ?? regionLabel(id),
        released: file?.enabled === true,
        isDefault: id === DEFAULT_REGION,
        shippedPool: file ? file.encounterPool : null,
      };
    });
  };
  return {
    list: entries,
    get: (regionId) => (isRegion(regionId) ? (entries().find((e) => e.id === regionId) ?? null) : null),
    defaultRegionId: () => DEFAULT_REGION,
  };
}
