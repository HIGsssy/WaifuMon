/**
 * Continue Journey — the button a travel encounter leaves behind.
 *
 * A travel encounter interrupts a journey whose destination was **already
 * committed**: `handleLocationTravel` calls `travelService.travel()` and only
 * then rolls for an encounter. So resuming the journey is navigation, and the
 * property worth pinning is that it stays navigation — no second travel
 * transaction, no re-roll, nothing charged, nothing moved.
 *
 * Two halves:
 *   - the presenter decides *when* the button appears (travel vs hunt, and
 *     terminal vs mid-chain);
 *   - the handler decides *what it does*, which must be a read and a repaint.
 *
 * Pure handlers and rendering against service doubles — no database, no
 * gateway. The doubles throw on any method that is not stubbed, so "travel was
 * never called" is an assertion rather than an assumption.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildEncounterResolved } from '../../src/discord/worldEncounterPresenter';
import { handleContinueJourney } from '../../src/discord/commands/waifumonLocations';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type {
  EncounterActivation,
  Resolution,
} from '../../src/modules/worldEncounters/worldEncounterService';

const PLAYER_ID = 7;
const OTHER_PLAYER_ID = 8;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;

const ctx = { config: { assetsDir: './assets' } } as unknown as AppContext;

const activation = {
  activeId: 42,
  encounter: {
    id: 1,
    slug: 'tv_bandit_ambush',
    name: 'Bandit Ambush',
    description: 'Rough company on the road.',
    rarity: 'uncommon',
    artworkPath: null,
    choices: [],
  },
  buddy: null,
  buddyBonusPercent: 0,
  choiceViews: [],
} as unknown as EncounterActivation;

function resolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    encounter: activation.encounter,
    choice: { id: 1, label: 'Fight' },
    check: { chance: 1, roll: 0, success: true, breakdown: {} },
    effectsApplied: [],
    followUps: [],
    chainedEncounterSlug: null,
    continuationActiveId: null,
    vendorInstance: null,
    wildEncounter: null,
    journey: null,
    ...overrides,
  } as unknown as Resolution;
}

const TRAVEL = { destinationRegionId: 'twin-peeks' };

function customIds(view: { components?: readonly unknown[] | undefined }): string[] {
  return (view.components ?? []).flatMap((row) => {
    const json = (row as { toJSON: () => { components: Array<{ custom_id?: string }> } }).toJSON();
    return json.components.map((c) => c.custom_id ?? '');
  });
}

const hasJourneyButton = (view: { components?: readonly unknown[] | undefined }) =>
  customIds(view).some((id) => id.includes('|loc|journey|'));

/* ─────────────────── When the button appears ─────────────────── */

describe('resolved view: which continuation the encounter offers', () => {
  it('offers Continue Journey after a terminal travel encounter', () => {
    const view = buildEncounterResolved(ctx, activation, resolution({ journey: TRAVEL }));
    expect(customIds(view)).toContain('wm|v1|loc|journey|42');
  });

  it('offers nothing of the sort after a hunt encounter', () => {
    // A hunt encounter has no journey to resume; its normal navigation is the
    // hunt screen's own.
    const view = buildEncounterResolved(ctx, activation, resolution({ journey: null }));
    expect(hasJourneyButton(view)).toBe(false);
  });

  it('prefers Continue over Continue Journey mid-chain', () => {
    // The chain is the story; the journey is the frame around it. Offering
    // both would ask the player to choose between finishing one and the other.
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({ journey: TRAVEL, continuationActiveId: 99 }),
    );
    expect(customIds(view)).toContain('wm|v1|encw|continue|99');
    expect(hasJourneyButton(view)).toBe(false);
  });

  it('brings Continue Journey back when the chain finally resolves', () => {
    // The continuation row copies `source` and both region columns from its
    // parent, so the travel context survives to the end of the chain.
    const chainTerminal = buildEncounterResolved(
      ctx,
      { ...activation, activeId: 99 } as EncounterActivation,
      resolution({ journey: TRAVEL, continuationActiveId: null }),
    );
    expect(customIds(chainTerminal)).toContain('wm|v1|loc|journey|99');
  });

  it('shows Continue Journey alongside a vendor at a terminal resolution', () => {
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({
        journey: TRAVEL,
        vendorInstance: { instanceId: 3, vendorKey: 'wandering_merchant' },
      }),
    );
    expect(customIds(view)).toContain('wm|v1|encv|open|42');
    expect(customIds(view)).toContain('wm|v1|loc|journey|42');
  });
});

/* ─────────────────── What the button does ─────────────────── */

