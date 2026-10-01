/**
 * Equipment management on Discord — presenters, ids and handler guard rails,
 * with no database. The transactional half (real equips, conflicts, removed
 * and foreign gear) lives in `tests/integration/equipmentManagement.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EQUIPMENT_HOME_TITLE,
  LOCKED_FEATURE,
  NO_BUDDY_LINE,
  STALE_ITEM,
  buildEquipmentHome,
  buildGearBag,
  buildItemDetail,
  buildSlotScreen,
  encodeContext,
  eqId,
  equipStatus,
  formatChange,
  formatDelta,
  formatMultiplier,
  groupMarks,
  indicators,
  parseContext,
  parseInstanceId,
  unequipStatus,
  type EquipmentContext,
} from '../../src/discord/equipmentPresenter';
import {
  handleEquipmentEquip,
  handleEquipmentFlag,
  handleEquipmentHome,
  handleEquipmentItem,
  handleEquipmentPick,
  handleEquipmentSlot,
  handleEquipmentUnequip,
  handleGearBag,
} from '../../src/discord/commands/waifumonEquipment';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import { assembleCombatStats, type CombatSlotItem } from '../../src/modules/equipment/equipmentMath';
import type { EquipmentDefinitionView, EquipmentInstanceView } from '../../src/modules/equipment/equipmentQueries';
import type { EquipmentGroup } from '../../src/modules/equipment/equipmentService';
import type {
  BagView,
  EquipmentManagementService,
  ItemView,
  SlotView,
} from '../../src/modules/equipment/equipmentManagementService';
import {
  GEAR_BAG_PAGE_SIZE,
  filterGearBagGroups,
  groupFocusId,
  paginate,
  sortGearBagGroups,
} from '../../src/modules/equipment/gearBag';
import type { EquipmentSlot } from '../../src/modules/equipment/vocabulary';
import {
  EquipmentNotOwnedError,
  FeatureLockedError,
  LoadoutConflictError,
} from '../../src/shared/errors';
import { silentLogger } from '../helpers/testDb';

// ── fixtures ──────────────────────────────────────────────────────────────

const def = (key: string, slot: EquipmentSlot, bp: number, over: Partial<EquipmentDefinitionView> = {}): EquipmentDefinitionView => ({
  key,
  name: key.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '),
  description: '',
  slot,
  rarity: 'N',
  // A single-value range at `bp`; the fixtures below give every copy that roll.
  multiplierMinBp: bp,
  multiplierMaxBp: bp,
  multiplierStepBp: 100,
  tags: [],
  regionId: null,
  artworkPath: null,
  enabled: true,
  ...over,
});

const slotItem = (id: number, d: EquipmentDefinitionView): CombatSlotItem => ({
  equipmentId: id,
  definitionKey: d.key,
  name: d.name,
  definitionName: d.name,
  affixKey: null,
  rarity: d.rarity,
  multiplierBp: d.multiplierMinBp,
  rolledProperties: {},
});

const instance = (id: number, d: EquipmentDefinitionView, over: Partial<EquipmentInstanceView> = {}): EquipmentInstanceView =>
  ({
    id,
    slot: d.slot,
    definition: d,
    rolledMultiplierBp: d.multiplierMinBp,
    affixKey: null,
    displayName: d.name,
    rolledProperties: {},
    isFavorite: false,
    isLocked: false,
    sourceType: 'admin',
    equipped: false,
    ...over,
  }) as EquipmentInstanceView;

const group = (d: EquipmentDefinitionView, over: Partial<EquipmentGroup> = {}): EquipmentGroup => ({
  definition: d,
  rolledMultiplierBp: d.multiplierMinBp,
  affixKey: null,
  displayName: d.name,
  count: 1,
  equippedCount: 0,
  favoriteCount: 0,
  lockedCount: 0,
  representativeId: 1,
  instanceIds: [1],
  ...over,
});

const PIPE = def('rusty_pipe', 'attack', 4500);
const COIL = def('plasma_coil_ring', 'attack', 8200, { rarity: 'SR' });
const PLATE = def('scrap_plate', 'defense', 3500);
const BOX = def('dented_lunchbox', 'health', 20000);
const BUDDY = { waifuId: 9, speciesSlug: 'wp', name: 'Warband Princess', level: 50, baseSp: 300, currentSp: 420 };

const fullStats = () =>
  assembleCombatStats({
    buddy: BUDDY,
    loadoutId: 1,
    slots: { attack: slotItem(11, PIPE), defense: slotItem(12, PLATE), health: slotItem(13, BOX) },
  });

type Json = { title?: string; description?: string; footer?: { text: string }; fields?: { name: string; value: string }[] };
type Payload = ReturnType<typeof buildEquipmentHome>;
const embedOf = (p: Payload): Json => ((p.embeds?.[0] as { toJSON(): Json }) ?? { toJSON: () => ({}) }).toJSON();
const text = (p: Payload) => {
  const j = embedOf(p);
  return [p.content ?? '', j.title, j.description, j.footer?.text, ...(j.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
};
type RowJson = { components: { type: number; custom_id?: string; label?: string; disabled?: boolean; style?: number; options?: { value: string; label: string; description?: string }[] }[] };
const rowsOf = (p: Payload): RowJson[] => (p.components ?? []).map((r) => (r as { toJSON(): RowJson }).toJSON());
const ids = (p: Payload) => rowsOf(p).flatMap((r) => r.components.map((c) => c.custom_id ?? ''));
const buttonByLabel = (p: Payload, label: string) =>
  rowsOf(p).flatMap((r) => r.components).find((c) => c.label === label);

/** Discord's hard limits, checked on every screen these tests build. */
function expectWithinDiscordLimits(p: Payload): void {
  const rows = rowsOf(p);
  expect(rows.length).toBeLessThanOrEqual(5);
  const all = ids(p);
  expect(new Set(all).size).toBe(all.length); // custom ids unique per message
  for (const id of all) expect(id.length).toBeLessThanOrEqual(100);
  for (const r of rows) {
    expect(r.components.length).toBeLessThanOrEqual(5);
    for (const c of r.components) if (c.options) expect(c.options.length).toBeLessThanOrEqual(25);
  }
  expect((embedOf(p).fields ?? []).length).toBeLessThanOrEqual(25);
}

