/**
 * Player-facing /waifumon UI (menu, profile, daily, inventory, shop).
 *
 * Every gameplay screen is ephemeral: `respondEphemeral` replies privately on
 * a slash command and updates in place on a button/select click, so
 * navigation replaces the previous screen instead of stacking. The public
 * channel carries only the rare-capture embed and the Care Mode Trainer
 * Profile.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  AlreadyClaimedError,
  AppError,
  CareModeDisabledError,
  CareTargetRequiredError,
  WaifuAlreadyReleasedError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { PriceCurrency } from '../../db/schema';
import type { ItemUseResult } from '../../modules/items/itemUseService';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondEphemeral } from '../ephemeralSession';
import { emitEvents } from '../gameEventEmitter';
import {
  careChangedDescriptors,
  careEnterDescriptors,
  careLeaveDescriptors,
  careTickDescriptors,
  levelUpDescriptors,
} from '../gameEventBuilders';
import { gameEvent, type GameEventDescriptor } from '../../modules/events/gameEvents';
import { renderSummaryLines } from '../../modules/session/sessionService';
import { affinityLabel } from '../../modules/capture/affinityMath';
import type { CareState, CareTickSummary } from '../../modules/care/careService';
import { ownerFromInteraction } from '../userDisplay';
import { withBackRow } from '../ui';
import { resolveAssetPath } from '../../modules/content/loader';
import fs from 'node:fs';
import type { QuestRewards, UiSplashConfig } from '../../modules/content/schemas';
import { parseQuestRewards, type RewardGrant } from '../../modules/quests/questService';

function menuComponents(care: CareState, questsEnabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const careButton = care.active
    ? new ButtonBuilder()
        .setCustomId(buildCustomId('care', 'leave'))
        .setLabel('Leave Care Mode')
        .setEmoji('💤')
        .setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId(buildCustomId('care', 'start'))
        .setLabel('Care for Waifumon')
        .setEmoji('💗')
        .setStyle(care.currentEnergy === 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!care.enabled);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
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
      careButton,
    ),
  ];
  const bottomRow: ButtonBuilder[] = [];
  if (questsEnabled) {
    bottomRow.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'quests'))
        .setLabel('Daily Quests')
        .setEmoji('📜')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (care.active) {
    bottomRow.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('care', 'change_open'))
        .setLabel('Change Target')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (bottomRow.length > 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...bottomRow));
  }
  return rows;
}

const DEFAULT_MENU_FLAVOR =
  'The charm compass hums softly. Somewhere nearby, a Waifumon is watching.';

/** Pick one main-menu flavor line, safe against empty/missing content. */
export function pickMainMenuFlavor(
  pool: readonly string[] | undefined,
  rng: () => number = Math.random,
): string {
  if (!pool || pool.length === 0) return DEFAULT_MENU_FLAVOR;
  const idx = Math.floor(rng() * pool.length);
  return pool[Math.min(idx, pool.length - 1)] ?? DEFAULT_MENU_FLAVOR;
}

export async function handleMenu(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  // Daily launch splash (once per guild-day). Only shown on slash-command
  // entry — clicking Start Hunt (`menu:start`) or any other in-board button
  // routes straight to the main menu via `renderMainMenu`.
  const splashCfg = ctx.content.tables.uiSplash;
  const isSlash = interaction.isChatInputCommand?.() === true;
  if (isSlash && splashCfg?.enabled) {
    const wantsEveryLaunch = splashCfg.frequency === 'always';
    const alreadySeen =
      !wantsEveryLaunch && (await ctx.services.session.hasSeenSplashToday(prov.playerId));
    if (!alreadySeen) {
      await renderSplash(ctx, interaction, prov, splashCfg);
      return;
    }
  }
  await renderMainMenu(ctx, interaction, prov);
}

/**
 * `menu:start` — button on the splash screen. Updates the same ephemeral
 * message into the normal main menu (no second message, because
 * `respondEphemeral` routes button clicks through `interaction.update`).
 */
export async function handleMenuStart(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  await renderMainMenu(ctx, interaction, prov);
}

/**
 * Renders the normal Waifumon main menu. Factored out so `handleMenu`
 * (splash gate) and `handleMenuStart` (splash button) both hit the same code
 * path.
 */
