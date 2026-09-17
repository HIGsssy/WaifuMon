/**
 * Hunt result presenter — turns an already-resolved lightweight outcome (a
 * hunt find, "nothing found", a released Waifumon) plus its already-resolved
 * presentation into a Discord screen.
 *
 * Two inputs, two owners:
 *
 *   - the **result** is gameplay's: amounts, balances, the item and quantity,
 *     level-ups, Buddy Bonuses, Energy. Every mechanical line on the screen is
 *     generated here from it, verbatim, and nothing authored can replace it;
 *   - the **presentation** is authored: optional prose shown *alongside* the
 *     mechanical lines, and an optional image. It was chosen once, before this
 *     call, and is never re-rolled here.
 *
 * There is no template language: authored text is shown as written.
 *
 * Discord-only by design, like `worldEncounterPresenter.ts`; the choice of
 * variant lives in `modules/resultPresentation`.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { SpeciesRow } from '../db/schema';
import type {
  HuntEncounterResult,
  HuntResult,
} from '../modules/hunt/huntService';
import type { LevelUpEvent } from '../modules/progression/progressionService';
import type { ResultPresentationKey } from '../modules/resultPresentation/keys';
import type { ResolvedResultPresentation } from '../modules/resultPresentation/resolver';
import { CARD_FILENAME } from './assets/resolveAppearanceAsset';
import {
  resolveArtworkAttachment,
  type ArtworkAttachmentContext,
} from './assets/resolveArtworkAttachment';
import { buddyAwardFeedbackLines, buddyBonusFeedbackLines } from './buddyBonusFeedback';
import type { SessionPayload } from './ephemeralSession';
import { buildCustomId } from './types';
import { withBackRow } from './ui';

/** Every hunt result that is not a wild Waifumon. */
export type FillerHuntResult = Exclude<HuntResult, HuntEncounterResult>;

const RARITY_COLORS: Record<string, number> = {
  N: 0xb8b8b8,
  R: 0x6fb1ff,
  SR: 0xa66fff,
  SSR: 0xffc46f,
  UR: 0xff6fa5,
  LR: 0xff3d7f,
  EX: 0xffffff,
};

/** Embed accent for a species rarity. */
export function rarityColor(rarity: string): number {
  return RARITY_COLORS[rarity] ?? 0xff6fa5;
}

/** Accent shared by every hunt filler screen. */
const HUNT_RESULT_COLOR = 0xff6fa5;

const HUNT_RESULT_TITLES: Record<FillerHuntResult['kind'], string> = {
  item_find: '🎒 Item Found',
  rare_item_find: '🌟 Rare Find!',
  waifubux_find: '💰 WaifuBux Found',
  essence_find: '✨ Essence Found',
  flavor: '🍃 Nothing but wind…',
};

/** Shown on a "nothing found" screen when no line exists anywhere. */
export const NOTHING_FOUND_DEFAULT_LINE = 'Nothing turned up this time.';

/** Built-in release copy, used when no authored variant supplies text. */
export const RELEASE_FALLBACK_LINES: readonly string[] = ['You let her slip back into the neon~'];

/** The presentation key a filler hunt result is shown under. */
export function huntPresentationKey(result: FillerHuntResult): ResultPresentationKey {
  switch (result.kind) {
    case 'waifubux_find':
      return 'hunt.waifubux_find';
    case 'essence_find':
      return 'hunt.essence_find';
    case 'item_find':
      return 'hunt.item_find';
    case 'rare_item_find':
      return 'hunt.rare_item_find';
    case 'flavor':
      return 'hunt.nothing_found';
  }
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

function levelUpLines(levelUps: readonly LevelUpEvent[]): string | null {
  if (levelUps.length === 0) return null;
  return levelUps
    .map(
      (l) =>
        `⬆️ **Level ${l.toLevel}!**${l.rewardLabels.length ? ` — ${l.rewardLabels.join(', ')}` : ''}`,
    )
    .join('\n');
}

/** The code-generated line that states what the find *was*. */
function mechanicalLine(result: FillerHuntResult): string | null {
  switch (result.kind) {
    case 'item_find':
    case 'rare_item_find':
      return `${result.item.emoji ?? '•'} **${result.item.name}** ×${result.quantity}`;
    case 'waifubux_find':
      return `+**${result.amount}** WaifuBux (balance: ${result.balanceAfter})`;
    case 'essence_find':
      return `+**${result.amount}** Essence (balance: ${result.balanceAfter})`;
    case 'flavor':
      return null;
  }
}

function attachmentStem(key: ResultPresentationKey): string {
  return `result_${key.replace(/\./g, '_')}`;
}

/** Resolve a `custom` presentation image, or null. Never throws. */
function customArtwork(
  ctx: ArtworkAttachmentContext,
  presentation: ResolvedResultPresentation,
): { file: AttachmentBuilder; url: string } | null {
  if (presentation.artworkMode !== 'custom') return null;
  return resolveArtworkAttachment(ctx, {
    relativePath: presentation.artworkPath,
    stem: attachmentStem(presentation.key),
    logTag: 'result-presentation',
    logFields: { key: presentation.key, variantId: presentation.variantId },
  });
}

/**
 * The screen for a non-encounter hunt result.
 *
 * Layout: authored prose (if any), then the mechanical find, then level-ups,
 * then Buddy lines; footer is the Energy left. A "nothing found" screen's
 * prose *is* its body.
 */
export function buildHuntResultView(
  ctx: ArtworkAttachmentContext,
  result: FillerHuntResult,
  presentation: ResolvedResultPresentation,
): SessionPayload {
  const mechanical = mechanicalLine(result);
  const prose =
    result.kind === 'flavor'
      ? (presentation.flavorText ?? NOTHING_FOUND_DEFAULT_LINE)
      : presentation.flavorText;
  const bonusLines = [
    ...buddyBonusFeedbackLines(result.buddyBonuses),
    ...buddyAwardFeedbackLines(result.buddyAward),
  ];
  const description = [
    prose,
    mechanical,
    levelUpLines(result.levelUps),
    bonusLines.length > 0 ? bonusLines.join('\n') : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(HUNT_RESULT_COLOR)
    .setTitle(HUNT_RESULT_TITLES[result.kind])
    .setDescription(description)
    .setFooter({ text: `Energy left: ${result.energyRemaining}` });

  const files: AttachmentBuilder[] = [];
  const artwork = customArtwork(ctx, presentation);
  if (artwork) {
    embed.setImage(artwork.url);
    files.push(artwork.file);
  }

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
  const { species, presentation } = input;
  const embed = new EmbedBuilder()
    .setColor(species ? rarityColor(species.rarity) : HUNT_RESULT_COLOR)
    .setTitle(species ? `👋 You let ${species.name} go` : '👋 You let her go')
    .setDescription(presentation.flavorText ?? RELEASE_FALLBACK_LINES[0]!);

  const files: AttachmentBuilder[] = [];
  if (presentation.artworkMode === 'encountered') {
    const file = species ? input.encounteredArtwork() : null;
    if (file) {
      embed.setImage(`attachment://${CARD_FILENAME}`);
      files.push(file);
    }
  } else {
    const artwork = customArtwork(ctx, presentation);
    if (artwork) {
      embed.setImage(artwork.url);
      files.push(artwork.file);
    }
  }

  return { content: '', embeds: [embed], components: withBackRow(), files };
}