const page = <T,>(items: T[], over: Partial<{ page: number; totalPages: number; totalItems: number }> = {}) => ({
  items,
  page: 0,
  totalPages: 1,
  totalItems: items.length,
  ...over,
});

// ── formatting ────────────────────────────────────────────────────────────

describe('comparison formatting', () => {
  it('signs differences clearly', () => {
    expect(formatDelta(38)).toBe('+38');
    expect(formatDelta(-22)).toBe('-22');
    expect(formatDelta(0)).toBe('±0');
  });

  it('formats a stat change, including a worse item and unavailable sides', () => {
    expect(formatChange('attack', 302, 340)).toBe('ATK 302 → 340 (+38)');
    expect(formatChange('attack', 340, 318)).toBe('ATK 340 → 318 (-22)');
    expect(formatChange('defense', 210, 245)).toBe('DEF 210 → 245 (+35)');
    expect(formatChange('health', 920, 1080)).toBe('HP 920 → 1080 (+160)');
    expect(formatChange('attack', null, 189)).toBe('ATK — → 189');
    expect(formatChange('attack', 189, null)).toBe('ATK 189 → —');
  });

  it('formats multipliers and indicators', () => {
    expect(formatMultiplier(8200)).toBe('×0.82');
    expect(indicators({ equipped: true, favorite: true, locked: true })).toBe('✅ ⭐ 🔒');
    expect(indicators({ equipped: false, favorite: true, locked: false })).toBe('⭐');
    expect(indicators({ equipped: false, favorite: false, locked: false })).toBe('');
  });

  it('describes equip and unequip outcomes', () => {
    const item = instance(5, COIL);
    expect(equipStatus({ slot: 'attack', changed: true, item, before: 302, after: 340 })).toBe(
      '✅ Equipped **Plasma Coil Ring**.\nATK 302 → 340 (+38)',
    );
    expect(equipStatus({ slot: 'attack', changed: true, item, before: null, after: null })).toBe(
      '✅ Equipped **Plasma Coil Ring**.',
    );
    expect(unequipStatus({ slot: 'attack', changed: true, item, before: 302, after: null })).toBe(
      'Attack Gear unequipped.\nATK unavailable until Attack Gear is equipped.',
    );
    expect(unequipStatus({ slot: 'attack', changed: false, item: null, before: null, after: null })).toMatch(/Nothing was equipped/);
  });
});

