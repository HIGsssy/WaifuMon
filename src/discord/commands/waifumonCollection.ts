/**
 * Collection, inspect, favorite, release, and duplicate-convert UI (M3).
 *
 * Every screen here is ephemeral (`respondEphemeral`): the collection list,
 * the inspect card, and the destructive confirmations (release, convert a
 * favorite) are all private to the player, so a mis-click is never a public
 * event and browsing someone's collection is never a channel spam source.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { affinityLabel } from '../../modules/capture/affinityMath';
import type { OwnedEntry, PaginatedOwned } from '../../modules/collection/collectionService';
import { resolveAssetPath } from '../../modules/content/loader';
import {
  InsufficientEssenceError,
  NotADuplicateError,
  WaifuAlreadyReleasedError,
  WaifuIsBuddyError,
  WaifuIsFavoriteError,
  WaifuNicknameTooEarlyError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondEphemeral } from '../ephemeralSession';
import { withBackRow } from '../ui';

const CARD_FILENAME = 'card.png';
const PAGE_SIZE = 10;

const RARITY_COLORS: Record<string, number> = {
  N: 0xb8b8b8,
  R: 0x6fb1ff,
  SR: 0xa66fff,
  SSR: 0xffc46f,
  UR: 0xff6fa5,
  LR: 0xff3d7f,
  EX: 0xffffff,
};

function rarityColor(rarity: string): number {
  return RARITY_COLORS[rarity] ?? 0xff6fa5;
}

function attachCardOr(ctx: AppContext, imagePath: string, slug: string): AttachmentBuilder | null {
  try {
    const abs = resolveAssetPath(ctx.config.assetsDir, imagePath);
    return new AttachmentBuilder(abs, { name: CARD_FILENAME });
  } catch (err) {
    ctx.logger.warn({ err, slug }, 'failed to attach species card image');
    return null;
  }
}

function displayName(entry: OwnedEntry): string {
  const nick = entry.waifu.nickname?.trim();
  return nick ? `${nick} (${entry.species.name})` : entry.species.name;
}

function renderCollectionEmbed(page: PaginatedOwned, dex: {
  owned: number;
  distinctSpecies: number;
  totalSpecies: number;
}): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('🎒 Your Collection').setColor(0xff6fa5);
  const header = `**${dex.owned}** owned · dex **${dex.distinctSpecies}/${dex.totalSpecies}** species`;
  if (page.entries.length === 0) {
    embed.setDescription(`${header}\n\n_No Waifumon yet~ Try \`/waifumon hunt\`._`);
    return embed;
  }
  const startIdx = (page.page - 1) * page.pageSize + 1;
  const lines = page.entries.map((entry, i) => {
    const num = String(startIdx + i).padStart(2, '0');
    const fav = entry.waifu.isFavorite ? ' 🩷' : '';
    return `\`${num}\` **[${entry.species.rarity}]** ${displayName(entry)} · Lv ${entry.waifu.level}${fav}`;
  });
  embed.setDescription(
    `${header}\n_Page ${page.page}/${page.totalPages}_\n\n${lines.join('\n')}`,
  );
  return embed;
}

function collectionComponents(
  page: PaginatedOwned,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (page.entries.length > 0) {
    const options = page.entries.slice(0, 25).map((entry) => ({
      label: displayName(entry).slice(0, 100),
      description: `[${entry.species.rarity}] Lv ${entry.waifu.level}${
        entry.waifu.isFavorite ? ' · favorite' : ''
      }`.slice(0, 100),
      value: String(entry.waifu.id),
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId(buildCustomId('col', 'pick'))
      .setPlaceholder('Inspect one…')
      .addOptions(options);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<
        ButtonBuilder | StringSelectMenuBuilder
      >,
    );
  }

  const nav: ButtonBuilder[] = [];
  const prev = new ButtonBuilder()
    .setCustomId(buildCustomId('col', 'page', String(page.page - 1)))
    .setLabel('◀ Prev')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page.page <= 1);
  const next = new ButtonBuilder()
    .setCustomId(buildCustomId('col', 'page', String(page.page + 1)))
    .setLabel('Next ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page.page >= page.totalPages);
  nav.push(prev, next);
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...nav) as ActionRowBuilder<
      ButtonBuilder | StringSelectMenuBuilder
    >,
  );

  // Back to menu.
  rows.push(...(withBackRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]));
  return rows;
}

async function buildCollectionScreen(
  ctx: AppContext,
  playerId: number,
  pageNum: number,
): Promise<{
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}> {
  const page = await ctx.services.collection.listOwned(playerId, {
    page: pageNum,
    pageSize: PAGE_SIZE,
  });
  const dex = await ctx.services.collection.getDexStats(playerId);
  return {
    embeds: [renderCollectionEmbed(page, dex)],
    components: collectionComponents(page),
  };
}

/** /waifumon collection and menu:collection button. */
export async function handleCollection(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildCollectionScreen(ctx, prov.playerId, 1);
  await respondEphemeral(interaction, view);
}

