/**
 * Cold card rendering without disturbing the real card cache.
 *
 * ## The problem
 *
 * A cold render test needs cards nobody has drawn. Clearing the cache would
 * produce them — and would also throw away every real player's cached cards,
 * making the *next* hour of real traffic a cold-render storm. And a run that
 * leaves its renders behind is warm the second time, so it cannot be repeated.
 *
 * ## The approach
 *
 * Level is part of a card's render key, and `/cards/species/:slug` takes a
 * `level`. So the key space already holds thousands of legitimate cards that
 * have simply never been requested — a level-37 preview of a species nobody
 * has at 37. The planner walks that space (species every synthetic player has
 * discovered, highest levels first, since those are the least likely to exist)
 * and keeps only keys whose master is **not on disk right now**. Every planned
 * request therefore really rasterizes, through the real renderer, worker pool
 * and disk cache that serve players.
 *
 * After the run, `evictColdCards` removes exactly those keys' files — master
 * and derivatives — and nothing else. The cache ends the run holding what it
 * held before it, so the next cold run is cold again. Nothing that existed
 * before the run is ever deleted: a key only enters the plan if its master was
 * absent at plan time.
 *
 * The one overlap worth naming: if a real player requests one of those exact
 * previews during the run, that file is removed too. It is a cache entry, and
 * it re-renders on next request.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CardRenderInput, CardRenderer } from '../cards';
import { CARD_WIDTH_BUCKETS } from '../cards/version';
import { speciesCardRequest, type CardPresentationDeps } from '../appearance/cardPresentation';
import type { ColdCardTarget } from './types';

export interface PlannedColdCard extends ColdCardTarget {
  renderKey: string;
}

export interface ColdPlanDeps {
  renderer: Pick<CardRenderer, 'isCached' | 'computeMasterRenderKey'>;
  /**
   * The render input `/cards/species/:slug?level=` resolves to, or null when
   * that species cannot be drawn. Defaults to the route's own resolution via
   * `speciesCardRequest`, so the planned key is exactly the key the request
   * will render.
   */
  inputFor?: (slug: string, level: number) => CardRenderInput | null;
  presentation?: CardPresentationDeps;
  maxLevel: number;
}

function routeInput(presentation: CardPresentationDeps) {
  return (slug: string, level: number): CardRenderInput | null => {
    const species = presentation.appearance.speciesContent(slug);
    if (!species) return null;
    try {
      // No width: the probe is for the master, which is the expensive part.
      return speciesCardRequest(presentation, species, { level }).input;
    } catch {
      return null; // missing artwork — not a card this route could draw either
    }
  };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const KEY_PATTERN = /^[0-9a-f]{8,64}$/;

/**
 * Up to `count` uncached (species, level) masters, interleaved across species
 * so a burst spreads over artwork rather than hammering one file.
 */
export async function planColdCards(
  deps: ColdPlanDeps,
  slugs: readonly string[],
  count: number,
): Promise<PlannedColdCard[]> {
  const out: PlannedColdCard[] = [];
  if (count <= 0) return out;
  const inputFor =
    deps.inputFor ??
    (deps.presentation ? routeInput(deps.presentation) : () => null);
  for (let level = deps.maxLevel; level >= 1 && out.length < count; level -= 1) {
    for (const slug of slugs) {
      if (out.length >= count) break;
      if (!SLUG_PATTERN.test(slug)) continue;
      const input = inputFor(slug, level);
      if (!input) continue;
      if (await deps.renderer.isCached(input)) continue;
      out.push({ slug, level, renderKey: await deps.renderer.computeMasterRenderKey(input) });
    }
  }
  return out;
}

/**
 * Deletes the planned keys' master and derivative files from `cacheRoot`.
 * Names are validated before any path is built, so nothing outside
 * `<cacheRoot>/<slug>/` can be touched. Returns the number of files removed.
 */
export async function evictColdCards(
  cacheRoot: string,
  planned: readonly PlannedColdCard[],
): Promise<number> {
  const root = path.resolve(cacheRoot);
  let removed = 0;
  for (const card of planned) {
    if (!SLUG_PATTERN.test(card.slug) || !KEY_PATTERN.test(card.renderKey)) continue;
    const dir = path.join(root, card.slug);
    if (path.dirname(dir) !== root) continue;
    const names = [
      `${card.renderKey}.webp`,
      ...CARD_WIDTH_BUCKETS.map((w) => `${card.renderKey}@${w}.webp`),
    ];
    for (const name of names) {
      try {
        await fs.unlink(path.join(dir, name));
        removed += 1;
      } catch {
        // Absent is the normal case for most derivative widths.
      }
    }
  }
  return removed;
}
