/**
 * Collection browser filter state — ephemeral UI state, nothing more.
 *
 * Filters, sort and page for the grouped collection screen can't ride in a
 * component custom id: those cap at 100 characters and use `|` as a field
 * delimiter, which a free-text name search would happily contain. So the
 * browser keeps its view state here instead, keyed by player, in the same
 * spirit as `modules/hunt/huntSession.ts`'s tracker.
 *
 * Deliberately **not** persisted, and deliberately not game state:
 *   - A restart drops every filter. The player simply sees their unfiltered
 *     collection next time they open it — nothing is lost, nothing is wrong.
 *   - State is keyed by `playerId` alone, so two collection messages open at
 *     once (say, in two channels) share one filter; the last interaction wins.
 * Both are accepted trade-offs for v1 rather than bugs to work around.
 *
 * Entries are swept lazily on write, so an idle process holds nothing for a
 * player who wandered off, without a timer to own or shut down.
 */
import {
  DEFAULT_COLLECTION_SORT,
  type CollectionSortBy,
} from '../modules/collection/collectionGrouping';

export interface CollectionFilterState {
  /** Substring match on species name or nickname. Null = no name filter. */
  name: string | null;
  minLevel: number | null;
  maxLevel: number | null;
  /** Minimum matching copies for a species group to be listed. */
  minCopies: number | null;
  sortBy: CollectionSortBy;
  page: number;
}

export interface CollectionFilterTracker {
  /** Current state, or a fresh default set when the player has none. */
  get(playerId: number): CollectionFilterState;
  /** Merge a patch and return the result. */
  set(
    playerId: number,
    patch: Partial<CollectionFilterState>,
    now?: number,
  ): CollectionFilterState;
  /** Back to defaults — the Clear Filters action. */
  reset(playerId: number): CollectionFilterState;
}

export interface CollectionFilterTrackerDeps {
  /** How long an untouched entry survives. Default 3h. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;

/** Longest name fragment we keep — the modal caps input at the same length. */
export const FILTER_NAME_MAX_LENGTH = 64;
/** Upper bound on the copies filter, purely to reject nonsense input. */
const MAX_COPIES_FILTER = 999;

export function defaultCollectionFilterState(): CollectionFilterState {
  return {
    name: null,
    minLevel: null,
    maxLevel: null,
    minCopies: null,
    sortBy: DEFAULT_COLLECTION_SORT,
    page: 1,
  };
}

/** True when anything other than sort/page differs from the defaults. */
export function hasActiveFilters(state: CollectionFilterState): boolean {
  return (
    state.name != null ||
    state.minLevel != null ||
    state.maxLevel != null ||
    state.minCopies != null
  );
}

export function createCollectionFilterTracker(
  deps: CollectionFilterTrackerDeps = {},
): CollectionFilterTracker {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const entries = new Map<number, { state: CollectionFilterState; updatedAt: number }>();

  function sweep(now: number): void {
    for (const [playerId, entry] of entries) {
      if (now - entry.updatedAt > ttlMs) entries.delete(playerId);
    }
  }

  return {
    get(playerId) {
      return entries.get(playerId)?.state ?? defaultCollectionFilterState();
    },
    set(playerId, patch, now = Date.now()) {
      sweep(now);
      const current = entries.get(playerId)?.state ?? defaultCollectionFilterState();
      const state: CollectionFilterState = { ...current, ...patch };
      entries.set(playerId, { state, updatedAt: now });
      return state;
    },
    reset(playerId) {
      const state = defaultCollectionFilterState();
      entries.set(playerId, { state, updatedAt: Date.now() });
      return state;
    },
  };
}

// ───────────────────────────── modal input parsing ─────────────────────────

/** Raw text-input values, exactly as the filter modal hands them over. */
export interface FilterInputRaw {
  name: string;
  minLevel: string;
  maxLevel: string;
  minCopies: string;
}

export type FilterPatch = Pick<
  CollectionFilterState,
  'name' | 'minLevel' | 'maxLevel' | 'minCopies'
>;

export type FilterParseResult =
  | { ok: true; patch: FilterPatch }
  | { ok: false; error: string };

/**
 * Parse one number field. Blank means "no bound" — not zero — so an empty box
 * clears that filter instead of pinning it to a value.
 */
function parseOptionalInt(
  raw: string,
  label: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `**${label}** must be a whole number (or left blank).` };
  }
  return { ok: true, value: Number(trimmed) };
}

/**
 * Validate and normalize the filter modal's four inputs.
 *
 * Out-of-range levels clamp into `[1, maxWaifuLevel]`, but an inverted range
 * is rejected rather than silently swapped: a player who typed min 30 / max 10
 * meant something, and guessing which half to keep would hide the mistake.
 */
export function parseFilterInput(
  raw: FilterInputRaw,
  maxWaifuLevel: number,
): FilterParseResult {
  const name = raw.name.trim().slice(0, FILTER_NAME_MAX_LENGTH);

  const min = parseOptionalInt(raw.minLevel, 'Min level');
  if (!min.ok) return { ok: false, error: min.error };
  const max = parseOptionalInt(raw.maxLevel, 'Max level');
  if (!max.ok) return { ok: false, error: max.error };
  const copies = parseOptionalInt(raw.minCopies, 'Min copies');
  if (!copies.ok) return { ok: false, error: copies.error };

  const ceiling = Math.max(1, maxWaifuLevel);
  const clampLevel = (value: number | null): number | null =>
    value == null ? null : Math.min(Math.max(value, 1), ceiling);
  const minLevel = clampLevel(min.value);
  const maxLevel = clampLevel(max.value);

  if (minLevel != null && maxLevel != null && minLevel > maxLevel) {
    return {
      ok: false,
      error: `**Min level** (${minLevel}) can't be above **max level** (${maxLevel}).`,
    };
  }

  // 0 and 1 both mean "every group qualifies", which is the same as no filter.
  const minCopies =
    copies.value == null || copies.value <= 1
      ? null
      : Math.min(copies.value, MAX_COPIES_FILTER);

  return {
    ok: true,
    patch: {
      name: name.length > 0 ? name : null,
      minLevel,
      maxLevel,
      minCopies,
    },
  };
}
