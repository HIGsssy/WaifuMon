/**
 * Renders a Result Presentation {@link ResultScreen} as a Discord embed.
 *
 * The layout — titles, the code-generated mechanical lines, where authored
 * prose goes, which image applies — is decided once in
 * `modules/resultPresentation/screens.ts`, and the Portal's preview renders
 * the same model. This module is only the Discord half: an `EmbedBuilder` and
 * the attachment for whichever image the screen asks for.
 *
 * Deliberately not navigation. Buttons belong to the handler that owns the
 * screen, so nothing authored can change where a control leads.
 */
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import type { ResultPresentationKey } from '../modules/resultPresentation/keys';
import {
  resolveResultPresentation,
  type ResolvedResultPresentation,
} from '../modules/resultPresentation/resolver';
import type { ResultScreen } from '../modules/resultPresentation/screens';
import { defaultRng } from '../shared/random';
import { CARD_FILENAME } from './assets/resolveAppearanceAsset';
import {
  resolveArtworkAttachment,
  type ArtworkAttachmentContext,
} from './assets/resolveArtworkAttachment';
import type { AppContext } from './types';

/**
 * Presentation randomness for a context wired without the presentation
 * service (tests, stripped-down graphs). Never the gameplay RNG.
 */
const fallbackPresentationRng = defaultRng();

/**
 * Choose how an already-resolved outcome is shown — once, after gameplay has
 * committed. Uses the authored variants when the service is wired, and the
 * built-in presentation otherwise. Never throws.
 */
export async function resolvePresentationFor(
  ctx: AppContext,
  key: ResultPresentationKey,
  fallbackFlavorLines: readonly string[] = [],
): Promise<ResolvedResultPresentation> {
  const service = ctx.services.resultPresentation;
  if (service) return service.resolve(key, { fallbackFlavorLines });
  return resolveResultPresentation({
    key,
    variants: [],
    fallbackFlavorLines,
    rng: fallbackPresentationRng,
  });
}

function attachmentStem(key: ResultPresentationKey): string {
  return `result_${key.replace(/\./g, '_')}`;
}

export interface RenderedResultScreen {
  embed: EmbedBuilder;
  files: AttachmentBuilder[];
}

/**
 * Render a screen model. `speciesArtwork` is consulted only when the screen
 * asks for the Waifumon's own art, so no asset work is wasted; it must never
 * throw — a screen describes something that already happened.
 */
export function renderResultScreen(
  ctx: ArtworkAttachmentContext,
  screen: ResultScreen,
  presentation: ResolvedResultPresentation,
  speciesArtwork: () => AttachmentBuilder | null = () => null,
): RenderedResultScreen {
  const embed = new EmbedBuilder()
    .setColor(screen.color)
    .setTitle(screen.title)
    .setDescription(screen.description);
  if (screen.footer) embed.setFooter({ text: screen.footer });

  const files: AttachmentBuilder[] = [];
  if (screen.artwork.kind === 'custom') {
    const artwork = resolveArtworkAttachment(ctx, {
      relativePath: screen.artwork.path,
      stem: attachmentStem(screen.key),
      logTag: 'result-presentation',
      logFields: { key: screen.key, variantId: presentation.variantId },
    });
    if (artwork) {
      embed.setImage(artwork.url);
      files.push(artwork.file);
    }
  } else if (screen.artwork.kind === 'encountered') {
    const file = speciesArtwork();
    if (file) {
      embed.setImage(`attachment://${CARD_FILENAME}`);
      files.push(file);
    }
  }
  return { embed, files };
}
