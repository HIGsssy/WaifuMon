/**
 * Equipment management screens: home, slot management, Gear Bag and item
 * detail. Pure builders from `EquipmentManagementService` view models.
 *
 * Every number shown comes from the combat-stat service — `CombatStats` for
 * the loadout, `previewSlot` for comparisons (including the difference). This
 * module formats them and never multiplies SP by anything.
 *
 * Custom ids (`eq` scope). A screen's "context" is where Back goes:
 * `h` (home), `s.<slot>.<page>` (slot screen), `b.<filter>.<page>` (Gear Bag).
 *
 *   eq|home                                 Equipment home
 *   eq|slot|<slot>|<page>  eq|slotp|…       slot screen (and its pager)
 *   eq|bag|<filter>|<page> eq|bagp|…        Gear Bag (and its pager)
 *   eq|pick|<ctx>                           select menu; the value is an instance id
 *   eq|item|<id>|<ctx>                      item detail
 *   eq|equip|<id>|<expectedCurrentId|->|<ctx>
 *   eq|uneq|<slot>|<expectedCurrentId>|<ctx>
 *   eq|flag|<id>|<f|l>|<0|1>|<ctx>          set (not toggle) favourite / lock
 *
 * Ids name instances and pages, never players. Every handler acts on the
 * clicking player and re-validates everything the id names.
 */
import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { CombatStats } from '../modules/equipment/equipmentMath';
import type {
  BagView,
  EquipmentSummary,
  ItemView,
  SlotChangeOutcome,
  SlotView,
} from '../modules/equipment/equipmentManagementService';
import type { EquipmentDefinitionView } from '../modules/equipment/equipmentQueries';
import { GEAR_BAG_FILTERS, isGearBagFilter, type GearBagFilter } from '../modules/equipment/gearBag';
import { EQUIPMENT_SLOTS, isEquipmentSlot, type EquipmentSlot } from '../modules/equipment/vocabulary';
import type { SessionPayload } from './ephemeralSession';
import { buildCustomId } from './types';

const COLOR = 0x6b7280;

export const SLOT_EMOJI: Readonly<Record<EquipmentSlot, string>> = { attack: '⚔️', defense: '🛡️', health: '❤️' };
export const SLOT_NAME: Readonly<Record<EquipmentSlot, string>> = { attack: 'Attack', defense: 'Defense', health: 'Health' };
export const SLOT_STAT_LABEL: Readonly<Record<EquipmentSlot, string>> = { attack: 'ATK', defense: 'DEF', health: 'HP' };
const SLOT_STAT_KEY: Readonly<Record<EquipmentSlot, keyof CombatStats['stats']>> = {
  attack: 'attack',
  defense: 'defense',
  health: 'maxHp',
};
const FILTER_LABEL: Readonly<Record<GearBagFilter, string>> = {
  all: 'All',
  attack: 'Attack',
  defense: 'Defense',
  health: 'Health',
  fav: '⭐ Favourites',
};

export const EQUIPMENT_HOME_TITLE = '⚔️ Equipment';
export const NO_BUDDY_LINE = 'No active Buddy.\nChoose a Buddy to calculate combat stats.';

// ── context (where Back goes) ─────────────────────────────────────────────

export type EquipmentContext =
  | { kind: 'home' }
  | { kind: 'slot'; slot: EquipmentSlot; page: number }
  | { kind: 'bag'; filter: GearBagFilter; page: number };

export const HOME_CONTEXT: EquipmentContext = { kind: 'home' };

const MAX_PAGE = 9_999;

function parsePage(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,4}$/.test(raw)) return null;
  const page = Number(raw);
  return page <= MAX_PAGE ? page : null;
}

export function encodeContext(ctx: EquipmentContext): string {
  switch (ctx.kind) {
    case 'home':
      return 'h';
    case 'slot':
      return `s.${ctx.slot}.${ctx.page}`;
    case 'bag':
      return `b.${ctx.filter}.${ctx.page}`;
  }
}

/** Strict: anything malformed is null, and the handler treats it as a stale button. */
export function parseContext(raw: string | undefined): EquipmentContext | null {
  if (raw === 'h') return HOME_CONTEXT;
  const [kind, key, rawPage, ...rest] = (raw ?? '').split('.');
  const page = parsePage(rawPage);
  if (rest.length > 0 || page === null) return null;
  if (kind === 's' && isEquipmentSlot(key)) return { kind: 'slot', slot: key, page };
  if (kind === 'b' && isGearBagFilter(key)) return { kind: 'bag', filter: key, page };
  return null;
}

