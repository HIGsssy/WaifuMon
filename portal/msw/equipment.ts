/**
 * A small in-memory stand-in for the Equipment API, for page tests.
 *
 * Stateful on purpose: the behaviour worth testing is the round trip — an
 * equip that changes the slot, the stats and the card; a conflict that leaves
 * the slot alone; a filter that reaches the server as a query parameter. Each
 * test builds its own backend, so nothing leaks between tests.
 *
 * It mirrors the real routes' *contract* (shapes, codes, the stale-slot guard,
 * display-name search) — the arithmetic here is test scaffolding standing in
 * for the server's combat-stat service, not something the Portal does.
 */
import { HttpResponse, http } from 'msw';

import type {
  CombatModifierRow,
  DismantleBlocker,
  DismantleLine,
  DismantleProblemReason,
  DismantleRarityLine,
  EquipmentItem,
  EquipmentOverview,
  EquipmentSlot,
  EquipmentStat,
  FabricationResult,
  Rarity,
  WorkshopRecipe,
  WorkshopSlotChoice,
} from '@/api/types';
import { apiError, data } from './handlers';

const STAT: Record<EquipmentSlot, EquipmentStat> = {
  attack: 'attack',
  defense: 'defense',
  health: 'maxHp',
};
const SLOT_ORDER: EquipmentSlot[] = ['attack', 'defense', 'health'];
const RARITY_ORDER = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'];

let nextId = 100;

export function gearItem(
  overrides: Partial<EquipmentItem> & Pick<EquipmentItem, 'name' | 'slot'>,
): EquipmentItem {
  nextId += 1;
  return {
    id: nextId,
    baseName: overrides.name,
    description: '',
    rarity: 'N',
    multiplier: 0.5,
    range: { min: 0.4, max: 0.6 },
    rollQuality: 50,
    combatBonuses: [],
    equipped: false,
    favorite: false,
    locked: false,
    acquiredAt: `2026-09-${String(10 + (nextId % 15)).padStart(2, '0')}T12:00:00.000Z`,
    source: 'Boss',
    // Placeholder: the fake recomputes it on every read, as the server does.
    salvage: { components: null, blockedBy: null },
    ...overrides,
  };
}

/** The recipe the fake serves, minus what the fake derives (affordability). */
export type FakeRecipe = Omit<WorkshopRecipe, 'affordable' | 'shortfall' | 'available'>;

const slotsOf = (counts: Partial<Record<WorkshopSlotChoice, number>>) =>
  (['attack', 'defense', 'health', 'any'] as const).map((choice) => ({
    choice,
    eligibleCount: counts[choice] ?? 0,
    available: (counts[choice] ?? 0) > 0,
  }));

/** The V1 recipes, with Health missing above N — the catalogue as it is today. */
export const DEFAULT_RECIPES: FakeRecipe[] = [
  {
    key: 'standard_rebuild',
    name: 'Standard Rebuild',
    description: 'Patch bolts something serviceable together.',
    rarity: 'N',
    componentCost: 5,
    waifubuxCost: 250,
    slots: slotsOf({ attack: 6, defense: 6, health: 1, any: 13 }),
  },
  {
    key: 'improved_rebuild',
    name: 'Improved Rebuild',
    description: 'Better parts, fewer sparks.',
    rarity: 'R',
    componentCost: 15,
    waifubuxCost: 750,
    slots: slotsOf({ attack: 3, defense: 3, health: 0, any: 6 }),
  },
  {
    key: 'advanced_rebuild',
    name: 'Advanced Rebuild',
    description: "Patch's best work.",
    rarity: 'SR',
    componentCost: 40,
    waifubuxCost: 2000,
    slots: slotsOf({ attack: 1, defense: 1, health: 0, any: 2 }),
  },
];

