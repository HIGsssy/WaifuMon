/**
 * Patch's Workshop on Discord — presenters, custom ids and handler guard
 * rails, against a service double. The transactional half (real dismantles,
 * charges, retries, races) is `tests/integration/equipmentWorkshop.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildEquipmentHome, eqId } from '../../src/discord/equipmentPresenter';
import {
  DISMANTLE_REPLAYED,
  FABRICATION_REPLAYED,
  buildDismantleList,
  buildDismantleResult,
  buildDismantleReview,
  buildFabricationResult,
  buildFabricationReview,
  buildRecipeList,
  buildSlotChoice,
  buildWorkshopHome,
  decodeIds,
  pwId,
} from '../../src/discord/workshopPresenter';
import {
  handleDismantleConfirm,
  handleDismantleList,
  handleDismantleSelect,
  handleFabricateConfirm,
  handleFabricateRecipe,
  handleFabricateReview,
  handleWorkshopHome,
  workshopRequestKey,
} from '../../src/discord/commands/waifumonWorkshop';
import { handleEquipmentHome } from '../../src/discord/commands/waifumonEquipment';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import { assembleCombatStats } from '../../src/modules/equipment/equipmentMath';
import type { EquipmentDefinitionView, EquipmentInstanceView } from '../../src/modules/equipment/equipmentQueries';
import type {
  DismantleCandidate,
  DismantleOutcome,
  DismantlePreview,
  EquipmentWorkshopService,
  FabricationOutcome,
  WorkshopOverview,
  WorkshopRecipeView,
} from '../../src/modules/equipment/equipmentWorkshopService';
import type { EquipmentSlot } from '../../src/modules/equipment/vocabulary';
import {
  EquipmentDismantleRefusedError,
  FeatureLockedError,
  InsufficientComponentsError,
} from '../../src/shared/errors';
import { silentLogger } from '../helpers/testDb';

// ── fixtures ──────────────────────────────────────────────────────────────

const PATCH = { key: 'patch', name: 'Patch', title: 'Scavenger & Mechanic', portraitPath: null };

const def = (key: string, slot: EquipmentSlot, rarity = 'N'): EquipmentDefinitionView => ({
  key,
  name: key.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '),
  description: '',
  slot,
  rarity,
  multiplierMinBp: 4_000,
  multiplierMaxBp: 6_000,
  multiplierStepBp: 500,
  tags: [],
  regionId: null,
  artworkPath: null,
  enabled: true,
});

const item = (id: number, d: EquipmentDefinitionView, over: Partial<EquipmentInstanceView> = {}): EquipmentInstanceView => ({
  id,
  slot: d.slot,
  definition: d,
  rolledMultiplierBp: 4_500,
  affixKey: 'poor_planning',
  displayName: `${d.name} of Poor Planning`,
  rolledProperties: {},
  isFavorite: false,
  isLocked: false,
  sourceType: 'boss',
  sourceKey: null,
  acquiredAt: new Date(0),
  equipped: false,
  ...over,
});

const candidate = (i: EquipmentInstanceView, components: number | null, blockedBy: DismantleCandidate['blockedBy'] = null) => ({
  item: i,
  components,
  blockedBy,
});

const slots = (available: Partial<Record<'attack' | 'defense' | 'health' | 'any', number>>) =>
  (['attack', 'defense', 'health', 'any'] as const).map((choice) => ({
    choice,
    eligibleCount: available[choice] ?? 0,
    available: (available[choice] ?? 0) > 0,
  }));

const recipe = (over: Partial<WorkshopRecipeView> = {}): WorkshopRecipeView => ({
  key: 'improved_rebuild',
  name: 'Improved Rebuild',
  description: 'Better parts, fewer sparks.',
  rarity: 'R',
  componentCost: 15,
  waifubuxCost: 750,
  slots: slots({ attack: 3, defense: 3, any: 6 }),
  available: true,
  affordable: true,
  shortfall: { components: 0, waifubux: 0 },
  ...over,
});

const overview = (over: Partial<WorkshopOverview> = {}): WorkshopOverview => ({
  balances: { components: 18, waifubux: 4_250 },
  salvageYields: [
    { rarity: 'N', components: 1 },
    { rarity: 'R', components: 4 },
    { rarity: 'SR', components: 12 },
  ],
  recipes: [
    recipe({ key: 'standard_rebuild', name: 'Standard Rebuild', rarity: 'N', componentCost: 5, waifubuxCost: 250, slots: slots({ attack: 6, defense: 6, health: 1, any: 13 }) }),
    recipe(),
    recipe({
      key: 'advanced_rebuild',
      name: 'Advanced Rebuild',
      rarity: 'SR',
      componentCost: 40,
      waifubuxCost: 2_000,
      slots: slots({ attack: 1, defense: 1, any: 2 }),
      affordable: false,
      shortfall: { components: 22, waifubux: 0 },
    }),
  ],
  ...over,
});

const preview = (over: Partial<DismantlePreview> = {}): DismantlePreview => ({
  count: 5,
  byRarity: [
    { rarity: 'N', count: 3, components: 3 },
    { rarity: 'R', count: 2, components: 8 },
  ],
  totalComponents: 11,
  items: [1, 2, 3, 4, 5].map((id) => ({
    equipmentId: id,
    displayName: `Thing ${id}`,
    rarity: id <= 3 ? 'N' : 'R',
    slot: 'attack' as const,
    rolledMultiplierBp: 4_500,
    components: id <= 3 ? 1 : 4,
  })),
  balances: { components: 18, waifubux: 4_250 },
  componentsAfter: 29,
  ...over,
});

const fabrication = (over: Partial<FabricationOutcome> = {}): FabricationOutcome => ({
  replayed: false,
  recipe: { key: 'improved_rebuild', name: 'Improved Rebuild', rarity: 'R' },
  slotChoice: 'attack',
  cost: { components: 15, waifubux: 750 },
  item: {
    equipmentId: 77,
    displayName: 'Combat Knife of Bad Decisions',
    name: 'Combat Knife',
    slot: 'attack',
    rarity: 'R',
    rolledMultiplierBp: 7_500,
    affixSuffix: 'of Bad Decisions',
  },
  balances: { components: 3, waifubux: 3_500 },
  ...over,
});

type Json = { title?: string; description?: string; footer?: { text: string }; author?: { name: string }; fields?: { name: string; value: string }[] };
type Payload = ReturnType<typeof buildWorkshopHome>;
const embedOf = (p: Payload): Json => ((p.embeds?.[0] as { toJSON(): Json }) ?? { toJSON: () => ({}) }).toJSON();
const text = (p: Payload) => {
  const j = embedOf(p);
  return [p.content ?? '', j.author?.name, j.title, j.description, j.footer?.text, ...(j.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
};
type Component = { type: number; custom_id?: string; label?: string; disabled?: boolean; style?: number; min_values?: number; max_values?: number; options?: { value: string; label: string; description?: string }[] };
type RowJson = { components: Component[] };
const rowsOf = (p: Payload): RowJson[] => (p.components ?? []).map((r) => (r as { toJSON(): RowJson }).toJSON());
const all = (p: Payload) => rowsOf(p).flatMap((r) => r.components);
const ids = (p: Payload) => all(p).map((c) => c.custom_id ?? '');
const byLabel = (p: Payload, label: string) => all(p).find((c) => c.label === label);
const select = (p: Payload) => all(p).find((c) => c.options);

function expectWithinDiscordLimits(p: Payload): void {
  const rows = rowsOf(p);
  expect(rows.length).toBeLessThanOrEqual(5);
  const list = ids(p);
  expect(new Set(list).size).toBe(list.length);
  for (const id of list) expect(id.length).toBeLessThanOrEqual(100);
  for (const r of rows) {
    expect(r.components.length).toBeLessThanOrEqual(5);
    for (const c of r.components) if (c.options) expect(c.options.length).toBeLessThanOrEqual(25);
  }
  expect((embedOf(p).fields ?? []).length).toBeLessThanOrEqual(25);
  for (const f of embedOf(p).fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
}

/** Nothing internal reaches a player: no definition / affix keys, no basis points. */
function expectNoInternals(p: Payload): void {
  const raw = JSON.stringify({ text: text(p), options: all(p).map((c) => c.options ?? []) });
  for (const leak of ['poor_planning', 'rusty_pipe', 'combat_knife', 'Bp', '4500', '7500', 'bad_decisions']) {
    expect(raw).not.toContain(leak);
  }
}

