/**
 * `trigger_waifumon_encounter` authoring model — pure, no React.
 *
 * The server accepts four storage shapes for this effect (see the backend's
 * `normalizeWaifumonSelection`):
 *
 *   `{ type }`                                   hunt draw (legacy default)
 *   `{ type, speciesSlug }`                      legacy specific
 *   `{ type, selection: { mode: 'specific' } }`  specific
 *   `{ type, selection: { mode: 'random' } }`    strict random selector
 *
 * The editor works on one {@link SelectorForm} instead, so an author never has
 * to know which generation they are editing. {@link formFromEffect} reads any
 * of the four; {@link effectFromForm} writes exactly one canonical shape for
 * the chosen mode and nothing else — no stale `speciesSlug` beside a random
 * selector, no filters beside a specific one, no empty arrays.
 *
 * Nothing here decides which species a selector matches. Candidate counts come
 * from the server, which runs the runtime's own picker.
 */
import { titleCase } from '@/lib/format';

import type { EffectShape } from './EffectEditor';

export const WAIFUMON_EFFECT = 'trigger_waifumon_encounter';

/**
 * `hunt_draw` is the legacy `{ type }` effect: the hunt's region/rarity roll
 * with its fallbacks. It is a real, distinct runtime behaviour, so it stays a
 * choice rather than being silently rewritten into a strict region selector.
 */
export type PoolChoice = 'hunt_draw' | 'region' | 'global';

export type SelectorForm =
  | { mode: 'specific'; speciesSlug: string }
  | {
      mode: 'random';
      pool: PoolChoice;
      rarities: string[];
      races: string[];
      affinities: string[];
    };

export const EMPTY_RANDOM: Extract<SelectorForm, { mode: 'random' }> = {
  mode: 'random',
  pool: 'region',
  rarities: [],
  races: [],
  affinities: [],
};

export const POOL_LABELS: Record<PoolChoice, string> = {
  hunt_draw: 'Hunt draw',
  region: 'Current Region',
  global: 'Global',
};