// ── home ──────────────────────────────────────────────────────────────────

describe('Equipment home', () => {
  it('shows the Buddy, authoritative stats and all three slots', () => {
    const stats = fullStats();
    const p = buildEquipmentHome(stats);
    const body = text(p);
    expect(embedOf(p).title).toBe(EQUIPMENT_HOME_TITLE);
    expect(body).toContain('**Warband Princess** · Lv. 50');
    expect(body).toContain('Current SP: **420**');
    // The values are whatever the combat-stat result says — never recomputed here.
    expect(body).toContain(`ATK **${stats.stats.attack}** · DEF **${stats.stats.defense}** · HP **${stats.stats.maxHp}**`);
    for (const name of ['Rusty Pipe', 'Scrap Plate', 'Dented Lunchbox']) expect(body).toContain(name);
    expect(ids(p)).toEqual([eqId.slot('attack'), eqId.slot('defense'), eqId.slot('health'), eqId.bag(), 'wm|v1|menu|start']);
    expectWithinDiscordLimits(p);
  });

  it('shows an empty slot as nothing equipped and its stat as unavailable', () => {
    const stats = assembleCombatStats({ buddy: BUDDY, loadoutId: 1, slots: { attack: null, defense: slotItem(12, PLATE), health: null } });
    const body = text(buildEquipmentHome(stats));
    expect(body).toContain('Nothing equipped\nATK unavailable');
    expect(body).toContain('Nothing equipped\nHP unavailable');
    expect(body).toContain('ATK unavailable');
  });

  it('without a Buddy, explains why there are no stats but keeps every control', () => {
    const stats = assembleCombatStats({ buddy: null, loadoutId: 1, slots: { attack: slotItem(11, PIPE), defense: null, health: null } });
    const p = buildEquipmentHome(stats);
    expect(text(p)).toContain(NO_BUDDY_LINE);
    expect(text(p)).toContain('Unavailable without a Buddy.');
    expect(ids(p)).toContain(eqId.bag());
    expect(ids(p)).toContain(eqId.slot('attack'));
  });
});

// ── slot screen ───────────────────────────────────────────────────────────

function slotView(over: Partial<SlotView> = {}): SlotView {
  return {
    slot: 'attack',
    stats: fullStats(),
    equipped: instance(11, PIPE, { equipped: true }),
    current: 189,
    candidates: page([
      { group: group(COIL, { count: 3, representativeId: 21 }), equipmentId: 21, preview: { equipmentId: 21, available: true, value: 344, delta: 155 } },
      { group: group(def('spiked_ring', 'attack', 3000), { representativeId: 22 }), equipmentId: 22, preview: { equipmentId: 22, available: true, value: 126, delta: -63 } },
    ]),
    ...over,
  };
}

