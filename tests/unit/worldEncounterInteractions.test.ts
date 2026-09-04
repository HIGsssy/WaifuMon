/**
 * World Encounter Discord button handlers — the interaction security surface.
 *
 * A Discord custom id is a string the client sends back to us. It is not a
 * capability, it is not signed, and a player can read the ids on their own
 * buttons and type different numbers into an API client. So the property
 * these tests pin is: **nothing that matters is taken from the custom id.**
 * Prices, stock, rewards, encounter state and species are all resolved
 * server-side from the player's own rows, and the id contributes only a
 * lookup key that is always scoped to the clicking player.
 *
 * Driven with service doubles and a fake interaction — no database, no
 * gateway. That keeps them runnable everywhere, which matters because the
 * transactional half of the same guarantees lives in
 * `tests/integration/worldEncounterVendorAndContinuation.test.ts` and needs
 * Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  handleWorldEncounterContinue,
  handleWorldEncounterVendorBuy,
  handleWorldEncounterVendorOpen,
} from '../../src/discord/commands/waifumonWorldEncounter';
import { handleWildEncounterOpen } from '../../src/discord/commands/waifumonHunt';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { AppError } from '../../src/shared/errors';

const PLAYER_ID = 7;
const OTHER_PLAYER_ID = 8;

const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;

/** Records every paint so a test can assert what the player was shown. */
function makeInteraction() {
  const painted: unknown[] = [];
  const interaction = {
    replied: false,
    deferred: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    update: vi.fn(async (body: unknown) => {
      painted.push(body);
    }),
    reply: vi.fn(async (body: unknown) => {
      painted.push(body);
    }),
    editReply: vi.fn(async (body: unknown) => {
      painted.push(body);
    }),
    followUp: vi.fn(async (body: unknown) => {
      painted.push(body);
    }),
  };
  return { interaction, painted };
}

/** The text of whatever was painted, for "was this the stale-button message?". */
function paintedText(painted: unknown[]): string {
  return painted
    .map((p) => {
      const body = p as { content?: string; embeds?: Array<{ data?: unknown }> };
      return [body.content ?? '', JSON.stringify(body.embeds ?? [])].join(' ');
    })
    .join('\n');
}

function makeCtx(services: Record<string, unknown>): AppContext {
  return {
    config: { assetsDir: './assets' },
    services,
  } as unknown as AppContext;
}

/* ─────────────────────── Continue ─────────────────────── */

describe('Continue button', () => {
  const activation = {
    activeId: 42,
    encounter: {
      id: 1,
      slug: 'tv_bandit_aftermath',
      name: 'Aftermath',
      description: 'The road is quiet again.',
      rarity: 'common',
      artworkPath: null,
      choices: [],
    },
    buddy: null,
    buddyBonusPercent: 0,
    choiceViews: [],
  };

  it('presents the continuation the server says belongs to this player', async () => {
    const getActivationById = vi.fn(async () => activation);
    const { interaction, painted } = makeInteraction();
    await handleWorldEncounterContinue(
      makeCtx({ worldEncounter: { getActivationById } }),
      interaction as never,
      prov,
      ['42'],
    );

    // The player id is supplied by the *session*, never by the button.
    expect(getActivationById).toHaveBeenCalledWith(42, PLAYER_ID);
    expect(paintedText(painted)).toContain('Aftermath');
  });

  it('refuses a second click once the continuation has been consumed', async () => {
    // The service returns null for a row that is no longer pending, which is
    // what makes a double-click safe: the second click paints a message, not
    // a second encounter.
    const getActivationById = vi
      .fn()
      .mockResolvedValueOnce(activation)
      .mockResolvedValueOnce(null);
    const ctx = makeCtx({ worldEncounter: { getActivationById } });

    const first = makeInteraction();
    await handleWorldEncounterContinue(ctx, first.interaction as never, prov, ['42']);
    const second = makeInteraction();
    await handleWorldEncounterContinue(ctx, second.interaction as never, prov, ['42']);

    expect(paintedText(second.painted)).toContain('already been consumed or expired');
  });

  it('refuses a forged continuation id belonging to another player', async () => {
    // The double models the real query: the row exists, but not for this
    // player, so the lookup answers null.
    const getActivationById = vi.fn(async (_id: number, playerId: number) =>
      playerId === OTHER_PLAYER_ID ? activation : null,
    );
    const { interaction, painted } = makeInteraction();
    await handleWorldEncounterContinue(
      makeCtx({ worldEncounter: { getActivationById } }),
      interaction as never,
      prov,
      ['9999'],
    );

    expect(paintedText(painted)).toContain('already been consumed or expired');
    expect(paintedText(painted)).not.toContain('Aftermath');
  });

  it('rejects a malformed id without calling the service', async () => {
    const getActivationById = vi.fn();
    const { interaction, painted } = makeInteraction();
    await handleWorldEncounterContinue(
      makeCtx({ worldEncounter: { getActivationById } }),
      interaction as never,
      prov,
      ['not-a-number'],
    );

    expect(getActivationById).not.toHaveBeenCalled();
    expect(paintedText(painted)).toContain('malformed');
  });
});

