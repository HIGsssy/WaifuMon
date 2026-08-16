/**
 * The one place that knows how to turn authored species content into renderer
 * input.
 *
 * It lives on the *content* side of the boundary on purpose. The cards module
 * stays a pure presentation layer that takes a resolved, self-contained input
 * and returns bytes — it never learns what a `SpeciesContent` is, never reads
 * the loader, and never touches the database. Everything content-shaped
 * (archetype fallback, optional `card` block, level defaulting) is resolved
 * here, so the renderer keeps exactly one way in.
 *
 * Artwork resolution is deliberately *not* done here: which appearance a player
 * has equipped, and where its bytes live, is a question for the caller (the API
 * route, the cache warmer), answered by the shared appearance resolver. What
 * this helper insists on is that the caller hand over the *result* of that
 * resolution as one value — see {@link CardArtworkSource} — so a card is always
 * keyed by the artwork it actually drew.
 */
import type { CardRenderInput, SpeciesCardMeta as RendererCardMeta } from '../cards';
import { resolveRace } from '../cards';
import type { Logger } from '../../shared/logger';
import type { SpeciesCardMeta, SpeciesContent } from './schemas';

/**
 * Compile-time guard that the authored shape still fits the renderer's shape.
 * The two are declared independently — the renderer must not import content
 * types — so this is what catches them drifting apart.
 */
const _cardMetaIsRenderable: RendererCardMeta = {} as SpeciesCardMeta;
void _cardMetaIsRenderable;

/** Everything the bridge needs from a species; a `SpeciesContent` satisfies it. */
export type CardRenderableSpecies = Pick<
  SpeciesContent,
  'slug' | 'name' | 'rarity' | 'archetype' | 'affinity'
> &
  Partial<Pick<SpeciesContent, 'race' | 'card'>>;

/**
 * The artwork a card is being rendered from — path and identity together.
 *
 * Structurally satisfied by `ResolvedAppearanceAsset` from the shared
 * appearance resolver, which is the point: after a fallback, `absolutePath`
 * and `assetId` describe the *same* asset, and taking them as one value makes
 * it impossible to pair resolved bytes with a requested id.
 *
 * That pairing is not hypothetical. Two appearances that both fall back to the
 * species default render byte-identical cards; keying them by what was
 * *requested* would mint two master renders of one image, and every future
 * fallback would quietly double the cache.
 */
export interface CardArtworkSource {
  absolutePath: string;
  assetId: { variant: string };
}

export interface SpeciesCardInputOptions {
  /**
   * The artwork that actually resolved. Supplies both the bytes to draw and
   * the appearance identity to key the render by — see
   * {@link CardArtworkSource}.
   */
  artwork: CardArtworkSource;
  /** Level printed on the card. Defaults to 1, matching a fresh capture. */
  level?: number;
  /** Requested display width; omitted means the full-size master. */
  width?: number;
  /** Per-render metadata overrides. Rare — event skins, previews. */
  overrides?: SpeciesCardMeta;
  /** Receives the race-fallback warning when `race` is absent and unmappable. */
  logger?: Logger;
}

/**
 * Builds a {@link CardRenderInput} from authored content.
 *
 * Race is resolved here (explicit `race` → archetype fallback → `human`), so
 * the renderer receives a `RaceCode` it can trust and never has to know that
 * `archetype` exists.
 */
export function toCardRenderInput(
  species: CardRenderableSpecies,
  options: SpeciesCardInputOptions,
): CardRenderInput {
  const race = resolveRace(
    {
      slug: species.slug,
      ...(species.race === undefined ? {} : { race: species.race }),
      archetype: species.archetype,
    },
    options.logger,
  );

  const input: CardRenderInput = {
    species: {
      slug: species.slug,
      name: species.name,
      rarity: species.rarity,
      race,
      affinity: species.affinity,
      ...(species.card === undefined ? {} : { card: species.card }),
    },
    variant: {
      // The *resolved* variant, never the requested one.
      appearanceId: options.artwork.assetId.variant,
      artworkAbsolutePath: options.artwork.absolutePath,
    },
    progress: { level: options.level ?? 1 },
  };

  return {
    ...input,
    ...(options.width === undefined ? {} : { output: { width: options.width } }),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  };
}