describe('slot management screen', () => {
  it('shows the current item and each candidate with its authoritative comparison', () => {
    const p = buildSlotScreen(slotView());
    const body = text(p);
    expect(body).toContain('**Rusty Pipe**\nATK ×0.45\nCurrent ATK: **189**');
    expect(body).toContain('Plasma Coil Ring ×3');
    expect(body).toContain('Would give: **344 ATK** (+155)');
    expect(body).toContain('Would give: **126 ATK** (-63)');
    const select = rowsOf(p)[0]!.components[0]!;
    expect(select.custom_id).toBe(eqId.pick({ kind: 'slot', slot: 'attack', page: 0 }));
    expect(select.options!.map((o) => o.value)).toEqual(['21', '22']);
    expect(select.options![0]!.description).toContain('344 ATK (+155)');
    expect(ids(p)).toContain(eqId.unequip('attack', 11, { kind: 'slot', slot: 'attack', page: 0 }));
    expectWithinDiscordLimits(p);
  });

  it('with nothing equipped, offers no Unequip', () => {
    const p = buildSlotScreen(slotView({ equipped: null, current: null }));
    expect(text(p)).toContain('Nothing equipped\nATK unavailable');
    expect(ids(p).some((id) => id.includes('|uneq|'))).toBe(false);
  });

  it('with no other gear, shows no select (Discord needs at least one option)', () => {
    const p = buildSlotScreen(slotView({ candidates: page([]) }));
    expect(text(p)).toContain('No other Attack Gear in your bag.');
    expect(rowsOf(p).some((r) => r.components.some((c) => c.options))).toBe(false);
  });

  it('without a Buddy, lists multipliers only', () => {
    const noBuddy = slotView({
      stats: assembleCombatStats({ buddy: null, loadoutId: 1, slots: { attack: slotItem(11, PIPE), defense: null, health: null } }),
      current: null,
      candidates: page([
        { group: group(COIL, { representativeId: 21 }), equipmentId: 21, preview: { equipmentId: 21, available: true, value: null, delta: null } },
      ]),
    });
    const body = text(buildSlotScreen(noBuddy));
    expect(body).toContain(NO_BUDDY_LINE);
    expect(body).toContain('ATK ×0.82');
    expect(body).not.toContain('Would give');
  });

  it('pages, with Prev disabled on the first page and Next on the last', () => {
    const first = buildSlotScreen(slotView({ candidates: { ...slotView().candidates, page: 0, totalPages: 3 } }));
    expect(buttonByLabel(first, '◀ Prev')?.disabled).toBe(true);
    expect(buttonByLabel(first, 'Next ▶')?.disabled).toBe(false);
    expect(buttonByLabel(first, 'Page 1 / 3')?.disabled).toBe(true);
    const last = buildSlotScreen(slotView({ candidates: { ...slotView().candidates, page: 2, totalPages: 3 } }));
    expect(buttonByLabel(last, 'Next ▶')?.disabled).toBe(true);
    expectWithinDiscordLimits(first);
    expectWithinDiscordLimits(last);
  });
});

// ── Gear Bag ──────────────────────────────────────────────────────────────