/** col:page button — swap page in place. */
export async function handleCollectionPage(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const pageNum = Math.max(1, Number(args[0]) || 1);
  const view = await buildCollectionScreen(ctx, prov.playerId, pageNum);
  await respondEphemeral(interaction, view);
}

/** col:pick select — inspect chosen waifu. */
export async function handleCollectionPick(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
): Promise<void> {
  const picked = Number(interaction.values[0]);
  if (!Number.isInteger(picked)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  await renderInspect(ctx, interaction as unknown as PlayerInteraction, prov, picked);
}

/** /waifumon inspect <name> — string arg with autocomplete over owned waifus. */
export async function handleInspectCommand(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const raw = interaction.options.getString('name', true).trim();
  // The autocomplete handler always sends id-as-string values, but a user may
  // also type a name directly and hit enter — support both.
  const asId = Number(raw);
  if (Number.isInteger(asId) && asId > 0) {
    await renderInspect(ctx, interaction, prov, asId);
    return;
  }
  const matches = await ctx.services.collection.searchByName(prov.playerId, raw, 1);
  if (matches.length === 0) {
    await respondEphemeral(interaction, {
      content: `No Waifumon matching "${raw}" in your collection.`,
      components: withBackRow(),
    });
    return;
  }
  await renderInspect(ctx, interaction, prov, matches[0]!.waifu.id);
}

/** Autocomplete for /waifumon inspect. */
export async function handleInspectAutocomplete(
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
  const choices = matches.map((entry) => ({
    name: `[${entry.species.rarity}] ${displayName(entry)} · Lv ${entry.waifu.level}`.slice(0, 100),
    value: String(entry.waifu.id),
  }));
  await interaction.respond(choices);
}

function inspectComponents(
  ctx: AppContext,
  entry: OwnedEntry,
  isDuplicate: boolean,
  convertEssence: number,
  isBuddy: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  const favBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('waifu', 'fav', String(entry.waifu.id)))
    .setLabel(entry.waifu.isFavorite ? '★ Unfavorite' : '☆ Favorite')
    .setStyle(entry.waifu.isFavorite ? ButtonStyle.Success : ButtonStyle.Secondary);
  const releaseBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('waifu', 'release', String(entry.waifu.id)))
    .setLabel('🕊️ Release')
    .setStyle(ButtonStyle.Danger);
  const backBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('col', 'list'))
    .setLabel('⟵ Collection')
    .setStyle(ButtonStyle.Secondary);
  const buddyBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('waifu', 'buddy', String(entry.waifu.id)))
    .setLabel(isBuddy ? '★ Buddy' : '🤝 Set Buddy')
    .setStyle(isBuddy ? ButtonStyle.Success : ButtonStyle.Primary)
    .setDisabled(isBuddy);
  const investBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('waifu', 'invest', String(entry.waifu.id)))
    .setLabel(
      `✨ Invest ${ctx.content.tables.waifuProgression.essenceInvestment.essenceCost} Essence`,
    )
    .setStyle(ButtonStyle.Secondary);
  const nickBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('waifu', 'nick_open', String(entry.waifu.id)))
    .setLabel('📝 Nickname')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(entry.waifu.level < ctx.content.tables.waifuProgression.nicknameMinLevel);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const primary: ButtonBuilder[] = [favBtn, buddyBtn];
  if (isDuplicate) {
    primary.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('waifu', 'convert', String(entry.waifu.id)))
        .setLabel(`✨ Convert (+${convertEssence})`)
        .setStyle(ButtonStyle.Primary),
    );
  }
  primary.push(releaseBtn);
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...primary));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(investBtn, nickBtn, backBtn));
  return rows;
}

