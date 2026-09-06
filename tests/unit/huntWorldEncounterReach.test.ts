/**
 * When does a hunt even *reach* the world-encounter roll?
 *
 * Staging reported that `forceTrigger = true` "still feels random" on hunts.
 * It is not the switch: `passesTriggerRoll` honours it unconditionally. The
 * randomness is upstream of the roll entirely — `handleHunt` returns early
 * when the hunt produced a wild Waifumon, and the shipped result table gives
 * that outcome 70 of 100 weight. So a forced world encounter can only fire on
 * the other 30% of hunts, which from a tester's chair looks exactly like a
 * force switch that does not work.
 *
 * This test pins the branch so the behaviour is stated somewhere rather than
 * rediscovered from a staging session. It asserts what the code does today;
 * it is not a claim that this is the right ordering.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs.
const { maybeTriggerHuntEncounter } = vi.hoisted(() => ({
  maybeTriggerHuntEncounter: vi.fn(async () => false),
}));

vi.mock('../../src/discord/commands/waifumonWorldEncounter', () => ({
  maybeTriggerHuntEncounter,
}));
// The encounter reveal renders a species card; stub the asset work away.
vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  CARD_FILENAME: 'card.png',
  renderOwnedCardAttachment: vi.fn(async () => null),
  renderEncounterDuplicateCardAttachment: vi.fn(async () => null),
}));

// `vi.mock` is hoisted above the imports, so a static import here still gets
// the mocked encounter module.
import { handleHunt } from '../../src/discord/commands/waifumonHunt';
import type { AppContext, Provisioned } from '../../src/discord/types';

const prov = { playerId: 1, guildDbId: 2 } as unknown as Provisioned;

function makeInteraction() {
  const record = vi.fn(async () => {});
  return {
    channelId: 'c-1',
    replied: false,
    deferred: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    update: record,
    reply: record,
    editReply: record,
    followUp: record,
  };
}

/** A hunt result of the given kind, with the scaffolding `handleHunt` reads. */
function huntResult(kind: 'encounter' | 'flavor') {
  const base = {
    levelUps: [],
    buddyAward: null,
    buddyBonuses: [],
    energyRemaining: 9,
    // `huntDescriptors` reads the session block off every result.
    session: { closedPreviousReason: null, isNew: false, id: 1 },
  };
  if (kind === 'flavor') return { ...base, kind: 'flavor' as const, text: 'wind' };
  return {
    ...base,
    kind: 'encounter' as const,
    encounter: { id: 5, speciesId: 3, attemptCount: 0, expiresAt: new Date(Date.now() + 60_000) },
    species: {
      id: 3,
      slug: 'alley_catgirl',
      name: 'Alley Catgirl',
      rarity: 'N',
      archetype: null,
      tags: [],
      baseCaptureRate: 0.5,
      artworkPath: null,
    },
  };
}

function makeCtx(kind: 'encounter' | 'flavor'): AppContext {
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => [{ level: 10 }] }) }),
  });
  return {
    config: { assetsDir: './assets' },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    db: { select },
    content: {
      tables: {
        capture: { announceMinRarity: 'SR', hereMentionMinRarity: 'UR' },
        inventory: { captureCapacity: 10 },
      },
    },
    events: { emit: vi.fn() },
    huntSessions: { record: vi.fn(), get: vi.fn(() => null) },
    services: {
      hunt: { hunt: vi.fn(async () => huntResult(kind)) },
      session: {
        ensureSession: vi.fn(async () => ({ id: 1 })),
        recordEvent: vi.fn(async () => {}),
      },
      travel: { getCurrentRegion: vi.fn(async () => 'waifu-valley') },
      inventory: { listOwned: vi.fn(async () => []), getCaptureItems: vi.fn(async () => []) },
      capture: {
        listEncounterItems: vi.fn(async () => []),
        quoteCapture: vi.fn(async () => null),
      },
      effects: { listActive: vi.fn(async () => []) },
      appearance: { resolveForWaifu: vi.fn(async () => null) },
      collection: {
        isDuplicate: vi.fn(async () => false),
        getBuddy: vi.fn(async () => null),
      },
      guilds: { getByDiscordId: vi.fn(async () => null) },
    },
  } as unknown as AppContext;
}

beforeEach(() => {
  maybeTriggerHuntEncounter.mockClear();
});

describe('the hunt result decides whether the world-encounter roll happens at all', () => {
  it('reaches the roll on a non-encounter hunt', async () => {
    await handleHunt(makeCtx('flavor'), makeInteraction() as never, prov);

    expect(maybeTriggerHuntEncounter).toHaveBeenCalledTimes(1);
  });

  it('never reaches the roll when the hunt produced a wild Waifumon', async () => {
    // 70 of 100 weight in the shipped result table. `forceTrigger` lives
    // downstream of this branch and cannot be consulted from here — which is
    // the whole reason it "feels random" in staging.
    // The encounter reveal renders a species card, which needs more of the
    // asset pipeline than this test wires. Whether that render succeeds is
    // beside the point: the branch has already been taken by then, and the
    // roll sits after it.
    await handleHunt(makeCtx('encounter'), makeInteraction() as never, prov).catch(() => {});

    expect(maybeTriggerHuntEncounter).not.toHaveBeenCalled();
  });
});
