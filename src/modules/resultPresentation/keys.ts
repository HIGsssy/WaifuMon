/**
 * Result Presentation keys — the closed, code-defined list of player-facing
 * outcomes whose *presentation* can be authored.
 *
 * A key names an outcome that gameplay has already decided. Nothing authored
 * against a key can change what happened: the key only answers "how should
 * this already-resolved result be shown?".
 *
 * This file is the one canonical statement of the list. The database CHECK
 * constraints, runtime validation, TypeScript types, labels and tests all
 * derive from it, so a key cannot exist in one place and not another. Adding
 * a key is a code change (and a migration updating the CHECK) by design:
 * authors cannot invent keys the runtime would never ask for.
 */

export const RESULT_PRESENTATION_KEYS = [
  'hunt.waifubux_find',
  'hunt.essence_find',
  'hunt.item_find',
  'hunt.rare_item_find',
  'hunt.nothing_found',
  'encounter.released',
] as const;
export type ResultPresentationKey = (typeof RESULT_PRESENTATION_KEYS)[number];

/**
 * Where a presentation's image comes from.
 *
 *   - `custom`      — the variant's own `artwork_path`;
 *   - `encountered` — the Waifumon the outcome is about (her canonical art);
 *   - `none`        — no image.
 */
export const ARTWORK_MODES = ['custom', 'encountered', 'none'] as const;
export type ArtworkMode = (typeof ARTWORK_MODES)[number];

interface KeyDefinition {
  /** Human-readable name for admin surfaces and logs. */
  label: string;
  /** Artwork modes a variant for this key may use. */
  artworkModes: readonly ArtworkMode[];
  /** What the built-in (no authored variant) presentation uses. */
  defaultArtworkMode: ArtworkMode;
}

/**
 * Per-key rules. Hunt finds have no Waifumon to show, so `encountered` is not
 * legal for them; a release does, and shows her by default.
 */
export const RESULT_PRESENTATION_KEY_DEFINITIONS: Readonly<
  Record<ResultPresentationKey, KeyDefinition>
> = {
  'hunt.waifubux_find': {
    label: 'WaifuBux Found',
    artworkModes: ['custom', 'none'],
    defaultArtworkMode: 'none',
  },
  'hunt.essence_find': {
    label: 'Essence Found',
    artworkModes: ['custom', 'none'],
    defaultArtworkMode: 'none',
  },
  'hunt.item_find': {
    label: 'Item Found',
    artworkModes: ['custom', 'none'],
    defaultArtworkMode: 'none',
  },
  'hunt.rare_item_find': {
    label: 'Rare Item Found',
    artworkModes: ['custom', 'none'],
    defaultArtworkMode: 'none',
  },
  'hunt.nothing_found': {
    label: 'Nothing Found',
    artworkModes: ['custom', 'none'],
    defaultArtworkMode: 'none',
  },
  'encounter.released': {
    label: 'Waifumon Released',
    artworkModes: ['encountered', 'custom', 'none'],
    defaultArtworkMode: 'encountered',
  },
};

export function isResultPresentationKey(value: unknown): value is ResultPresentationKey {
  return (
    typeof value === 'string' &&
    (RESULT_PRESENTATION_KEYS as readonly string[]).includes(value)
  );
}

export function resultPresentationLabel(key: ResultPresentationKey): string {
  return RESULT_PRESENTATION_KEY_DEFINITIONS[key].label;
}

export function isArtworkModeAllowed(key: ResultPresentationKey, mode: ArtworkMode): boolean {
  return RESULT_PRESENTATION_KEY_DEFINITIONS[key].artworkModes.includes(mode);
}

export function defaultArtworkModeFor(key: ResultPresentationKey): ArtworkMode {
  return RESULT_PRESENTATION_KEY_DEFINITIONS[key].defaultArtworkMode;
}

/** Keys whose variants may use the given artwork mode. */
export function keysAllowingArtworkMode(mode: ArtworkMode): ResultPresentationKey[] {
  return RESULT_PRESENTATION_KEYS.filter((key) => isArtworkModeAllowed(key, mode));
}

/**
 * Longest authored flavor text, in characters. Matches the World Encounter
 * outcome-text cap: a short paragraph that always fits a Discord embed
 * description (4096) alongside the code-generated result, level-up and Buddy
 * lines.
 */
export const RESULT_PRESENTATION_FLAVOR_MAX_LENGTH = 500;

const sqlList =(values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/** SQL fragments for the CHECK constraints in `schema.ts`. */
export const RESULT_PRESENTATION_KEY_SQL_LIST = sqlList(RESULT_PRESENTATION_KEYS);
export const ARTWORK_MODE_SQL_LIST = sqlList(ARTWORK_MODES);
export const ENCOUNTERED_ARTWORK_KEY_SQL_LIST = sqlList(keysAllowingArtworkMode('encountered'));
