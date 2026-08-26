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
import { isAppearanceUnlocked } from '../../modules/appearance/appearanceRules';
import type { AppearanceView } from '../../modules/appearance/appearanceService';
import {
  MAX_ESSENCE_APPLICATIONS,
  type OwnedEntry,
  type PaginatedGroups,
  type WaifuInvestResult,
} from '../../modules/collection/collectionService';
import {
  maxAffordableApplications,
  parseEssenceApplications,
  type EssenceBatchLimits,
} from '../essenceInput';
import {
  COLLECTION_SORTS,
  COLLECTION_SORT_LABELS,
  isCollectionSortBy,
} from '../../modules/collection/collectionGrouping';
import {
  createCollectionFilterTracker,
  hasActiveFilters,
  parseFilterInput,
  FILTER_NAME_MAX_LENGTH,
  type CollectionFilterState,
  type CollectionFilterTracker,
} from '../collectionFilterTracker';
import {
  CARD_FILENAME,
  resolveAppearanceAsset,
  resolveAppearanceAssetOrPath,
} from '../assets/resolveAppearanceAsset';
import {
  AppearanceLockedError,
  AppearanceNotFoundError,
  InsufficientEssenceError,
  NotADuplicateError,
  WaifuAlreadyReleasedError,
  WaifuAtMaxLevelError,
  WaifuIsBuddyError,
  WaifuIsFavoriteError,
  WaifuNicknameTooEarlyError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { postAppearanceUnlockToasts } from '../appearanceToast';
import { emitEvents } from '../gameEventEmitter';
import { gameEvent } from '../../modules/events/gameEvents';
import { renderOwnedCardAttachment } from '../assets/attachRenderedCard';
import { respondEphemeral } from '../ephemeralSession';
import { backButton, isStaleInteractionError, withBackRow } from '../ui';

const PAGE_SIZE = 10;
/** Discord select menus cap at 25 options; the gallery paginates past that. */
const GALLERY_PAGE_SIZE = 25;

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

/**
 * The card image for one owned copy, honouring her **selected appearance**.
 *
 * Discord code never touches a path: it asks the appearance service which
 * `AssetId` this copy is wearing and hands that to the process's own resolver.
 * `species.imagePath` is passed only as the resolver's private last resort, for
 * a species whose appearance artwork is missing entirely.
 */
function attachCardOr(ctx: AppContext, entry: OwnedEntry): AttachmentBuilder | null {
  const appearance = ctx.services.appearance.currentAppearance(
    entry.species,
    entry.waifu.variant,
  );
  return resolveAppearanceAssetOrPath(ctx, appearance.assetId, entry.species.imagePath);
}

function displayName(entry: OwnedEntry): string {
  const nick = entry.waifu.nickname?.trim();
  return nick ? `${nick} (${entry.species.name})` : entry.species.name;
}

/**
 * Filter state for this context.
 *
 * Production wires a tracker onto the context in `index.ts`. When one is
 * absent (tests building a bare `AppContext`) we attach a per-context tracker
 * lazily, so each context still gets correct — and mutually isolated — filter
 * behaviour instead of sharing one process-wide map.
 */
const contextFilterTrackers = new WeakMap<AppContext, CollectionFilterTracker>();

function filterTracker(ctx: AppContext): CollectionFilterTracker {
  if (ctx.collectionFilters) return ctx.collectionFilters;
  let tracker = contextFilterTrackers.get(ctx);
  if (!tracker) {
    tracker = createCollectionFilterTracker();
    contextFilterTrackers.set(ctx, tracker);
  }
  return tracker;
}

/** One-line summary of what the player is currently looking at. */
function describeFilters(state: CollectionFilterState): string {
  const parts: string[] = [];
  if (state.name != null) parts.push(`“${state.name}”`);
  if (state.minLevel != null && state.maxLevel != null) {
    parts.push(`Lv ${state.minLevel}–${state.maxLevel}`);
  } else if (state.minLevel != null) {
    parts.push(`Lv ${state.minLevel}+`);
  } else if (state.maxLevel != null) {
    parts.push(`Lv ${state.maxLevel} and under`);
  }
  if (state.minCopies != null) parts.push(`${state.minCopies}+ copies`);
  const sort = `Sort: ${COLLECTION_SORT_LABELS[state.sortBy]}`;
  return parts.length > 0
    ? `🔎 ${parts.join(' · ')} · ${sort}`
    : `🔎 No filters · ${sort}`;
}

export function renderCollectionEmbed(
  view: PaginatedGroups,
  dex: { owned: number; distinctSpecies: number; totalSpecies: number },
  state: CollectionFilterState,
  essenceBalance?: number,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('🎒 Your Collection').setColor(0xff6fa5);
  const purse = essenceBalance === undefined ? '' : ` · ✨ **${essenceBalance}**`;
  const header = `**${dex.owned}** owned · dex **${dex.distinctSpecies}/${dex.totalSpecies}** species${purse}`;
  const summary = describeFilters(state);

  if (view.groups.length === 0) {
    // Two different empty states: nothing owned at all vs. nothing matching.
    const body = hasActiveFilters(state)
      ? '_No Waifumon match these filters._\nTry **Clear Filters**, or widen them.'
      : '_No Waifumon yet~ Try `/waifumon hunt`._';
    embed.setDescription(`${header}\n${summary}\n\n${body}`);
    return embed;
  }

  const startIdx = (view.page - 1) * view.pageSize + 1;
  const lines = view.groups.map((group, i) => {
    const num = String(startIdx + i).padStart(2, '0');
    const fav = group.copies.some((copy) => copy.waifu.isFavorite) ? ' 🩷' : '';
    const copies = group.totalCopies > 1 ? ` · ×${group.totalCopies}` : '';
    return `\`${num}\` **[${group.species.rarity}]** ${group.species.name} · Lv ${group.maxLevel}${copies}${fav}`;
  });
  const tally = `${view.totalGroups} species · ${view.totalCopies} copies`;
  embed.setDescription(
    `${header}\n${summary}\n_Page ${view.page}/${view.totalPages} · ${tally}_\n\n${lines.join('\n')}`,
  );
  return embed;
}

/** Select options for the species groups on this page. */
function groupSelectOptions(
  groups: PaginatedGroups['groups'],
): { label: string; description: string; value: string }[] {
  return groups.map((group) => {
    const copies = group.totalCopies > 1 ? ` · ${group.totalCopies} copies` : '';
    return {
      label: group.species.name.slice(0, 100),
      description: `[${group.species.rarity}] Lv ${group.maxLevel}${copies}`.slice(0, 100),
      // One copy inspects straight through; several open the copy picker.
      value:
        group.totalCopies === 1 && group.copies[0]
          ? `single:${group.copies[0].waifu.id}`
          : `dup:${group.speciesId}`,
    };
  });
}

function sortSelectRow(
  state: CollectionFilterState,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId('col', 'sort'))
    .setPlaceholder('Sort…')
    .addOptions(
      COLLECTION_SORTS.map((sort) => ({
        label: COLLECTION_SORT_LABELS[sort],
        value: sort,
        default: sort === state.sortBy,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    select,
  ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;
}

function collectionComponents(
  view: PaginatedGroups,
  state: CollectionFilterState,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  // Discord rejects a select menu with zero options, so an empty result must
  // omit the row entirely rather than render a disabled placeholder.
  const options = groupSelectOptions(view.groups);
  if (options.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(buildCustomId('col', 'pick_group'))
      .setPlaceholder('Inspect one…')
      .addOptions(options);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<
        ButtonBuilder | StringSelectMenuBuilder
      >,
    );
  }

  rows.push(sortSelectRow(state));

  const active = hasActiveFilters(state);
  const nav = [
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'page', String(view.page - 1)))
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'page', String(view.page + 1)))
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.page >= view.totalPages),
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'filter_open'))
      .setLabel('🔎 Filters')
      .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'filter_clear'))
      .setLabel('✕ Clear')
      .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!active),
    backButton(),
  ];
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...nav) as ActionRowBuilder<
      ButtonBuilder | StringSelectMenuBuilder
    >,
  );
  return rows;
}

