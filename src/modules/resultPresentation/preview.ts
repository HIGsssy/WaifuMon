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
  isArtworkModeAllowed,
  RESULT_PRESENTATION_KEY_DEFINITIONS,
  type ArtworkMode,
  type ResultPresentationKey,
} from './keys';
import { presentVariant, type FlavorSource } from './resolver';
import {
  BACK_TO_HUNTING_FALLBACK_LINES,
  buildBackToHuntingScreen,
  buildConversionScreen,
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

/** The keys whose preview is a hunt find (or "nothing found"). */
type HuntFindKey =
  | 'hunt.waifubux_find'
  | 'hunt.essence_find'
  | 'hunt.item_find'
  | 'hunt.rare_item_find'
  | 'hunt.nothing_found';

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
export const PREVIEW_FIXTURES: Readonly<Record<HuntFindKey, FixtureFacts>> = {
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

/**
 * The sample Back to Hunting screen. The region is a real one from content
 * when there is one, so the line reads as it will in play.
 */
export const BACK_TO_HUNTING_PREVIEW_REGION_NAME = 'Waifu Valley';

/**
 * The sample conversion. Her name comes from the preview Waifumon when one is
 * chosen, so the name and the artwork agree; the Essence numbers are fixed
 * here and can never be supplied by a request.
 */
export const CONVERSION_PREVIEW_FIXTURE = {
  displayName: 'Example Waifumon',
  essenceGranted: 32,
  balanceAfter: 672,
} as const;

export interface PreviewSpecies {
  slug: string;
  name: string;
  rarity: string;
}

export interface ResultPresentationPreviewDeps {
  items: ReadonlyArray<{ slug: string; name: string; emoji?: string | null | undefined }>;
  /** The live `tables.hunt.flavor` pool. */
  huntFlavorPool: readonly string[];
  /** Enabled species a preview may show, in display order. */
  species: readonly PreviewSpecies[];
  /** Region display names, for the Back to Hunting sample. */
  regionNames: readonly string[];
  locateArtwork(relativePath: string): LocatedArtwork;
  /** Whether her canonical artwork resolves for `slug`. */
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
  /** The Waifumon this preview shows; null for keys that show none. */
  previewSpecies: PreviewSpecies | null;
}

/** Always the first built-in line, so a preview is stable while typing. */
const firstLine = {
  next: () => 0,
  intInclusive: (min: number) => min,
};

function huntFacts(key: HuntFindKey, deps: ResultPresentationPreviewDeps): HuntScreenFacts {
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
  /**
   * Which Waifumon to show, for the keys that show one (a release, a
   * conversion). Preview-only: never stored, and it does not make the variant
   * apply to that Waifumon.
   */
  previewSpeciesSlug?: string | null | undefined;
}

/** The sample screen for one key, through the shared screen model. */
function buildPreviewScreen(
  key: ResultPresentationKey,
  presentation: ReturnType<typeof presentVariant>,
  species: PreviewSpecies | null,
  deps: ResultPresentationPreviewDeps,
): ResultScreen {
  switch (key) {
    case 'encounter.released':
      return buildReleaseScreen({ species }, presentation);
    case 'world_encounter.back_to_hunting':
      return buildBackToHuntingScreen(
        {
          regionName: deps.regionNames[0] ?? BACK_TO_HUNTING_PREVIEW_REGION_NAME,
          energyRemaining: PREVIEW_ENERGY_REMAINING,
        },
        presentation,
      );
    case 'collection.converted_to_essence':
      return buildConversionScreen(
        {
          displayName: species?.name ?? CONVERSION_PREVIEW_FIXTURE.displayName,
          essenceGranted: CONVERSION_PREVIEW_FIXTURE.essenceGranted,
          balanceAfter: CONVERSION_PREVIEW_FIXTURE.balanceAfter,
          // A Buddy Bonus line is reported only when one actually applied, so
          // a sample never invents one.
          buddyLine: null,
          hasSpeciesArtwork: species !== null,
        },
        presentation,
      );
    default:
      return buildHuntResultScreen(huntFacts(key, deps), presentation);
  }
}

export function buildResultPresentationPreview(
  request: PreviewRequest,
  deps: ResultPresentationPreviewDeps,
): ResultPresentationPreview {
  const variant = parseResultPresentationPreviewVariant(request.variant);
  const key = variant.presentationKey;
  // Whichever keys may show a Waifumon get the preview picker — today a
  // release and a conversion. Asked of the canonical rules, not listed here.
  const showsWaifumon = isArtworkModeAllowed(key, 'encountered');

  let species: PreviewSpecies | null = null;
  if (showsWaifumon) {
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
      { path: 'previewSpeciesSlug', message: 'This result does not show a Waifumon.' },
    ]);
  }

  const fallbackLines =
    key === 'hunt.nothing_found'
      ? deps.huntFlavorPool
      : key === 'encounter.released'
        ? RELEASE_FALLBACK_LINES
        : key === 'world_encounter.back_to_hunting'
          ? BACK_TO_HUNTING_FALLBACK_LINES
          : [];
  const presentation = presentVariant(
    key,
    { id: null, ...variant },
    fallbackLines,
    firstLine,
  );

  const screen = buildPreviewScreen(key, presentation, species, deps);

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
        : key === 'world_encounter.back_to_hunting'
          ? 'No flavor text on this variant: players see the standard "you pick up the trail" line.'
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
