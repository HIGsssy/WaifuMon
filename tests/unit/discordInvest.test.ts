/**
 * `handleWaifuInvest` — Discord interaction lifecycle.
 *
 * Regression for the intermittent "Something went wrong, nothing was consumed"
 * button error. The handler used to call `interaction.followUp()` on an
 * un-replied ButtonInteraction whenever the investment produced a level-up,
 * which threw `InteractionNotReplied` and routed through the outer error
 * boundary — after the essence transaction had already committed. The message
 * shown to the player therefore contradicted the actual DB state.
 *
 * The tests below drive the handler with fake services (no DB) and a fake
 * interaction that models Discord's own lifecycle rules, so we can assert the
 * order and shape of the calls the handler makes without spinning up Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import { InsufficientEssenceError, WaifuNotOwnedError } from '../../src/shared/errors';
import { handleWaifuInvest } from '../../src/discord/commands/waifumonCollection';
import { silentLogger } from '../helpers/testDb';

interface CallLog {
  order: string[];
}

/**
 * A minimal ButtonInteraction that follows Discord's own state machine: a
 * successful `deferUpdate` sets `deferred = true`; a subsequent `editReply`
 * flips it to `replied = true`; `followUp` is only legal once one of those has
 * happened. That is the exact invariant the fix relies on, and the exact
 * invariant the old code violated.
 */
function makeInteraction(log: CallLog) {
  const state = { replied: false, deferred: false };
  return {
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    isButton: () => true,
    isStringSelectMenu: () => false,
    deferUpdate: vi.fn(async () => {
      log.order.push('deferUpdate');
      state.deferred = true;
    }),
    update: vi.fn(async () => {
      log.order.push('update');
      // `update` on a component ack — no follow-on reply state change matters
      // for these tests; anything that leans on it fails the test outright.
      state.replied = true;
    }),
    editReply: vi.fn(async () => {
      log.order.push('editReply');
      state.replied = true;
    }),
    reply: vi.fn(async () => {
      log.order.push('reply');
      state.replied = true;
    }),
    followUp: vi.fn(async () => {
      log.order.push('followUp');
      if (!state.replied && !state.deferred) {
        // Matches discord.js's own behaviour so a test hitting the old bug
        // fails loudly here rather than passing on a silent mock.
        throw new Error('InteractionNotReplied');
      }
    }),
  };
}

/**
 * The other half of the setup: a ctx just complete enough for
 * `handleWaifuInvest` and the `renderInspect` it re-renders on completion.
 * Nothing in here writes to disk, hits the DB, or talks to Discord — all IO
 * is replaced by counters and vi.fn stubs.
 */
