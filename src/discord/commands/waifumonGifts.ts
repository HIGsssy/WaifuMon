/**
 * Affection gift interactions.
 *
 * V1's whole surface is *inspect plus Accept Gift* — deliberately not a social
 * system, not a DM, and not an expiring prompt. The gift sits on the owned
 * copy until the player happens to look at her, which is exactly the moment
 * the reveal lands best.
 *
 * The reveal is the only place the item is named. The inspect teaser says only
 * that she is excited; this screen says what she was holding.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
} from 'discord.js';
import type { GiftClaimResult } from '../../modules/gifts/affectionGiftService';
import { gameEvent } from '../../modules/events/gameEvents';
import { AppError } from '../../shared/errors';
import { publicWaifuName } from '../gameEventBuilders';
import { emitEvents } from '../gameEventEmitter';
import { respondEphemeral } from '../ephemeralSession';
import { withBackRow } from '../ui';
import type { AppContext, Provisioned } from '../types';
import { buildCustomId } from '../types';

const RARITY_COLORS: Record<string, number> = {
  N: 0xb8b8b8,
  R: 0x6fb1ff,
  SR: 0xa66fff,
  SSR: 0xffc46f,
  UR: 0xff6fa5,
  LR: 0xff3d7f,
  EX: 0xffffff,
};

/** The reveal screen. Names the item, and offers the way back to her card. */
function giftRevealMessage(result: GiftClaimResult): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const name = publicWaifuName(result);
  const emoji = result.item.emoji ?? '🎁';
  const embed = new EmbedBuilder()
    .setTitle(`🎁 A gift from ${name}`)
    .setColor(RARITY_COLORS[result.species.rarity] ?? 0xff6fa5)
    .setDescription(
      `**She presses something into your hands, then looks away.**\n\n` +
        `${emoji} **${result.item.name}** ×${result.quantity}\n` +
        `_${result.item.description || 'No description.'}_`,
    )
    .setFooter({ text: `You now hold ×${result.quantityAfter}.` });

  const back = new ButtonBuilder()
    .setCustomId(buildCustomId('col', 'pick_id', String(result.waifu.id)))
    .setLabel(`⟵ Back to ${name}`)
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(back),
      ...withBackRow(),
    ],
  };
}

/**
 * `gift:claim <waifuId>` — accept the gift waiting on one owned copy.
 *
 * The service is transactional and idempotent, so a double-clicked button
 * grants once and the loser is told plainly that it already landed. Every
 * refusal (capacity in particular) leaves the gift exactly where it was.
 */
export async function handleGiftClaim(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, 'That button no longer works~');
    return;
  }

  let result: GiftClaimResult;
  try {
    result = await ctx.services.gifts.claimGift(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof AppError) {
      await respondEphemeral(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    throw err;
  }

  await respondEphemeral(interaction, giftRevealMessage(result));

  // Post-commit only. The claim is already durable; a feed failure can never
  // un-give a gift (`emitEvents` swallows subscriber errors regardless).
  await emitEvents(ctx, interaction, prov, [
    gameEvent('WAIFU_GIFT_CLAIMED', {
      waifuId: result.waifu.id,
      waifuName: publicWaifuName(result),
      itemSlug: result.item.slug,
      itemName: result.item.name,
      quantity: result.quantity,
    }),
  ]);
}