async function renderMainMenu(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  // Lazy Care Mode tick: apply anything pending before rendering so the
  // board always shows fresh energy/target state. Cheap no-op when Care
  // Mode isn't active. Credited ticks are narrated (internally) after the
  // paint so the Trainer Profile refreshes.
  const ticks = await ctx.services.care.applyPending(prov.playerId);
  const care = await ctx.services.care.getState(prov.playerId);
  const flavor = pickMainMenuFlavor(ctx.content.tables.uiFlavor?.mainMenu);
  const description =
    `_${flavor}_\n\n` +
    '🏹 **Hunt** — spend 1 energy to find someone\n' +
    '🎁 **Claim Daily** — energy refill, WaifuBux, and charms\n' +
    '🛍️ **Shop** — spend WaifuBux on capture charms\n' +
    '🎒 **Collection** — browse your captured Waifumon\n' +
    '👤 **Profile** · 🎒 **Inventory** · 💗 **Care Mode**';
  const embed = new EmbedBuilder()
    .setTitle('💖 Waifumon')
    .setDescription(description)
    .setColor(care.active ? 0xffb6d1 : 0xff6fa5);

  embed.addFields({ name: '💗 Care Mode', value: renderCareStatusLines(care).join('\n') });

  // "Today" summary: fold in whatever the daily tally has recorded so far.
  // Read-only — the session row is created/updated by the handlers that
  // actually record events (hunt, daily, capture).
  const channelId = interaction.channelId;
  if (channelId) {
    const existing = await ctx.services.session.findByPlayerAndChannel(
      prov.playerId,
      channelId,
    );
    const summary =
      existing && ctx.services.session.isSummaryFresh(existing)
        ? ctx.services.session.readSummary(existing)
        : ctx.services.session.readSummary({
            summaryJson: {},
          } as never);
    embed.addFields({ name: '📅 Today', value: renderSummaryLines(summary).join('\n') });
  }
  await respondEphemeral(interaction, {
    embeds: [embed],
    components: menuComponents(care, ctx.services.quests.config.enabled),
  });
  await emitEvents(ctx, interaction, prov, careTickDescriptors(ticks));
}

const SPLASH_IMAGE_FILENAME = 'splash.png';

/** Build the splash embed + optional image attachment from config. */
export function buildSplashView(
  ctx: AppContext,
  splash: UiSplashConfig,
): { embed: EmbedBuilder; files: AttachmentBuilder[] } {
  const bodyLines = Array.isArray(splash.body) ? splash.body : [splash.body];
  const description = bodyLines.filter((l) => l && l.length > 0).join('\n\n');
  const embed = new EmbedBuilder()
    .setTitle(`🎴 ${splash.title}`)
    .setColor(0xff6fa5)
    .setDescription(description || '_Ready when you are~_');

  const files: AttachmentBuilder[] = [];
  if (splash.imagePath) {
    try {
      const abs = resolveAssetPath(ctx.config.assetsDir, splash.imagePath);
      if (fs.existsSync(abs)) {
        files.push(new AttachmentBuilder(abs, { name: SPLASH_IMAGE_FILENAME }));
        embed.setImage(`attachment://${SPLASH_IMAGE_FILENAME}`);
      } else {
        ctx.logger.warn(
          { imagePath: splash.imagePath },
          'splash image not found — rendering text-only',
        );
      }
    } catch (err) {
      ctx.logger.warn(
        { err, imagePath: splash.imagePath },
        'splash image failed to resolve — rendering text-only',
      );
    }
  }
  return { embed, files };
}

function splashComponents(buttonLabel: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'start'))
        .setLabel(buttonLabel)
        .setEmoji('🏹')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

/**
 * Paint the splash onto the session board and record the daily view *after*
 * the paint call returns (so a render failure never marks the splash shown).
 */
async function renderSplash(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  splash: UiSplashConfig,
): Promise<void> {
  const { embed, files } = buildSplashView(ctx, splash);
  await respondEphemeral(interaction, {
    embeds: [embed],
    components: splashComponents(splash.buttonLabel),
    files,
  });
  // Mark shown only after the paint succeeds. `daily` frequency records the
  // view so subsequent /waifumon calls this guild-day skip the splash;
  // `always` never records so the splash renders every launch.
  if (splash.frequency === 'daily') {
    try {
      await ctx.services.session.markSplashShown(prov.playerId);
    } catch (err) {
      // Not fatal — worst case the splash shows again this same day.
      ctx.logger.warn({ err, playerId: prov.playerId }, 'failed to mark splash shown');
    }
  }
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
    ? `${buddy.waifu.nickname ? `${buddy.waifu.nickname} (${buddy.species.name})` : buddy.species.name} · Lv ${buddy.waifu.level} · ${affinityLabel(buddy.species.affinity)}`
    : '_(none — set one from `/waifumon buddy`)_';

  const embed = new EmbedBuilder()
    .setTitle(`👤 ${ownerFromInteraction(interaction).displayName}'s Profile`)
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
  await respondEphemeral(interaction, { embeds: [embed], components: withBackRow() });
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
    const channelId = interaction.channelId;
    if (channelId) {
      const session = await ctx.services.session.ensureSession(
        prov.guildDbId,
        prov.playerId,
        channelId,
      );
      await ctx.services.session.recordEvent(session.id, { type: 'daily' });
      for (const lu of result.levelUps) {
        await ctx.services.session.recordEvent(session.id, {
          type: 'levelup',
          toLevel: lu.toLevel,
        });
      }
    }
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
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: withBackRow(),
    });
    // The daily claim always exits Care Mode, so the profile has to come down.
    const events: GameEventDescriptor[] = [
      ...(result.careExit ? careLeaveDescriptors(result.careExit, 'daily') : []),
      ...levelUpDescriptors(result.levelUps),
    ];
    await emitEvents(ctx, interaction, prov, events);
  } catch (err) {
    if (err instanceof AlreadyClaimedError) {
      // Already-claimed is an error condition — reply ephemerally so the
      // session board stays on its current screen.
      await respondEphemeral(interaction, `🎁 ${err.userMessage}`);
      return;
    }
    throw err;
  }
}