/** A positive integer id from a component, or null. Never trusted beyond that. */
export function parseInstanceId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export { parsePage };

// ── custom ids ────────────────────────────────────────────────────────────

export const eqId = {
  home: () => buildCustomId('eq', 'home'),
  slot: (slot: EquipmentSlot, page = 0) => buildCustomId('eq', 'slot', slot, String(page)),
  slotPage: (slot: EquipmentSlot, page: number) => buildCustomId('eq', 'slotp', slot, String(page)),
  bag: (filter: GearBagFilter = 'all', page = 0) => buildCustomId('eq', 'bag', filter, String(page)),
  bagPage: (filter: GearBagFilter, page: number) => buildCustomId('eq', 'bagp', filter, String(page)),
  pick: (ctx: EquipmentContext) => buildCustomId('eq', 'pick', encodeContext(ctx)),
  item: (id: number, ctx: EquipmentContext) => buildCustomId('eq', 'item', String(id), encodeContext(ctx)),
  equip: (id: number, expectedCurrentId: number | null, ctx: EquipmentContext) =>
    buildCustomId('eq', 'equip', String(id), expectedCurrentId == null ? '-' : String(expectedCurrentId), encodeContext(ctx)),
  unequip: (slot: EquipmentSlot, expectedCurrentId: number, ctx: EquipmentContext) =>
    buildCustomId('eq', 'uneq', slot, String(expectedCurrentId), encodeContext(ctx)),
  flag: (id: number, flag: 'f' | 'l', value: boolean, ctx: EquipmentContext) =>
    buildCustomId('eq', 'flag', String(id), flag, value ? '1' : '0', encodeContext(ctx)),
} as const;

/** The button that returns to a context's screen. */
function contextButton(ctx: EquipmentContext, label = 'Back'): ButtonBuilder {
  const id = ctx.kind === 'home' ? eqId.home() : ctx.kind === 'slot' ? eqId.slot(ctx.slot, ctx.page) : eqId.bag(ctx.filter, ctx.page);
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary);
}

function homeButton(label = 'Equipment'): ButtonBuilder {
  return new ButtonBuilder().setCustomId(eqId.home()).setLabel(label).setEmoji('⚔️').setStyle(ButtonStyle.Secondary);
}

function menuButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildCustomId('menu', 'start'))
    .setLabel('Back to Waifumon')
    .setStyle(ButtonStyle.Secondary);
}

function row(...components: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...components);
}

function selectRow(select: StringSelectMenuBuilder): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as unknown as ActionRowBuilder<ButtonBuilder>;
}

// ── formatting ────────────────────────────────────────────────────────────

/** `4500` → `×0.45`. */
export function formatMultiplier(bp: number): string {
  return `×${(bp / 10_000).toFixed(2)}`;
}

/**
 * One Equipment drop, as every reward surface prints it:
 * `⚔️ **Rusty Pipe of Poor Planning** · ATK ×0.45`.
 *
 * The generated display name and the formatted multiplier only — never the
 * affix key, the pool or raw basis points.
 */
export function formatEquipmentDrop(drop: {
  displayName: string;
  slot: EquipmentSlot;
  rolledMultiplierBp: number;
}): string {
  return `${SLOT_EMOJI[drop.slot]} **${drop.displayName}** · ${SLOT_STAT_LABEL[drop.slot]} ${formatMultiplier(drop.rolledMultiplierBp)}`;
}

/** `+38`, `-22`, `±0`. */
export function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return '±0';
}

/** `ATK 340 → 318 (-22)`; any unavailable side renders as `—`. */
export function formatChange(slot: EquipmentSlot, before: number | null, after: number | null): string {
  const delta = before != null && after != null ? ` (${formatDelta(after - before)})` : '';
  return `${SLOT_STAT_LABEL[slot]} ${before ?? '—'} → ${after ?? '—'}${delta}`;
}

function statValue(value: number | null): string {
  return value == null ? 'unavailable' : `**${value}**`;
}