function makeInteraction() {
  const painted: unknown[] = [];
  const record = vi.fn(async (body: unknown) => {
    painted.push(body);
  });
  return {
    painted,
    interaction: {
      replied: false,
      deferred: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      update: record,
      reply: record,
      editReply: record,
      followUp: record,
    },
  };
}

function paintedText(painted: unknown[]): string {
  return painted
    .map((p) => {
      const body = p as { content?: string; embeds?: unknown[] };
      return [body.content ?? '', JSON.stringify(body.embeds ?? [])].join(' ');
    })
    .join('\n');
}

const STATUS = {
  enabled: true,
  currentRegion: 'twin-peeks',
  currentRegionName: 'Twin Peeks',
  level: 10,
  waifubux: 500,
  essence: 100,
  activeEncounterId: null,
  destinations: [],
};

/**
 * A travel service where every mutating method blows up. `travel` and
 * `purchase` are the ones that must never be reached — a Continue Journey that
 * called either would charge the player twice.
 */
function travelDouble(getStatus = vi.fn(async () => STATUS)) {
  return {
    getStatus,
    travel: vi.fn(async () => {
      throw new Error('travel() must never be called by Continue Journey');
    }),
    purchase: vi.fn(async () => {
      throw new Error('purchase() must never be called by Continue Journey');
    }),
    getCurrentRegion: vi.fn(async () => 'twin-peeks'),
  };
}

function makeCtx(services: Record<string, unknown>): AppContext {
  return {
    config: { assetsDir: './assets' },
    getContent: () => ({ regions: [] }),
    services,
  } as unknown as AppContext;
}

describe('Continue Journey handler', () => {
  it('repaints the arrival screen without re-running travel', async () => {
    const travel = travelDouble();
    const getJourneyContext = vi.fn(async () => TRAVEL);
    const { interaction, painted } = makeInteraction();

    await handleContinueJourney(
      makeCtx({ travel, worldEncounter: { getJourneyContext } }),
      interaction as never,
      prov,
      ['42'],
    );

    // Ownership is proven from the session, never from the button.
    expect(getJourneyContext).toHaveBeenCalledWith(42, PLAYER_ID);
    // The whole point: no travel transaction, no re-roll, no movement.
    expect(travel.travel).not.toHaveBeenCalled();
    expect(travel.purchase).not.toHaveBeenCalled();
    expect(travel.getStatus).toHaveBeenCalledWith(PLAYER_ID);
    expect(paintedText(painted)).toContain('Twin Peeks');
  });

  it('is safe to click repeatedly', async () => {
    const travel = travelDouble();
    const getJourneyContext = vi.fn(async () => TRAVEL);
    const c = makeCtx({ travel, worldEncounter: { getJourneyContext } });

    for (let i = 0; i < 3; i++) {
      const { interaction } = makeInteraction();
      await handleContinueJourney(c, interaction as never, prov, ['42']);
    }

    // Three clicks, three reads, zero writes.
    expect(travel.getStatus).toHaveBeenCalledTimes(3);
    expect(travel.travel).not.toHaveBeenCalled();
  });

  it('answers a stale encounter id with a friendly message, not a journey', async () => {
    const travel = travelDouble();
    const getJourneyContext = vi.fn(async () => null);
    const { interaction, painted } = makeInteraction();

    await handleContinueJourney(
      makeCtx({ travel, worldEncounter: { getJourneyContext } }),
      interaction as never,
      prov,
      ['42'],
    );

    expect(paintedText(painted)).toContain('already moved on');
    expect(travel.travel).not.toHaveBeenCalled();
    expect(travel.getStatus).not.toHaveBeenCalled();
  });

  it('refuses another player’s encounter id', async () => {
    const travel = travelDouble();
    // Models the real lookup: the row exists, but not for this player.
    const getJourneyContext = vi.fn(async (_id: number, playerId: number) =>
      playerId === OTHER_PLAYER_ID ? TRAVEL : null,
    );
    const { interaction, painted } = makeInteraction();

    await handleContinueJourney(
      makeCtx({ travel, worldEncounter: { getJourneyContext } }),
      interaction as never,
      prov,
      ['9999'],
    );

    expect(paintedText(painted)).toContain('already moved on');
    expect(travel.getStatus).not.toHaveBeenCalled();
  });

  it('rejects a malformed id without touching any service', async () => {
    const travel = travelDouble();
    const getJourneyContext = vi.fn();
    const { interaction, painted } = makeInteraction();

    await handleContinueJourney(
      makeCtx({ travel, worldEncounter: { getJourneyContext } }),
      interaction as never,
      prov,
      ['../../etc/passwd'],
    );

    expect(getJourneyContext).not.toHaveBeenCalled();
    expect(travel.getStatus).not.toHaveBeenCalled();
    expect(paintedText(painted)).toContain('already moved on');
  });
});
