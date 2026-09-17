/**
 * Result Presentation preview — how the variant *currently in the editor*
 * would look, before anything is saved.
 *
 * Deliberately inert:
 *
 *   - nothing is written, no service is called, no reward exists;
 *   - there is no weighted selection — the author sees *this* variant;
 *   - the input is validated with exactly the write rules, so a preview can
 *     never show something a save would refuse;
 *   - the layout comes from `screens.ts`, the same model Discord renders.
 *
 * The gameplay values on a preview are fixed, clearly synthetic samples owned
 * here. They are not part of the variant, and the request cannot supply them:
 * mechanical values are never author-controlled.
 */
import type { LocatedArtwork } from '../assets/artworkFile';
import {
  RESULT_PRESENTATION_KEY_DEFINITIONS,
  type ArtworkMode,
  type ResultPresentationKey,
} from './keys';
import { presentVariant, type FlavorSource } from './resolver';
import {
  buildHuntResultScreen,
  buildReleaseScreen,
  RELEASE_FALLBACK_LINES,
  type HuntScreenFacts,
  type ResultScreen,
} from './screens';
import {
  parseResultPresentationPreviewVariant,
  ResultPresentationValidationError,
} from './validation';

/** Shown above every preview. */
export const PREVIEW_SAMPLE_NOTICE =
  'Sample gameplay values are shown below. They are not part of this variant.';

/** Energy shown in every hunt preview footer. */
export const PREVIEW_ENERGY_REMAINING = 18;

type HuntPreviewKey = Exclude<ResultPresentationKey, 'encounter.released'>;

type FixtureFacts =
  | { kind: 'waifubux_find'; amount: number; balanceAfter: number }
  | { kind: 'essence_find'; amount: number; balanceAfter: number }
  | { kind: 'item_find' | 'rare_item_find'; itemSlug: string; itemName: string; quantity: number }
  | { kind: 'flavor' };

/**
 * The sample result shown for each hunt key. Items name a real shipped item
 * so the emoji matches the live catalogue; the fallback name keeps the
 * preview working if that item is ever removed.
 */
export const PREVIEW_FIXTURES: Readonly<Record<HuntPreviewKey, FixtureFacts>> = {
  'hunt.waifubux_find': { kind: 'waifubux_find', amount: 12, balanceAfter: 1284 },
  'hunt.essence_find': { kind: 'essence_find', amount: 24, balanceAfter: 640 },
  'hunt.item_find': { kind: 'item_find', itemSlug: 'basic_charm', itemName: 'Basic Charm', quantity: 1 },
  'hunt.rare_item_find': {
    kind: 'rare_item_find',
    itemSlug: 'velvet_charm',
    itemName: 'Velvet Charm',
    quantity: 1,
  },
  'hunt.nothing_found': { kind: 'flavor' },
};

export interface PreviewSpecies {
  slug: string;
  name: string;
  rarity: string;
}

export interface ResultPresentationPreviewDeps {
  items: ReadonlyArray<{ slug: string; name: string; emoji?: string | null | undefined }>;
  /** The live `tables.hunt.flavor` pool. */
  huntFlavorPool: readonly string[];
  /** Enabled species a release preview may show, in display order. */
  species: readonly PreviewSpecies[];
  locateArtwork(relativePath: string): LocatedArtwork;
  /** Whether the release screen's species artwork resolves for `slug`. */
  speciesArtworkAvailable(slug: string): boolean;
}

export type PreviewArtwork =
  | { mode: 'none' }
  | { mode: 'custom'; path: string; status: 'available' | 'missing' | 'unsafe' }
  | { mode: 'encountered'; species: PreviewSpecies | null; available: boolean };

export interface ResultPresentationPreview {
  key: ResultPresentationKey;
  label: string;
  screen: Omit<ResultScreen, 'artwork' | 'sections'> & {
    /** `sample` marks gameplay values that come from the preview fixture. */
    sections: Array<ResultScreen['sections'][number] & { sample: boolean }>;
  };
  artwork: PreviewArtwork;
  artworkMode: ArtworkMode;
  flavorSource: FlavorSource;
  /** Explains a flavor line the author did not write, when one is shown. */
  flavorNote: string | null;
  sampleNotice: string;
  /** The Waifumon a release preview shows; null for hunt keys. */
  previewSpecies: PreviewSpecies | null;
}

