/**
 * Canonical region identifiers — the shared location primitive.
 *
 * Regions started life boss-local (`modules/bosses/regions.ts`), where the
 * only question was "which region does this boss belong to". Travel makes a
 * region something a *player* stands in, so the closed set moved here and the
 * boss module now re-exports from it. Anything that needs to name a region —
 * player state, encounter pools, shops, bosses — reads this list.
 *
 * Kebab-case rather than the snake_case used by item/species slugs, because
 * the shipped `bosses.json` authors it that way and a region id is a content
 * identifier that also reads in player-facing copy ("Waifu Valley").
 *
 * Adding a region here is deliberately a code change, not a content change:
 * `players.current_region`, `guild_boss_state.region` and friends carry CHECK
 * constraints against this list, so a new region needs a migration to widen
 * them. That coupling is the price of the database refusing to store a typo.
 */
export const REGIONS = ['waifu-valley', 'twin-peeks'] as const;
export type Region = (typeof REGIONS)[number];

/**
 * Where every player starts and the fallback for unset config.
 *
 * Load-bearing in three places: the `players.current_region` column default,
 * the hunt query's regional fallback, and travel's "this destination is always
 * reachable" rule. Content declares the same fact (`"starting": true` on
 * exactly one region file) and the loader asserts the two agree.
 */
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

/**
 * Species tag marking a Waifumon as belonging to exactly one region.
 *
 * A tag rather than a species column: tags already round-trip through the
 * content schema, the `species` table and the admin panel, so exclusivity
 * costs no migration and no new field on the many species that do not care.
 *
 * It carries two enforcement points that must agree, which is why the string
 * lives here rather than in either of them:
 *
 *   - **content validation** rejects a tagged species that appears in more
 *     than one enabled region's encounter pool;
 *   - **the hunt's global fallback** refuses to draw a tagged species at all,
 *     so the one way to meet her stays an explicit region pool.
 *
 * Without the second, the first would be decorative: a fallback that reached
 * past the pools could hand a Twin Peeks exclusive to someone who never left
 * the valley, and "exclusive" would mean "usually".
 */
export const REGION_EXCLUSIVE_TAG = 'region_exclusive';

/** `["region_exclusive"]` — the containment operand for a jsonb `@>` test. */
export const REGION_EXCLUSIVE_TAG_JSON = JSON.stringify([REGION_EXCLUSIVE_TAG]);

/** SQL fragment listing every region id, for CHECK constraints in schema.ts. */
export const REGION_SQL_LIST = REGIONS.map((r) => `'${r}'`).join(',');