// ── home and entry ────────────────────────────────────────────────────────

describe('entry from Equipment', () => {
  const stats = assembleCombatStats({ buddy: null, loadoutId: null, slots: { attack: null, defense: null, health: null } });

  it('the Equipment home offers 🔧 Visit Patch when the Workshop is wired', () => {
    const home = buildEquipmentHome(stats, null, null, { workshop: true });
    const visit = byLabel(home, 'Visit Patch');
    expect(visit?.custom_id).toBe(pwId.home());
    expectWithinDiscordLimits(home);
  });

  it('and not otherwise', () => {
    expect(byLabel(buildEquipmentHome(stats), 'Visit Patch')).toBeUndefined();
  });

  it('a locked player never sees the Equipment home, so never sees the entry', async () => {
    const painted: { content?: string; components?: unknown[] }[] = [];
    const i = { replied: false, deferred: false, isButton: () => true, update: vi.fn(async (b) => painted.push(b)), reply: vi.fn(async (b) => painted.push(b)), editReply: vi.fn(async (b) => painted.push(b)) };
    const ctx = {
      config: { assetsDir: './assets' },
      logger: silentLogger(),
      services: {
        equipmentManagement: { home: vi.fn(async () => { throw new FeatureLockedError('equipment'); }) },
        equipmentWorkshop: {},
      },
    } as unknown as AppContext;
    await handleEquipmentHome(ctx, i as never, { playerId: 1, guildDbId: 1 } as Provisioned);
    expect(JSON.stringify(painted)).not.toContain('pw|home');
  });
});