/** Always the first built-in line, so a preview is stable while typing. */
const firstLine = {
  next: () => 0,
  intInclusive: (min: number) => min,
};

function huntFacts(key: HuntPreviewKey, deps: ResultPresentationPreviewDeps): HuntScreenFacts {
  const fixture = PREVIEW_FIXTURES[key];
  const common = { energyRemaining: PREVIEW_ENERGY_REMAINING, levelUps: [] };
  switch (fixture.kind) {
    case 'item_find':
    case 'rare_item_find': {
      const item = deps.items.find((i) => i.slug === fixture.itemSlug);
      return {
        ...common,
        kind: fixture.kind,
        item: { name: item?.name ?? fixture.itemName, emoji: item?.emoji ?? null },
        quantity: fixture.quantity,
      };
    }
    case 'flavor':
      return { ...common, kind: 'flavor' };
    default:
      return { ...common, ...fixture };
  }
}

export interface PreviewRequest {
  variant: unknown;
  /** Release previews only: which Waifumon to show. Never stored. */
  previewSpeciesSlug?: string | null | undefined;
}

export function buildResultPresentationPreview(
  request: PreviewRequest,
  deps: ResultPresentationPreviewDeps,
): ResultPresentationPreview {
  const variant = parseResultPresentationPreviewVariant(request.variant);
  const key = variant.presentationKey;
  const isRelease = key === 'encounter.released';

  let species: PreviewSpecies | null = null;
  if (isRelease) {
    const requested = request.previewSpeciesSlug ?? null;
    species = requested
      ? (deps.species.find((s) => s.slug === requested) ?? null)
      : (deps.species[0] ?? null);
    if (requested && !species) {
      throw new ResultPresentationValidationError([
        { path: 'previewSpeciesSlug', message: `Unknown or disabled Waifumon "${requested}".` },
      ]);
    }
  } else if (request.previewSpeciesSlug) {
    throw new ResultPresentationValidationError([
      { path: 'previewSpeciesSlug', message: 'Only a release preview shows a Waifumon.' },
    ]);
  }

  const fallbackLines =
    key === 'hunt.nothing_found'
      ? deps.huntFlavorPool
      : isRelease
        ? RELEASE_FALLBACK_LINES
        : [];
  const presentation = presentVariant(
    key,
    { id: null, ...variant },
    fallbackLines,
    firstLine,
  );

  const screen = isRelease
    ? buildReleaseScreen({ species }, presentation)
    : buildHuntResultScreen(huntFacts(key as HuntPreviewKey, deps), presentation);

  let artwork: PreviewArtwork = { mode: 'none' };
  if (screen.artwork.kind === 'custom') {
    const located = deps.locateArtwork(screen.artwork.path);
    artwork = { mode: 'custom', path: screen.artwork.path, status: located.status };
  } else if (variant.artworkMode === 'encountered') {
    artwork = {
      mode: 'encountered',
      species,
      available: species ? deps.speciesArtworkAvailable(species.slug) : false,
    };
  }

  const flavorNote =
    presentation.flavorSource !== 'fallback'
      ? null
      : key === 'hunt.nothing_found'
        ? 'No flavor text on this variant: players see a random line from the hunt flavor pool (the first line is shown here).'
        : 'No flavor text on this variant: players see the standard release message.';

  const { artwork: _artwork, sections, ...rest } = screen;
  return {
    key,
    label: RESULT_PRESENTATION_KEY_DEFINITIONS[key].label,
    screen: {
      ...rest,
      sections: sections.map((s) => ({ ...s, sample: s.kind !== 'flavor' })),
    },
    artwork,
    artworkMode: variant.artworkMode,
    flavorSource: presentation.flavorSource,
    flavorNote,
    sampleNotice: PREVIEW_SAMPLE_NOTICE,
    previewSpecies: species,
  };
}
