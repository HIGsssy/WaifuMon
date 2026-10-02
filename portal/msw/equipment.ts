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
import { http } from 'msw';

import type {
  EquipmentItem,
  EquipmentOverview,
  EquipmentSlot,
  EquipmentStat,
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
    equipped: false,
    favorite: false,
    locked: false,
    acquiredAt: `2026-09-${String(10 + (nextId % 15)).padStart(2, '0')}T12:00:00.000Z`,
    source: 'Boss',
    ...overrides,
  };
}

export interface EquipmentBackendOptions {
  unlocked?: boolean;
  /** Null for no active Buddy. */
  buddy?: { waifuId: number; name: string; level: number; currentSp: number } | null;
  items?: EquipmentItem[];
  equipped?: Partial<Record<EquipmentSlot, number>>;
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
  };

  const view = (item: (typeof state.items)[number]): EquipmentItem => ({
    ...item,
    equipped: state.slots[item.slot] === item.id,
  });
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
      unavailableReason: !state.buddy ? 'no_buddy' : missing ? 'incomplete_loadout' : null,
      slots,
    };
  }

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
  ];

  return { state, handlers };
}