export const POOL_HELP: Record<PoolChoice, string> = {
  hunt_draw:
    'The same region/rarity roll a hunt uses, including its usual fallbacks. Filters are not available.',
  region: "Only Waifumon in the encounter's current region pool.",
  global: 'Enabled non-region-exclusive Waifumon, plus species from the current region.',
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Any stored shape → the editor's form. Never throws on odd data. */
export function formFromEffect(effect: Record<string, unknown>): SelectorForm {
  const selection = effect.selection;
  if (selection && typeof selection === 'object') {
    const sel = selection as Record<string, unknown>;
    if (sel.mode === 'specific') {
      return { mode: 'specific', speciesSlug: String(sel.speciesSlug ?? '') };
    }
    return {
      mode: 'random',
      pool: sel.poolScope === 'global' ? 'global' : 'region',
      rarities: strings(sel.rarities),
      races: strings(sel.races),
      affinities: strings(sel.affinities),
    };
  }
  if (typeof effect.speciesSlug === 'string' && effect.speciesSlug.length > 0) {
    return { mode: 'specific', speciesSlug: effect.speciesSlug };
  }
  return { ...EMPTY_RANDOM, pool: 'hunt_draw' };
}

/** Canonical value order for each filter, from the server's reference lists. */
export interface CanonicalOrder {
  rarities?: readonly string[];
  races?: readonly string[];
  affinities?: readonly string[];
}

/** De-duplicated, in reference order, unknown values kept at the end. */
function canonical(values: readonly string[], order: readonly string[] = []): string[] {
  const present = new Set(values);
  return [...order.filter((v) => present.has(v)), ...[...present].filter((v) => !order.includes(v))];
}

/**
 * The form's `selection` payload, or null for the hunt draw (which is stored
 * as a bare `{ type }`). Empty filters are omitted rather than sent as `[]`,
 * which the server refuses.
 */
export function selectionFromForm(
  form: SelectorForm,
  order: CanonicalOrder = {},
): Record<string, unknown> | null {
  if (form.mode === 'specific') {
    // An unchosen species is carried as a bare `{ mode: 'specific' }` — never
    // `speciesSlug: ""`. It is an incomplete form, and the editor blocks
    // every save while it is present (see `unchosenSpeciesIssues`).
    return form.speciesSlug
      ? { mode: 'specific', speciesSlug: form.speciesSlug }
      : { mode: 'specific' };
  }
  if (form.pool === 'hunt_draw') return null;
  const out: Record<string, unknown> = { mode: 'random', poolScope: form.pool };
  const rarities = canonical(form.rarities, order.rarities);
  const races = canonical(form.races, order.races);
  const affinities = canonical(form.affinities, order.affinities);
  if (rarities.length > 0) out.rarities = rarities;
  if (races.length > 0) out.races = races;
  if (affinities.length > 0) out.affinities = affinities;
  return out;
}

/** The one canonical effect for this form — nothing from any other mode. */
export function effectFromForm(form: SelectorForm, order: CanonicalOrder = {}): EffectShape {
  const selection = selectionFromForm(form, order);
  return selection ? { type: WAIFUMON_EFFECT, selection } : { type: WAIFUMON_EFFECT };
}

/* ─────────────────────── Labels & summaries ─────────────────────── */

export const rarityLabel = (value: string): string => value.toUpperCase();
export const raceLabel = (value: string): string => titleCase(value);
export const affinityLabel = (value: string): string => titleCase(value);

export function regionLabel(id: string, names?: Record<string, string>): string {
  return names?.[id] ?? titleCase(id);
}

/**
 * One line an author can read at a glance, e.g.
 * "Random LR Primal Demon or Spirit Waifumon from current region".
 */
export function summarizeSelector(
  form: SelectorForm,
  speciesName?: (slug: string) => string | undefined,
): string {
  if (form.mode === 'specific') {
    const name = form.speciesSlug ? (speciesName?.(form.speciesSlug) ?? form.speciesSlug) : null;
    return `Specific Waifumon: ${name ?? '(none chosen)'}`;
  }
  if (form.pool === 'hunt_draw') return 'Random Waifumon from the hunt draw (region/rarity roll)';
  const words: string[] = [];
  if (form.rarities.length > 0) words.push(form.rarities.map(rarityLabel).join('/'));
  if (form.affinities.length > 0) words.push(form.affinities.map(affinityLabel).join(' or '));
  if (form.races.length > 0) words.push(form.races.map(raceLabel).join(' or '));
  words.push('Waifumon');
  return `Random ${words.join(' ')} from ${form.pool === 'region' ? 'current region' : 'global pool'}`;
}

/** Summary for a stored effect of any generation. */
export function summarizeEffect(
  effect: Record<string, unknown>,
  speciesName?: (slug: string) => string | undefined,
): string {
  return summarizeSelector(formFromEffect(effect), speciesName);
}

/* ─────────────────────── Validation issue wording ─────────────────────── */

export interface IssueLike {
  code: string;
  message: string;
  regions?: string[] | undefined;
}

/**
 * Author-facing wording for a validation issue. Selector issues get a plain
 * explanation (with region names, not ids); everything else keeps the
 * server's message. The server's own text stays available as `detail`.
 */
export function describeIssue(
  issue: IssueLike,
  regionNames?: Record<string, string>,
): { headline: string; detail: string | null } {
  switch (issue.code) {
    case 'selector_no_candidates':
      return {
        headline: 'This selector does not match any enabled Waifumon in any valid region.',
        detail: issue.message,
      };
    case 'selector_region_no_candidates': {
      const where =
        issue.regions && issue.regions.length > 0
          ? ` (${issue.regions.map((r) => regionLabel(r, regionNames)).join(', ')})`
          : '';
      return {
        headline:
          'This selector has no matching Waifumon in one or more regions where this ' +
          `encounter may run${where}.`,
        detail: issue.message,
      };
    }
    default:
      return { headline: issue.message, detail: null };
  }
}