/* ─────────────────────── Vendor ─────────────────────── */

const VENDOR_INSTANCE = {
  id: 1,
  activeEncounterId: 42,
  vendorKey: 'wandering_merchant',
  name: 'The Wandering Merchant',
  description: 'Curiosities for travellers.',
  stock: [
    { itemSlug: 'basic_charm', quantity: 3, remaining: 3, price: 150, currency: 'waifubux' },
  ],
  closed: false,
};

describe('Open shop button', () => {
  it('paints the shop for the encounter the player actually owns', async () => {
    const getForEncounter = vi.fn(async () => VENDOR_INSTANCE);
    const { interaction, painted } = makeInteraction();
    await handleWorldEncounterVendorOpen(
      makeCtx({ worldEncounterVendor: { getForEncounter } }),
      interaction as never,
      prov,
      ['42'],
    );

    expect(getForEncounter).toHaveBeenCalledWith(PLAYER_ID, 42);
    expect(paintedText(painted)).toContain('Wandering Merchant');
  });

  it('refuses a forged encounter id belonging to another player', async () => {
    // Player scoping happens in the query, so a foreign id is simply absent —
    // the response cannot even confirm that the instance exists.
    const getForEncounter = vi.fn(async (playerId: number) =>
      playerId === OTHER_PLAYER_ID ? VENDOR_INSTANCE : null,
    );
    const { interaction, painted } = makeInteraction();
    await handleWorldEncounterVendorOpen(
      makeCtx({ worldEncounterVendor: { getForEncounter } }),
      interaction as never,
      prov,
      ['12345'],
    );

    expect(paintedText(painted)).toContain('packed up');
    expect(paintedText(painted)).not.toContain('Wandering Merchant');
  });
});

