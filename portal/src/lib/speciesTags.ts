/**
 * Which species tags a player sees, and what they are called.
 *
 * Species `tags` are free-form content metadata (see docs/content-authoring.md)
 * and the server reads them for gameplay — hunt fallback exclusion, World
 * Encounter race matching. So the raw collection is **internal by default**: a
 * tag reaches the page only when it is listed in {@link PLAYER_FACING_TAGS},
 * with a label written for players. A new tag added to content stays hidden
 * until someone decides here what it means to a player.
 *
 * Zone tags are not handled here. They are shown as the Zone field, through
 * `@/lib/zone`, and are never rendered as a tag.
 */
import { isZoneTag } from '@/lib/zone';

export interface PlayerFacingTag {
  readonly tag: string;
  readonly label: string;
}

/**
 * Tags shown to players, in display order.
 *
 * `region_exclusive` is the one classification with a player-visible
 * consequence: the species is only met through its own region's encounter
 * pool, never the hunt's global fallback.
 */
export const PLAYER_FACING_TAGS: readonly PlayerFacingTag[] = [
  { tag: 'region_exclusive', label: 'Zone Exclusive' },
];

/**
 * Tags known to exist in content and deliberately kept off the page. Not read
 * at runtime — anything unlisted is hidden anyway — but it records the
 * decision, and the content test uses it to catch tags nobody has classified.
 *
 *   `starter`    marks the base content set. Every one is a Waifu Valley
 *                species, so the Zone field already says it; and "Starter"
 *                reads to a player like a starter-pick, which it is not.
 *   `expansion`  marks expansion-pack content. Every one is outside Waifu
 *                Valley, so again the Zone field already says it.
 */
export const INTERNAL_TAGS: readonly string[] = ['starter', 'expansion'];

const BY_TAG = new Map<string, PlayerFacingTag>(PLAYER_FACING_TAGS.map((t) => [t.tag, t]));

/**
 * The species' player-facing tags, labelled, in {@link PLAYER_FACING_TAGS}
 * order and without duplicates. Unknown, internal and zone tags are dropped —
 * zone tags because none is ever listed there (a test holds that).
 */
export function playerFacingTags(species: {
  tags?: readonly unknown[] | null | undefined;
}): PlayerFacingTag[] {
  const tags = new Set(Array.isArray(species.tags) ? species.tags : []);
  return PLAYER_FACING_TAGS.filter((entry) => tags.has(entry.tag));
}

/** True when a tag has been classified as zone, player-facing or internal. */
export function isClassifiedTag(tag: string): boolean {
  return isZoneTag(tag) || BY_TAG.has(tag) || INTERNAL_TAGS.includes(tag);
}