async function buildCollectionScreen(
  ctx: AppContext,
  playerId: number,
): Promise<{
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}> {
  const tracker = filterTracker(ctx);
  const state = tracker.get(playerId);
  const view = await ctx.services.collection.listOwnedGrouped(playerId, {
    name: state.name,
    minLevel: state.minLevel,
    maxLevel: state.maxLevel,
    minCopies: state.minCopies,
    sortBy: state.sortBy,
    page: state.page,
    pageSize: PAGE_SIZE,
  });
  // The view clamps an out-of-range page; write it back so Prev/Next and the
  // next render agree with what the player is actually looking at.
  const settled = view.page === state.page ? state : tracker.set(playerId, { page: view.page });
  const [dex, balances] = await Promise.all([
    ctx.services.collection.getDexStats(playerId),
    ctx.services.currency.getBalances(playerId),
  ]);
  return {
    embeds: [renderCollectionEmbed(view, dex, settled, balances.essence)],
    components: collectionComponents(view, settled),
  };
}

/** /waifumon collection and menu:collection button. */
export async function handleCollection(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildCollectionScreen(ctx, prov.playerId);
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
  filterTracker(ctx).set(prov.playerId, { page: pageNum });
  const view = await buildCollectionScreen(ctx, prov.playerId);
  await respondEphemeral(interaction, view);
}

/** col:sort select — re-sort and jump back to page 1. */
export async function handleCollectionSort(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
): Promise<void> {
  const picked = interaction.values[0];
  if (isCollectionSortBy(picked)) {
    filterTracker(ctx).set(prov.playerId, { sortBy: picked, page: 1 });
  }
  const view = await buildCollectionScreen(ctx, prov.playerId);
  await respondEphemeral(interaction, view);
}