describe('Workshop home', () => {
  it('shows Patch, both balances and the salvage values', () => {
    const p = buildWorkshopHome(overview(), PATCH);
    const t = text(p);
    expect(embedOf(p).title).toBe("🔧 Patch's Workshop");
    expect(embedOf(p).author?.name).toBe('Patch · Scavenger & Mechanic');
    expect(t).toContain('Salvaged Components: **18**');
    expect(t).toContain('WaifuBux: **4,250**');
    expect(t).toContain('N → 1 · R → 4 · SR → 12');
    expect(all(p).map((c) => c.label)).toEqual(['Dismantle Equipment', 'Fabricate Equipment', 'Back']);
    expect(byLabel(p, 'Back')?.custom_id).toBe(eqId.home());
    expectWithinDiscordLimits(p);
  });
});

// ── dismantle ─────────────────────────────────────────────────────────────

describe('dismantle list', () => {
  const pipe = def('rusty_pipe', 'attack');
  const knife = def('combat_knife', 'attack', 'R');
  const relic = def('ancient_relic', 'attack', 'SSR');
  const free = item(1, pipe);
  const fav = item(2, pipe, { isFavorite: true });
  const locked = item(3, knife, { isLocked: true });
  const equipped = item(4, pipe, { equipped: true });
  const ssr = item(5, relic, { displayName: 'Ancient Relic', affixKey: null });
  const page = { items: [candidate(free, 1), candidate(fav, 1, 'favorite'), candidate(locked, 4, 'locked'), candidate(equipped, 1, 'equipped'), candidate(ssr, null, 'unsupported_rarity')], page: 0, totalPages: 3, totalItems: 25 };

  it('shows every copy with name, rarity, multiplier and state; protected rows say why', () => {
    const p = buildDismantleList(page, PATCH);
    const t = text(p);
    expect(t).toContain('**Rusty Pipe of Poor Planning**');
    expect(t).toContain('N • ATK ×0.45 • +1 Salvaged Components');
    expect(t).toContain('Favourite — unfavourite it first');
    expect(t).toContain('Locked — unlock it first');
    expect(t).toContain('Equipped — unequip it first');
    expect(t).toContain("Patch can't salvage this rarity yet");
    expect(t).toContain('⭐');
    expect(t).toContain('🔒');
    expect(t).toContain('✅');
    expectWithinDiscordLimits(p);
    expectNoInternals(p);
  });

  it('only unprotected copies can be selected, several at once', () => {
    const p = buildDismantleList(page, PATCH);
    const menu = select(p)!;
    expect(menu.custom_id).toBe(pwId.dismantleSelect(0));
    expect(menu.options!.map((o) => o.value)).toEqual(['1']);
    expect([menu.min_values, menu.max_values]).toEqual([1, 1]);
  });

  it('paginates', () => {
    const p = buildDismantleList({ ...page, page: 1 }, PATCH);
    const prev = byLabel(p, '◀ Prev')!;
    const next = byLabel(p, 'Next ▶')!;
    expect(parseCustomId(prev.custom_id!)).toMatchObject({ scope: 'pw', action: 'disp', args: ['0', 'p'] });
    expect(parseCustomId(next.custom_id!)).toMatchObject({ scope: 'pw', action: 'disp', args: ['2', 'n'] });
    expect(byLabel(p, 'Page 2 / 3')?.disabled).toBe(true);
  });

  it('a page of only protected copies offers nothing to pick', () => {
    const p = buildDismantleList({ items: [candidate(fav, 1, 'favorite')], page: 0, totalPages: 1, totalItems: 1 }, PATCH);
    expect(select(p)).toBeUndefined();
    expect(text(p)).toContain('Every copy here is protected.');
  });
});

