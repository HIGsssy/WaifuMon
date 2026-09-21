/**
 * Zone presentation vocabulary.
 *
 * A species' zone is read from its **tags** — the canonical source of zone
 * membership in content. Not from the file or expansion directory it was
 * authored in, and not from `starter` / `expansion` / `region_exclusive`,
 * none of which say *which* zone.
 *
 * This is the only place in the Portal that knows a zone tag exists. Cards,
 * filters and URL parsing all go through the helpers below, so a new zone is
 * one entry in {@link ZONES} and nothing else.
 *
 * Presentation only: this decides what a player reads, never where a species
 * can be hunted. Region gameplay is the server's.
 */

export interface ZoneDefinition {
  /** The canonical species tag, e.g. `waifu_valley`. Never shown to players. */
  readonly tag: string;
  /** Player-facing name. */
  readonly label: string;
}

/**
 * Recognised zones, in the order the filter lists them.
 *
 * `twin_peeks` is the in-game spelling. The legacy `twin_peaks` expansion
 * directory is a filename, not a zone, and is deliberately not recognised.
 */
export const ZONES: readonly ZoneDefinition[] = [
  { tag: 'waifu_valley', label: 'Waifu Valley' },
  { tag: 'twin_peeks', label: 'Twin Peeks' },
  { tag: 'flaccid_foothills', label: 'Flaccid Foothills' },
  { tag: 'thirstlands', label: 'Thirstlands' },
  { tag: 'base_80085', label: 'Base 80085' },
];

const BY_TAG = new Map<string, ZoneDefinition>(ZONES.map((zone) => [zone.tag, zone]));

/** True when `value` is a recognised zone tag. */
export function isZoneTag(value: unknown): value is string {
  return typeof value === 'string' && BY_TAG.has(value);
}

/**
 * The zone a species belongs to, or `null` when none of its tags is a
 * recognised zone. Tolerates a missing or malformed `tags` array so a bad row
 * costs one missing label rather than a failed card.
 *
 * Content assigns exactly one zone per species; should that ever be violated,
 * the first recognised tag wins, so the answer is at least stable.
 */
export function zoneFor(species: {
  tags?: readonly unknown[] | null | undefined;
}): ZoneDefinition | null {
  const tags = Array.isArray(species.tags) ? species.tags : [];
  for (const tag of tags) {
    if (typeof tag === 'string') {
      const zone = BY_TAG.get(tag);
      if (zone) return zone;
    }
  }
  return null;
}

/** Player-facing name for a zone tag; `null` for anything unrecognised. */
export function zoneLabel(tag: string): string | null {
  return BY_TAG.get(tag)?.label ?? null;
}