describe('Gear Bag', () => {
  const bagView = (entries: BagView['entries'], filter: BagView['filter'] = 'all'): BagView => ({ filter, entries });

  it('marks a single copy with icons, and spells out flags held by only some copies', () => {
    const p = buildGearBag(
      bagView(
        page([
          { group: group(COIL, { count: 3, equippedCount: 1, favoriteCount: 1, lockedCount: 2, instanceIds: [5, 6, 7] }), focusId: 6 },
          { group: group(PIPE, { equippedCount: 1, favoriteCount: 1, lockedCount: 1 }), focusId: 1 },
        ]),
      ),
    );
    const body = text(p);
    // Only some of the three rings are equipped / favourite / locked: no icon
    // in front of the name, which would read as "all of them".
    expect(body).toContain('**Plasma Coil Ring** ×3\nSR • Attack • ×0.82\n✅ 1 of 3 equipped · ⭐ 1 of 3 · 🔒 2 of 3');
    expect(body).not.toMatch(/[✅⭐🔒] \*\*Plasma Coil Ring/u);
    expect(body).toContain('✅ ⭐ 🔒 **Rusty Pipe** ×1\nN • Attack • ×0.45');
    const select = rowsOf(p)[0]!.components[0]!;
    expect(select.options!.map((o) => o.value)).toEqual(['6', '1']);
    expect(select.options![0]!.description).toContain('1 of 3 equipped');
    expect(select.options![1]!.description).toContain('• Equipped');
    expectWithinDiscordLimits(p);
  });

  it.each([
    [{ count: 3, equippedCount: 0, favoriteCount: 3, lockedCount: 3 }, '⭐ 🔒', ''],
    [{ count: 3, equippedCount: 0, favoriteCount: 0, lockedCount: 0 }, '', ''],
    [{ count: 2, equippedCount: 1, favoriteCount: 2, lockedCount: 0 }, '⭐', '✅ 1 of 2 equipped'],
    [{ count: 1, equippedCount: 1, favoriteCount: 0, lockedCount: 0 }, '✅', ''],
  ])('group marks %j → icons %j, partial %j', (counts, marks, partial) => {
    expect(groupMarks(counts)).toEqual({ marks, partial });
  });

  it('offers All / Attack / Defense / Health / Favourites, with the current one selected', () => {
    const p = buildGearBag(bagView(page([]), 'defense'));
    const filterRow = rowsOf(p).find((r) => r.components.some((c) => c.label === 'All'))!;
    expect(filterRow.components.map((c) => c.label)).toEqual(['All', 'Attack', 'Defense', 'Health', '⭐ Favourites']);
    expect(filterRow.components.find((c) => c.label === 'Defense')!.disabled).toBe(true);
    expect(text(p)).toContain('Nothing here yet.');
    expectWithinDiscordLimits(p);
  });

  it('shows the page position and stays within limits on a full middle page', () => {
    const full = Array.from({ length: GEAR_BAG_PAGE_SIZE }, (_, i) => ({ group: group(def(`gear_${i}`, 'attack', 1000 + i)), focusId: i + 1 }));
    const p = buildGearBag(bagView(page(full, { page: 1, totalPages: 5, totalItems: 47 })));
    expect(embedOf(p).footer?.text).toBe('Page 2 / 5 · 47 items');
    expect(buttonByLabel(p, '◀ Prev')?.disabled).toBe(false);
    expect(buttonByLabel(p, 'Next ▶')?.disabled).toBe(false);
    expectWithinDiscordLimits(p);
  });

  it('never labels gear from a disabled definition', () => {
    const retired = def('old_ring', 'attack', 5000, { enabled: false });
    const body = text(buildGearBag(bagView(page([{ group: group(retired), focusId: 1 }]))));
    expect(body).toContain('Old Ring');
    expect(body.toLowerCase()).not.toMatch(/disabled|retired/);
  });
});

describe('Gear Bag ordering, filters and paging (pure)', () => {
  const g = (d: EquipmentDefinitionView, over: Partial<EquipmentGroup> = {}) => group(d, over);

  it('orders equipped, then favourites, then slot, then rarity/power, then name', () => {
    const order = sortGearBagGroups([
      g(def('b_ring', 'attack', 5000)),
      g(BOX),
      g(PLATE, { favoriteCount: 1 }),
      g(def('a_ring', 'attack', 5000)),
      g(COIL),
      g(PIPE, { equippedCount: 1 }),
    ]).map((x) => x.definition.key);
    expect(order).toEqual(['rusty_pipe', 'scrap_plate', 'plasma_coil_ring', 'a_ring', 'b_ring', 'dented_lunchbox']);
  });

  it('filters by slot and by favourite', () => {
    const groups = [g(PIPE), g(PLATE, { favoriteCount: 2 }), g(BOX)];
    expect(filterGearBagGroups(groups, 'all')).toHaveLength(3);
    expect(filterGearBagGroups(groups, 'defense').map((x) => x.definition.key)).toEqual(['scrap_plate']);
    expect(filterGearBagGroups(groups, 'fav').map((x) => x.definition.key)).toEqual(['scrap_plate']);
  });

  it('pages and clamps stale page numbers into range', () => {
    const items = Array.from({ length: 47 }, (_, i) => i);
    expect(paginate(items, 0)).toMatchObject({ page: 0, totalPages: 5, totalItems: 47, items: items.slice(0, 10) });
    expect(paginate(items, 4).items).toEqual(items.slice(40));
    expect(paginate(items, 99).page).toBe(4);
    expect(paginate(items, -3).page).toBe(0);
    expect(paginate([], 7)).toMatchObject({ page: 0, totalPages: 1, items: [] });
  });

  it('focuses a group on its equipped copy when there is one', () => {
    const grp = g(COIL, { count: 3, instanceIds: [5, 6, 7], representativeId: 5, equippedCount: 1 });
    expect(groupFocusId(grp, new Set([6]))).toBe(6);
    expect(groupFocusId(grp, new Set())).toBe(5);
  });
});

