/**
 * Race — the biological/lore category the card frame communicates.
 *
 * Race is *not* the same thing as `species.archetype`. `archetype` is a
 * free-form narrative role; race is a closed set that maps one-to-one onto an
 * icon in `assets/cardart/icons/races/`. Today's content corpus happens to use
 * archetype values that coincide with race codes, which is why
 * {@link archetypeToRace} exists — it is a backward-compatibility bridge, not
 * the long-term source of truth. Phase 2 adds an explicit optional
 * `species.race` to the content schema; this module already prefers it.
 */
import type { Logger } from '../../shared/logger';

export const RACE_CODES = [
  'angel',
  'demon',
  'demi-human',
  'human',
  'spirit',
  'valkyrie',
  'android',
] as const;

export type RaceCode = (typeof RACE_CODES)[number];

/** Race used when nothing else resolves. Deliberately the most neutral frame. */
export const DEFAULT_RACE: RaceCode = 'human';

const RACE_CODE_SET = new Set<string>(RACE_CODES);

export function isRaceCode(value: unknown): value is RaceCode {
  return typeof value === 'string' && RACE_CODE_SET.has(value);
}

/**
 * Aliases the corpus (or a future author) might plausibly write. Kept small on
 * purpose: this is a compatibility shim, not a synonym dictionary.
 */
const ARCHETYPE_ALIASES: Readonly<Record<string, RaceCode>> = {
  demihuman: 'demi-human',
  beastkin: 'demi-human',
  robot: 'android',
  cyborg: 'android',
  machine: 'android',
  ghost: 'spirit',
  youkai: 'spirit',
  devil: 'demon',
  succubus: 'demon',
  seraph: 'angel',
};

/**
 * Normalizes an archetype string to a {@link RaceCode}, or `null` when it does
 * not correspond to any known race. Returning `null` rather than a default
 * keeps the fallback decision — and the warning — with the caller.
 */
export function archetypeToRace(archetype: string | null | undefined): RaceCode | null {
  if (typeof archetype !== 'string') return null;
  const normalized = archetype
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (normalized.length === 0) return null;
  if (isRaceCode(normalized)) return normalized;
  return ARCHETYPE_ALIASES[normalized] ?? null;
}

/** The minimum a species needs to expose for race resolution. */
export interface RaceResolvable {
  slug?: string;
  race?: string | null | undefined;
  archetype?: string | null | undefined;
}

/**
 * Resolution order: explicit `race` wins, then archetype-derived race, then
 * {@link DEFAULT_RACE} with a warning so unmigrated content is visible in logs
 * rather than silently rendering as a human.
 */
export function resolveRace(species: RaceResolvable, logger?: Logger): RaceCode {
  if (isRaceCode(species.race)) return species.race;

  if (species.race != null && String(species.race).trim() !== '') {
    logger?.warn(
      { tag: 'card-renderer/race-fallback', slug: species.slug, race: species.race },
      'Unknown explicit race on species; falling back to archetype',
    );
  }

  const fromArchetype = archetypeToRace(species.archetype);
  if (fromArchetype) return fromArchetype;

  logger?.warn(
    {
      tag: 'card-renderer/race-fallback',
      slug: species.slug,
      archetype: species.archetype ?? null,
    },
    `Could not resolve race; defaulting to "${DEFAULT_RACE}"`,
  );
  return DEFAULT_RACE;
}

/** Card-face label for a race, e.g. `demi-human` → `DEMI-HUMAN`. */
export function raceLabel(race: RaceCode): string {
  return race.toUpperCase();
}
