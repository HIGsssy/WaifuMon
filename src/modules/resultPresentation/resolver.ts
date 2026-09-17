/**
 * The pure Result Presentation resolver: given an outcome that gameplay has
 * *already* resolved, pick how to show it.
 *
 * It is handed everything it may use and nothing else — the key, the
 * authored variants, a fallback line pool and a **presentation** random
 * source. It never sees a transaction, a gameplay service, the tables or the
 * gameplay RNG, and it returns presentation data only. That is the whole
 * safety argument: there is nothing here that could change an amount, an
 * item, a species or a state.
 *
 * Call it once per player-facing result and hand the answer to the renderer;
 * renderers must not re-resolve, so a screen never shows one variant's text
 * with another's artwork.
 *
 * Phase 1 selection depends only on the key: no region, item or species
 * filtering yet. Those would arrive as an extra, optional input.
 */
import { rollWeighted, type Rng } from '../../shared/random';
import {
  defaultArtworkModeFor,
  isArtworkModeAllowed,
  type ArtworkMode,
  type ResultPresentationKey,
} from './keys';

/** An authored variant as the resolver consumes it. */
export interface ResultPresentationVariant {
  id: number;
  presentationKey: ResultPresentationKey;
  enabled: boolean;
  weight: number;
  flavorText: string | null;
  artworkPath: string | null;
  artworkMode: ArtworkMode;
}

/** Where the resolved flavor line came from. */
export type FlavorSource = 'authored' | 'fallback' | 'none';

export interface ResolvedResultPresentation {
  key: ResultPresentationKey;
  /** The authored variant chosen, or null when the built-in one is used. */
  variantId: number | null;
  flavorText: string | null;
  flavorSource: FlavorSource;
  artworkMode: ArtworkMode;
  /** Set only when `artworkMode` is `custom`. */
  artworkPath: string | null;
  /** True when no authored variant was available and the built-in was used. */
  usedFallback: boolean;
}

export interface ResolveResultPresentationInput {
  key: ResultPresentationKey;
  /** Candidate variants; anything disabled, off-key or unusable is ignored. */
  variants: readonly ResultPresentationVariant[];
  /**
   * Built-in lines for this key, used when no variant is available or the
   * chosen variant has no text of its own. Empty → no line.
   */
  fallbackFlavorLines?: readonly string[] | undefined;
  /** Presentation randomness. Never the gameplay RNG. */
  rng: Rng;
}

/** A variant the runtime can honour for this key. */
export function isUsableVariant(
  key: ResultPresentationKey,
  variant: ResultPresentationVariant,
): boolean {
  return (
    variant.presentationKey === key &&
    variant.enabled &&
    Number.isFinite(variant.weight) &&
    variant.weight > 0 &&
    isArtworkModeAllowed(key, variant.artworkMode) &&
    (variant.artworkMode !== 'custom' || Boolean(variant.artworkPath))
  );
}

function pickLine(lines: readonly string[] | undefined, rng: Rng): string | null {
  const pool = (lines ?? []).filter((line) => line.trim().length > 0);
  if (pool.length === 0) return null;
  return pool[rng.intInclusive(0, pool.length - 1)]!;
}

export function resolveResultPresentation(
  input: ResolveResultPresentationInput,
): ResolvedResultPresentation {
  const { key, rng } = input;
  const usable = input.variants.filter((v) => isUsableVariant(key, v));

  if (usable.length === 0) {
    const line = pickLine(input.fallbackFlavorLines, rng);
    return {
      key,
      variantId: null,
      flavorText: line,
      flavorSource: line ? 'fallback' : 'none',
      artworkMode: defaultArtworkModeFor(key),
      artworkPath: null,
      usedFallback: true,
    };
  }

  const chosen = rollWeighted(
    usable.map((v) => ({ weight: v.weight, value: v })),
    rng,
  );
  return presentVariant(key, chosen, input.fallbackFlavorLines, rng);
}

/** The presentable parts of a variant; weight and enabled do not affect the look. */
export type PresentableVariant = Pick<
  ResultPresentationVariant,
  'flavorText' | 'artworkMode' | 'artworkPath'
> & { id: number | null };

/**
 * Present one specific variant — no selection. `resolveResultPresentation`
 * uses this for the variant it picked, and the admin preview uses it for the
 * unsaved variant in the editor, so both describe a variant identically.
 *
 * An artwork-only variant still gets words where the key has built-in ones (a
 * "nothing found" screen is its line), drawn from `rng`.
 */
export function presentVariant(
  key: ResultPresentationKey,
  variant: PresentableVariant,
  fallbackFlavorLines: readonly string[] | undefined,
  rng: Rng,
): ResolvedResultPresentation {
  const authored = variant.flavorText?.trim() ? variant.flavorText : null;
  const line = authored ?? pickLine(fallbackFlavorLines, rng);
  return {
    key,
    variantId: variant.id,
    flavorText: line,
    flavorSource: authored ? 'authored' : line ? 'fallback' : 'none',
    artworkMode: variant.artworkMode,
    artworkPath: variant.artworkMode === 'custom' ? variant.artworkPath : null,
    usedFallback: false,
  };
}