// ── item detail ───────────────────────────────────────────────────────────

describe('item detail', () => {
  const back: EquipmentContext = { kind: 'bag', filter: 'all', page: 1 };
  const view = (over: Partial<ItemView> = {}): ItemView => ({
    instance: instance(21, COIL),
    copies: [21, 22, 23],
    equippedCopies: 0,
    slotEquipped: instance(11, PIPE, { equipped: true }),
    current: 189,
    preview: { equipmentId: 21, available: true, value: 344, delta: 155 },
    stats: fullStats(),
    ...over,
  });

  it('compares against the current item and equips with the slot it saw', () => {
    const p = buildItemDetail(view(), back);
    const body = text(p);
    expect(body).toContain('SR Attack Equipment');
    expect(body).toContain('Warband Princess — 420 SP');
    expect(body).toContain('Current ATK: 189\nWith this item: 344\nDifference: +155');
    expect(body).toContain('3 (viewing copy 1)');
    expect(ids(p)).toContain(eqId.equip(21, 11, back));
    expect(ids(p)).toContain(eqId.item(22, back)); // Next copy
    expect(ids(p)).toContain(eqId.bag('all', 1)); // Back
    expectWithinDiscordLimits(p);
  });

  it('flag buttons carry the value to set, so a double click lands on the same state', () => {
    const plain = buildItemDetail(view(), back);
    expect(ids(plain)).toContain(eqId.flag(21, 'f', true, back));
    expect(ids(plain)).toContain(eqId.flag(21, 'l', true, back));
    const flagged = buildItemDetail(view({ instance: instance(21, COIL, { isFavorite: true, isLocked: true }) }), back);
    expect(text(flagged)).toContain('⭐ Favourite · 🔒 Locked');
    expect(ids(flagged)).toContain(eqId.flag(21, 'f', false, back));
    expect(ids(flagged)).toContain(eqId.flag(21, 'l', false, back));
    // Locked gear can still be equipped.
    expect(ids(flagged)).toContain(eqId.equip(21, 11, back));
  });

  it('an equipped item shows Equipped and Unequip instead of Equip', () => {
    const p = buildItemDetail(view({ instance: instance(11, PIPE, { equipped: true }), copies: [11], current: 189 }), back);
    expect(buttonByLabel(p, 'Equipped')?.disabled).toBe(true);
    expect(ids(p)).toContain(eqId.unequip('attack', 11, back));
    expect(ids(p).some((id) => id.includes('|equip|'))).toBe(false);
  });

  it('into an empty slot, the equip id expects the slot empty', () => {
    expect(ids(buildItemDetail(view({ slotEquipped: null, current: null }), back))).toContain(eqId.equip(21, null, back));
  });
});

// ── ids ───────────────────────────────────────────────────────────────────

