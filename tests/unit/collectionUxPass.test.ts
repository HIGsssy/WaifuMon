/**
 * The Discord half of the Collection/Waifumon UX pass:
 *
 *   - the rarity picker is built from the game's own rarity ladder, and
 *     selecting from it narrows the collection query rather than the rendered
 *     page;
 *   - Inspect Buddy routes into the ordinary inspect card;
 *   - Release is disabled, and *explained*, for a protected copy.
 *
 * Pure handlers and builders against service doubles — no database. The
 * release rule itself is a domain invariant and is proved against real
 * Postgres in `tests/integration/collection.test.ts`; what is pinned here is
 * that the screen agrees with it.
 */
import { describe, expect, it, vi } from 'vitest';
import { RARITIES } from '../../src/db/schema';
import { menuComponents } from '../../src/discord/commands/waifumon';
import {
  handleCollectionPickId,
  handleCollectionRarity,
  handleInspectBuddy,
  releaseBlock,
} from '../../src/discord/commands/waifumonCollection';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type { OwnedEntry } from '../../src/modules/collection/collectionService';

const PLAYER_ID = 7;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;

function makeInteraction(values: string[] = []) {
  const painted: unknown[] = [];
  const record = vi.fn(async (body: unknown) => {
    painted.push(body);
  });
  return {
    painted,
    interaction: {
      values,
      channelId: 'c-1',
      replied: false,
      deferred: false,
      isButton: () => true,
      isStringSelectMenu: () => true,
      update: record,
      reply: record,
      editReply: record,
      followUp: record,
    },
  };
}

function customIds(view: unknown): string[] {
  const body = view as { components?: readonly unknown[] };
  return (body.components ?? []).flatMap((row) => {
    const json = (row as { toJSON: () => { components: Array<{ custom_id?: string }> } }).toJSON();
    return json.components.map((c) => c.custom_id ?? '');
  });
}

function componentsJson(view: unknown): Array<{
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  options?: Array<{ value: string; default?: boolean }>;
  min_values?: number;
  max_values?: number;
}> {
  const body = view as { components?: readonly unknown[] };
  return (body.components ?? []).flatMap((row) => {
    const json = (row as { toJSON: () => { components: unknown[] } }).toJSON();
    return json.components as never[];
  });
}

const ENTRY = {
  waifu: {
    id: 42,
    level: 20,
    xp: 0,
    baseSp: 100,
    affection: 5,
    isFavorite: false,
    nickname: null,
    variant: null,
    caughtAt: new Date('2026-01-01T00:00:00Z'),
    releasedAt: null,
  },
  species: {
    id: 1,
    slug: 'neko_barista',
    name: 'Neko Barista',
    rarity: 'SR',
    archetype: 'catgirl',
    affinity: 'sweet',
    description: 'She remembers your order.',
    tags: [],
  },
} as unknown as OwnedEntry;

const favorite = (): OwnedEntry =>
  ({ ...ENTRY, waifu: { ...ENTRY.waifu, isFavorite: true } }) as OwnedEntry;

/* ───────────────────────── A. rarity filter ───────────────────────── */

