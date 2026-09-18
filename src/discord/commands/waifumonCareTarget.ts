/**
 * Care Mode target picker — the grouped collection browser, aimed at picking
 * a care target instead of inspecting.
 *
 * A single select menu can hold at most 25 options, so the old picker (the
 * first 25 owned copies) hid most of a large collection. This screen pages
 * through species groups instead, with the collection's search/filter modal,
 * sort and rarity controls, and the duplicate copy selector for species the
 * player owns more than once. Released copies never appear: the grouped view
 * reads active copies only, and `CareService` re-validates ownership on pick.
 *
 * Navigation lives here; *applying* a pick (single copy or chosen duplicate)
 * lives in `waifumon.ts` beside the rest of the Care Mode flow.
 *
 * Filter state is separate from the Collection screen's, so searching for a
 * care target never disturbs how the player left their collection. Like that
 * tracker it is in-memory UI state only — a restart just shows page 1.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { PaginatedGroups } from '../../modules/collection/collectionService';
import { isCollectionSortBy } from '../../modules/collection/collectionGrouping';
import {
  createCollectionFilterTracker,
  hasActiveFilters,
  normalizeRarityFilter,
  type CollectionFilterState,
  type CollectionFilterTracker,
} from '../collectionFilterTracker';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondEphemeral } from '../ephemeralSession';
import { replyEphemeralNotice } from '../ephemeralCleanup';
import { backButton, withBackRow } from '../ui';
import {
  GALLERY_PAGE_SIZE,
  describeFilters,
  duplicateComponents,
  filterModal,
  groupSelectOptions,
  parseFilterModal,
  raritySelectRow,
  renderDuplicateEmbed,
  sortSelectRow,
  type CopySelectorIds,
} from './waifumonCollection';

/** Species groups per page — the same density as the collection list. */
export const CARE_TARGET_PAGE_SIZE = 10;

type Rows = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
type Screen = { embeds: EmbedBuilder[]; components: Rows };

const pickerTrackers = new WeakMap<AppContext, CollectionFilterTracker>();

function pickerState(ctx: AppContext): CollectionFilterTracker {
  let tracker = pickerTrackers.get(ctx);
  if (!tracker) {
    tracker = createCollectionFilterTracker();
    pickerTrackers.set(ctx, tracker);
  }
  return tracker;
}

/** Forget any previous search — each "Change target" starts on page 1. */
export function resetCareTargetPicker(ctx: AppContext, playerId: number): void {
  pickerState(ctx).reset(playerId);
}

function renderCareTargetEmbed(
  view: PaginatedGroups,
  state: CollectionFilterState,
  currentTargetId: number | null,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('💗 Care Mode — choose a target').setColor(0xffb6d1);
  const intro = 'Select which Waifumon to care for. Ticks continue every 30 minutes.';
  const summary = describeFilters(state);
  if (view.groups.length === 0) {
    embed.setDescription(
      `${intro}\n${summary}\n\n_No Waifumon match these filters._\nTry **✕ Clear**, or widen them.`,
    );
    return embed;
  }
  const startIdx = (view.page - 1) * view.pageSize + 1;
  const lines = view.groups.map((group, i) => {
    const num = String(startIdx + i).padStart(2, '0');
    const copies = group.totalCopies > 1 ? ` · ×${group.totalCopies}` : '';
    const caring = group.copies.some((copy) => copy.waifu.id === currentTargetId)
      ? ' · 💗 caring'
      : '';
    return `\`${num}\` **[${group.species.rarity}]** ${group.species.name} · Lv ${group.maxLevel}${copies}${caring}`;
  });
  const tally = `${view.totalGroups} species · ${view.totalCopies} copies`;
  embed.setDescription(
    `${intro}\n${summary}\n_Page ${view.page}/${view.totalPages} · ${tally}_\n\n${lines.join('\n')}`,
  );
  return embed;
}

function careTargetComponents(view: PaginatedGroups, state: CollectionFilterState): Rows {
  const rows: Rows = [];
  // Discord rejects an empty select menu — a zero-result page omits the row.
  const options = groupSelectOptions(view.groups);
  if (options.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildCustomId('care', 'target_pick'))
          .setPlaceholder('Choose a Waifumon to care for…')
          .addOptions(options),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    );
  }
  rows.push(sortSelectRow(state, buildCustomId('care', 'target_sort')));
  rows.push(raritySelectRow(state, buildCustomId('care', 'target_rarity')));
  const active = hasActiveFilters(state);
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('care', 'target_page', String(view.page - 1)))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page <= 1),
      new ButtonBuilder()
        .setCustomId(buildCustomId('care', 'target_page', String(view.page + 1)))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page >= view.totalPages),
      new ButtonBuilder()
        .setCustomId(buildCustomId('care', 'target_filter_open'))
        .setLabel('🔎 Search')
        .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('care', 'target_filter_clear'))
        .setLabel('✕ Clear')
        .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!active),
      backButton(),
    ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
  );
  return rows;
}

/**
 * The picker screen for the player's current search state, or null when they
 * own no active Waifumon at all (as opposed to none matching a filter).
 */
