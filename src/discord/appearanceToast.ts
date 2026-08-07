/**
 * The progression toast — "you earned something, here it is, want it now?".
 *
 * v1 carries appearance unlocks. The shape is deliberately generic (title,
 * artwork, a requirement line, a rarity tag, an accept/browse/dismiss row), so
 * a future evolution / achievement / gift notification reuses this renderer
 * with a different payload rather than growing a parallel one.
 *
 * Rendering rules that make it feel like a reward instead of a log line:
 *   - the *new* artwork is attached, resolved from its `AssetId` through the
 *     Discord process's own resolver — no path crosses into this file;
 *   - the requirement that was met is named ("Reach Level 20"), because that is
 *     the sentence the player just earned;
 *   - `Select Now` applies it in one click, `View Gallery` opens the journal,
 *     and doing nothing is a valid third option — dismissing costs nothing and
 *     the look stays unlocked forever.
 *
 * Every send is best-effort: this runs after the gameplay transaction has
 * committed, so a Discord failure is logged and swallowed rather than surfaced.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import type { AppearanceUnlockRef } from '../modules/appearance/appearanceService';
import { CARD_FILENAME, resolveAppearanceAsset } from './assets/resolveAppearanceAsset';
import type { AppContext, PlayerInteraction } from './types';
import { buildCustomId } from './types';

const COSMETIC_RARITY_LABELS: Record<string, string> = {
  standard: 'Standard',
  common: 'Common',
  rare: 'Rare',
  seasonal: 'Seasonal',
  limited: 'Limited',
  exclusive: 'Exclusive',
};

/**
 * At most this many toasts per action. A player who levels a copy through
 * several milestones at once gets the first few plus a "check the gallery"
 * nudge, rather than five stacked ephemerals.
 */
const MAX_TOASTS = 3;

export interface AppearanceToastView {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  files: ReturnType<typeof resolveAppearanceAsset>[];
}

/** Pure view builder — no Discord calls, no DB. Unit-testable. */
export function buildAppearanceUnlockView(
  ctx: AppContext,
  unlock: AppearanceUnlockRef,
  waifuName: string,
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder>; card: ReturnType<typeof resolveAppearanceAsset> } {
  const rarityLabel = COSMETIC_RARITY_LABELS[unlock.cosmeticRarity] ?? 'Common';
  const embed = new EmbedBuilder()
    .setTitle('🎀 New Appearance Unlocked!')
    .setColor(0xffb6d1)
    .setDescription(
      `**${waifuName}** earned a new look: **${unlock.name}**.\n` +
        `_${unlock.unlockLabel}_`,
    )
    .setFooter({ text: `✦ ${rarityLabel} · Cosmetic only — nothing about her changes.` });

  const card = resolveAppearanceAsset(ctx, unlock.assetId);
  if (card) embed.setImage(`attachment://${CARD_FILENAME}`);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildCustomId('appear', 'select', String(unlock.waifuId), unlock.appearanceId),
      )
      .setLabel('🎀 Select Now')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(
        buildCustomId('appear', 'open', String(unlock.waifuId), '1', unlock.appearanceId),
      )
      .setLabel('View Gallery')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, row, card };
}

/**
 * Follow up the player's ephemeral with one toast per new appearance.
 *
 * Called *after* the outcome screen is painted, so the reward lands on top of
 * the thing that caused it. Never throws.
 */
export async function postAppearanceUnlockToasts(
  ctx: AppContext,
  interaction: PlayerInteraction,
  unlocks: readonly AppearanceUnlockRef[],
  waifuName: string,
): Promise<void> {
  if (unlocks.length === 0) return;

  for (const unlock of unlocks.slice(0, MAX_TOASTS)) {
    try {
      const { embed, row, card } = buildAppearanceUnlockView(ctx, unlock, waifuName);
      await interaction.followUp({
        embeds: [embed],
        components: [row],
        files: card ? [card] : [],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      ctx.logger.warn(
        { err, waifuId: unlock.waifuId, appearanceId: unlock.appearanceId },
        'appearance unlock toast failed',
      );
    }
  }

  const overflow = unlocks.length - MAX_TOASTS;
  if (overflow > 0) {
    try {
      await interaction.followUp({
        content: `🎀 …and **${overflow}** more new look${overflow === 1 ? '' : 's'}. Open the gallery to see them.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      ctx.logger.warn({ err }, 'appearance unlock overflow notice failed');
    }
  }
}