async function renderInspect(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  waifuId: number,
): Promise<void> {
  try {
    const entry = await ctx.services.collection.getOwned(prov.playerId, waifuId);
    // Daily-quest: inspecting an owned Waifumon ticks the inspect quest.
    // Ownership was verified above (getOwned throws WaifuNotOwnedError
    // otherwise), so wrong-user / stale interactions never reach this call.
    await ctx.services.quests.recordQuestEvent(null, prov.playerId, 'inspect_waifu', 1, {});
    const [isDuplicate, buddy] = await Promise.all([
      ctx.services.collection.hasOtherActiveCopies(prov.playerId, waifuId),
      ctx.services.collection.getBuddy(prov.playerId),
    ]);
    const isBuddy = buddy?.waifu.id === waifuId;
    const { waifu, species } = entry;
    const caught = waifu.caughtAt.toISOString().slice(0, 10);
    const convertEssence =
      (ctx.content.tables.duplicate.essenceByRarity as Record<string, number>)[species.rarity] ??
      0;

    const waifuProg = ctx.services.collection.waifuProgress(waifu);
    const xpLine = waifuProg.atMaxLevel
      ? `${waifu.xp} XP · **MAX**`
      : `${waifuProg.xpIntoLevel} / ${waifuProg.xpToNext} XP to Lv ${waifu.level + 1}`;

    const nicknameUnlock = ctx.content.tables.waifuProgression.nicknameMinLevel;
    const unlockLines: string[] = [];
    if (waifu.level >= nicknameUnlock) unlockLines.push('📝 Nickname unlocked');
    else unlockLines.push(`🔒 Nickname at Lv ${nicknameUnlock}`);

    const embed = new EmbedBuilder()
      .setTitle(`✨ ${displayName(entry)}${isBuddy ? ' · ★ Buddy' : ''}`)
      .setColor(rarityColor(species.rarity))
      .setDescription(species.description || '_A mysterious presence…_')
      .addFields(
        { name: 'Rarity', value: species.rarity, inline: true },
        { name: 'Archetype', value: species.archetype, inline: true },
        { name: 'Affinity', value: affinityLabel(species.affinity), inline: true },
        { name: 'Variant', value: waifu.variant, inline: true },
        { name: 'Level', value: `${waifu.level}`, inline: true },
        { name: 'XP', value: xpLine, inline: true },
        { name: 'Affection', value: `${waifu.affection}`, inline: true },
        { name: 'Nickname', value: waifu.nickname || '_(none)_', inline: true },
        { name: 'Favorite', value: waifu.isFavorite ? '★ yes' : '☆ no', inline: true },
        { name: 'Captured', value: caught, inline: true },
        {
          name: 'Copies',
          value: isDuplicate ? 'duplicate — extras convertible' : 'only copy',
          inline: true,
        },
        { name: 'Unlocks', value: unlockLines.join('\n'), inline: true },
      );
    const card = attachCardOr(ctx, species.imagePath, species.slug);
    const files = card ? [card] : [];
    if (card) embed.setImage(`attachment://${CARD_FILENAME}`);
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: inspectComponents(ctx, entry, isDuplicate, convertEssence, isBuddy),
      files,
    });
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
}

/** waifu:fav — toggle and re-render inspect. */
export async function handleWaifuFavorite(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  try {
    await ctx.services.collection.toggleFavorite(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
  await renderInspect(ctx, interaction, prov, waifuId);
}

function releaseConfirmRow(waifuId: number, force: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildCustomId('waifu', 'release_confirm', String(waifuId), force ? 'force' : 'std'),
      )
      .setLabel(force ? '⚠️ Yes, release my favorite' : 'Confirm Release')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'pick_id', String(waifuId)))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

/** waifu:release — first click, show confirm; second click, do it. */
export async function handleWaifuRelease(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  let entry: OwnedEntry;
  try {
    entry = await ctx.services.collection.getOwned(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
  const essence = Math.floor(
    ((ctx.content.tables.duplicate.essenceByRarity as Record<string, number>)[
      entry.species.rarity
    ] ?? 0) * ctx.content.tables.duplicate.releaseFraction,
  );
  const warn = entry.waifu.isFavorite
    ? '⚠️ **This is a ★ favorite.** Are you sure?\n\n'
    : '';
  const embed = new EmbedBuilder()
    .setTitle(`🕊️ Release ${displayName(entry)}?`)
    .setColor(0xff6f6f)
    .setDescription(`${warn}You'll receive **${essence} Essence**. This cannot be undone.`);
  await respondEphemeral(interaction, {
    embeds: [embed],
    components: [releaseConfirmRow(waifuId, entry.waifu.isFavorite)],
    files: [],
  });
}

/** waifu:release_confirm — perform the release. */
export async function handleWaifuReleaseConfirm(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  const force = args[1] === 'force';
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  try {
    const result = await ctx.services.collection.releaseWaifu(prov.playerId, waifuId, { force });
    const embed = new EmbedBuilder()
      .setTitle(`🕊️ Released ${displayName({ waifu: result.waifu, species: result.species })}`)
      .setColor(0x7ce68a)
      .setDescription(
        `+**${result.essenceGranted}** Essence (balance: ${result.balanceAfter}).`,
      );
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: withBackRow([
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buildCustomId('menu', 'collection'))
            .setLabel('Back to Collection')
            .setStyle(ButtonStyle.Secondary),
        ),
      ]),
      files: [],
    });
  } catch (err) {
    if (err instanceof WaifuIsFavoriteError) {
      // Should be rare — the confirm button we sent already carried force=true
      // for favorites — but stay safe.
      await respondEphemeral(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuIsBuddyError) {
      await respondEphemeral(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
}

/** col:pick_id — inspect-by-id, used by "Cancel" in the release confirm. */
export async function handleCollectionPickId(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  await renderInspect(ctx, interaction, prov, waifuId);
}

/** col:list — return to the paginated collection list from inspect. */
export async function handleCollectionList(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildCollectionScreen(ctx, prov.playerId, 1);
  await respondEphemeral(interaction, view);
}

// ───────────────────────────── duplicate prompt ─────────────────────────────

/**
 * Builds the ephemeral extras (embed + row) shown when a capture succeeds on
 * a duplicate. Called from the capture handler right after the outcome embed.
 */
export function duplicatePromptComponents(
  waifuId: number,
  essenceValue: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('dup', 'keep', String(waifuId)))
      .setLabel('💜 Keep Duplicate')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildCustomId('dup', 'convert', String(waifuId)))
      .setLabel(`✨ Convert to Essence (+${essenceValue})`)
      .setStyle(ButtonStyle.Primary),
  );
}

