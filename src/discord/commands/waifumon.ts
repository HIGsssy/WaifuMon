/**
 * Player-facing /waifumon UI (menu, profile, daily, inventory, shop).
 *
 * Navigation model: menu buttons and sub-screens paint the *same* ephemeral
 * message via `respondScreen`, so nothing stacks. First-touch slash commands
 * (`/waifumon shop`, etc.) reply fresh. Sub-screens carry a Back button that
 * routes to `menu:back` → `handleMenu`.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
} from 'discord.js';
import { AlreadyClaimedError } from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondScreen, withBackRow } from '../ui';

function menuComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'hunt'))
        .setLabel('Hunt')
        .setEmoji('🏹')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'daily'))
        .setLabel('Claim Daily')
        .setEmoji('🎁')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'shop'))
        .setLabel('Shop')
        .setEmoji('🛍️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'collection'))
        .setLabel('Collection')
        .setEmoji('🎒')
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'profile'))
        .setLabel('Profile')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'inventory'))
        .setLabel('Inventory')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export async function handleMenu(
  _ctx: AppContext,
  interaction: PlayerInteraction,
  _prov: Provisioned,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('💖 Waifumon')
    .setDescription(
      'Welcome, hunter~\n\n' +
        '🏹 **Hunt** — spend 1 energy to find someone\n' +
        '🎁 **Claim Daily** — energy refill, WaifuBux, and charms\n' +
        '🛍️ **Shop** — spend WaifuBux on capture charms\n' +
        '🎒 **Collection** — browse your captured Waifumon\n' +
        '👤 **Profile** · 🎒 **Inventory**',
    )
    .setColor(0xff6fa5);
  await respondScreen(interaction, { embeds: [embed], components: menuComponents() });
}

export async function handleProfile(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const { player, currencies } = await ctx.services.players.getProfile(prov.playerId);
  const progress = ctx.services.progression.progressFor(player.xp);
  const maxEnergy = ctx.services.progression.computeMaxEnergy(player.level);
  const prestige = ctx.services.progression.getPrestigeTitle(player.level);
  const buddy = await ctx.services.collection.getBuddy(prov.playerId);

  const xpLine = progress.atMaxLevel
    ? `${player.xp} XP · **MAX**`
    : `${progress.xpIntoLevel} / ${progress.xpToNext} XP to Lv ${progress.level + 1} · ${player.xp} total`;

  const buddyLine = buddy
    ? `${buddy.waifu.nickname ? `${buddy.waifu.nickname} (${buddy.species.name})` : buddy.species.name} · Lv ${buddy.waifu.level}`
    : '_(none — set one from `/waifumon buddy`)_';

  const embed = new EmbedBuilder()
    .setTitle(`👤 ${interaction.user.displayName}'s Profile`)
    .setColor(0xff6fa5)
    .addFields(
      { name: 'Level', value: `${player.level}${prestige ? ` — *${prestige}*` : ''}`, inline: true },
      { name: 'XP', value: xpLine, inline: false },
      { name: '⚡ Hunt Energy', value: `${currencies.huntEnergy} / ${maxEnergy}`, inline: true },
      { name: '💰 WaifuBux', value: `${currencies.waifubux}`, inline: true },
      { name: '✨ Essence', value: `${currencies.essence}`, inline: true },
      { name: '★ Buddy', value: buddyLine, inline: false },
    )
    .setFooter({ text: `Hunter since ${player.createdAt.toDateString()}` });
  await respondScreen(interaction, { embeds: [embed], components: withBackRow() });
}

function formatLevelUps(levelUps: readonly { toLevel: number; rewardLabels: readonly string[] }[]): string {
  return levelUps
    .map((lu) => {
      const rewards = lu.rewardLabels.length ? ` — ${lu.rewardLabels.join(', ')}` : '';
      return `⬆️ **Level ${lu.toLevel}!**${rewards}`;
    })
    .join('\n');
}

export async function handleDaily(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  try {
    const result = await ctx.services.daily.claim(prov.playerId);
    const itemLines = result.items
      .map(({ item, quantity }) => `${item.emoji ?? '•'} ${item.name} ×${quantity}`)
      .join('\n');
    const rareNote = result.rareItemGranted ? '\n🌟 Rare bonus this time!' : '';
    const levelUpNote = result.levelUps.length ? `\n\n${formatLevelUps(result.levelUps)}` : '';
    const embed = new EmbedBuilder()
      .setTitle('🎁 Daily Claimed!')
      .setColor(0x7ce68a)
      .setDescription(
        `⚡ Hunt Energy refilled to **${result.energySetTo}**\n` +
          `💰 **+${result.waifubux}** WaifuBux\n${itemLines}` +
          rareNote +
          `\n\n+${result.xp.xpDelta} XP` +
          levelUpNote,
      )
      .setFooter({ text: 'Come back after the daily reset~' });
    await respondScreen(interaction, { embeds: [embed], components: withBackRow() });
  } catch (err) {
    if (err instanceof AlreadyClaimedError) {
      const embed = new EmbedBuilder()
        .setTitle('🎁 Daily')
        .setColor(0xffc46f)
        .setDescription(err.userMessage);
      await respondScreen(interaction, { embeds: [embed], components: withBackRow() });
      return;
    }
    throw err;
  }
}

export async function handleInventory(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const entries = await ctx.services.inventory.getInventory(prov.playerId);
  const byCategory = new Map<string, string[]>();
  for (const { item, quantity } of entries) {
    const modifier = item.isGuaranteedCapture
      ? '**guarantees capture**'
      : item.captureModifier != null
        ? `×${item.captureModifier} capture`
        : '';
    const line = `${item.emoji ?? '•'} **${item.name}** ×${quantity}${modifier ? ` — ${modifier}` : ''}`;
    const lines = byCategory.get(item.category) ?? [];
    lines.push(line);
    byCategory.set(item.category, lines);
  }
  const embed = new EmbedBuilder().setTitle('🎒 Inventory').setColor(0xff6fa5);
  if (byCategory.size === 0) {
    embed.setDescription('Empty~ Claim your daily or visit the shop!');
  } else {
    for (const [category, lines] of byCategory) {
      embed.addFields({
        name: category.charAt(0).toUpperCase() + category.slice(1),
        value: lines.join('\n'),
      });
    }
  }
  await respondScreen(interaction, { embeds: [embed], components: withBackRow() });
}

interface ShopView {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

async function buildShopView(
  ctx: AppContext,
  prov: Provisioned,
  statusLine?: string,
): Promise<ShopView> {
  const [catalog, balances, inventory] = await Promise.all([
    ctx.services.shop.getCatalog(),
    ctx.services.currency.getBalances(prov.playerId),
    ctx.services.inventory.getInventory(prov.playerId),
  ]);
  const owned = new Map(inventory.map((e) => [e.item.id, e.quantity]));

  const lines = catalog.map(({ item, available, availabilityNote }) => {
    const modifier = item.isGuaranteedCapture
      ? 'guarantees capture'
      : `×${item.captureModifier ?? 1} capture`;
    const price = available ? `**${item.buyPrice} WB**` : `*${availabilityNote}*`;
    return `${item.emoji ?? '•'} **${item.name}** (${modifier}) — ${price} · owned ×${owned.get(item.id) ?? 0}`;
  });

  const header = `💰 Balance: **${balances.waifubux} WaifuBux**`;
  const status = statusLine ? `\n\n${statusLine}` : '';
  const embed = new EmbedBuilder()
    .setTitle('🛍️ Charm Shop')
    .setColor(0xffc46f)
    .setDescription(`${header}${status}\n\n${lines.join('\n')}`);

  const buyButtons = catalog
    .filter((entry) => entry.available)
    .map(({ item }) =>
      new ButtonBuilder()
        .setCustomId(buildCustomId('shop', 'buy', item.slug))
        .setLabel(`Buy ${item.name} — ${item.buyPrice} WB`)
        .setStyle(ButtonStyle.Success),
    );
  const extras: ActionRowBuilder<ButtonBuilder>[] =
    buyButtons.length > 0
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buyButtons)]
      : [];
  return { embeds: [embed], components: withBackRow(extras) };
}

export async function handleShop(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildShopView(ctx, prov);
  await respondScreen(interaction, view);
}

/**
 * Shop buy: refresh the shop embed in place with a status line at the top —
 * no separate followUp ephemeral so nothing stacks.
 */
export async function handleShopBuy(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  itemSlug: string,
): Promise<void> {
  const result = await ctx.services.shop.purchase(prov.playerId, itemSlug, 1);
  const status = `✅ Bought **${result.item.name}** for **${result.totalPrice} WB** — you now own ×${result.ownedAfter}.`;
  const view = await buildShopView(ctx, prov, status);
  await respondScreen(interaction, view);
}