/** Short currency label used across shop/inventory copy. */
export function currencyLabel(currency: PriceCurrency): string {
  return currency === 'essence' ? '✨ Essence' : '💰 WB';
}

/** "40 ✨ Essence" / "500 💰 WB" — price with its currency, never bare. */
export function formatPrice(amount: number, currency: PriceCurrency): string {
  return `${amount} ${currencyLabel(currency)}`;
}

/** 0.03 → "+3%" — the player-facing form of a flat capture bonus. */
export function formatCaptureBonus(modifier: number): string {
  const pct = Math.round(modifier * 1000) / 10;
  return `+${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * One line describing the player's active capture buff, e.g.
 * "💊 **Microdose** active — +3% capture · **4** charges left".
 * Returns null when nothing is active so callers can omit the field entirely.
 */
export function renderCaptureBonusLine(
  state: { modifier: number; chargesRemaining: number; sourceItemSlug: string } | null,
  displayName?: string,
  emoji?: string | null,
): string | null {
  if (!state) return null;
  const name = displayName ?? state.sourceItemSlug;
  return (
    `${emoji ?? '💊'} **${name}** active — ${formatCaptureBonus(state.modifier)} capture chance · ` +
    `**${state.chargesRemaining}** charge${state.chargesRemaining === 1 ? '' : 's'} left`
  );
}

/** Content metadata for an item slug (name/emoji), for buff labelling. */
function itemMeta(ctx: AppContext, slug: string): { name: string; emoji: string | null } {
  const found = ctx.content.items.find((i) => i.slug === slug);
  return { name: found?.name ?? slug, emoji: found?.emoji ?? null };
}

/** Discord allows 5 buttons per action row. */
function chunkButtonRows(
  buttons: readonly ButtonBuilder[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

interface ScreenView {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

async function buildInventoryView(
  ctx: AppContext,
  prov: Provisioned,
  statusLine?: string,
): Promise<ScreenView> {
  const [entries, captureBonus] = await Promise.all([
    ctx.services.inventory.getInventory(prov.playerId),
    ctx.services.effects.getCaptureBonus(prov.playerId),
  ]);
  const byCategory = new Map<string, string[]>();
  for (const { item, quantity } of entries) {
    const modifier = item.isGuaranteedCapture
      ? '**guarantees capture**'
      : item.captureModifier != null
        ? `×${item.captureModifier} capture`
        : effectSummary(item.effectType, item.effectConfig);
    const line = `${item.emoji ?? '•'} **${item.name}** ×${quantity}${modifier ? ` — ${modifier}` : ''}`;
    const lines = byCategory.get(item.category) ?? [];
    lines.push(line);
    byCategory.set(item.category, lines);
  }
  const embed = new EmbedBuilder().setTitle('🎒 Inventory').setColor(0xff6fa5);
  const status = statusLine ? `${statusLine}\n\n` : '';
  if (byCategory.size === 0) {
    embed.setDescription(`${status}Empty~ Claim your daily or visit the shop!`);
  } else {
    if (status) embed.setDescription(status.trimEnd());
    for (const [category, lines] of byCategory) {
      embed.addFields({
        name: category.charAt(0).toUpperCase() + category.slice(1),
        value: lines.join('\n'),
      });
    }
  }
  const buffLine = renderCaptureBonusLine(
    captureBonus,
    captureBonus ? itemMeta(ctx, captureBonus.sourceItemSlug).name : undefined,
    captureBonus ? itemMeta(ctx, captureBonus.sourceItemSlug).emoji : undefined,
  );
  if (buffLine) embed.addFields({ name: '⏳ Active Effects', value: buffLine });

  // Usable = has an effect and the player owns at least one.
  const useButtons = entries
    .filter((e) => e.item.effectType != null && e.quantity > 0)
    .slice(0, 10)
    .map((e) => {
      const btn = new ButtonBuilder()
        .setCustomId(buildCustomId('item', 'use', e.item.slug))
        .setLabel(`Use ${e.item.name}`)
        .setStyle(ButtonStyle.Success);
      if (e.item.emoji) btn.setEmoji(e.item.emoji);
      return btn;
    });
  return { embeds: [embed], components: withBackRow(chunkButtonRows(useButtons)) };
}

/** Short human description of an item's active effect, for list rows. */
export function effectSummary(
  effectType: string | null,
  effectConfig: Record<string, unknown> | null,
): string {
  if (effectType === 'restore_energy_full') return 'restores Hunt Energy to full';
  if (effectType === 'capture_bonus_charges') {
    const cfg = effectConfig ?? {};
    const bonus = typeof cfg.captureBonus === 'number' ? cfg.captureBonus : 0;
    const charges = typeof cfg.charges === 'number' ? cfg.charges : 0;
    return `${formatCaptureBonus(bonus)} capture for ${charges} attempts`;
  }
  return '';
}

export async function handleInventory(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildInventoryView(ctx, prov);
  await respondEphemeral(interaction, view);
}

/** Human-readable outcome line for a successful item use. */
export function formatItemUseResult(result: ItemUseResult): string {
  if (result.kind === 'restore_energy_full') {
    const care = result.careModeExited
      ? ` Left Care Mode${result.careEnergyGained > 0 ? ` (+${result.careEnergyGained} ⚡ from pending ticks)` : ''}.`
      : '';
    return (
      `✅ **${result.item.name}** used: Hunt Energy restored to ` +
      `**${result.energyAfter}/${result.maxEnergy}**.${care}`
    );
  }
  const verb = result.refreshed ? 'refreshed' : 'active';
  return (
    `✅ **${result.item.name}** ${verb}: ${formatCaptureBonus(result.modifier)} capture chance ` +
    `for your next **${result.chargesRemaining}** capture attempts.`
  );
}

/**
 * `item:use` — consume one usable item and repaint the inventory screen on the
 * same public session board with a status line. Refusals (energy already full,
 * none owned) answer ephemerally so the board keeps its current state.
 */
export async function handleItemUse(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  itemSlug: string,
): Promise<void> {
  if (!itemSlug) {
    await respondEphemeral(interaction, 'That button no longer works~');
    return;
  }
  // Snapshot the care target before the use — `ItemUseService` reports the
  // exit as a boolean and the row is cleared by the time we get the result.
  const careTargetBefore = (await ctx.services.care.getState(prov.playerId)).target;
  let result: ItemUseResult;
  try {
    result = await ctx.services.itemUse.use(prov.playerId, itemSlug);
  } catch (err) {
    if (err instanceof AppError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }
  const view = await buildInventoryView(ctx, prov, formatItemUseResult(result));
  await respondEphemeral(interaction, view);
  // Energy Drink (and any future restore-energy consumable) exits Care Mode.
  // The service reports it as a boolean, so we resolve the name we already
  // know from the pre-use state rather than adding a service field.
  if (result.kind === 'restore_energy_full' && result.careModeExited) {
    await emitEvents(ctx, interaction, prov, [
      gameEvent('PLAYER_LEFT_CARE', {
        waifuId: careTargetBefore?.waifu.id ?? null,
        buddyName: careTargetBefore
          ? (careTargetBefore.waifu.nickname?.trim() || careTargetBefore.species.name)
          : null,
        reason: 'item',
      }),
    ]);
  }
}

async function buildShopView(
  ctx: AppContext,
  prov: Provisioned,
  statusLine?: string,
): Promise<ScreenView> {
  const [catalog, balances, inventory] = await Promise.all([
    ctx.services.shop.getCatalog(),
    ctx.services.currency.getBalances(prov.playerId),
    ctx.services.inventory.getInventory(prov.playerId),
  ]);
  const owned = new Map(inventory.map((e) => [e.item.id, e.quantity]));

  const lines = catalog.map(({ item, available, availabilityNote, currency }) => {
    const detail = item.isGuaranteedCapture
      ? 'guarantees capture'
      : item.captureModifier != null
        ? `×${item.captureModifier} capture`
        : effectSummary(item.effectType, item.effectConfig) || item.category;
    const price = available
      ? `**${formatPrice(item.buyPrice ?? 0, currency)}**`
      : `*${availabilityNote}*`;
    return `${item.emoji ?? '•'} **${item.name}** (${detail}) — ${price} · owned ×${owned.get(item.id) ?? 0}`;
  });

  const header = `💰 **${balances.waifubux}** WaifuBux · ✨ **${balances.essence}** Essence`;
  const status = statusLine ? `\n\n${statusLine}` : '';
  const embed = new EmbedBuilder()
    .setTitle('🛍️ Shop')
    .setColor(0xffc46f)
    .setDescription(`${header}${status}\n\n${lines.join('\n')}`);

  const buyButtons = catalog
    .filter((entry) => entry.available)
    .map(({ item, currency }) =>
      new ButtonBuilder()
        .setCustomId(buildCustomId('shop', 'buy', item.slug))
        .setLabel(`Buy ${item.name} — ${formatPrice(item.buyPrice ?? 0, currency)}`)
        .setStyle(ButtonStyle.Success),
    );
  return { embeds: [embed], components: withBackRow(chunkButtonRows(buyButtons)) };
}

export async function handleShop(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildShopView(ctx, prov);
  await respondEphemeral(interaction, view);
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
  const status = `✅ Bought **${result.item.name}** for **${formatPrice(result.totalPrice, result.currency)}** — you now own ×${result.ownedAfter}.`;
  const view = await buildShopView(ctx, prov, status);
  await respondEphemeral(interaction, view);
}

// ─────────────────────────── Care Mode ───────────────────────────

/**
 * Human-readable status lines describing the player's Care Mode state.
 * Rendered into the menu embed so the board always shows what's happening.
 */
export function renderCareStatusLines(care: CareState): string[] {
  if (!care.enabled) {
    return ['_Care Mode is currently disabled._'];
  }
  if (!care.active || !care.target) {
    const cap = care.effectiveEnergyCap;
    const availableNote =
      care.currentEnergy < cap
        ? `Care Mode available: **+${care.energyPerTick} energy** and Waifumon training every ${care.intervalMinutes}m up to **${cap} energy**.`
        : `Energy at cap (**${care.currentEnergy}/${care.maxEnergy}**) — Care Mode still trains Waifumon.`;
    return [`⚡ **${care.currentEnergy}** energy`, availableNote];
  }
  const target = care.target;
  const nick = target.waifu.nickname?.trim();
  const label = nick ? `${nick} (${target.species.name})` : target.species.name;
  const nextTs = care.nextTickAt
    ? `<t:${Math.floor(care.nextTickAt.getTime() / 1000)}:R>`
    : 'soon';
  const capReached = care.currentEnergy >= care.effectiveEnergyCap;
  const lines = [
    `**Caring for:** ${label} · Lv ${target.waifu.level}`,
    `⚡ **${care.currentEnergy}/${care.maxEnergy}** · next tick ${nextTs}`,
    `Per tick: +${care.energyPerTick} Energy · +${care.waifuXpPerTick} XP · +${care.affectionPerTick} Affection`,
  ];
  if (capReached) {
    lines.push(
      `⚠️ Energy at Care Mode cap (**${care.effectiveEnergyCap}**) — Waifumon training continues.`,
    );
  }
  return lines;
}

/** Short summary line after a start/leave/change that had ticks. */
function formatCareSummary(summary: CareTickSummary): string | null {
  if (summary.ticksProcessed <= 0) return null;
  const parts = [
    `${summary.ticksProcessed} tick${summary.ticksProcessed === 1 ? '' : 's'} applied`,
    `+${summary.energyGained} ⚡`,
    `+${summary.waifuXpGained} XP`,
    `+${summary.affectionGained} affection`,
  ];
  const line = parts.join(' · ');
  return summary.leveledUp && summary.toLevel != null
    ? `${line} · ⬆️ Waifu now Lv ${summary.toLevel}`
    : line;
}

/** Build the target-picker select menu (owned, non-released copies). */
async function buildChangeTargetView(
  ctx: AppContext,
  prov: Provisioned,
): Promise<{
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
} | null> {
  const matches = await ctx.services.collection.searchByName(prov.playerId, '', 25);
  if (matches.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId('care', 'change_pick'))
    .setPlaceholder('Choose a Waifumon to care for…')
    .addOptions(
      matches.slice(0, 25).map((entry) => {
        const nick = entry.waifu.nickname?.trim();
        return {
          label: (nick ?? entry.species.name).slice(0, 100),
          description: `[${entry.species.rarity}] Lv ${entry.waifu.level}`.slice(0, 100),
          value: String(entry.waifu.id),
        };
      }),
    );
  const embed = new EmbedBuilder()
    .setTitle('💗 Care Mode — choose a target')
    .setColor(0xffb6d1)
    .setDescription('Select which Waifumon to care for. Ticks continue every 30 minutes.');
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ...withBackRow(),
  ];
  return { embeds: [embed], components: rows };
}

/**
 * "Care for Waifumon" — no arg: use buddy if available, otherwise open the
 * target picker. From `/waifumon care <name>`: resolve the name and use it.
 */
export async function handleCareStart(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  explicitTargetId?: number,
): Promise<void> {
  if (!ctx.services.care.config.enabled) {
    await respondEphemeral(interaction, new CareModeDisabledError().userMessage);
    return;
  }
  const care = await ctx.services.care.getState(prov.playerId);
  let targetId: number | null = explicitTargetId ?? null;
  if (targetId == null && !care.active) {
    const buddy = await ctx.services.collection.getBuddy(prov.playerId);
    if (buddy) targetId = buddy.waifu.id;
  }
  if (targetId == null && !care.active) {
    // No buddy, no explicit target — open the picker.
    const view = await buildChangeTargetView(ctx, prov);
    if (!view) {
      await respondEphemeral(
        interaction,
        'You have no Waifumon to care for yet~ Catch one first!',
      );
      return;
    }
    await respondEphemeral(interaction, view);
    return;
  }
  const wasActive = care.active;
  try {
    const summary = await ctx.services.care.start(prov.playerId, targetId ?? undefined);
    // Repaint the menu first so it claims the primary (in-place) response;
    // the tick summary follows as a small ephemeral note.
    await handleMenu(ctx, interaction, prov);
    const line = formatCareSummary(summary);
    if (line) await respondEphemeral(interaction, `💗 ${line}`);
    await emitEvents(
      ctx,
      interaction,
      prov,
      // A bare "start" while already caring is a target switch, not an entry.
      wasActive
        ? careChangedDescriptors(summary)
        : [...closeHuntSessionForCare(ctx, prov), ...careEnterDescriptors(summary)],
    );
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    if (err instanceof CareTargetRequiredError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }
}

/**
 * Care Mode ends any hunt in progress. Returns the `PLAYER_COMPLETED_HUNT`
 * descriptor when a session was open, or nothing when the player wasn't out
 * hunting (or the tracker was reset by a restart).
 */
function closeHuntSessionForCare(
  ctx: AppContext,
  prov: Provisioned,
): GameEventDescriptor[] {
  const tracked = ctx.huntSessions.close(prov.playerId);
  if (!tracked) return [];
  return [
    gameEvent('PLAYER_COMPLETED_HUNT', { location: tracked.location, reason: 'care_mode' }),
  ];
}

export async function handleCareLeave(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const summary = await ctx.services.care.leave(prov.playerId);
  await handleMenu(ctx, interaction, prov);
  const line = formatCareSummary(summary);
  if (line) await respondEphemeral(interaction, `💤 Left Care Mode — ${line}`);
  await emitEvents(ctx, interaction, prov, careLeaveDescriptors(summary, 'manual'));
}

export async function handleCareChangeOpen(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildChangeTargetView(ctx, prov);
  if (!view) {
    await respondEphemeral(interaction, 'No Waifumon in your collection~');
    return;
  }
  await respondEphemeral(interaction, view);
}

export async function handleCareChangePick(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
): Promise<void> {
  const raw = interaction.values[0];
  const targetId = Number(raw);
  if (!Number.isInteger(targetId)) {
    await respondEphemeral(interaction, 'That Waifumon is no longer available.');
    return;
  }
  let events: GameEventDescriptor[] = [];
  let statusLine: string | null = null;
  try {
    const care = await ctx.services.care.getState(prov.playerId);
    // If not in Care Mode, treat as start with target; otherwise change.
    const summary = care.active
      ? await ctx.services.care.changeTarget(prov.playerId, targetId)
      : await ctx.services.care.start(prov.playerId, targetId);
    events = care.active
      ? careChangedDescriptors(summary)
      : [...closeHuntSessionForCare(ctx, prov), ...careEnterDescriptors(summary)];
    statusLine = formatCareSummary(summary);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }
  await handleMenu(ctx, interaction, prov);
  if (statusLine) await respondEphemeral(interaction, `💗 ${statusLine}`);
  await emitEvents(ctx, interaction, prov, events);
}

/**
 * `/waifumon care [name]` — no arg starts Care Mode with buddy (or opens
 * picker); with arg, resolves the name and cares for that specific target.
 */
export async function handleCareCommand(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction as ChatInputCommandInteraction;
  const raw = cmd.options.getString('name')?.trim();
  if (!raw) {
    await handleCareStart(ctx, interaction, prov);
    return;
  }
  const asId = Number(raw);
  let waifuId: number | null = null;
  if (Number.isInteger(asId) && asId > 0) waifuId = asId;
  else {
    const matches = await ctx.services.collection.searchByName(prov.playerId, raw, 1);
    if (matches.length > 0) waifuId = matches[0]!.waifu.id;
  }
  if (waifuId == null) {
    await respondEphemeral(interaction, `No Waifumon matching "${raw}" in your collection.`);
    return;
  }
  await handleCareStart(ctx, interaction, prov, waifuId);
}

/** Autocomplete for `/waifumon care` — same shape as inspect/buddy. */
export async function handleCareAutocomplete(
  ctx: AppContext,
  interaction: import('discord.js').AutocompleteInteraction,
  playerId: number | null,
): Promise<void> {
  if (playerId == null) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'name') {
    await interaction.respond([]);
    return;
  }
  const matches = await ctx.services.collection.searchByName(playerId, focused.value, 25);
  await interaction.respond(
    matches.map((entry) => {
      const nick = entry.waifu.nickname?.trim();
      const label = nick ? `${nick} (${entry.species.name})` : entry.species.name;
      return {
        name: `[${entry.species.rarity}] ${label} · Lv ${entry.waifu.level}`.slice(0, 100),
        value: String(entry.waifu.id),
      };
    }),
  );
}

// ─────────────────────────── Daily Quests ───────────────────────────

export interface QuestRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  target: number;
  progress: number;
  completedAt: Date | null;
  claimedAt: Date | null;
  /** Preformatted reward summary, e.g. "25 WaifuBux, 🧿 Basic Charm ×1". */
  rewardsLabel: string;
}

export interface RewardDisplayItem {
  name: string;
  emoji?: string | null;
  quantity: number;
}

export interface RewardDisplay {
  waifubux: number;
  essence: number;
  items: RewardDisplayItem[];
}

/**
 * Format a rewards bundle the same way inventory/shop label items
 * (`emoji name ×qty`). Same-named items are combined, e.g.
 * "50 WaifuBux, 10 Essence, 🧿 Basic Charm ×2".
 */
export function formatRewardSummary(rewards: RewardDisplay): string {
  const parts: string[] = [];
  if (rewards.waifubux > 0) parts.push(`${rewards.waifubux} WaifuBux`);
  if (rewards.essence > 0) parts.push(`${rewards.essence} Essence`);
  const combined = new Map<string, RewardDisplayItem>();
  for (const it of rewards.items) {
    if (it.quantity <= 0) continue;
    const existing = combined.get(it.name);
    if (existing) existing.quantity += it.quantity;
    else combined.set(it.name, { ...it });
  }
  for (const it of combined.values()) {
    parts.push(`${it.emoji ?? '•'} ${it.name} ×${it.quantity}`);
  }
  return parts.join(', ');
}

export interface QuestBoardExtras {
  /** Formatted all-complete bonus rewards; null when not configured. */
  bonusPreview: string | null;
  /** Whether today's all-complete bonus has already been granted. */
  bonusClaimed: boolean;
  /** Claim-result lines to surface on the board (claim summary / nothing-to-claim). */
  noticeLines?: readonly string[];
}

/** Build the quests screen from the current quest rows. */
export function questsView(
  quests: QuestRow[],
  hasClaimable: boolean,
  extras: QuestBoardExtras = { bonusPreview: null, bonusClaimed: false },
): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder().setTitle('📜 Daily Quests').setColor(0xffc46f);
  if (quests.length === 0) {
    embed.setDescription('_No quests today~ Check back at the daily reset._');
    return { embed, components: withBackRow() };
  }
  const lines = quests.map((q) => {
    const status = q.claimedAt
      ? `✅ Claimed (${q.progress}/${q.target})`
      : q.completedAt
        ? `🎁 Complete — ready to claim (${q.progress}/${q.target})`
        : `⏳ In Progress (${q.progress}/${q.target})`;
    const rewardLine = q.rewardsLabel ? `\nRewards: ${q.rewardsLabel}` : '';
    return `**${q.title}** — ${status}\n_${q.description}_${rewardLine}`;
  });
  if (extras.bonusPreview) {
    lines.push(
      extras.bonusClaimed
        ? `🏆 **All-complete bonus** — ✅ Claimed · ${extras.bonusPreview}`
        : `🏆 **All-complete bonus** — complete all quests to earn: ${extras.bonusPreview}`,
    );
  }
  embed.setDescription(lines.join('\n\n'));
  if (extras.noticeLines && extras.noticeLines.length > 0) {
    embed.addFields({ name: '🧾 Claim Results', value: extras.noticeLines.join('\n') });
  }
  const claimBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('quests', 'claim_all'))
    .setLabel('Claim Completed')
    .setEmoji('🎁')
    .setStyle(hasClaimable ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!hasClaimable);
  return { embed, components: withBackRow([new ActionRowBuilder<ButtonBuilder>().addComponents(claimBtn)]) };
}

/** slug → display metadata from content, for reward previews. */
function itemDisplayBySlug(ctx: AppContext): Map<string, { name: string; emoji?: string | null }> {
  const map = new Map<string, { name: string; emoji?: string | null }>();
  for (const item of ctx.content.items) {
    map.set(item.slug, { name: item.name, emoji: item.emoji ?? null });
  }
  return map;
}

/** Resolve a frozen QuestRewards struct (slugs) into display entries. */
function rewardDisplayFromConfig(
  rewards: QuestRewards,
  bySlug: Map<string, { name: string; emoji?: string | null }>,
): RewardDisplay {
  return {
    waifubux: rewards.waifubux,
    essence: rewards.essence,
    items: rewards.items.map((i) => {
      const meta = bySlug.get(i.slug);
      return { name: meta?.name ?? i.slug, emoji: meta?.emoji ?? null, quantity: i.quantity };
    }),
  };
}

/** Resolve a granted RewardGrant (item rows) into display entries. */
function rewardDisplayFromGrant(grant: RewardGrant): RewardDisplay {
  return {
    waifubux: grant.waifubux,
    essence: grant.essence,
    items: grant.items.map((g) => ({
      name: g.item.name,
      emoji: g.item.emoji ?? null,
      quantity: g.quantity,
    })),
  };
}

async function loadTodayQuests(
  ctx: AppContext,
  playerId: number,
): Promise<{ rows: QuestRow[]; claimable: number; board: QuestBoardExtras }> {
  await ctx.services.quests.ensureDailyQuests(playerId);
  const raw = await ctx.services.quests.getDailyQuests(playerId);
  const bySlug = itemDisplayBySlug(ctx);
  const rows: QuestRow[] = raw.map((r) => ({
    id: r.id,
    slug: r.questSlug,
    title: r.titleSnapshot,
    description: r.descriptionSnapshot,
    target: r.target,
    progress: r.progress,
    completedAt: r.completedAt,
    claimedAt: r.claimedAt,
    rewardsLabel: formatRewardSummary(
      rewardDisplayFromConfig(parseQuestRewards(r.rewardsJson), bySlug),
    ),
  }));
  const claimable = rows.filter((r) => r.completedAt && !r.claimedAt).length;
  const bonusConfig = ctx.services.quests.config.allCompleteBonus;
  const board: QuestBoardExtras = {
    bonusPreview: bonusConfig
      ? formatRewardSummary(rewardDisplayFromConfig(bonusConfig, bySlug))
      : null,
    bonusClaimed: bonusConfig
      ? await ctx.services.quests.hasClaimedAllCompleteBonus(playerId)
      : false,
  };
  return { rows, claimable, board };
}

/** /waifumon quests and menu:quests button — paint the Daily Quests screen. */
export async function handleQuests(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  if (!ctx.services.quests.config.enabled) {
    await respondEphemeral(interaction, 'Daily Quests are turned off right now~');
    return;
  }
  const { rows, claimable, board } = await loadTodayQuests(ctx, prov.playerId);
  const { embed, components } = questsView(rows, claimable > 0, board);
  await respondEphemeral(interaction, { embeds: [embed], components });
}

/**
 * Claim every completed-unclaimed quest for today, plus the all-complete
 * bonus. Paints the result onto the public session board in a single pass —
 * replying ephemerally first would flip `interaction.replied` and make
 * `paintSession` edit the ephemeral reply instead of the public board.
 */
export async function handleQuestsClaimAll(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  if (!ctx.services.quests.config.enabled) {
    await respondEphemeral(interaction, 'Daily Quests are turned off right now~');
    return;
  }
  const result = await ctx.services.quests.claimAllCompleted(prov.playerId);
  const noticeLines: string[] = [];
  if (result.claimed.length === 0 && !result.allCompleteBonusGranted) {
    noticeLines.push('No completed quests are ready to claim yet.');
  } else {
    if (result.claimed.length > 0) {
      const summary = formatRewardSummary(rewardDisplayFromGrant(result.questRewards));
      noticeLines.push(`Claimed rewards: ${summary || 'nothing'}`);
    }
    if (result.allCompleteBonusGranted && result.allCompleteBonusRewards) {
      const bonus = formatRewardSummary(rewardDisplayFromGrant(result.allCompleteBonusRewards));
      noticeLines.push(`🎉 All-complete bonus: ${bonus || 'nothing'}`);
    }
  }
  const { rows, claimable, board } = await loadTodayQuests(ctx, prov.playerId);
  const view = questsView(rows, claimable > 0, { ...board, noticeLines });
  await respondEphemeral(interaction, {
    embeds: [view.embed],
    components: view.components,
  });
}