/** dup:keep — no-op confirmation; the row was already saved on capture. */
export async function handleDuplicateKeep(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  await respondEphemeral(interaction, {
    content: '💜 Kept in your collection~',
    components: withBackRow(),
  });
}

/** dup:convert — soft-release the just-caught row and grant full essence. */
export async function handleDuplicateConvert(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  try {
    // Post-capture path — the just-created row is never a favorite, so the
    // default (no force) is safe. The duplicate guard is satisfied because the
    // player already owned an earlier active copy of this species.
    const result = await ctx.services.collection.convertDuplicateToEssence(
      prov.playerId,
      waifuId,
    );
    const embed = new EmbedBuilder()
      .setTitle(`✨ Converted ${result.species.name} to Essence`)
      .setColor(0x7ce68a)
      .setDescription(
        `+**${result.essenceGranted}** Essence (balance: ${result.balanceAfter}).`,
      );
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: withBackRow(),
      files: [],
    });
  } catch (err) {
    if (
      err instanceof WaifuNotOwnedError ||
      err instanceof WaifuAlreadyReleasedError ||
      err instanceof NotADuplicateError
    ) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
}

// ───────────────────────── convert-from-inspect flow ─────────────────────────

function convertConfirmRow(waifuId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('waifu', 'convert_confirm', String(waifuId), 'force'))
      .setLabel('⚠️ Yes, convert my favorite')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'pick_id', String(waifuId)))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * waifu:convert — from the inspect card. Non-favorites are converted
 * immediately (the button label already displayed the Essence value); favorite
 * copies require an extra confirmation before the destructive action fires.
 */
export async function handleWaifuConvert(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  let entry;
  try {
    entry = await ctx.services.collection.getOwned(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }

  if (entry.waifu.isFavorite) {
    const essence =
      (ctx.content.tables.duplicate.essenceByRarity as Record<string, number>)[
        entry.species.rarity
      ] ?? 0;
    const embed = new EmbedBuilder()
      .setTitle(`✨ Convert ${displayName(entry)} to Essence?`)
      .setColor(0xff6f6f)
      .setDescription(
        `⚠️ **This is a ★ favorite.** You'll receive **${essence} Essence**. This cannot be undone.`,
      );
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: [convertConfirmRow(waifuId)],
      files: [],
    });
    return;
  }
  await performConvertFromInspect(ctx, interaction, prov, waifuId, false);
}

/** waifu:convert_confirm — after favorite confirmation. */
export async function handleWaifuConvertConfirm(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  const force = args[1] === 'force';
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  await performConvertFromInspect(ctx, interaction, prov, waifuId, force);
}