/** col:filter_clear button — back to an unfiltered page 1. */
export async function handleCollectionFilterClear(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  filterTracker(ctx).reset(prov.playerId);
  const view = await buildCollectionScreen(ctx, prov.playerId);
  await respondEphemeral(interaction, view);
}

/** col:filter_open button — show the filter modal, prefilled with current state. */
export async function handleCollectionFilterOpen(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  const state = filterTracker(ctx).get(prov.playerId);
  const text = (
    id: string,
    label: string,
    value: string,
    maxLength: number,
    placeholder: string,
  ): ActionRowBuilder<TextInputBuilder> =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(maxLength)
        .setPlaceholder(placeholder)
        .setValue(value),
    );
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('col', 'filter_submit'))
    .setTitle('Filter your collection')
    .addComponents(
      text('name', 'Name (blank = any)', state.name ?? '', FILTER_NAME_MAX_LENGTH, 'e.g. saku'),
      text('min_level', 'Min level (blank = any)', state.minLevel?.toString() ?? '', 3, 'e.g. 10'),
      text('max_level', 'Max level (blank = any)', state.maxLevel?.toString() ?? '', 3, 'e.g. 50'),
      text('min_copies', 'Min copies (blank = any)', state.minCopies?.toString() ?? '', 3, 'e.g. 2'),
    );
  await interaction.showModal(modal);
}

/** col:filter_submit — modal callback. */
export async function handleCollectionFilterSubmit(
  ctx: AppContext,
  interaction: ModalSubmitInteraction,
  prov: Provisioned,
): Promise<void> {
  const parsed = parseFilterInput(
    {
      name: interaction.fields.getTextInputValue('name'),
      minLevel: interaction.fields.getTextInputValue('min_level'),
      maxLevel: interaction.fields.getTextInputValue('max_level'),
      minCopies: interaction.fields.getTextInputValue('min_copies'),
    },
    ctx.content.tables.waifuProgression.maxLevel,
  );
  if (!parsed.ok) {
    // Filters are left exactly as they were — a rejected form changes nothing.
    await interaction.reply({ content: parsed.error, ...EPHEMERAL });
    return;
  }
  filterTracker(ctx).set(prov.playerId, { ...parsed.patch, page: 1 });
  const view = await buildCollectionScreen(ctx, prov.playerId);
  await respondEphemeral(interaction, view);
}

/** col:pick_group select — inspect a lone copy, or open the copy picker. */
export async function handleCollectionPickGroup(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
): Promise<void> {
  const picked = interaction.values[0] ?? '';
  const [kind, rawId] = picked.split(':');
  const id = Number(rawId);
  if (!Number.isInteger(id)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  if (kind === 'single') {
    await renderInspect(ctx, interaction as unknown as PlayerInteraction, prov, id);
    return;
  }
  await renderDuplicateSelector(ctx, interaction as unknown as PlayerInteraction, prov, id, 1);
}

/** col:pick select — legacy flat picker; kept so older messages still work. */
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

// ───────────────────────── duplicate copy selector ─────────────────────────

/**
 * One species' individual copies, so a player holding several can pick the
 * exact one they mean. Navigation only: every action still lives on the
 * inspect screen this leads to.
 *
 * The active level filter carries over, so the copies listed here are the same
 * ones the group line counted.
 */
function renderDuplicateEmbed(
  species: OwnedEntry['species'],
  copies: OwnedEntry[],
  buddyId: number | null,
  page: number,
  totalPages: number,
  state: CollectionFilterState,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🎒 ${species.name} — your copies`)
    .setColor(rarityColor(species.rarity));
  if (copies.length === 0) {
    embed.setDescription(
      `**[${species.rarity}]** ${species.name}\n\n_No copies match these filters any more._`,
    );
    return embed;
  }
  const shown = copies.slice((page - 1) * GALLERY_PAGE_SIZE, page * GALLERY_PAGE_SIZE);
  const lines = shown.map((copy) => {
    const marks = [
      copy.waifu.isFavorite ? '🩷' : '',
      copy.waifu.id === buddyId ? '★ buddy' : '',
      copy.waifu.nickname?.trim() ? `“${copy.waifu.nickname.trim()}”` : '',
    ].filter((mark) => mark.length > 0);
    const suffix = marks.length > 0 ? ` · ${marks.join(' · ')}` : '';
    return `\`#${copy.waifu.id}\` Lv ${copy.waifu.level} · 💗 ${copy.waifu.affection}${suffix}`;
  });
  const header = `**[${species.rarity}]** ${copies.length} ${
    copies.length === 1 ? 'copy' : 'copies'
  }`;
  const pager = totalPages > 1 ? `\n_Page ${page}/${totalPages}_` : '';
  // Only the level range is worth repeating here — sort order applies to the
  // group list, and the name filter already matched to get us to this species.
  const range =
    state.minLevel != null && state.maxLevel != null
      ? `\n_Showing Lv ${state.minLevel}–${state.maxLevel}_`
      : state.minLevel != null
        ? `\n_Showing Lv ${state.minLevel}+_`
        : state.maxLevel != null
          ? `\n_Showing Lv ${state.maxLevel} and under_`
          : '';
  embed.setDescription(`${header}${range}${pager}\n\n${lines.join('\n')}`);
  return embed;
}