describe('dismantle review and result', () => {
  it('summarises by rarity, totals the Components and warns before Confirm / Cancel', () => {
    const p = buildDismantleReview(preview(), [1, 2, 3, 4, 5], 2, 'nonce123', PATCH);
    const t = text(p);
    expect(embedOf(p).title).toBe('Dismantle 5 pieces?');
    expect(t).toContain('3× N\n2× R');
    expect(t).toContain('**You receive:**\n11 Salvaged Components');
    expect(t).toContain('This cannot be undone.');
    expect(all(p).map((c) => c.label)).toEqual(['Confirm', 'Cancel']);
    expect(byLabel(p, 'Cancel')?.custom_id).toBe(pwId.dismantle(2));
    const confirm = parseCustomId(byLabel(p, 'Confirm')!.custom_id!);
    expect(confirm).toMatchObject({ scope: 'pw', action: 'dcf', args: ['nonce123', '11', expect.any(String)] });
    expect(decodeIds((confirm as { args: string[] }).args[2])).toEqual([1, 2, 3, 4, 5]);
    expectWithinDiscordLimits(p);
  });

  it('a full page of large ids still fits one confirm id', () => {
    const big = Array.from({ length: 10 }, (_, i) => 2_000_000_000 + i);
    const p = buildDismantleReview(preview({ totalComponents: 120 }), big, 0, 'abcdefgh', PATCH);
    const confirm = byLabel(p, 'Confirm')!;
    expect(confirm.custom_id!.length).toBeLessThanOrEqual(100);
    expect(decodeIds((parseCustomId(confirm.custom_id!) as { args: string[] }).args[2])).toEqual(big);
  });

  it('decodes ids strictly', () => {
    for (const raw of [undefined, '', '1..2', '-1', '1.2.x!', 'A', '0']) expect(decodeIds(raw)).toBeNull();
    expect(decodeIds('1.a.zz')).toEqual([1, 10, 1295]);
  });

  it('reports the result and remaining balances; a replay says so', () => {
    const outcome: DismantleOutcome = { replayed: false, count: 5, byRarity: preview().byRarity, totalComponents: 11, items: preview().items, balances: { components: 29, waifubux: 4_250 } };
    const p = buildDismantleResult(outcome, PATCH);
    expect(text(p)).toContain('**+11 Salvaged Components**');
    expect(text(p)).toContain('Salvaged Components: **29**');
    expect(p.content).toBeUndefined();
    expect(buildDismantleResult({ ...outcome, replayed: true }, PATCH).content).toBe(DISMANTLE_REPLAYED);
  });
});

// ── fabrication ───────────────────────────────────────────────────────────