async function performConvertFromInspect(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  waifuId: number,
  force: boolean,
): Promise<void> {
  try {
    const result = await ctx.services.collection.convertDuplicateToEssence(
      prov.playerId,
      waifuId,
      { force },
    );
    const embed = new EmbedBuilder()
      .setTitle(
        `✨ Converted ${displayName({ waifu: result.waifu, species: result.species })} to Essence`,
      )
      .setColor(0x7ce68a)
      .setDescription(
        `+**${result.essenceGranted}** Essence (balance: ${result.balanceAfter}).`,
      );
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: withBackRow([
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buildCustomId('menu', 'collection'))
            .setLabel('Back to Collection')
            .setStyle(ButtonStyle.Secondary),
        ),
      ]),
      files: [],
    });
  } catch (err) {
    if (err instanceof NotADuplicateError) {
      await respondEphemeral(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuIsFavoriteError) {
      // Shouldn't happen — the confirm path passes force=true — but stay safe.
      await respondEphemeral(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuIsBuddyError) {
      await respondEphemeral(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
}


// --------------------------- buddy / invest / nickname ---------------------------

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

/** waifu:buddy � set as active buddy, then re-render inspect. */
export async function handleWaifuSetBuddy(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  try {
    await ctx.services.collection.setBuddy(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
  await renderInspect(ctx, interaction, prov, waifuId);
}

/** waifu:invest � spend Essence for waifu XP, re-render inspect with a status. */
export async function handleWaifuInvest(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  try {
    const result = await ctx.services.collection.investEssence(prov.playerId, waifuId);
    if (result.toLevel > result.fromLevel) {
      await interaction.followUp({
        content: `\u2b06\ufe0f **${displayName({ waifu: result.waifu, species: (await ctx.services.collection.getOwned(prov.playerId, waifuId)).species })}** advanced to Lv ${result.toLevel}!`,
        ...EPHEMERAL,
      });
    }
    await renderInspect(ctx, interaction, prov, waifuId);
  } catch (err) {
    if (err instanceof InsufficientEssenceError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
}

/** waifu:nick_open � show the nickname modal. */
export async function handleWaifuNicknameOpen(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  let entry: OwnedEntry;
  try {
    entry = await ctx.services.collection.getOwned(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
  const minLevel = ctx.content.tables.waifuProgression.nicknameMinLevel;
  if (entry.waifu.level < minLevel) {
    await respondEphemeral(interaction, {
      content: `Nicknames unlock at Lv ${minLevel} (currently Lv ${entry.waifu.level}).`,
      components: withBackRow(),
    });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('waifu', 'nick_submit', String(waifuId)))
    .setTitle(`Nickname for ${entry.species.name}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('nickname')
          .setLabel('Nickname (max 32 chars, blank clears)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(32)
          .setValue(entry.waifu.nickname ?? ''),
      ),
    );
  await interaction.showModal(modal);
}

/** waifu:nick_submit � modal callback. */
export async function handleWaifuNicknameSubmit(
  ctx: AppContext,
  interaction: ModalSubmitInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  if (!Number.isInteger(waifuId)) {
    await interaction.reply({ content: 'That Waifumon is no longer available.', ...EPHEMERAL });
    return;
  }
  const raw = interaction.fields.getTextInputValue('nickname');
  try {
    await ctx.services.collection.setNickname(prov.playerId, waifuId, raw || null);
    await interaction.reply({
      content: raw.trim().length > 0 ? `Nickname set to **${raw.trim()}**.` : 'Nickname cleared.',
      ...EPHEMERAL,
    });
  } catch (err) {
    if (err instanceof WaifuNicknameTooEarlyError) {
      await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
      return;
    }
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
      return;
    }
    throw err;
  }
}

// --------------------------- /waifumon buddy ---------------------------

/**
 * /waifumon buddy [name] � no arg shows the current buddy, with-arg sets it.
 * Autocomplete over the player's own waifus (same as inspect).
 */
export async function handleBuddyCommand(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction as ChatInputCommandInteraction;
  const raw = cmd.options.getString('name')?.trim();
  if (!raw) {
    // Show current buddy.
    const buddy = await ctx.services.collection.getBuddy(prov.playerId);
    if (!buddy) {
      await respondEphemeral(interaction, {
        content: 'No buddy set~ Set one from `/waifumon inspect` or `/waifumon buddy <name>`.',
        components: withBackRow(),
      });
      return;
    }
    await renderInspect(ctx, interaction, prov, buddy.waifu.id);
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
    await respondEphemeral(interaction, {
      content: `No Waifumon matching "${raw}" in your collection.`,
      components: withBackRow(),
    });
    return;
  }
  try {
    await ctx.services.collection.setBuddy(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
  await renderInspect(ctx, interaction, prov, waifuId);
}

/** Autocomplete for /waifumon buddy � same shape as inspect. */
export async function handleBuddyAutocomplete(
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
    matches.map((entry) => ({
      name: `[${entry.species.rarity}] ${displayName(entry)} � Lv ${entry.waifu.level}`.slice(
        0,
        100,
      ),
      value: String(entry.waifu.id),
    })),
  );
}