function duplicateComponents(
  speciesId: number,
  copies: OwnedEntry[],
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const shown = copies.slice((page - 1) * GALLERY_PAGE_SIZE, page * GALLERY_PAGE_SIZE);

  // Same rule as the group list: never emit an empty select menu.
  if (shown.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(buildCustomId('col', 'pick_copy'))
      .setPlaceholder('Inspect a copy…')
      .addOptions(
        shown.map((copy) => {
          const nick = copy.waifu.nickname?.trim();
          const marks = [
            copy.waifu.isFavorite ? 'favorite' : '',
            nick ? `“${nick}”` : '',
          ].filter((mark) => mark.length > 0);
          return {
            label: `#${copy.waifu.id} · Lv ${copy.waifu.level}`.slice(0, 100),
            description: `💗 ${copy.waifu.affection}${
              marks.length > 0 ? ` · ${marks.join(' · ')}` : ''
            }`.slice(0, 100),
            value: String(copy.waifu.id),
          };
        }),
      );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<
        ButtonBuilder | StringSelectMenuBuilder
      >,
    );
  }

  const nav: ButtonBuilder[] = [];
  if (totalPages > 1) {
    nav.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('col', 'dupes', String(speciesId), String(page - 1)))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(buildCustomId('col', 'dupes', String(speciesId), String(page + 1)))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages),
    );
  }
  nav.push(
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'list'))
      .setLabel('⟵ Back to collection')
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...nav) as ActionRowBuilder<
      ButtonBuilder | StringSelectMenuBuilder
    >,
  );
  return rows;
}

async function renderDuplicateSelector(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  speciesId: number,
  page: number,
): Promise<void> {
  const state = filterTracker(ctx).get(prov.playerId);
  const copies = await ctx.services.collection.listOwnedCopiesForSpecies(
    prov.playerId,
    speciesId,
    { minLevel: state.minLevel, maxLevel: state.maxLevel },
  );
  const first = copies[0];
  if (!first) {
    // Every copy was released or filtered out between render and click.
    await respondEphemeral(interaction, {
      content: 'No copies of that Waifumon match your filters any more.',
      components: withBackRow(),
    });
    return;
  }
  const totalPages = Math.max(1, Math.ceil(copies.length / GALLERY_PAGE_SIZE));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const buddy = await ctx.services.collection.getBuddy(prov.playerId);
  await respondEphemeral(interaction, {
    embeds: [
      renderDuplicateEmbed(
        first.species,
        copies,
        buddy?.waifu.id ?? null,
        clamped,
        totalPages,
        state,
      ),
    ],
    components: duplicateComponents(speciesId, copies, clamped, totalPages),
  });
}