describe('fabrication screens', () => {
  it('lists recipes with cost, slot availability and shortfall', () => {
    const p = buildRecipeList(overview({ recipes: [...overview().recipes, recipe({ key: 'dead_rebuild', name: 'Dead Rebuild', slots: slots({}), available: false })] }), PATCH);
    const t = text(p);
    expect(t).toContain('Improved Rebuild — R Equipment');
    expect(t).toContain('15 Salvaged Components + 750 WaifuBux');
    expect(t).toContain('❤️ Health — none yet');
    expect(t).toContain('Needs 22 more Salvaged Components.');
    expect(byLabel(p, 'Improved Rebuild')?.custom_id).toBe(pwId.recipe('improved_rebuild'));
    expect(byLabel(p, 'Dead Rebuild')?.disabled).toBe(true);
    expectWithinDiscordLimits(p);
  });

  it('offers Attack / Defense / Health / Any, disabling unavailable ones with a reason', () => {
    const p = buildSlotChoice(recipe(), { components: 18, waifubux: 4_250 }, PATCH);
    const labels = all(p).map((c) => [c.label, c.disabled ?? false]);
    expect(labels).toEqual([
      ['Attack', false],
      ['Defense', false],
      ['Health — none yet', true],
      ['Any / Surprise Me', false],
      ['Back', false],
    ]);
    expect(text(p)).toContain('Health: Patch has no R blueprints for it.');
    expect(byLabel(p, 'Any / Surprise Me')?.custom_id).toBe(pwId.review('improved_rebuild', 'any'));
    expectWithinDiscordLimits(p);
  });

  it('reviews the cost with before and after, Confirm carrying a fresh nonce', () => {
    const p = buildFabricationReview(recipe(), 'attack', { components: 18, waifubux: 4_250 }, 'n0nce999', PATCH);
    const t = text(p);
    expect(t).toContain('**Improved Rebuild** · R · Attack');
    expect(t).toContain('**Cost:** 15 Salvaged Components + 750 WaifuBux');
    expect(t).toContain('**After:** 3 Salvaged Components · 3,500 WaifuBux');
    expect(byLabel(p, 'Confirm')).toMatchObject({ custom_id: pwId.fabricateConfirm('improved_rebuild', 'attack', 'n0nce999'), disabled: false });
    expect(byLabel(p, 'Cancel')?.custom_id).toBe(pwId.recipe('improved_rebuild'));
    expectWithinDiscordLimits(p);
  });

  it('cannot confirm what the player cannot afford', () => {
    const r = recipe({ affordable: false, shortfall: { components: 0, waifubux: 300 } });
    const p = buildFabricationReview(r, 'attack', { components: 18, waifubux: 450 }, 'n0nce999', PATCH);
    expect(byLabel(p, 'Confirm')?.disabled).toBe(true);
    expect(text(p)).toContain('Needs 300 more WaifuBux.');
  });

  it('a maximal recipe key still fits the confirm id', () => {
    const key = 'r'.repeat(64);
    const p = buildFabricationReview(recipe({ key }), 'defense', { components: 99, waifubux: 9_999 }, 'abcdefgh', PATCH);
    expect(byLabel(p, 'Confirm')!.custom_id!.length).toBeLessThanOrEqual(100);
    expect(byLabel(p, 'Confirm')?.disabled).toBe(false);
  });

  it('reveals the item: name, rarity, slot, multiplier, affix and remaining balances — nothing internal', () => {
    const p = buildFabricationResult(fabrication(), PATCH, true);
    const t = text(p);
    expect(embedOf(p).title).toBe('✨ Combat Knife of Bad Decisions');
    for (const part of ['Rarity\nR', 'Slot\n⚔️ Attack', 'Multiplier\nATK ×0.75', 'Affix\nof Bad Decisions', 'Salvaged Components: **3**', 'WaifuBux: **3,500**']) {
      expect(t).toContain(part);
    }
    expect(byLabel(p, 'Inspect')?.custom_id).toBe(eqId.item(77, { kind: 'home' }));
    expect(byLabel(p, 'Fabricate Again')?.custom_id).toBe(pwId.review('improved_rebuild', 'attack'));
    expectNoInternals(p);
    expect(buildFabricationResult(fabrication({ replayed: true }), PATCH, true).content).toBe(FABRICATION_REPLAYED);
    expect(byLabel(buildFabricationResult(fabrication(), PATCH, false), 'Fabricate Again')?.disabled).toBe(true);
  });
});

// ── handlers ──────────────────────────────────────────────────────────────

const PLAYER_ID = 7;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;

function interaction(values?: string[]) {
  const painted: Payload[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as Payload);
  });
  return {
    i: { replied: false, deferred: false, values, user: { id: 'u-1' }, isButton: () => !values, isStringSelectMenu: () => !!values, update: paint, reply: paint, editReply: paint, followUp: paint },
    painted,
  };
}