/** `N • Attack • ×0.55` — the multiplier is the copy's own roll. */
function itemLine(def: EquipmentDefinitionView, rolledMultiplierBp: number): string {
  return `${def.rarity} • ${SLOT_NAME[def.slot]} • ${formatMultiplier(rolledMultiplierBp)}`;
}

/** ✅ equipped, ⭐ favourite, 🔒 locked — in that order, only those that apply. */
export function indicators(flags: { equipped: boolean; favorite: boolean; locked: boolean }): string {
  return [flags.equipped ? '✅' : '', flags.favorite ? '⭐' : '', flags.locked ? '🔒' : ''].filter(Boolean).join(' ');
}

/**
 * Flags for a group of identical copies. Favourite, lock and equipped belong
 * to individual copies, so an icon in front of the name means *every* copy
 * has it; anything that applies to only some copies is spelt out as
 * "n of N" instead, so the bag never implies a flag covers copies it does not.
 */
export function groupMarks(group: {
  count: number;
  equippedCount: number;
  favoriteCount: number;
  lockedCount: number;
}): { marks: string; partial: string } {
  const all = (n: number) => n > 0 && n === group.count;
  const some = (n: number) => n > 0 && n < group.count;
  const marks = indicators({
    equipped: all(group.equippedCount),
    favorite: all(group.favoriteCount),
    locked: all(group.lockedCount),
  });
  const partial = [
    some(group.equippedCount) ? `✅ ${group.equippedCount} of ${group.count} equipped` : '',
    some(group.favoriteCount) ? `⭐ ${group.favoriteCount} of ${group.count}` : '',
    some(group.lockedCount) ? `🔒 ${group.lockedCount} of ${group.count}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { marks, partial };
}

function equippedNote(group: { count: number; equippedCount: number }): string {
  if (group.equippedCount === 0) return '';
  return group.equippedCount === group.count ? ' • Equipped' : ` • ${group.equippedCount} of ${group.count} equipped`;
}

function buddyField(stats: CombatStats): { name: string; value: string } {
  if (!stats.buddy) return { name: 'Buddy', value: NO_BUDDY_LINE };
  return {
    name: 'Buddy',
    value: `**${stats.buddy.name}** · Lv. ${stats.buddy.level}\nCurrent SP: **${stats.buddy.currentSp}**`,
  };
}

function withStatus(payload: SessionPayload, status: string | null | undefined): SessionPayload {
  return status ? { ...payload, content: status } : payload;
}

// ── summary lines (inspect, Player Profile, Trainer Profile) ──────────────

export type UnlockedEquipmentSummary = Extract<EquipmentSummary, { unlocked: true }>;

/** Shown for an empty slot, and for a stat it leaves unavailable. */
export const EMPTY_SLOT = '—';

/**
 * One line per slot: `⚔️ Rusty Pipe`, or `Attack: Rusty Pipe` when `labelled`.
 * Display names only — the summary carries nothing else to show.
 */
export function summaryGearLines(summary: UnlockedEquipmentSummary, opts: { labelled?: boolean } = {}): string[] {
  return EQUIPMENT_SLOTS.map((slot) => {
    const name = summary.slots[slot]?.name ?? EMPTY_SLOT;
    return opts.labelled ? `${SLOT_NAME[slot]}: ${name}` : `${SLOT_EMOJI[slot]} ${name}`;
  });
}

/** `['ATK 336', 'DEF 231', 'HP 1344']`, verbatim from the summary; `—` when unavailable. */
export function summaryStatParts(summary: UnlockedEquipmentSummary): string[] {
  return EQUIPMENT_SLOTS.map((slot) => `${SLOT_STAT_LABEL[slot]} ${summary.stats[SLOT_STAT_KEY[slot]] ?? EMPTY_SLOT}`);
}

// ── home ──────────────────────────────────────────────────────────────────

/** The active Buddy's picture, as `ownedArtworkImage` draws it. */
export interface BuddyArtwork {
  file: AttachmentBuilder;
  url: string;
}

/** Patch's Workshop entry on the Equipment home. Only ever drawn for an unlocked player. */
function visitPatchButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildCustomId('pw', 'home'))
    .setLabel('Visit Patch')
    .setEmoji('🔧')
    .setStyle(ButtonStyle.Secondary);
}

export function buildEquipmentHome(
  stats: CombatStats,
  status?: string | null,
  artwork?: BuddyArtwork | null,
  opts: { workshop?: boolean } = {},
): SessionPayload {
  const embed = new EmbedBuilder().setTitle(EQUIPMENT_HOME_TITLE).setColor(COLOR);
  embed.addFields(buddyField(stats));
  // A thumbnail, not a second card: the stats are what this screen is for.
  // Never without a Buddy — a picture with no Buddy panel would be nobody.
  const picture = stats.buddy ? artwork ?? null : null;
  if (picture) embed.setThumbnail(picture.url);
  embed.addFields({
    name: 'Combat Stats',
    value: stats.buddy
      ? EQUIPMENT_SLOTS.map((slot) => `${SLOT_STAT_LABEL[slot]} ${statValue(stats.stats[SLOT_STAT_KEY[slot]])}`).join(' · ')
      : 'Unavailable without a Buddy.',
  });
  for (const slot of EQUIPMENT_SLOTS) {
    const item = stats.loadout.slots[slot];
    embed.addFields({
      name: `${SLOT_EMOJI[slot]} ${SLOT_NAME[slot]}`,
      value: item
        ? `${item.name}\n${formatMultiplier(item.multiplierBp)}`
        : `Nothing equipped\n${SLOT_STAT_LABEL[slot]} unavailable`,
      inline: true,
    });
  }
  const slotButtons = EQUIPMENT_SLOTS.map((slot) =>
    new ButtonBuilder()
      .setCustomId(eqId.slot(slot))
      .setLabel(`${SLOT_NAME[slot]} Gear`)
      .setEmoji(SLOT_EMOJI[slot])
      .setStyle(ButtonStyle.Primary),
  );
  const bag = new ButtonBuilder().setCustomId(eqId.bag()).setLabel('Gear Bag').setEmoji('🎒').setStyle(ButtonStyle.Secondary);
  return withStatus(
    {
      embeds: [embed],
      components: [row(...slotButtons), row(bag, ...(opts.workshop ? [visitPatchButton()] : []), menuButton())],
      files: picture ? [picture.file] : [],
    },
    status,
  );
}

// ── slot management ───────────────────────────────────────────────────────

function pager(
  page: number,
  totalPages: number,
  idFor: (page: number) => string,
): ButtonBuilder[] {
  return [
    new ButtonBuilder()
      .setCustomId(idFor(Math.max(page - 1, 0)) + '|p')
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(buildCustomId('eq', 'noop', 'page'))
      .setLabel(`Page ${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(idFor(Math.min(page + 1, totalPages - 1)) + '|n')
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  ];
}

export function buildSlotScreen(view: SlotView, status?: string | null): SessionPayload {
  const { slot, stats } = view;
  const stat = SLOT_STAT_LABEL[slot];
  const ctx: EquipmentContext = { kind: 'slot', slot, page: view.candidates.page };
  const embed = new EmbedBuilder().setTitle(`${SLOT_EMOJI[slot]} ${SLOT_NAME[slot]} Gear`).setColor(COLOR);
  if (!stats.buddy) embed.setDescription(NO_BUDDY_LINE);
  embed.addFields({
    name: 'Currently Equipped',
    value: view.equipped
      ? `**${view.equipped.displayName}**\n${stat} ${formatMultiplier(view.equipped.rolledMultiplierBp)}\nCurrent ${stat}: ${statValue(view.current)}`
      : `Nothing equipped\n${stat} unavailable`,
  });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const candidates = view.candidates.items;
  if (candidates.length === 0) {
    embed.addFields({ name: 'Choose Equipment', value: `No other ${SLOT_NAME[slot]} Gear in your bag.` });
  } else {
    for (const c of candidates) {
      const count = c.group.count > 1 ? ` ×${c.group.count}` : '';
      const would =
        c.preview.value != null
          ? `\nWould give: **${c.preview.value} ${stat}**${c.preview.delta != null ? ` (${formatDelta(c.preview.delta)})` : ''}`
          : '';
      embed.addFields({
        name: `${c.group.displayName}${count}`,
        value: `${stat} ${formatMultiplier(c.group.rolledMultiplierBp)}${would}`,
      });
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(eqId.pick(ctx))
      .setPlaceholder(`Compare ${SLOT_NAME[slot]} Gear…`)
      .addOptions(
        candidates.map((c) => {
          const def = c.group.definition;
          const value = c.preview.value != null ? ` · ${c.preview.value} ${stat}` : '';
          const delta = c.preview.delta != null ? ` (${formatDelta(c.preview.delta)})` : '';
          return {
            label: `${c.group.displayName}${c.group.count > 1 ? ` ×${c.group.count}` : ''}`.slice(0, 100),
            description: `${def.rarity} • ${stat} ${formatMultiplier(c.group.rolledMultiplierBp)}${value}${delta}`.slice(0, 100),
            value: String(c.equipmentId),
          };
        }),
      );
    rows.push(selectRow(select));
  }
  if (view.candidates.totalPages > 1) {
    rows.push(row(...pager(view.candidates.page, view.candidates.totalPages, (p) => eqId.slotPage(slot, p))));
  }
  const actions: ButtonBuilder[] = [];
  if (view.equipped) {
    actions.push(
      new ButtonBuilder()
        .setCustomId(eqId.unequip(slot, view.equipped.id, ctx))
        .setLabel('Unequip')
        .setStyle(ButtonStyle.Danger),
    );
  }
  actions.push(
    new ButtonBuilder().setCustomId(eqId.bag(slot)).setLabel('Gear Bag').setEmoji('🎒').setStyle(ButtonStyle.Secondary),
    homeButton(),
  );
  rows.push(row(...actions));
  return withStatus({ embeds: [embed], components: rows, files: [] }, status);
}

// ── Gear Bag ──────────────────────────────────────────────────────────────

export function buildGearBag(view: BagView, status?: string | null): SessionPayload {
  const { entries, filter } = view;
  const ctx: EquipmentContext = { kind: 'bag', filter, page: entries.page };
  const embed = new EmbedBuilder()
    .setTitle(`🎒 Gear Bag${filter === 'all' ? '' : ` — ${FILTER_LABEL[filter]}`}`)
    .setColor(COLOR)
    .setFooter({ text: `Page ${entries.page + 1} / ${entries.totalPages} · ${entries.totalItems} item${entries.totalItems === 1 ? '' : 's'}` });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (entries.items.length === 0) {
    embed.setDescription(filter === 'fav' ? 'No favourites yet.' : 'Nothing here yet.');
  } else {
    embed.setDescription(
      entries.items
        .map(({ group }) => {
          const { marks, partial } = groupMarks(group);
          return (
            `${marks ? `${marks} ` : ''}**${group.displayName}** ×${group.count}\n${itemLine(group.definition, group.rolledMultiplierBp)}` +
            (partial ? `\n${partial}` : '')
          );
        })
        .join('\n\n'),
    );
    rows.push(
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId(eqId.pick(ctx))
          .setPlaceholder('Open an item…')
          .addOptions(
            entries.items.map(({ group, focusId }) => ({
              label: `${group.displayName} ×${group.count}`.slice(0, 100),
              description: `${itemLine(group.definition, group.rolledMultiplierBp)}${equippedNote(group)}`.slice(0, 100),
              value: String(focusId),
            })),
          ),
      ),
    );
  }
  rows.push(
    row(
      ...GEAR_BAG_FILTERS.map((f) =>
        new ButtonBuilder()
          .setCustomId(eqId.bag(f))
          .setLabel(FILTER_LABEL[f])
          .setStyle(f === filter ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(f === filter),
      ),
    ),
  );
  rows.push(row(...pager(entries.page, entries.totalPages, (p) => eqId.bagPage(filter, p)), homeButton()));
  return withStatus({ embeds: [embed], components: rows, files: [] }, status);
}

// ── item detail ───────────────────────────────────────────────────────────

export function buildItemDetail(view: ItemView, ctx: EquipmentContext, status?: string | null): SessionPayload {
  const { instance, preview, stats } = view;
  const def = instance.definition;
  const slot = instance.slot;
  const stat = SLOT_STAT_LABEL[slot];
  const flags = [
    instance.equipped ? '✅ Equipped' : '',
    instance.isFavorite ? '⭐ Favourite' : '',
    instance.isLocked ? '🔒 Locked' : '',
  ].filter(Boolean);
  const embed = new EmbedBuilder()
    .setTitle(`${SLOT_EMOJI[slot]} ${instance.displayName}`)
    .setColor(COLOR)
    .setDescription(
      [`${def.rarity} ${SLOT_NAME[slot]} Equipment`, `${stat} ${formatMultiplier(instance.rolledMultiplierBp)}`, def.description ? `*${def.description}*` : '']
        .filter(Boolean)
        .join('\n'),
    );
  if (flags.length > 0) embed.addFields({ name: 'Status', value: flags.join(' · ') });
  embed.addFields({
    name: 'Current Buddy',
    value: stats.buddy ? `${stats.buddy.name} — ${stats.buddy.currentSp} SP` : NO_BUDDY_LINE,
  });
  if (stats.buddy) {
    embed.addFields(
      instance.equipped
        ? { name: `Current ${stat}`, value: String(view.current ?? '—') }
        : {
            name: 'Comparison',
            value:
              `Current ${stat}: ${view.current ?? 'unavailable'}\n` +
              `With this item: ${preview.value ?? '—'}\n` +
              `Difference: ${preview.delta != null ? formatDelta(preview.delta) : '—'}`,
          },
    );
  }
  const copyIndex = view.copies.indexOf(instance.id);
  embed.addFields({
    name: 'Owned',
    value: view.copies.length > 1 ? `${view.copies.length} (viewing copy ${copyIndex + 1})` : '1',
  });

  const actions: ButtonBuilder[] = [];
  if (instance.equipped) {
    actions.push(
      new ButtonBuilder().setCustomId(buildCustomId('eq', 'noop', 'equipped')).setLabel('Equipped').setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder()
        .setCustomId(eqId.unequip(slot, instance.id, ctx))
        .setLabel('Unequip')
        .setStyle(ButtonStyle.Danger),
    );
  } else {
    actions.push(
      new ButtonBuilder()
        .setCustomId(eqId.equip(instance.id, view.slotEquipped?.id ?? null, ctx))
        .setLabel('Equip')
        .setStyle(ButtonStyle.Success),
    );
  }
  const flagsRow: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(eqId.flag(instance.id, 'f', !instance.isFavorite, ctx))
      .setLabel(instance.isFavorite ? 'Unfavourite' : 'Favourite')
      .setEmoji('⭐')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(eqId.flag(instance.id, 'l', !instance.isLocked, ctx))
      .setLabel(instance.isLocked ? 'Unlock' : 'Lock')
      .setEmoji(instance.isLocked ? '🔓' : '🔒')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (view.copies.length > 1) {
    const next = view.copies[(copyIndex + 1) % view.copies.length]!;
    flagsRow.push(new ButtonBuilder().setCustomId(eqId.item(next, ctx)).setLabel('Next copy').setStyle(ButtonStyle.Secondary));
  }
  actions.push(contextButton(ctx));
  return withStatus({ embeds: [embed], components: [row(...actions), row(...flagsRow)], files: [] }, status);
}

// ── outcome lines ─────────────────────────────────────────────────────────

export function equipStatus(outcome: SlotChangeOutcome): string {
  const name = outcome.item?.displayName ?? 'that item';
  if (!outcome.changed) return `**${name}** is already equipped.`;
  // Without a Buddy there is no stat on either side: say what happened, not "— → —".
  if (outcome.before == null && outcome.after == null) return `✅ Equipped **${name}**.`;
  return `✅ Equipped **${name}**.\n${formatChange(outcome.slot, outcome.before, outcome.after)}`;
}

export function unequipStatus(outcome: SlotChangeOutcome): string {
  const gear = `${SLOT_NAME[outcome.slot]} Gear`;
  if (!outcome.changed) return `Nothing was equipped in ${gear}.`;
  return `${gear} unequipped.\n${SLOT_STAT_LABEL[outcome.slot]} unavailable until ${gear} is equipped.`;
}

export const STALE_ITEM = 'That item is no longer available.';
export const LOCKED_FEATURE = '🔒 You haven’t unlocked Equipment yet.';

export function conflictStatus(slot: EquipmentSlot): string {
  return `Your ${SLOT_NAME[slot]} Gear changed in another window — here’s what’s equipped now.`;
}

export function lockedFeatureView(): SessionPayload {
  return { content: LOCKED_FEATURE, embeds: [], components: [row(menuButton())], files: [] };
}