/** col:dupes button — page the copy list. */
export async function handleCollectionDuplicates(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const speciesId = Number(args[0]);
  const page = Math.max(1, Number(args[1]) || 1);
  if (!Number.isInteger(speciesId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  await renderDuplicateSelector(
    ctx,
    interaction as unknown as PlayerInteraction,
    prov,
    speciesId,
    page,
  );
}

/** col:pick_copy select — inspect one specific copy. */
export async function handleCollectionPickCopy(
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

/** Essence tiers offered as buttons. Custom covers everything else. */
const ESSENCE_TIERS = [1, 5, 10] as const;

/**
 * The four numbers every Essence decision needs, gathered in one place so the
 * buttons, the modal and its validation can't disagree about the limits.
 */
async function essenceLimits(
  ctx: AppContext,
  playerId: number,
  entry: OwnedEntry,
): Promise<EssenceBatchLimits> {
  const balances = await ctx.services.currency.getBalances(playerId);
  return {
    cap: MAX_ESSENCE_APPLICATIONS,
    costPer: ctx.content.tables.waifuProgression.essenceInvestment.essenceCost,
    balance: balances.essence,
    maxUseful: ctx.services.collection.maxUsefulApplications(entry.waifu),
  };
}

function inspectComponents(
  ctx: AppContext,
  entry: OwnedEntry,
  isDuplicate: boolean,
  convertEssence: number,
  isBuddy: boolean,
  essence: { balance: number; maxUseful: number },
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
  const costPer = ctx.content.tables.waifuProgression.essenceInvestment.essenceCost;
  // A tier is offered only when the player can both afford it and use it, so a
  // capped or broke copy shows the reason greyed out rather than failing on
  // click. The service re-checks both under its row lock regardless.
  const investBtns = ESSENCE_TIERS.map((tier) =>
    new ButtonBuilder()
      .setCustomId(buildCustomId('waifu', 'invest', String(entry.waifu.id), String(tier)))
      .setLabel(`✨ ${tier}× (${tier * costPer})`)
      .setStyle(tier === 1 ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(tier > essence.maxUseful || tier * costPer > essence.balance),
  );
  const investCustomBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('waifu', 'invest_open', String(entry.waifu.id)))
    .setLabel('✨ Custom…')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(essence.maxUseful <= 0 || costPer > essence.balance);
  const nickBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('waifu', 'nick_open', String(entry.waifu.id)))
    .setLabel('📝 Nickname')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(entry.waifu.level < ctx.content.tables.waifuProgression.nicknameMinLevel);
  // Never disabled: every species has at least the implicit `standard` entry,
  // and the gallery doubles as the place a player *sees what to work toward*,
  // which is exactly the case where they own nothing else yet.
  const appearanceBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('appear', 'open', String(entry.waifu.id), '1'))
    .setLabel('🎀 Appearance')
    .setStyle(ButtonStyle.Secondary);

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
  // Essence gets its own row so the tiers read as one control group.
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...investBtns, investCustomBtn),
  );
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(nickBtn, appearanceBtn, backBtn),
  );
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
    const [isDuplicate, buddy, balances] = await Promise.all([
      ctx.services.collection.hasOtherActiveCopies(prov.playerId, waifuId),
      ctx.services.collection.getBuddy(prov.playerId),
      ctx.services.currency.getBalances(prov.playerId),
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

    // Essence panel: what she costs to train, and what the player can spend.
    // `affordable` is the smallest of balance, level headroom and the batch
    // ceiling, so the number shown is always one the player can actually press
    // — the level headroom alone runs to hundreds early on.
    const costPer = ctx.content.tables.waifuProgression.essenceInvestment.essenceCost;
    const maxUseful = ctx.services.collection.maxUsefulApplications(waifu);
    const affordable = maxAffordableApplications({
      cap: MAX_ESSENCE_APPLICATIONS,
      costPer,
      balance: balances.essence,
      maxUseful,
    });
    const essenceValue = waifuProg.atMaxLevel
      ? `✨ ${balances.essence} · **MAX level**`
      : affordable <= 0
        ? `✨ ${balances.essence} · need **${costPer}** per 1×`
        : `✨ ${balances.essence} · **${costPer}** per 1× · up to **${affordable}×** now`;

    const nicknameUnlock = ctx.content.tables.waifuProgression.nicknameMinLevel;
    const unlockLines: string[] = [];
    if (waifu.level >= nicknameUnlock) unlockLines.push('📝 Nickname unlocked');
    else unlockLines.push(`🔒 Nickname at Lv ${nicknameUnlock}`);

    // Pure content lookup — no query, and no gameplay reads it.
    const catalog = ctx.services.appearance.catalogFor(species);
    const worn = ctx.services.appearance.currentAppearance(species, waifu.variant);
    const unlockedLooks = catalog.filter((a) =>
      isAppearanceUnlocked(a, { level: waifu.level }),
    ).length;
    const appearanceValue =
      catalog.length > 1
        ? `${worn.name} · ${unlockedLooks}/${catalog.length} unlocked`
        : worn.name;

    const embed = new EmbedBuilder()
      .setTitle(`✨ ${displayName(entry)}${isBuddy ? ' · ★ Buddy' : ''}`)
      .setColor(rarityColor(species.rarity))
      .setDescription(species.description || '_A mysterious presence…_')
      .addFields(
        { name: 'Rarity', value: species.rarity, inline: true },
        { name: 'Archetype', value: species.archetype, inline: true },
        { name: 'Affinity', value: affinityLabel(species.affinity), inline: true },
        { name: 'Appearance', value: appearanceValue, inline: true },
        { name: 'Level', value: `${waifu.level}`, inline: true },
        { name: 'XP', value: xpLine, inline: true },
        { name: 'Affection', value: `${waifu.affection}`, inline: true },
        { name: 'Essence', value: essenceValue, inline: true },
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
    // The canonical collectible view: a player looking at one of her own
    // Waifumon sees the card, carrying her real level and her equipped look.
    // The CAUGHT emblem is a *pre-catch* duplicate warning drawn only on the
    // hunt encounter reveal, so it deliberately does not appear here. Falls
    // back to raw artwork when rendering is off.
    const owned = await renderOwnedCardAttachment(ctx, entry);
    const artwork = owned ? null : attachCardOr(ctx, entry);
    const card = owned?.file ?? artwork;
    const files = card ? [card] : [];
    if (card) embed.setImage(owned ? owned.url : `attachment://${CARD_FILENAME}`);
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: inspectComponents(ctx, entry, isDuplicate, convertEssence, isBuddy, {
        balance: balances.essence,
        maxUseful,
      }),
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

// ─────────────────────────── appearance gallery ───────────────────────────
//
// The gallery is a **progression journal**, not a picker: every entry shows its
// requirement whether it is earned or not, so a player browsing a species they
// just caught can already see what Level 20 and Level 40 hold. Locked entries
// are listed, described, and explained — never hidden.
//
// Purely cosmetic end to end. Selecting a look writes one column and cannot
// touch level, XP, affection, evolution, or capture odds.

const COSMETIC_RARITY_LABELS: Record<string, string> = {
  standard: 'Standard',
  common: 'Common',
  rare: 'Rare',
  seasonal: 'Seasonal',
  limited: 'Limited',
  exclusive: 'Exclusive',
};

/**
 * Cosmetic-rarity tag. Deliberately worded and emoji'd differently from the
 * species-rarity palette (`[SR]`, the embed colour) so a Rare species wearing a
 * Seasonal look reads as two independent signals, never one.
 */
function cosmeticRarityTag(rarity: string): string {
  return `✦ ${COSMETIC_RARITY_LABELS[rarity] ?? 'Common'}`;
}

function galleryPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
}

/**
 * The gallery embed: the highlighted entry's artwork and metadata, over a
 * roster of every appearance with its requirement.
 */
function renderGalleryEmbed(
  entry: OwnedEntry,
  appearances: AppearanceView[],
  highlighted: AppearanceView,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const unlockedCount = appearances.filter((a) => a.isUnlocked).length;

  const roster = appearances
    .slice((page - 1) * GALLERY_PAGE_SIZE, page * GALLERY_PAGE_SIZE)
    .map((a) => {
      const mark = a.isSelected ? '🎀' : a.isUnlocked ? '✅' : '🔒';
      return `${mark} **${a.name}** — _${a.unlockLabel}_`;
    })
    .join('\n');

  const detail: string[] = [];
  if (highlighted.flavorText) detail.push(`_“${highlighted.flavorText}”_`);
  if (highlighted.description) detail.push(highlighted.description);
  detail.push(
    [
      cosmeticRarityTag(highlighted.cosmeticRarity),
      highlighted.introducedVersion ? `Introduced ${highlighted.introducedVersion}` : null,
      `Unlock: ${highlighted.unlockLabel}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  const embed = new EmbedBuilder()
    .setTitle(`🎀 ${displayName(entry)} — ${highlighted.name}`)
    .setColor(rarityColor(entry.species.rarity))
    .setDescription(detail.join('\n\n'))
    .addFields({
      name: `Appearances (${unlockedCount}/${appearances.length} unlocked)`,
      value: roster || '_None yet._',
      inline: false,
    })
    .setFooter({
      text:
        totalPages > 1
          ? `Page ${page}/${totalPages} · Appearances are cosmetic only.`
          : 'Appearances are cosmetic only — they never change stats or odds.',
    });
  return embed;
}

function galleryComponents(
  waifuId: number,
  appearances: AppearanceView[],
  highlightedId: string,
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const visible = appearances.slice((page - 1) * GALLERY_PAGE_SIZE, page * GALLERY_PAGE_SIZE);

  if (visible.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(buildCustomId('appear', 'pick', String(waifuId), String(page)))
      .setPlaceholder('Choose a look…')
      .addOptions(
        visible.map((a) => ({
          // The requirement rides in the description on *both* states — that is
          // what makes this a journal rather than a lock indicator.
          label: `${a.isSelected ? '🎀 ' : a.isUnlocked ? '' : '🔒 '}${a.name}`.slice(0, 100),
          description: `${a.unlockLabel} · ${cosmeticRarityTag(a.cosmeticRarity)}`.slice(0, 100),
          value: a.id,
          default: a.id === highlightedId,
        })),
      );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<
        ButtonBuilder | StringSelectMenuBuilder
      >,
    );
  }

  const nav: ButtonBuilder[] = [];
  if (totalPages > 1) {
    nav.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('appear', 'open', String(waifuId), String(page - 1)))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(buildCustomId('appear', 'open', String(waifuId), String(page + 1)))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages),
    );
  }
  nav.push(
    new ButtonBuilder()
      .setCustomId(buildCustomId('col', 'pick_id', String(waifuId)))
      .setLabel('⟵ Back')
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...nav) as ActionRowBuilder<
      ButtonBuilder | StringSelectMenuBuilder
    >,
  );
  return rows;
}

/**
 * Paint the gallery. `highlightId` is what the detail panel describes —
 * the selected look by default, or whatever the player just tapped, including
 * a locked one (previewing what you are working toward is the point).
 */
async function renderGallery(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  waifuId: number,
  page = 1,
  highlightId?: string,
): Promise<void> {
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

  // Reading the gallery is also what acknowledges retroactively-unlocked
  // artwork — see `appearanceService.listAppearances`.
  const gallery = await ctx.services.appearance.listAppearances(prov.playerId, waifuId);
  const { appearances } = gallery;
  const totalPages = galleryPageCount(appearances.length);
  const clampedPage = Math.min(Math.max(1, page), totalPages);

  const highlighted =
    appearances.find((a) => a.id === highlightId) ??
    appearances.find((a) => a.isSelected) ??
    appearances[0];
  if (!highlighted) {
    await respondEphemeral(interaction, {
      content: 'She has no appearances configured yet~',
      components: withBackRow(),
    });
    return;
  }

  const card = resolveAppearanceAsset(ctx, highlighted.assetId);
  const embed = renderGalleryEmbed(entry, appearances, highlighted, clampedPage, totalPages);
  if (card) embed.setImage(`attachment://${CARD_FILENAME}`);

  await respondEphemeral(interaction, {
    embeds: [embed],
    components: galleryComponents(
      waifuId,
      appearances,
      highlighted.id,
      clampedPage,
      totalPages,
    ),
    files: card ? [card] : [],
  });
}

/** appear:open — from the inspect card, the toast, or gallery pagination. */
export async function handleAppearanceOpen(
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
  await renderGallery(ctx, interaction, prov, waifuId, Number(args[1]) || 1, args[2]);
}

/**
 * appear:pick — a select-menu choice.
 *
 * Unlocked → apply and re-render with the new artwork. Locked → re-render with
 * that entry highlighted plus an ephemeral note naming the requirement, so a
 * curious tap is a *preview*, never a dead end.
 */
export async function handleAppearancePick(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  const page = Number(args[1]) || 1;
  const appearanceId = interaction.values[0];
  if (!Number.isInteger(waifuId) || !appearanceId) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }

  let selected;
  try {
    selected = await ctx.services.appearance.selectAppearance(
      prov.playerId,
      waifuId,
      appearanceId,
    );
  } catch (err) {
    if (err instanceof AppearanceLockedError) {
      // A locked pick is a *preview*, not a failure: re-render with that entry
      // highlighted so the player sees the artwork they are working toward,
      // and explain the requirement alongside it.
      await renderGallery(ctx, interaction, prov, waifuId, page, appearanceId);
      await interaction.followUp({ content: `🔒 ${err.userMessage}`, ...EPHEMERAL });
      return;
    }
    if (err instanceof AppearanceNotFoundError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
  await renderGallery(ctx, interaction, prov, waifuId, page, appearanceId);
  await emitAppearanceChanged(ctx, interaction, prov, waifuId, selected.appearance);
}

/**
 * Internal-scope notification that a copy changed looks. Never narrated
 * publicly — a wardrobe click is not news — but it refreshes any surface that
 * is already showing this copy (today, the Trainer Profile).
 */
async function emitAppearanceChanged(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  waifuId: number,
  appearance: AppearanceView,
): Promise<void> {
  let waifuName = 'Your Waifumon';
  try {
    waifuName = displayName(await ctx.services.collection.getOwned(prov.playerId, waifuId));
  } catch {
    // Presentation only — a name lookup failure must not break the flow.
  }
  await emitEvents(ctx, interaction, prov, [
    gameEvent('WAIFU_APPEARANCE_CHANGED', {
      waifuId,
      waifuName,
      appearanceId: appearance.id,
      appearanceName: appearance.name,
      assetId: appearance.assetId,
    }),
  ]);
}

/** appear:select — the "Select Now" button on an unlock toast. */
export async function handleAppearanceSelect(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const waifuId = Number(args[0]);
  const appearanceId = args[1];
  if (!Number.isInteger(waifuId) || !appearanceId) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  let selected;
  try {
    selected = await ctx.services.appearance.selectAppearance(
      prov.playerId,
      waifuId,
      appearanceId,
    );
  } catch (err) {
    if (
      err instanceof AppearanceLockedError ||
      err instanceof AppearanceNotFoundError ||
      err instanceof WaifuNotOwnedError ||
      err instanceof WaifuAlreadyReleasedError
    ) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
  await renderGallery(ctx, interaction, prov, waifuId, 1, appearanceId);
  await emitAppearanceChanged(ctx, interaction, prov, waifuId, selected.appearance);
}

/**
 * `/wm appearance <name>` — opens the gallery directly.
 *
 * Same name-or-id resolution as `/wm inspect`, so the autocomplete handler is
 * shared. Exists so the feature is discoverable without first knowing the
 * inspect card has a button on it.
 */
export async function handleAppearanceCommand(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const raw = interaction.options.getString('name', true).trim();
  const asId = Number(raw);
  if (Number.isInteger(asId) && asId > 0) {
    await renderGallery(ctx, interaction, prov, asId);
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
  await renderGallery(ctx, interaction, prov, matches[0]!.waifu.id);
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

/**
 * col:list — return to the collection list from inspect or the copy picker.
 * Filters, sort and page are whatever the player left them on, so coming back
 * lands where they were rather than resetting the browse.
 */
export async function handleCollectionList(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  const view = await buildCollectionScreen(ctx, prov.playerId);
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

/** waifu:invest — spend Essence for waifu XP, re-render inspect with a status. */
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
  // Tier rides in args[1]; buttons minted before batching (and older messages
  // still on screen) carry no second arg and mean a single application.
  const applications = args[1] === undefined ? 1 : Number(args[1]);
  if (!Number.isInteger(applications) || applications < 1) {
    await respondEphemeral(interaction, {
      content: 'That Essence amount is no longer valid — reopen her card.',
      components: withBackRow(),
    });
    return;
  }
  // ACK the button before the transaction runs. Without this a level-up would
  // try to followUp() on an interaction the code has not yet replied to or
  // deferred — after the essence has already been consumed — and the outer
  // error boundary would tell the player "nothing was consumed" while the
  // balance had, in fact, already moved.
  try {
    await interaction.deferUpdate();
  } catch (err) {
    if (isStaleInteractionError(err)) return;
    throw err;
  }
  try {
    const result = await ctx.services.collection.investEssenceBatch(
      prov.playerId,
      waifuId,
      applications,
    );
    await renderInspect(ctx, interaction, prov, waifuId);
    await announceInvestOutcome(ctx, interaction, prov, waifuId, result);
  } catch (err) {
    if (
      err instanceof InsufficientEssenceError ||
      err instanceof WaifuAtMaxLevelError ||
      err instanceof WaifuNotOwnedError ||
      err instanceof WaifuAlreadyReleasedError
    ) {
      await respondEphemeral(interaction, { content: err.userMessage, components: withBackRow() });
      return;
    }
    throw err;
  }
}

/**
 * Post-investment follow-ups: the level-up note, then any cosmetics the level
 * gain earned.
 *
 * Shared by the tier buttons and the custom modal so both announce identically.
 * Runs after the inspect card is repainted, so the reward lands on top of the
 * thing that caused it — the same ordering the capture and buddy paths use.
 *
 * `newAppearances` is already only the *newly* acknowledged unlocks:
 * `syncUnlocks` diffs against `seen_appearances` inside the transaction, so a
 * look the player has seen before can never produce a second toast. A batch
 * that crosses several milestones at once reports all of them, and
 * `postAppearanceUnlockToasts` caps the burst with an overflow notice.
 */
async function announceInvestOutcome(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  waifuId: number,
  result: WaifuInvestResult,
): Promise<void> {
  const leveled = result.toLevel > result.fromLevel;
  if (!leveled && result.newAppearances.length === 0) return;

  // One lookup covers both announcements — she is named the same way in each.
  const invested = await ctx.services.collection.getOwned(prov.playerId, waifuId);
  const name = displayName(invested);

  if (leveled) {
    const batch = result.applications > 1 ? ` (${result.applications}× Essence)` : '';
    await interaction.followUp({
      content: `⬆️ **${name}** advanced to Lv ${result.toLevel}!${batch}`,
      ...EPHEMERAL,
    });
  }
  await postAppearanceUnlockToasts(ctx, interaction, result.newAppearances, name);
}

/** waifu:invest_open — the custom-amount modal. */
export async function handleWaifuInvestOpen(
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
  const limits = await essenceLimits(ctx, prov.playerId, entry);
  if (limits.maxUseful <= 0) {
    await respondEphemeral(interaction, {
      content: `**${displayName(entry)}** is already at max level — Essence can't take her further.`,
      components: withBackRow(),
    });
    return;
  }
  const affordable = maxAffordableApplications(limits);
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('waifu', 'invest_submit', String(waifuId)))
    .setTitle(`Invest Essence — ${entry.species.name}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('applications')
          .setLabel(`How many times? (max ${affordable})`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setPlaceholder(`${limits.costPer} Essence each · you have ${limits.balance}`),
      ),
    );
  await interaction.showModal(modal);
}

/** waifu:invest_submit — modal callback for the custom amount. */
export async function handleWaifuInvestSubmit(
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
  let entry: OwnedEntry;
  try {
    entry = await ctx.services.collection.getOwned(prov.playerId, waifuId);
  } catch (err) {
    if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
      await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
      return;
    }
    throw err;
  }
  const limits = await essenceLimits(ctx, prov.playerId, entry);
  const parsed = parseEssenceApplications(
    interaction.fields.getTextInputValue('applications'),
    limits,
  );
  if (!parsed.ok) {
    // Nothing is spent on a rejected form — the player just gets told why.
    await interaction.reply({ content: parsed.error, ...EPHEMERAL });
    return;
  }
  try {
    const result = await ctx.services.collection.investEssenceBatch(
      prov.playerId,
      waifuId,
      parsed.applications,
    );
    await renderInspect(ctx, interaction, prov, waifuId);
    await announceInvestOutcome(ctx, interaction, prov, waifuId, result);
  } catch (err) {
    if (
      err instanceof InsufficientEssenceError ||
      err instanceof WaifuAtMaxLevelError ||
      err instanceof WaifuNotOwnedError ||
      err instanceof WaifuAlreadyReleasedError
    ) {
      await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
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