function workshop(over: Partial<Record<keyof EquipmentWorkshopService, unknown>> = {}) {
  return {
    isAvailable: vi.fn(async () => true),
    overview: vi.fn(async () => overview()),
    dismantleCandidates: vi.fn(async () => ({ items: [], page: 0, totalPages: 1, totalItems: 0 })),
    previewDismantle: vi.fn(async () => preview()),
    dismantle: vi.fn(async () => ({ replayed: false, count: 5, byRarity: preview().byRarity, totalComponents: 11, items: preview().items, balances: { components: 29, waifubux: 4_250 } })),
    fabricate: vi.fn(async () => fabrication()),
    salvageValue: vi.fn(() => 1),
    ...over,
  } as unknown as EquipmentWorkshopService & Record<keyof EquipmentWorkshopService, ReturnType<typeof vi.fn>>;
}

const appCtx = (svc: unknown) =>
  ({ config: { assetsDir: './assets' }, logger: silentLogger(), content: { npcs: [PATCH] }, services: { equipmentWorkshop: svc } }) as unknown as AppContext;

describe('pw:* handlers', () => {
  it('a locked player reaches nothing, whatever the id says', async () => {
    const locked = vi.fn(async () => {
      throw new FeatureLockedError('equipment');
    });
    const svc = workshop({ overview: locked, dismantleCandidates: locked, previewDismantle: locked, dismantle: locked, fabricate: locked });
    const calls: [string, (i: never) => Promise<void>, string[] | undefined][] = [
      ['home', (i) => handleWorkshopHome(appCtx(svc), i, prov), undefined],
      ['list', (i) => handleDismantleList(appCtx(svc), i, prov, ['0']), undefined],
      ['select', (i) => handleDismantleSelect(appCtx(svc), i, prov, ['0']), ['5']],
      ['confirm', (i) => handleDismantleConfirm(appCtx(svc), i, prov, ['abcdefgh', '1', '5']), undefined],
      ['recipe', (i) => handleFabricateRecipe(appCtx(svc), i, prov, ['standard_rebuild']), undefined],
      ['review', (i) => handleFabricateReview(appCtx(svc), i, prov, ['standard_rebuild', 'attack']), undefined],
      ['fabricate', (i) => handleFabricateConfirm(appCtx(svc), i, prov, ['standard_rebuild', 'attack', 'abcdefgh']), undefined],
    ];
    for (const [label, call, values] of calls) {
      const { i, painted } = interaction(values);
      await call(i as never);
      expect(painted[0]?.content, label).toBe('🔒 You haven’t unlocked Equipment yet.');
    }
  });

  it('the select shows a review of exactly the chosen copies for the clicking player', async () => {
    const svc = workshop();
    const { i, painted } = interaction(['4', '9']);
    await handleDismantleSelect(appCtx(svc), i as never, prov, ['1']);
    expect(svc.previewDismantle).toHaveBeenCalledWith(PLAYER_ID, [4, 9]);
    expect(svc.dismantle).not.toHaveBeenCalled();
    expect(byLabel(painted[0]!, 'Confirm')).toBeDefined();
    expect(byLabel(painted[0]!, 'Cancel')?.custom_id).toBe(pwId.dismantle(1));
  });

  it('confirm dismantles the reviewed ids with the button’s request key and reviewed total', async () => {
    const svc = workshop();
    const { i, painted } = interaction();
    await handleDismantleConfirm(appCtx(svc), i as never, prov, ['abcdefgh', '11', '4.9']);
    expect(svc.dismantle).toHaveBeenCalledWith(PLAYER_ID, {
      equipmentIds: [4, 9],
      requestKey: workshopRequestKey('abcdefgh'),
      expectedComponents: 11,
    });
    expect(text(painted[0]!)).toContain('+11 Salvaged Components');
  });

  it('the same Confirm clicked twice carries the same request key (the service replays)', async () => {
    const svc = workshop();
    for (let n = 0; n < 2; n += 1) {
      const { i } = interaction();
      await handleDismantleConfirm(appCtx(svc), i as never, prov, ['abcdefgh', '11', '4.9']);
    }
    const keys = svc.dismantle.mock.calls.map((c) => (c[1] as { requestKey: string }).requestKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('a refused (stale) dismantle repaints the list with the reason', async () => {
    const svc = workshop({
      dismantle: vi.fn(async () => {
        throw new EquipmentDismantleRefusedError([{ equipmentId: 9, reason: 'favorite' }]);
      }),
    });
    const { i, painted } = interaction();
    await handleDismantleConfirm(appCtx(svc), i as never, prov, ['abcdefgh', '11', '4.9']);
    expect(painted[0]?.content).toContain('Nothing was dismantled: one selected item is a favourite');
    expect(svc.dismantleCandidates).toHaveBeenCalledWith(PLAYER_ID, 0, 10);
  });

  it('malformed ids are refused without reaching the service', async () => {
    const svc = workshop();
    for (const args of [['short', '1', '5'], ['abcdefgh', 'x', '5'], ['abcdefgh', '1', '5..6'], ['abcdefgh', '1']]) {
      const { i, painted } = interaction();
      await handleDismantleConfirm(appCtx(svc), i as never, prov, args);
      expect(painted[0]?.content).toMatch(/malformed/);
    }
    for (const values of [['x'], [], Array.from({ length: 11 }, (_, n) => String(n + 1))]) {
      const { i, painted } = interaction(values);
      await handleDismantleSelect(appCtx(svc), i as never, prov, ['0']);
      expect(painted[0]?.content).toMatch(/malformed/);
    }
    const { i, painted } = interaction();
    await handleFabricateConfirm(appCtx(svc), i as never, prov, ['standard_rebuild', 'relic', 'abcdefgh']);
    expect(painted[0]?.content).toMatch(/malformed/);
    expect(svc.dismantle).not.toHaveBeenCalled();
    expect(svc.previewDismantle).not.toHaveBeenCalled();
    expect(svc.fabricate).not.toHaveBeenCalled();
  });

  it('reviewing never charges; confirming fabricates with the nonce and reveals', async () => {
    const svc = workshop();
    const review = interaction();
    await handleFabricateReview(appCtx(svc), review.i as never, prov, ['improved_rebuild', 'attack']);
    expect(svc.fabricate).not.toHaveBeenCalled();
    const confirmId = byLabel(review.painted[0]!, 'Confirm')!.custom_id!;
    const nonce = (parseCustomId(confirmId) as { args: string[] }).args[2]!;

    const confirm = interaction();
    await handleFabricateConfirm(appCtx(svc), confirm.i as never, prov, ['improved_rebuild', 'attack', nonce]);
    expect(svc.fabricate).toHaveBeenCalledWith(PLAYER_ID, {
      recipeKey: 'improved_rebuild',
      slot: 'attack',
      requestKey: workshopRequestKey(nonce),
    });
    expect(embedOf(confirm.painted[0]!).title).toBe('✨ Combat Knife of Bad Decisions');
  });

  it('every review mints a fresh nonce', async () => {
    const svc = workshop();
    const nonces = new Set<string>();
    for (let n = 0; n < 3; n += 1) {
      const { i, painted } = interaction();
      await handleFabricateReview(appCtx(svc), i as never, prov, ['improved_rebuild', 'attack']);
      nonces.add(byLabel(painted[0]!, 'Confirm')!.custom_id!);
    }
    expect(nonces.size).toBe(3);
  });

  it('a short balance repaints the slot choice with the reason', async () => {
    const svc = workshop({
      fabricate: vi.fn(async () => {
        throw new InsufficientComponentsError(15, 3);
      }),
    });
    const { i, painted } = interaction();
    await handleFabricateConfirm(appCtx(svc), i as never, prov, ['improved_rebuild', 'attack', 'abcdefgh']);
    expect(painted[0]?.content).toBe('You need 15 Salvaged Components but only have 3.');
    expect(byLabel(painted[0]!, 'Attack')?.custom_id).toBe(pwId.review('improved_rebuild', 'attack'));
  });

  it('a recipe that vanished falls back to the recipe list', async () => {
    const svc = workshop();
    const { i, painted } = interaction();
    await handleFabricateRecipe(appCtx(svc), i as never, prov, ['gone_rebuild']);
    expect(painted[0]?.content).toBe("Patch isn't taking that order right now.");
    expect(byLabel(painted[0]!, 'Improved Rebuild')).toBeDefined();
  });
});
