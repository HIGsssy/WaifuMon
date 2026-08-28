/**
 * Canonical region identifiers.
 *
 * Regions are the first piece of the location system to become load-bearing:
 * a boss belongs to exactly one, and a guild scouts exactly one at a time.
 * Nothing *travels* between them yet (that is explicitly out of Stage 1
 * scope), so the whole system is a single-entry list today — but boss content
 * already names its region, and validating that name against a closed set is
 * what stops a typo from producing a boss no guild can ever draw.
 *
 * Kebab-case rather than the snake_case used by item/species slugs, because
 * the shipped `bosses.json` authors it that way and a region id is a content
 * identifier that also reads in player-facing copy ("Waifu Valley").
 */
export const REGIONS = ['waifu-valley'] as const;
export type Region = (typeof REGIONS)[number];

/** The only region that exists today, and the fallback for unset config. */
export const DEFAULT_REGION: Region = 'waifu-valley';

const REGION_SET = new Set<string>(REGIONS);

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && REGION_SET.has(value);
}

/** "waifu-valley" → "Waifu Valley". One wording, every surface. */
export function regionLabel(value: Region | string): string {
  return String(value)
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