export interface EquipmentBackendOptions {
  unlocked?: boolean;
  /** Null for no active Buddy. */
  buddy?: { waifuId: number; name: string; level: number; currentSp: number } | null;
  items?: EquipmentItem[];
  equipped?: Partial<Record<EquipmentSlot, number>>;
  /** Workshop balances and content. */
  components?: number;
  waifubux?: number;
  salvageYields?: Partial<Record<Rarity, number>>;
  recipes?: FakeRecipe[];
  /** Which image the fake server says it resolved; null for text-only. */
  workshopArtwork?: 'workshop' | 'patch' | null;
  /**
   * The loadout's cumulative combat bonuses as the server would format them.
   * Scripted, not derived: totalling and capping are the server's combat rules.
   */
  combatModifiers?: CombatModifierRow[];
}

export function createEquipmentBackend(opts: EquipmentBackendOptions = {}) {
  const state = {
    unlocked: opts.unlocked ?? true,
    buddy:
      opts.buddy === undefined
        ? { waifuId: 1, name: 'Nyx', level: 30, currentSp: 420 }
        : opts.buddy,
    items: (opts.items ?? []).map((item) => ({ ...item })),
    slots: { attack: null, defense: null, health: null, ...opts.equipped } as Record<
      EquipmentSlot,
      number | null
    >,
    /** Every Gear Bag query string the page sent, in order. */
    bagRequests: [] as URLSearchParams[],
    /** Set to make the next mutation fail with this error instead. */
    failNextMutation: null as { status: number; code: string; message: string } | null,
    components: opts.components ?? 0,
    waifubux: opts.waifubux ?? 0,
    salvageYields: opts.salvageYields ?? ({ N: 1, R: 4, SR: 12 } as Partial<Record<Rarity, number>>),
    recipes: opts.recipes ?? DEFAULT_RECIPES,
    workshopArtwork: opts.workshopArtwork ?? null,
    combatModifiers: opts.combatModifiers ?? [],
    /** Every Workshop write the page sent, in order: body and addressed player. */
    workshopRequests: [] as { path: string; body: Record<string, unknown>; playerId: string }[],
    /** Results by request key — the server's idempotency, so a retry replays. */
    operations: new Map<string, unknown>(),
    /** What the next fabrication produces. */
    nextFabricated: null as Partial<EquipmentItem> | null,
  };

  const blockerOf = (item: EquipmentItem & { equipped: boolean }): DismantleBlocker | null =>
    item.equipped
      ? 'equipped'
      : item.favorite
        ? 'favorite'
        : item.locked
          ? 'locked'
          : state.salvageYields[item.rarity] == null
            ? 'unsupported_rarity'
            : null;

  const view = (item: (typeof state.items)[number]): EquipmentItem => {
    const equipped = state.slots[item.slot] === item.id;
    const withEquipped = { ...item, equipped };
    return {
      ...withEquipped,
      salvage: {
        components: state.salvageYields[item.rarity] ?? null,
        blockedBy: blockerOf(withEquipped),
      },
    };
  };
  const find = (id: number) => state.items.find((item) => item.id === id);
  const statFor = (itemId: number | null): number | null => {
    const item = itemId == null ? undefined : find(itemId);
    return state.buddy && item ? Math.round(state.buddy.currentSp * item.multiplier) : null;
  };
  const locked = () => apiError(422, 'FEATURE_LOCKED', "You haven't unlocked that yet.");
  const notOwned = () =>
    apiError(404, 'EQUIPMENT_NOT_OWNED', "That equipment isn't in your gear bag.");
  const injected = () => {
    const fail = state.failNextMutation;
    state.failNextMutation = null;
    return fail ? apiError(fail.status, fail.code, fail.message) : null;
  };

  function overview(): EquipmentOverview {
    if (!state.unlocked) return { unlocked: false };
    const slots = {} as Record<EquipmentSlot, EquipmentItem | null>;
    for (const slot of SLOT_ORDER) {
      const item = state.slots[slot] == null ? undefined : find(state.slots[slot]!);
      slots[slot] = item ? view(item) : null;
    }
    const missing = SLOT_ORDER.some((slot) => state.slots[slot] == null);
    return {
      unlocked: true,
      buddy: state.buddy,
      stats: {
        attack: statFor(state.slots.attack),
        defense: statFor(state.slots.defense),
        maxHp: statFor(state.slots.health),
      },
      combatModifiers: state.combatModifiers,
      unavailableReason: !state.buddy ? 'no_buddy' : missing ? 'incomplete_loadout' : null,
      slots,
    };
  }

  const balances = () => ({ components: state.components, waifubux: state.waifubux });

  function workshopOverview() {
    return {
      balances: balances(),
      artwork: state.workshopArtwork ? { source: state.workshopArtwork } : null,
      salvageYields: (Object.entries(state.salvageYields) as [Rarity, number][]).map(([rarity, components]) => ({
        rarity,
        components,
      })),
      recipes: state.recipes.map((r) => {
        const shortfall = {
          components: Math.max(0, r.componentCost - state.components),
          waifubux: Math.max(0, r.waifubuxCost - state.waifubux),
        };
        return {
          ...r,
          available: r.slots.some((s) => s.available),
          affordable: shortfall.components === 0 && shortfall.waifubux === 0,
          shortfall,
        };
      }),
    };
  }

  /** The server's all-or-nothing check, in its order. */
  function assess(ids: number[]) {
    const problems: { id: number; reason: DismantleProblemReason }[] = [];
    const lines: DismantleLine[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) {
        problems.push({ id, reason: 'duplicate' });
        continue;
      }
      seen.add(id);
      const item = find(id);
      if (!item) {
        problems.push({ id, reason: 'not_owned' });
        continue;
      }
      const v = view(item);
      if (v.salvage.blockedBy) problems.push({ id, reason: v.salvage.blockedBy });
      else {
        lines.push({
          id,
          name: v.name,
          rarity: v.rarity,
          slot: v.slot,
          multiplier: v.multiplier,
          combatBonuses: v.combatBonuses,
          components: v.salvage.components!,
        });
      }
    }
    const byRarity: DismantleRarityLine[] = [];
    for (const line of lines) {
      const entry = byRarity.find((b) => b.rarity === line.rarity);
      if (entry) {
        entry.count += 1;
        entry.components += line.components;
      } else byRarity.push({ rarity: line.rarity, count: 1, components: line.components });
    }
    byRarity.sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
    const total = lines.reduce((sum, l) => sum + l.components, 0);
    return { problems, lines, byRarity, total };
  }

  const refused = (problems: { id: number; reason: DismantleProblemReason }[]) =>
    HttpResponse.json(
      {
        error: {
          code: 'EQUIPMENT_DISMANTLE_REFUSED',
          message: `Nothing was dismantled: one selected item can't be dismantled.`,
          details: { problems },
        },
        requestId: 'test-request-id',
      },
      { status: 409 },
    );

  const handlers = [
    http.get('/api/v1/players/:playerId/equipment', () => data(overview())),

    http.get('/api/v1/players/:playerId/equipment/items', ({ request }) => {
      if (!state.unlocked) return locked();
      const params = new URL(request.url).searchParams;
      state.bagRequests.push(params);
      const limit = Number(params.get('limit') ?? 24);
      if (limit > 50) return apiError(400, 'VALIDATION_ERROR', 'The request was not valid.');
      const search = params.get('search')?.toLowerCase();
      let items = state.items
        .map(view)
        .filter(
          (item) =>
            (!params.get('slot') || item.slot === params.get('slot')) &&
            (!params.get('rarity') || item.rarity === params.get('rarity')) &&
            (!params.has('equipped') || String(item.equipped) === params.get('equipped')) &&
            (!params.has('favorite') || String(item.favorite) === params.get('favorite')) &&
            (!params.has('locked') || String(item.locked) === params.get('locked')) &&
            (!search || item.name.toLowerCase().includes(search)),
        );
      const sort = params.get('sort') ?? 'newest';
      const by: Record<string, (a: EquipmentItem, b: EquipmentItem) => number> = {
        newest: (a, b) => b.id - a.id,
        oldest: (a, b) => a.id - b.id,
        slot: (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || a.id - b.id,
        rarity: (a, b) =>
          RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.id - a.id,
        name: (a, b) => a.baseName.localeCompare(b.baseName) || a.id - b.id,
        multiplier: (a, b) => b.multiplier - a.multiplier || b.id - a.id,
        quality: (a, b) => b.rollQuality - a.rollQuality || b.id - a.id,
      };
      items = [...items].sort(by[sort]);
      const offset = Number(params.get('cursor') ?? 0);
      const page = items.slice(offset, offset + limit);
      const next = offset + limit < items.length ? String(offset + limit) : null;
      return data({ items: page, nextCursor: next });
    }),

    http.get('/api/v1/players/:playerId/equipment/items/:equipmentId', ({ params }) => {
      if (!state.unlocked) return locked();
      const item = find(Number(params.equipmentId));
      if (!item) return notOwned();
      const currentId = state.slots[item.slot];
      const current = statFor(currentId);
      const withItem = statFor(item.id);
      const equippedItem = currentId == null ? undefined : find(currentId);
      return data({
        item: view(item),
        identicalCopies: 1,
        comparison: {
          stat: STAT[item.slot],
          current,
          withItem,
          delta: current != null && withItem != null ? withItem - current : null,
          equippedItem: equippedItem ? view(equippedItem) : null,
          hasBuddy: state.buddy != null,
        },
      });
    }),

    http.post(
      '/api/v1/players/:playerId/equipment/items/:equipmentId/equip',
      async ({ params, request }) => {
        if (!state.unlocked) return locked();
        const fail = injected();
        if (fail) return fail;
        const item = find(Number(params.equipmentId));
        if (!item) return notOwned();
        const body = (await request.json()) as { expectedCurrentId: number | null };
        const currentId = state.slots[item.slot];
        if (body.expectedCurrentId !== currentId) {
          return apiError(
            409,
            'LOADOUT_CONFLICT',
            'Your equipment changed in the meantime — take another look.',
          );
        }
        const before = statFor(currentId);
        state.slots[item.slot] = item.id;
        return data({
          slot: item.slot,
          changed: currentId !== item.id,
          item: view(item),
          before,
          after: statFor(item.id),
        });
      },
    ),

    http.post(
      '/api/v1/players/:playerId/equipment/loadout/:slot/unequip',
      async ({ params, request }) => {
        if (!state.unlocked) return locked();
        const fail = injected();
        if (fail) return fail;
        const slot = params.slot as EquipmentSlot;
        const body = (await request.json()) as { expectedCurrentId: number | null };
        const currentId = state.slots[slot];
        if (body.expectedCurrentId !== currentId) {
          return apiError(
            409,
            'LOADOUT_CONFLICT',
            'Your equipment changed in the meantime — take another look.',
          );
        }
        const before = statFor(currentId);
        const taken = currentId == null ? undefined : find(currentId);
        state.slots[slot] = null;
        return data({
          slot,
          changed: currentId != null,
          item: taken ? view(taken) : null,
          before,
          after: null,
        });
      },
    ),

    http.put(
      '/api/v1/players/:playerId/equipment/items/:equipmentId/flags/:flag',
      async ({ params, request }) => {
        if (!state.unlocked) return locked();
        const fail = injected();
        if (fail) return fail;
        const item = find(Number(params.equipmentId));
        if (!item) return notOwned();
        const { value } = (await request.json()) as { value: boolean };
        if (params.flag === 'favorite') item.favorite = value;
        else item.locked = value;
        return data(view(item));
      },
    ),

    http.get('/api/v1/players/:playerId/equipment/workshop', () => {
      if (!state.unlocked) return locked();
      return data(workshopOverview());
    }),

    http.post('/api/v1/players/:playerId/equipment/workshop/dismantle/preview', async ({ request, params }) => {
      if (!state.unlocked) return locked();
      const body = (await request.json()) as { equipmentIds: number[] };
      state.workshopRequests.push({
        path: 'preview',
        body,
        playerId: String(params.playerId),
      });
      const { problems, lines, byRarity, total } = assess(body.equipmentIds);
      if (problems.length > 0) return refused(problems);
      return data({
        count: lines.length,
        byRarity,
        totalComponents: total,
        items: lines,
        balances: balances(),
        componentsAfter: state.components + total,
      });
    }),

    http.post('/api/v1/players/:playerId/equipment/workshop/dismantle', async ({ request, params }) => {
      if (!state.unlocked) return locked();
      const body = (await request.json()) as { equipmentIds: number[]; requestKey: string; expectedComponents?: number };
      state.workshopRequests.push({
        path: 'dismantle',
        body,
        playerId: String(params.playerId),
      });
      const fail = injected();
      if (fail) return fail;
      const previous = state.operations.get(body.requestKey);
      if (previous) return data({ ...(previous as object), replayed: true, balances: balances() });
      const { problems, lines, byRarity, total } = assess(body.equipmentIds);
      if (problems.length > 0) return refused(problems);
      if (body.expectedComponents !== undefined && body.expectedComponents !== total) {
        return apiError(409, 'WORKSHOP_PREVIEW_STALE', 'Salvage values changed since you reviewed this.');
      }
      state.items = state.items.filter((item) => !body.equipmentIds.includes(item.id));
      state.components += total;
      const result = { replayed: false, count: lines.length, byRarity, totalComponents: total, items: lines, balances: balances() };
      state.operations.set(body.requestKey, result);
      return data(result);
    }),

    http.post('/api/v1/players/:playerId/equipment/workshop/fabricate', async ({ request, params }) => {
      if (!state.unlocked) return locked();
      const body = (await request.json()) as { recipeKey: string; slot: WorkshopSlotChoice; requestKey: string };
      state.workshopRequests.push({
        path: 'fabricate',
        body,
        playerId: String(params.playerId),
      });
      const fail = injected();
      if (fail) return fail;
      const previous = state.operations.get(body.requestKey) as FabricationResult | undefined;
      if (previous) return data({ ...previous, replayed: true, balances: balances() });
      const recipe = state.recipes.find((r) => r.key === body.recipeKey);
      if (!recipe) return apiError(404, 'WORKSHOP_RECIPE_UNAVAILABLE', "Patch isn't taking that order right now.");
      if (!recipe.slots.find((s) => s.choice === body.slot)?.available) {
        return apiError(422, 'WORKSHOP_NO_ELIGIBLE_EQUIPMENT', `Patch has no blueprints for that yet. Nothing was charged.`);
      }
      if (state.components < recipe.componentCost) {
        return apiError(
          422,
          'INSUFFICIENT_COMPONENTS',
          `You need ${recipe.componentCost} Salvaged Components but only have ${state.components}.`,
        );
      }
      if (state.waifubux < recipe.waifubuxCost) {
        return apiError(422, 'INSUFFICIENT_FUNDS', `You need ${recipe.waifubuxCost} WaifuBux but only have ${state.waifubux}.`);
      }
      state.components -= recipe.componentCost;
      state.waifubux -= recipe.waifubuxCost;
      const slot: EquipmentSlot = body.slot === 'any' ? 'attack' : body.slot;
      const made = gearItem({
        name: 'Fabricated Thing of Fresh Solder',
        baseName: 'Fabricated Thing',
        slot,
        rarity: recipe.rarity,
        multiplier: 0.75,
        source: 'Fabricated by Patch',
        ...state.nextFabricated,
      });
      state.items.push(made);
      const result: FabricationResult = {
        replayed: false,
        recipe: { key: recipe.key, name: recipe.name, rarity: recipe.rarity },
        slotChoice: body.slot,
        cost: { components: recipe.componentCost, waifubux: recipe.waifubuxCost },
        item: {
          id: made.id,
          name: made.name,
          baseName: made.baseName,
          slot: made.slot,
          rarity: made.rarity,
          multiplier: made.multiplier,
          affix: made.name.startsWith(`${made.baseName} `) ? made.name.slice(made.baseName.length + 1) : null,
          combatBonuses: made.combatBonuses,
        },
        balances: balances(),
      };
      state.operations.set(body.requestKey, result);
      return data(result);
    }),
  ];

  return { state, handlers };
}