describe('custom ids and contexts', () => {
  it.each<EquipmentContext>([
    { kind: 'home' },
    { kind: 'slot', slot: 'defense', page: 3 },
    { kind: 'bag', filter: 'fav', page: 0 },
  ])('round-trips context %j', (ctx) => {
    expect(parseContext(encodeContext(ctx))).toEqual(ctx);
  });

  it.each(['', 'x', 's.relic.0', 's.attack', 's.attack.-1', 's.attack.1.2', 'b.rarity.0', 'b.all.abc', undefined])(
    'rejects malformed context %j',
    (raw) => {
      expect(parseContext(raw as string | undefined)).toBeNull();
    },
  );

  it('accepts only positive integer instance ids', () => {
    expect(parseInstanceId('42')).toBe(42);
    for (const bad of ['0', '-1', '1.5', 'abc', '', undefined, '9'.repeat(20)]) expect(parseInstanceId(bad)).toBeNull();
  });

  it('builds ids the shared parser reads back', () => {
    expect(parseCustomId(eqId.equip(5, null, { kind: 'home' }))).toEqual({ scope: 'eq', action: 'equip', args: ['5', '-', 'h'] });
    expect(parseCustomId(eqId.flag(5, 'l', true, { kind: 'bag', filter: 'health', page: 2 }))).toEqual({
      scope: 'eq',
      action: 'flag',
      args: ['5', 'l', '1', 'b.health.2'],
    });
  });
});

// ── handlers (service doubles) ─────────────────────────────────────────────

const PLAYER_ID = 7;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;

function interaction(values?: string[]) {
  const painted: { content?: string; embeds?: unknown[] }[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as { content?: string });
  });
  return {
    i: { replied: false, deferred: false, values, isButton: () => !values, isStringSelectMenu: () => !!values, update: paint, reply: paint, editReply: paint, followUp: paint },
    painted,
  };
}

function management(over: Partial<Record<keyof EquipmentManagementService, unknown>> = {}) {
  const homeView = { stats: fullStats() };
  return {
    home: vi.fn(async () => homeView),
    slot: vi.fn(async () => slotView()),
    bag: vi.fn(async () => ({ filter: 'all', entries: page([]) })),
    item: vi.fn(async () => {
      throw new EquipmentNotOwnedError(1);
    }),
    equip: vi.fn(),
    unequip: vi.fn(),
    setFlag: vi.fn(),
    ...over,
  } as unknown as EquipmentManagementService & Record<keyof EquipmentManagementService, ReturnType<typeof vi.fn>>;
}

const appCtx = (svc: unknown) =>
  ({ config: { assetsDir: './assets' }, logger: silentLogger(), services: { equipmentManagement: svc } }) as unknown as AppContext;
const paintedText = (painted: unknown[]) => JSON.stringify(painted);

