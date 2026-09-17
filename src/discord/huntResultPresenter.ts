/**
 * Hunt result presenter — renders the lightweight outcome screens (a hunt
 * find, "nothing found", a released Waifumon) as Discord embeds.
 *
 * The layout itself — titles, the code-generated mechanical lines, where
 * authored prose goes, which image applies — is decided once in
 * `modules/resultPresentation/screens.ts`, and the Portal preview renders the
 * same model. This module only turns that model into an `EmbedBuilder` and
 * resolves the image into an attachment.
 *
 * The presentation was chosen before this call and is never re-rolled here.
 * There is no template language: authored text is shown as written.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { SpeciesRow } from '../db/schema';
import type { HuntEncounterResult, HuntResult } from '../modules/hunt/huntService';
import type { ResultPresentationKey } from '../modules/resultPresentation/keys';
import type { ResolvedResultPresentation } from '../modules/resultPresentation/resolver';
import {
  buildHuntResultScreen,
  buildReleaseScreen,
  huntPresentationKey as keyForKind,
  type ResultScreen,
} from '../modules/resultPresentation/screens';
import { CARD_FILENAME } from './assets/resolveAppearanceAsset';
import {
  resolveArtworkAttachment,
  type ArtworkAttachmentContext,
} from './assets/resolveArtworkAttachment';
import { buddyAwardFeedbackLines, buddyBonusFeedbackLines } from './buddyBonusFeedback';
import type { SessionPayload } from './ephemeralSession';
import { buildCustomId } from './types';
import { withBackRow } from './ui';

export {
  NOTHING_FOUND_DEFAULT_LINE,
  RELEASE_FALLBACK_LINES,
  rarityColor,
} from '../modules/resultPresentation/screens';

/** Every hunt result that is not a wild Waifumon. */
export type FillerHuntResult = Exclude<HuntResult, HuntEncounterResult>;

/** The presentation key a filler hunt result is shown under. */
export function huntPresentationKey(result: FillerHuntResult): ResultPresentationKey {
  return keyForKind(result.kind);
}

/** Small "Hunt again" pill for the non-encounter result screens. */
export function huntAgainRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('menu', 'hunt'))
      .setLabel('Hunt again')
      .setEmoji('🏹')
      .setStyle(ButtonStyle.Primary),
  );
}

function attachmentStem(key: ResultPresentationKey): string {
  return `result_${key.replace(/\./g, '_')}`;
}

/**
 * Render a screen model. `encounteredArtwork` is consulted only when the
 * screen asks for the Waifumon's own art, so no asset work is wasted.
 */
function renderScreen(
  ctx: ArtworkAttachmentContext,
  screen: ResultScreen,
  presentation: ResolvedResultPresentation,
  encounteredArtwork: () => AttachmentBuilder | null = () => null,
): { embed: EmbedBuilder; files: AttachmentBuilder[] } {
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
    const file = encounteredArtwork();
    if (file) {
      embed.setImage(`attachment://${CARD_FILENAME}`);
      files.push(file);
    }
  }
  return { embed, files };
}

/** The screen for a non-encounter hunt result. */
export function buildHuntResultView(
  ctx: ArtworkAttachmentContext,
  result: FillerHuntResult,
  presentation: ResolvedResultPresentation,
): SessionPayload {
  const buddyLines = [
    ...buddyBonusFeedbackLines(result.buddyBonuses),
    ...buddyAwardFeedbackLines(result.buddyAward),
  ];
  const screen = buildHuntResultScreen(result, presentation, buddyLines);
  const { embed, files } = renderScreen(ctx, screen, presentation);
  return { embeds: [embed], components: withBackRow([huntAgainRow()]), files };
}

/**
 * One line naming a reward this hunt already granted, for the World
 * Encounter screen that took this hunt's turn. Read straight off the
 * committed result; nothing is recomputed. Null when there is no reward to
 * report ("nothing found", or a wild Waifumon).
 */
export function alongTheWaySummary(result: HuntResult): string | null {
  switch (result.kind) {
    case 'waifubux_find':
      return `💰 +${result.amount} WaifuBux`;
    case 'essence_find':
      return `✨ +${result.amount} Essence`;
    case 'item_find':
      return `🎒 Found ${result.item.emoji ? `${result.item.emoji} ` : ''}**${result.item.name}** ×${result.quantity}`;
    case 'rare_item_find':
      return `🌟 Rare find: ${result.item.emoji ? `${result.item.emoji} ` : ''}**${result.item.name}** ×${result.quantity}`;
    case 'flavor':
    case 'encounter':
      return null;
  }
}

export interface ReleaseViewInput {
  /** The released Waifumon, or null if her row could not be read. */
  species: SpeciesRow | null;
  presentation: ResolvedResultPresentation;
  /**
   * Her canonical artwork as a `card.png` attachment. Called only when the
   * presentation asks for `encountered` art, so no asset work is wasted.
   */
  encounteredArtwork: () => AttachmentBuilder | null;
}

/**
 * The screen after Let Her Go. The release itself has already committed;
 * this only describes it. Works the same for hunted and spawned encounters.
 */
export function buildReleaseView(
  ctx: ArtworkAttachmentContext,
  input: ReleaseViewInput,
): SessionPayload {
  const screen = buildReleaseScreen({ species: input.species }, input.presentation);
  const { embed, files } = renderScreen(ctx, screen, input.presentation, input.encounteredArtwork);
  return { content: '', embeds: [embed], components: withBackRow(), files };
}