describe('Buy button', () => {
  it('never reads the price from the custom id', async () => {
    // A tampered id carrying "price=1" must not reach the service: the
    // handler forwards only (playerId, encounterId, itemSlug), and the price
    // comes from the locked instance row.
    const purchase = vi.fn(async () => ({
      itemSlug: 'basic_charm',
      quantity: 1,
      price: 150,
      currency: 'waifubux' as const,
      remaining: 2,
      balanceAfter: 850,
    }));
    const getForEncounter = vi.fn(async () => VENDOR_INSTANCE);
    const { interaction, painted } = makeInteraction();

    await handleWorldEncounterVendorBuy(
      makeCtx({ worldEncounterVendor: { purchase, getForEncounter } }),
      interaction as never,
      prov,
      ['42', 'basic_charm', '1'],
    );

    expect(purchase).toHaveBeenCalledWith(PLAYER_ID, 42, 'basic_charm');
    expect(purchase.mock.calls[0]).toHaveLength(3);
    expect(paintedText(painted)).toContain('150');
  });

  it('reports sold out rather than completing a purchase', async () => {
    const purchase = vi.fn(async () => {
      throw new AppError(
        'VENDOR_OUT_OF_STOCK',
        'sold out',
        'Sold out — check back another time.',
      );
    });
    const { interaction, painted } = makeInteraction();

    await handleWorldEncounterVendorBuy(
      makeCtx({ worldEncounterVendor: { purchase } }),
      interaction as never,
      prov,
      ['42', 'basic_charm'],
    );

    expect(paintedText(painted)).toContain('Sold out');
  });

  it('surfaces the service refusal for a forged item slug', async () => {
    const purchase = vi.fn(async () => {
      throw new AppError(
        'VENDOR_STOCK_UNAVAILABLE',
        'not stocked',
        'That item is not stocked here.',
      );
    });
    const { interaction, painted } = makeInteraction();

    await handleWorldEncounterVendorBuy(
      makeCtx({ worldEncounterVendor: { purchase } }),
      interaction as never,
      prov,
      ['42', 'mythic_contract'],
    );

    expect(paintedText(painted)).toContain('not stocked here');
  });

  it('lets the service decide a duplicate buy, and repaints the new stock', async () => {
    // The handler makes exactly one purchase call per click. Serialising two
    // rapid clicks is the vendor service's `SELECT … FOR UPDATE` job, and the
    // second click here sees the decremented row.
    const purchase = vi
      .fn()
      .mockResolvedValueOnce({
        itemSlug: 'basic_charm',
        quantity: 1,
        price: 150,
        currency: 'waifubux',
        remaining: 0,
        balanceAfter: 850,
      })
      .mockRejectedValueOnce(
        new AppError('VENDOR_OUT_OF_STOCK', 'sold out', 'Sold out — check back another time.'),
      );
    const getForEncounter = vi.fn(async () => ({
      ...VENDOR_INSTANCE,
      stock: [{ ...VENDOR_INSTANCE.stock[0], remaining: 0 }],
    }));
    const ctx = makeCtx({ worldEncounterVendor: { purchase, getForEncounter } });

    const first = makeInteraction();
    await handleWorldEncounterVendorBuy(ctx, first.interaction as never, prov, [
      '42',
      'basic_charm',
    ]);
    const second = makeInteraction();
    await handleWorldEncounterVendorBuy(ctx, second.interaction as never, prov, [
      '42',
      'basic_charm',
    ]);

    expect(purchase).toHaveBeenCalledTimes(2);
    expect(paintedText(second.painted)).toContain('Sold out');
  });

  it('rejects a malformed id without touching the service', async () => {
    const purchase = vi.fn();
    const { interaction, painted } = makeInteraction();
    await handleWorldEncounterVendorBuy(
      makeCtx({ worldEncounterVendor: { purchase } }),
      interaction as never,
      prov,
      ['nope', ''],
    );

    expect(purchase).not.toHaveBeenCalled();
    expect(paintedText(painted)).toContain('malformed');
  });
});

/* ─────────────────── Spawned wild encounter ─────────────────── */

describe('Meet-her button (spawned wild encounter)', () => {
  it('refuses an encounter id that is not this player’s', async () => {
    const getPlayerEncounter = vi.fn(async (playerId: number) =>
      playerId === OTHER_PLAYER_ID ? { encounter: {}, species: {} } : null,
    );
    const { interaction, painted } = makeInteraction();

    await handleWildEncounterOpen(
      makeCtx({ wildEncounters: { getPlayerEncounter } }),
      interaction as never,
      prov,
      ['555'],
    );

    expect(getPlayerEncounter).toHaveBeenCalledWith(PLAYER_ID, 555);
    expect(paintedText(painted)).toContain('no longer active');
  });

  it('rejects a malformed id without touching the spawner', async () => {
    const getPlayerEncounter = vi.fn();
    const { interaction, painted } = makeInteraction();

    await handleWildEncounterOpen(
      makeCtx({ wildEncounters: { getPlayerEncounter } }),
      interaction as never,
      prov,
      ['../../etc/passwd'],
    );

    expect(getPlayerEncounter).not.toHaveBeenCalled();
    expect(paintedText(painted)).toContain('no longer active');
  });

  it('degrades cleanly when the spawner is not wired', async () => {
    const { interaction, painted } = makeInteraction();
    await handleWildEncounterOpen(makeCtx({}), interaction as never, prov, ['555']);
    expect(paintedText(painted)).toContain('no longer active');
  });
});