describe('eq:* handlers', () => {
  it('a locked player reaches nothing, whatever the id says', async () => {
    const locked = async () => {
      throw new FeatureLockedError('equipment');
    };
    const svc = management({ home: vi.fn(locked), slot: vi.fn(locked), bag: vi.fn(locked), item: vi.fn(locked), equip: vi.fn(locked), unequip: vi.fn(locked), setFlag: vi.fn(locked) });
    const calls: [string, (i: never) => Promise<void>][] = [
      ['home', (i) => handleEquipmentHome(appCtx(svc), i, prov)],
      ['slot', (i) => handleEquipmentSlot(appCtx(svc), i, prov, ['attack', '0'])],
      ['bag', (i) => handleGearBag(appCtx(svc), i, prov, ['all', '0'])],
      ['item', (i) => handleEquipmentItem(appCtx(svc), i, prov, ['5', 'h'])],
      ['equip', (i) => handleEquipmentEquip(appCtx(svc), i, prov, ['5', '-', 'h'])],
      ['uneq', (i) => handleEquipmentUnequip(appCtx(svc), i, prov, ['attack', '5', 'h'])],
      ['flag', (i) => handleEquipmentFlag(appCtx(svc), i, prov, ['5', 'f', '1', 'h'])],
    ];
    for (const [label, call] of calls) {
      const { i, painted } = interaction();
      await call(i as never);
      expect(painted[0]?.content, label).toBe(LOCKED_FEATURE);
    }
  });

  it('always acts on the clicking player', async () => {
    const svc = management({ equip: vi.fn(async () => ({ slot: 'attack', changed: true, item: instance(5, COIL), before: 1, after: 2 })) });
    const { i } = interaction();
    await handleEquipmentEquip(appCtx(svc), i as never, prov, ['5', '11', 's.attack.0']);
    expect(svc.equip).toHaveBeenCalledWith(PLAYER_ID, 5, 11);
    expect(svc.slot).toHaveBeenCalledWith(PLAYER_ID, 'attack', 0);
  });

  it.each<[string, (ctx: AppContext, i: never) => Promise<void>]>([
    ['a bad slot', (c, i) => handleEquipmentSlot(c, i, prov, ['relic', '0'])],
    ['a bad page', (c, i) => handleGearBag(c, i, prov, ['all', 'x'])],
    ['a bad filter', (c, i) => handleGearBag(c, i, prov, ['rarity', '0'])],
    ['a bad item id', (c, i) => handleEquipmentItem(c, i, prov, ['-5', 'h'])],
    ['a bad expected id', (c, i) => handleEquipmentEquip(c, i, prov, ['5', 'zz', 'h'])],
    ['a bad unequip slot', (c, i) => handleEquipmentUnequip(c, i, prov, ['relic', '5', 'h'])],
    ['a bad flag', (c, i) => handleEquipmentFlag(c, i, prov, ['5', 'x', '1', 'h'])],
    ['a bad flag value', (c, i) => handleEquipmentFlag(c, i, prov, ['5', 'f', '2', 'h'])],
    ['a bad context', (c, i) => handleEquipmentItem(c, i, prov, ['5', 'q.1'])],
  ])('treats %s as malformed and calls no service', async (_label, call) => {
    const svc = management();
    const { i, painted } = interaction();
    await call(appCtx(svc), i as never);
    expect(paintedText(painted)).toContain('malformed');
    for (const fn of [svc.home, svc.slot, svc.bag, svc.item, svc.equip, svc.unequip, svc.setFlag]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('a missing / foreign / removed item repaints where the player came from, with one line', async () => {
    const svc = management();
    const { i, painted } = interaction(['999']);
    await handleEquipmentPick(appCtx(svc), i as never, prov, ['b.attack.2']);
    expect(svc.bag).toHaveBeenCalledWith(PLAYER_ID, 'attack', 2);
    expect(painted[0]?.content).toBe(STALE_ITEM);
  });

  it('a non-numeric select value is stale, not an error', async () => {
    const svc = management();
    const { i, painted } = interaction(['not-an-id']);
    await handleEquipmentPick(appCtx(svc), i as never, prov, ['s.health.0']);
    expect(svc.item).not.toHaveBeenCalled();
    expect(painted[0]?.content).toBe(STALE_ITEM);
  });

  it('a slot changed elsewhere repaints that slot with an explanation', async () => {
    const svc = management({
      equip: vi.fn(async () => {
        throw new LoadoutConflictError('attack');
      }),
      item: vi.fn(async () => ({ instance: instance(5, COIL) })),
    });
    const { i, painted } = interaction();
    await handleEquipmentEquip(appCtx(svc), i as never, prov, ['5', '11', 'h']);
    expect(svc.slot).toHaveBeenCalledWith(PLAYER_ID, 'attack', 0);
    expect(painted[0]?.content).toMatch(/changed in another window/);
  });

  it('says so when the deployment has no Equipment management', async () => {
    const { i, painted } = interaction();
    await handleEquipmentHome(appCtx(undefined), i as never, prov);
    expect(paintedText(painted)).toContain('no longer works');
  });
});