function makeCtx(overrides: {
  investEssence: (playerId: number, waifuId: number) => Promise<{
    fromLevel: number;
    toLevel: number;
    waifu: { id: number; playerId: number; level: number };
  }>;
}) {
  const speciesRow = {
    id: 1,
    slug: 'test_subject',
    name: 'Test Subject',
    rarity: 'SR',
    archetype: 'demon',
    description: 'stub',
    imagePath: 'waifumon/test_subject/standard.png',
    affinity: 'primal',
  };
  const waifuRow = {
    id: 42,
    playerId: 1,
    speciesId: 1,
    level: 6,
    xp: 400,
    variant: 'standard',
    affection: 0,
    nickname: null,
    isFavorite: false,
    releasedAt: null,
    caughtAt: new Date('2026-01-01T00:00:00Z'),
    seenAppearances: [],
  };
  const entry = { waifu: waifuRow, species: speciesRow };

  const investEssence = vi.fn(overrides.investEssence);
  const getOwned = vi.fn(async () => entry);

  return {
    ctx: {
      config: {
        assetsDir: '/tmp/waifumon-nonexistent-assets',
        platformApi: { cardRendererEnabled: false },
      },
      logger: silentLogger(),
      content: {
        tables: {
          duplicate: { essenceByRarity: { SR: 5 } },
          waifuProgression: {
            nicknameMinLevel: 10,
            essenceInvestment: { essenceCost: 50, xpGranted: 200 },
          },
        },
      },
      services: {
        collection: {
          investEssence,
          getOwned,
          hasOtherActiveCopies: vi.fn(async () => false),
          getBuddy: vi.fn(async () => null),
          waifuProgress: vi.fn(() => ({
            atMaxLevel: false,
            xpIntoLevel: 0,
            xpToNext: 100,
          })),
        },
        quests: {
          recordQuestEvent: vi.fn(async () => undefined),
        },
        appearance: {
          catalogFor: vi.fn(() => [
            { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
          ]),
          currentAppearance: vi.fn(() => ({
            id: 'standard',
            name: 'Standard',
            assetId: { kind: 'waifumon', slug: 'test_subject', variant: 'standard' },
          })),
        },
      },
    },
    investEssence,
    getOwned,
    entry,
    waifuRow,
    speciesRow,
  };
}

const PROV = { guildDbId: 1, playerId: 1 };

describe('handleWaifuInvest — interaction lifecycle', () => {
  it('acks the button before the transaction so a level-up can followUp safely', async () => {
    const log: CallLog = { order: [] };
    const interaction = makeInteraction(log);
    const { ctx, investEssence } = makeCtx({
      investEssence: async () => ({
        fromLevel: 6,
        toLevel: 7,
        waifu: { id: 42, playerId: 1, level: 7 },
      }),
    });

    await handleWaifuInvest(ctx as never, interaction as never, PROV, ['42']);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(investEssence).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    // deferUpdate must precede everything the transaction and the followUp do.
    expect(log.order[0]).toBe('deferUpdate');
    const investIdx = log.order.indexOf('deferUpdate');
    const followUpIdx = log.order.indexOf('followUp');
    expect(followUpIdx).toBeGreaterThan(investIdx);
  });

  it('does not followUp when the investment does not level her up', async () => {
    const log: CallLog = { order: [] };
    const interaction = makeInteraction(log);
    const { ctx, investEssence } = makeCtx({
      investEssence: async () => ({
        fromLevel: 6,
        toLevel: 6,
        waifu: { id: 42, playerId: 1, level: 6 },
      }),
    });

    await handleWaifuInvest(ctx as never, interaction as never, PROV, ['42']);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(investEssence).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('reports InsufficientEssenceError without a followUp and without a second invest attempt', async () => {
    const log: CallLog = { order: [] };
    const interaction = makeInteraction(log);
    const { ctx, investEssence } = makeCtx({
      investEssence: async () => {
        throw new InsufficientEssenceError(50, 10);
      },
    });

    await expect(
      handleWaifuInvest(ctx as never, interaction as never, PROV, ['42']),
    ).resolves.toBeUndefined();

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(investEssence).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
    // Deferred → error is surfaced via editReply (respondEphemeral's choice).
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });

  it('reports WaifuNotOwnedError cleanly and never invests twice', async () => {
    const log: CallLog = { order: [] };
    const interaction = makeInteraction(log);
    const { ctx, investEssence } = makeCtx({
      investEssence: async () => {
        throw new WaifuNotOwnedError(42);
      },
    });

    await expect(
      handleWaifuInvest(ctx as never, interaction as never, PROV, ['42']),
    ).resolves.toBeUndefined();

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(investEssence).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('rejects a non-integer waifu id before touching the interaction or the DB', async () => {
    const log: CallLog = { order: [] };
    const interaction = makeInteraction(log);
    const { ctx, investEssence } = makeCtx({
      investEssence: async () => {
        throw new Error('should not be reached');
      },
    });

    await handleWaifuInvest(ctx as never, interaction as never, PROV, ['not-a-number']);

    expect(investEssence).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('spends essence exactly once per handler call, regardless of downstream failure', async () => {
    // Force `renderInspect` to fail after the transaction. The old handler
    // would have re-attempted (there was no retry, but the point is: nothing in
    // the new code shape re-runs the transaction on failure). This test locks
    // that in.
    const log: CallLog = { order: [] };
    const interaction = makeInteraction(log);
    const { ctx, investEssence, getOwned } = makeCtx({
      investEssence: async () => ({
        fromLevel: 6,
        toLevel: 7,
        waifu: { id: 42, playerId: 1, level: 7 },
      }),
    });
    // First call inside `renderInspect` — throw to simulate a downstream failure
    // after the transaction has committed. Later calls (the level-up display)
    // must never happen if renderInspect failed first.
    let ownedCalls = 0;
    getOwned.mockImplementation(async () => {
      ownedCalls += 1;
      if (ownedCalls === 1) throw new Error('downstream failure after commit');
      return { waifu: { id: 42, playerId: 1, level: 7 }, species: { name: 'Test Subject' } } as never;
    });

    await expect(
      handleWaifuInvest(ctx as never, interaction as never, PROV, ['42']),
    ).rejects.toThrow('downstream failure after commit');

    expect(investEssence).toHaveBeenCalledTimes(1);
  });
});