export async function buildCareTargetScreen(
  ctx: AppContext,
  playerId: number,
): Promise<Screen | null> {
  const tracker = pickerState(ctx);
  const state = tracker.get(playerId);
  const view = await ctx.services.collection.listOwnedGrouped(playerId, {
    name: state.name,
    minLevel: state.minLevel,
    maxLevel: state.maxLevel,
    minCopies: state.minCopies,
    rarities: state.rarities,
    sortBy: state.sortBy,
    page: state.page,
    pageSize: CARE_TARGET_PAGE_SIZE,
  });
  if (view.totalCopies === 0 && !hasActiveFilters(state)) return null;
  // The view clamps an out-of-range page; keep Prev/Next in step with it.
  const settled = view.page === state.page ? state : tracker.set(playerId, { page: view.page });
  const care = await ctx.services.care.getState(playerId);
  const currentTargetId = care.active ? (care.target?.waifu.id ?? null) : null;
  return {
    embeds: [renderCareTargetEmbed(view, settled, currentTargetId)],
    components: careTargetComponents(view, settled),
  };
}

async function repaint(
  ctx: AppContext,
  interaction: PlayerInteraction | ModalSubmitInteraction,
  prov: Provisioned,
): Promise<void> {
  const screen = await buildCareTargetScreen(ctx, prov.playerId);
  await respondEphemeral(
    interaction,
    screen ?? { content: 'You have no Waifumon to care for yet~', components: withBackRow() },
  );
}

const CARE_COPY_IDS: CopySelectorIds = {
  // The pre-existing care pick route: its value is an owned copy id.
  pick: buildCustomId('care', 'change_pick'),
  placeholder: 'Care for this copy…',
  page: (speciesId, page) =>
    buildCustomId('care', 'target_dupes', String(speciesId), String(page)),
  back: new ButtonBuilder()
    .setCustomId(buildCustomId('care', 'target_list'))
    .setLabel('⟵ Back to list')
    .setStyle(ButtonStyle.Secondary),
};

/** One species' active copies, so the player can pick the exact one to care for. */
export async function renderCareCopySelector(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  speciesId: number,
  page: number,
): Promise<void> {
  const state = pickerState(ctx).get(prov.playerId);
  const copies = await ctx.services.collection.listOwnedCopiesForSpecies(
    prov.playerId,
    speciesId,
    { minLevel: state.minLevel, maxLevel: state.maxLevel },
  );
  const first = copies[0];
  if (!first) {
    await respondEphemeral(interaction, {
      content: 'No copies of that Waifumon match your search any more.',
      components: withBackRow(),
    });
    return;
  }
  const totalPages = Math.max(1, Math.ceil(copies.length / GALLERY_PAGE_SIZE));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const buddy = await ctx.services.collection.getBuddy(prov.playerId);
  const embed = renderDuplicateEmbed(
    first.species,
    copies,
    buddy?.waifu.id ?? null,
    clamped,
    totalPages,
    state,
  ).setTitle(`💗 Care Mode — which ${first.species.name}?`);
  await respondEphemeral(interaction, {
    embeds: [embed],
    components: duplicateComponents(speciesId, copies, clamped, totalPages, CARE_COPY_IDS),
  });
}

/** care:target_page button. */
export async function handleCareTargetPage(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  pickerState(ctx).set(prov.playerId, { page: Math.max(1, Number(args[0]) || 1) });
  await repaint(ctx, interaction as unknown as PlayerInteraction, prov);
}

/** care:target_sort select — re-sort from page 1. */
export async function handleCareTargetSort(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
): Promise<void> {
  const picked = interaction.values[0];
  if (isCollectionSortBy(picked)) {
    pickerState(ctx).set(prov.playerId, { sortBy: picked, page: 1 });
  }
  await repaint(ctx, interaction as unknown as PlayerInteraction, prov);
}

/** care:target_rarity select — an empty selection means every rarity. */
export async function handleCareTargetRarity(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
): Promise<void> {
  pickerState(ctx).set(prov.playerId, {
    rarities: normalizeRarityFilter(interaction.values),
    page: 1,
  });
  await repaint(ctx, interaction as unknown as PlayerInteraction, prov);
}

/** care:target_filter_open button — the collection's filter modal. */
export async function handleCareTargetFilterOpen(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  const state = pickerState(ctx).get(prov.playerId);
  await interaction.showModal(
    filterModal(buildCustomId('care', 'target_filter_submit'), 'Find a Waifumon to care for', state),
  );
}

/** care:target_filter_submit — modal callback. */
export async function handleCareTargetFilterSubmit(
  ctx: AppContext,
  interaction: ModalSubmitInteraction,
  prov: Provisioned,
): Promise<void> {
  const parsed = parseFilterModal(ctx, interaction);
  if (!parsed.ok) {
    await replyEphemeralNotice(ctx, interaction, prov.playerId, parsed.error, 'filter-rejected');
    return;
  }
  pickerState(ctx).set(prov.playerId, { ...parsed.patch, page: 1 });
  await repaint(ctx, interaction, prov);
}

/** care:target_filter_clear button. */
export async function handleCareTargetFilterClear(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  pickerState(ctx).reset(prov.playerId);
  await repaint(ctx, interaction as unknown as PlayerInteraction, prov);
}

/** care:target_list button — back from the copy selector, search intact. */
export async function handleCareTargetList(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
): Promise<void> {
  await repaint(ctx, interaction as unknown as PlayerInteraction, prov);
}

/** care:target_dupes button — page one species' copies. */
export async function handleCareTargetDuplicates(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const speciesId = Number(args[0]);
  if (!Number.isInteger(speciesId)) {
    await respondEphemeral(interaction, {
      content: 'That Waifumon is no longer available.',
      components: withBackRow(),
    });
    return;
  }
  await renderCareCopySelector(
    ctx,
    interaction as unknown as PlayerInteraction,
    prov,
    speciesId,
    Math.max(1, Number(args[1]) || 1),
  );
}