describe('rarity picker', () => {
  function ctxWithTracker(listOwnedGrouped = vi.fn(async () => emptyView())) {
    const tracker = createCollectionFilterTracker();
    return {
      tracker,
      listOwnedGrouped,
      ctx: {
        config: { assetsDir: './assets' },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        collectionFilters: tracker,
        content: { tables: { waifuProgression: { maxLevel: 50 } } },
        services: {
          collection: {
            listOwnedGrouped,
            getDexStats: vi.fn(async () => ({
              owned: 3,
              distinctSpecies: 2,
              totalSpecies: 10,
            })),
          },
          currency: { getBalances: vi.fn(async () => ({ essence: 10, waifubux: 0 })) },
          gifts: { pendingWaifuIds: vi.fn(async () => new Set<number>()) },
        },
      } as unknown as AppContext,
    };
  }

  function emptyView() {
    return { groups: [], page: 1, pageSize: 10, totalPages: 1, totalGroups: 0, totalCopies: 0 };
  }

  it('narrows the collection query, and only the query', async () => {
    const { ctx, listOwnedGrouped, tracker } = ctxWithTracker();
    const { interaction } = makeInteraction(['SR', 'EX']);

    await handleCollectionRarity(ctx, interaction as never, prov);

    // The service is asked for the filtered set — pagination therefore runs
    // downstream of rarity rather than over the unfiltered collection.
    expect(listOwnedGrouped).toHaveBeenCalledWith(
      PLAYER_ID,
      expect.objectContaining({ rarities: ['SR', 'EX'] }),
    );
    expect(tracker.get(PLAYER_ID).rarities).toEqual(['SR', 'EX']);
  });

  it('resets to page 1 so the player lands on the start of the new list', async () => {
    const { ctx, listOwnedGrouped, tracker } = ctxWithTracker();
    tracker.set(PLAYER_ID, { page: 4 });
    const { interaction } = makeInteraction(['EX']);

    await handleCollectionRarity(ctx, interaction as never, prov);

    expect(tracker.get(PLAYER_ID).page).toBe(1);
    expect(listOwnedGrouped).toHaveBeenCalledWith(
      PLAYER_ID,
      expect.objectContaining({ page: 1 }),
    );
  });

  it('an empty selection is "All rarities"', async () => {
    const { ctx, listOwnedGrouped, tracker } = ctxWithTracker();
    tracker.set(PLAYER_ID, { rarities: ['N'] });
    const { interaction } = makeInteraction([]);

    await handleCollectionRarity(ctx, interaction as never, prov);

    expect(tracker.get(PLAYER_ID).rarities).toBeNull();
    expect(listOwnedGrouped).toHaveBeenCalledWith(
      PLAYER_ID,
      expect.objectContaining({ rarities: null }),
    );
  });

  it('keeps the other filters intact when rarity changes', async () => {
    const { ctx, listOwnedGrouped, tracker } = ctxWithTracker();
    tracker.set(PLAYER_ID, { name: 'neko', minLevel: 10, sortBy: 'level_desc' });
    const { interaction } = makeInteraction(['SR']);

    await handleCollectionRarity(ctx, interaction as never, prov);

    expect(listOwnedGrouped).toHaveBeenCalledWith(
      PLAYER_ID,
      expect.objectContaining({
        name: 'neko',
        minLevel: 10,
        sortBy: 'level_desc',
        rarities: ['SR'],
      }),
    );
  });

  it('renders one option per canonical rarity, multi-select, deselectable', async () => {
    const { ctx } = ctxWithTracker();
    const { interaction, painted } = makeInteraction(['SR']);

    await handleCollectionRarity(ctx, interaction as never, prov);

    const select = componentsJson(painted[0]).find((c) => c.custom_id === 'wm|v1|col|rarity');
    expect(select).toBeDefined();
    // Sourced from the game's own rarity ladder — no second list to drift.
    expect(select!.options!.map((o) => o.value)).toEqual([...RARITIES]);
    expect(select!.min_values).toBe(0); // deselect-all = All rarities
    expect(select!.max_values).toBe(RARITIES.length);
    expect(select!.options!.filter((o) => o.default).map((o) => o.value)).toEqual(['SR']);
  });

  it('keeps the screen inside Discord\u2019s five-action-row limit', async () => {
    const { ctx } = ctxWithTracker();
    const { interaction, painted } = makeInteraction(['SR']);

    await handleCollectionRarity(ctx, interaction as never, prov);

    const rows = (painted[0] as { components?: unknown[] }).components ?? [];
    expect(rows.length).toBeLessThanOrEqual(5);
  });
});

/* ───────────────────────── B. inspect buddy ───────────────────────── */

