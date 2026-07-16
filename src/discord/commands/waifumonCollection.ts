/**
 * Collection, inspect, favorite, release, and duplicate-convert UI (M3).
 *
 * All screens are ephemeral and update in place via `respondScreen`. Paginated
 * collection list uses a string-select for inspect and prev/next buttons for
 * pagination. Inspect shows the full waifu card with Favorite / Release / Back
 * actions. Release is two-step (confirm), with an extra layer for favorites.
 * Duplicate-capture prompt lives here too so all owned-waifu UI is co-located.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { OwnedEntry, PaginatedOwned } from '../../modules/collection/collectionService';
import { resolveAssetPath } from '../../modules/content/loader';
import {
  NotADuplicateError,
  WaifuAlreadyReleasedError,
  WaifuIsFavoriteError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondScreen, withBackRow } from '../ui';

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
  await respondScreen(interaction, view);
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
  await respondScreen(interaction, view);
}

/** col:pick select — inspect chosen waifu. */
export async function handleCollectionPick(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
): Promise<void> {
  const picked = Number(interaction.values[0]);
  if (!Number.isInteger(picked)) {
    await respondScreen(interaction as unknown as PlayerInteraction, {
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
    await respondScreen(interaction, {
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
  entry: OwnedEntry,
  isDuplicate: boolean,
  convertEssence: number,
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
  // Convert only surfaces when this really is a duplicate (i.e. the player
  // owns another active copy of the same species). Unique copies must go
  // through Release (smaller Essence value).
  const buttons: ButtonBuilder[] = [favBtn];
  if (isDuplicate) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('waifu', 'convert', String(entry.waifu.id)))
        .setLabel(`✨ Convert to Essence (+${convertEssence})`)
        .setStyle(ButtonStyle.Primary),
    );
  }
  buttons.push(releaseBtn, backBtn);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

async function renderInspect(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  waifuId: number,
): Promise<void> {
  try {
    const entry = await ctx.services.collection.getOwned(prov.playerId, waifuId);
    const isDuplicate = await ctx.services.collection.hasOtherActiveCopies(
      prov.playerId,
      waifuId,
    );
    const { waifu, species } = entry;
    const caught = waifu.caughtAt.toISOString().slice(0, 10);
    const convertEssence =
      (ctx.content.tables.duplicate.essenceByRarity as Record<string, number>)[species.rarity] ??
      0;
    const embed = new EmbedBuilder()
      .setTitle(`✨ ${displayName(entry)}`)
      .setColor(rarityColor(species.rarity))
      .setDescription(species.description || '_A mysterious presence…_')
      .addFields(
        { name: 'Rarity', value: species.rarity, inline: true },
        { name: 'Archetype', value: species.archetype, inline: true },
        { name: 'Variant', value: waifu.variant, inline: true },
        { name: 'Level', value: `${waifu.level}`, inline: true },
        { name: 'Affection', value: `${waifu.affection}`, inline: true },
        { name: 'Favorite', value: waifu.isFavorite ? '★ yes' : '☆ no', inline: true },
        { name: 'Nickname', value: waifu.nickname || '_(none)_', inline: true },
        { name: 'Captured', value: caught, inline: true },
        {
          name: 'Copies',
          value: isDuplicate ? 'duplicate — extras convertible' : 'only copy',
          inline: true,
        },
      );
    const card = attachCardOr(ctx, species.imagePath, species.slug);
    const files = card ? [card] : [];
    if (card) embed.setImage(`attachment://${CARD_FILENAME}`);
    await respondScreen(interaction, {
      embeds: [embed],
      components: inspectComponents(entry, isDuplicate, convertEssence),
      files,
    });
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondScreen(interaction, { content: err.userMessage, components: withBackRow() });
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
    await respondScreen(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  try {
    await ctx.services.collection.toggleFavorite(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondScreen(interaction, { content: err.userMessage, components: withBackRow() });
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
    await respondScreen(interaction, {
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
      await respondScreen(interaction, { content: err.userMessage, components: withBackRow() });
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
  await respondScreen(interaction, {
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
    await respondScreen(interaction, {
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
    await respondScreen(interaction, {
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
      await respondScreen(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondScreen(interaction, { content: err.userMessage, components: withBackRow() });
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
    await respondScreen(interaction, {
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
  await respondScreen(interaction, view);
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
  _ctx: AppContext,
  interaction: ButtonInteraction,
  _prov: Provisioned,
): Promise<void> {
  await respondScreen(interaction, {
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
    await respondScreen(interaction, {
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
    await respondScreen(interaction, {
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
      await respondScreen(interaction, { content: err.userMessage, components: withBackRow() });
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
    await respondScreen(interaction, {
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
      await respondScreen(interaction, { content: err.userMessage, components: withBackRow() });
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
    await respondScreen(interaction, {
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
    await respondScreen(interaction, {
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
    await respondScreen(interaction, {
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
      await respondScreen(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuIsFavoriteError) {
      // Shouldn't happen — the confirm path passes force=true — but stay safe.
      await respondScreen(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondScreen(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
}