describe('main menu · Inspect Buddy', () => {
  it('sits on the menu beside Care for Waifumon', () => {
    const rows = menuComponents({ active: false, enabled: true, currentEnergy: 5 } as never, true);
    const rowIds = rows.map((row) =>
      row.toJSON().components.map((c) => (c as { custom_id?: string }).custom_id ?? ''),
    );

    expect(rowIds.flat()).toContain('wm|v1|menu|inspect_buddy');

    // Beside Care, in the same action row, and inside Discord's five-button cap.
    const careRow = rowIds.find((ids) => ids.includes('wm|v1|care|start'));
    expect(careRow).toBeDefined();
    expect(careRow).toContain('wm|v1|menu|inspect_buddy');
    expect(careRow!.length).toBeLessThanOrEqual(5);
    // And no row anywhere exceeds the cap.
    for (const ids of rowIds) expect(ids.length).toBeLessThanOrEqual(5);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it('is offered while Care Mode is active too', () => {
    const rows = menuComponents({ active: true, enabled: true, currentEnergy: 0 } as never, true);
    const ids = rows.flatMap((row) =>
      row.toJSON().components.map((c) => (c as { custom_id?: string }).custom_id ?? ''),
    );
    expect(ids).toContain('wm|v1|menu|inspect_buddy');
  });

  it('opens the ordinary inspect card for the active buddy', async () => {
    const getOwned = vi.fn(async () => ENTRY);
    const ctx = inspectCtx({ buddyId: 42, getOwned });
    const { interaction, painted } = makeInteraction();

    await handleInspectBuddy(ctx, interaction as never, prov);

    // The same renderer Collection uses: it reads the copy by id and paints
    // the card's own action ids.
    expect(getOwned).toHaveBeenCalledWith(PLAYER_ID, 42);
    const ids = customIds(painted[0]);
    expect(ids).toContain('wm|v1|waifu|fav|42');
    expect(ids).toContain('wm|v1|waifu|release|42');
    expect(ids).toContain('wm|v1|col|list'); // Back navigation preserved
  });

  it('explains how to set one when there is no buddy, and touches nothing', async () => {
    const getOwned = vi.fn();
    const ctx = inspectCtx({ buddyId: null, getOwned });
    const { interaction, painted } = makeInteraction();

    await handleInspectBuddy(ctx, interaction as never, prov);

    expect(getOwned).not.toHaveBeenCalled();
    const body = painted[0] as { content?: string };
    expect(body.content).toContain('no active Buddy');
    expect(customIds(painted[0])).toContain('wm|v1|menu|back');
  });
});

/* ───────────────────────── C. release protection ───────────────────────── */

describe('releaseBlock — the rule the inspect screen renders', () => {
  it('allows an ordinary copy', () => {
    expect(releaseBlock(ENTRY, false)).toBeNull();
  });

  it('blocks a favourite, and says why', () => {
    expect(releaseBlock(favorite(), false)).toContain('Favourite');
  });

  it('blocks the active buddy, and says why', () => {
    expect(releaseBlock(ENTRY, true)).toContain('Buddy');
  });

  it('names both causes at once', () => {
    const message = releaseBlock(favorite(), true)!;
    expect(message).toContain('favourite');
    expect(message).toContain('Buddy');
  });
});

describe('inspect card · Release button', () => {
  /** Inspect one copy by id — the Collection route into the same renderer. */
  async function inspect(entry: OwnedEntry, buddyId: number | null) {
    const ctx = inspectCtx({ buddyId, getOwned: vi.fn(async () => entry) });
    const { interaction, painted } = makeInteraction();
    await handleCollectionPickId(ctx, interaction as never, prov, ['42']);
    return painted[0];
  }

  const releaseButton = (view: unknown) =>
    componentsJson(view).find((c) => c.custom_id === 'wm|v1|waifu|release|42');
  const embedText = (view: unknown) =>
    JSON.stringify((view as { embeds?: unknown[] }).embeds);

  it('is enabled for an ordinary copy, with no notice', async () => {
    const view = await inspect(ENTRY, 999);

    expect(releaseButton(view)!.disabled).toBeFalsy();
    expect(embedText(view)).not.toContain('Release unavailable');
  });

  it('is disabled for a favourite, with the reason in the embed', async () => {
    const view = await inspect(favorite(), 999);

    expect(releaseButton(view)!.disabled).toBe(true);
    expect(embedText(view)).toContain('Release unavailable');
    expect(embedText(view)).toContain('Favourite');
  });

  it('is disabled for the active buddy, with the reason in the embed', async () => {
    const view = await inspect(ENTRY, 42);

    expect(releaseButton(view)!.disabled).toBe(true);
    expect(embedText(view)).toContain('Release unavailable');
    expect(embedText(view)).toContain('Buddy');
  });

  it('names both causes when the copy is favourite and buddy', async () => {
    const view = await inspect(favorite(), 42);

    expect(releaseButton(view)!.disabled).toBe(true);
    expect(embedText(view)).toContain('favourite');
    expect(embedText(view)).toContain('Buddy');
  });

  it('the disabled state always matches the rule', async () => {
    // The button and `releaseBlock` must never disagree — the embed's
    // explanation is derived from the same call.
    for (const [entry, buddyId] of [
      [ENTRY, 999],
      [ENTRY, 42],
      [favorite(), 999],
      [favorite(), 42],
    ] as const) {
      const view = await inspect(entry, buddyId);
      const expected = releaseBlock(entry, buddyId === 42) != null;
      expect(releaseButton(view)!.disabled ?? false).toBe(expected);
    }
  });
});

/** Context wired for `renderInspect`: every read it makes, and nothing else. */
function inspectCtx(opts: {
  buddyId: number | null;
  getOwned: ReturnType<typeof vi.fn>;
}): AppContext {
  const buddy =
    opts.buddyId == null
      ? null
      : ({ ...ENTRY, waifu: { ...ENTRY.waifu, id: opts.buddyId } } as OwnedEntry);
  return {
    config: { assetsDir: './assets' },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    content: {
      // `findBuddyBonus` reads the species list; empty means "no bonus", which
      // keeps these tests about the release rule rather than the bonus panel.
      species: [],
      tables: {
        waifuProgression: {
          maxLevel: 50,
          nicknameMinLevel: 10,
          essenceInvestment: { essenceCost: 5 },
        },
        duplicate: { essenceByRarity: { SR: 20 }, releaseFraction: 0.5 },
      },
    },
    services: {
      collection: {
        getOwned: opts.getOwned,
        getBuddy: vi.fn(async () => buddy),
        hasOtherActiveCopies: vi.fn(async () => false),
        waifuProgress: () => ({ atMaxLevel: false, xpIntoLevel: 0, xpToNext: 100 }),
        maxUsefulApplications: () => 3,
      },
      currency: { getBalances: vi.fn(async () => ({ essence: 100, waifubux: 0 })) },
      gifts: { getPendingGift: vi.fn(async () => null) },
      quests: { recordQuestEvent: vi.fn(async () => {}) },
      appearance: {
        catalogFor: () => [
          { id: 'standard', name: 'Standard', unlock: { type: 'always' } },
        ],
        currentAppearance: () => ({ name: 'Standard' }),
      },
    },
  } as unknown as AppContext;
}
