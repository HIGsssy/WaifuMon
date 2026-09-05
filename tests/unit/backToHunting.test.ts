/**
 * Back to Hunting — the button a hunt-origin World Encounter leaves behind.
 *
 * A hunt encounter *is* the result of a hunt that already charged its Energy
 * and stamped its cooldown, so there is nothing left to spend and nothing
 * left to roll. Before this button the resolution screen simply dead-ended;
 * the property worth pinning is that fixing that stayed navigation — no
 * second hunt, no re-roll, nothing written.
 *
 * Two halves, mirroring `continueJourney.test.ts`:
 *   - the presenter decides *when* the button appears (hunt vs travel, and
 *     terminal vs mid-chain);
 *   - the handler decides *what it does*, which must be reads and a repaint.
 *
 * Pure handlers and rendering against service doubles — no database, no
 * gateway. The doubles throw on the methods that must never be reached, so
 * "no hunt was run" is an assertion rather than an assumption.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildEncounterResolved } from '../../src/discord/worldEncounterPresenter';
import { handleHuntReturn } from '../../src/discord/commands/waifumonHunt';
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
    slug: 'hn_snared_rabbit',
    name: 'Snared Rabbit',
    description: 'Something thrashes in the brush.',
    rarity: 'common',
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
    choice: { id: 1, label: 'Cut it loose' },
    check: { chance: 1, roll: 0, success: true, breakdown: {} },
    effectsApplied: [],
    followUps: [],
    chainedEncounterSlug: null,
    continuationActiveId: null,
    vendorInstance: null,
    wildEncounter: null,
    journey: null,
    huntReturn: null,
    ...overrides,
  } as unknown as Resolution;
}

const HUNT = { regionId: 'starter-town' };
const TRAVEL = { destinationRegionId: 'twin-peeks' };

function customIds(view: { components?: readonly unknown[] | undefined }): string[] {
  return (view.components ?? []).flatMap((row) => {
    const json = (row as { toJSON: () => { components: Array<{ custom_id?: string }> } }).toJSON();
    return json.components.map((c) => c.custom_id ?? '');
  });
}

const hasHuntReturnButton = (view: { components?: readonly unknown[] | undefined }) =>
  customIds(view).some((id) => id.includes('|hunt|return|'));

/* ─────────────────── When the button appears ─────────────────── */

describe('resolved view: which exit a hunt encounter offers', () => {
  it('offers Back to Hunting after a terminal hunt encounter', () => {
    const view = buildEncounterResolved(ctx, activation, resolution({ huntReturn: HUNT }));
    expect(customIds(view)).toContain('wm|v1|hunt|return|42');
  });

  it('labels it so the player can tell what it does', () => {
    const view = buildEncounterResolved(ctx, activation, resolution({ huntReturn: HUNT }));
    const labels = (view.components ?? []).flatMap((row) => {
      const json = (row as { toJSON: () => { components: Array<{ label?: string }> } }).toJSON();
      return json.components.map((c) => c.label ?? '');
    });
    expect(labels.join(' ')).toContain('Back to Hunting');
  });

  it('prefers Continue over Back to Hunting mid-chain', () => {
    // Same precedence as Continue Journey: the chain is the story, and
    // offering both would ask the player to abandon it mid-way.
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({ huntReturn: HUNT, continuationActiveId: 99 }),
    );
    expect(customIds(view)).toContain('wm|v1|encw|continue|99');
    expect(hasHuntReturnButton(view)).toBe(false);
  });

  it('brings Back to Hunting back at the terminal node of a hunt chain', () => {
    // The continuation row copies `source` from its parent, so hunt origin
    // survives to the end of the chain.
    const chainTerminal = buildEncounterResolved(
      ctx,
      { ...activation, activeId: 99 } as EncounterActivation,
      resolution({ huntReturn: HUNT, continuationActiveId: null }),
    );
    expect(customIds(chainTerminal)).toContain('wm|v1|hunt|return|99');
  });

  it('offers Continue Journey, not Back to Hunting, for a travel encounter', () => {
    const view = buildEncounterResolved(ctx, activation, resolution({ journey: TRAVEL }));
    expect(customIds(view)).toContain('wm|v1|loc|journey|42');
    expect(hasHuntReturnButton(view)).toBe(false);
  });

  it('coexists with vendor and wild-Waifumon follow-ups', () => {
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({
        huntReturn: HUNT,
        vendorInstance: { instanceId: 3, vendorKey: 'wandering_merchant' },
        wildEncounter: {
          status: 'created',
          encounterId: 77,
          speciesSlug: 'alley_catgirl',
          speciesName: 'Alley Catgirl',
          blockedByEncounterId: null,
        },
      }),
    );
    expect(customIds(view)).toContain('wm|v1|encv|open|42');
    expect(customIds(view)).toContain('wm|v1|enc|wild|77');
    expect(customIds(view)).toContain('wm|v1|hunt|return|42');
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
  currentRegion: 'starter-town',
  currentRegionName: 'Starter Town',
  level: 10,
  waifubux: 500,
  essence: 100,
  activeEncounterId: null,
  destinations: [],
};

/**
 * Doubles for everything the Hunt screen can reach. `hunt.hunt` is the method
 * that must never be called — it is the one that spends Energy, stamps the
 * cooldown, and rolls both a find and a fresh world encounter. `setHuntEnergy`
 * and `spendWaifubux` stand in for "any write at all".
 */
function huntDoubles() {
  const getBalances = vi.fn(async () => ({ huntEnergy: 12, waifubux: 500, essence: 100 }));
  return {
    getBalances,
    services: {
      travel: {
        getStatus: vi.fn(async () => STATUS),
        getCurrentRegion: vi.fn(async () => 'starter-town'),
        travel: vi.fn(async () => {
          throw new Error('travel() must never be called by Back to Hunting');
        }),
      },
      currency: {
        getBalances,
        setHuntEnergy: vi.fn(async () => {
          throw new Error('setHuntEnergy() must never be called by Back to Hunting');
        }),
        spendWaifubux: vi.fn(async () => {
          throw new Error('spendWaifubux() must never be called by Back to Hunting');
        }),
      },
      hunt: {
        hunt: vi.fn(async () => {
          throw new Error('hunt() must never be called by Back to Hunting');
        }),
        getActiveEncounter: vi.fn(async () => null),
      },
      session: {
        ensureSession: vi.fn(async () => {
          throw new Error('ensureSession() must never be called by Back to Hunting');
        }),
      },
    },
  };
}

function makeCtx(services: Record<string, unknown>): AppContext {
  return {
    config: { assetsDir: './assets' },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    getContent: () => ({ regions: [] }),
    services,
  } as unknown as AppContext;
}

describe('Back to Hunting handler', () => {
  it('repaints the Hunt screen from live player state', async () => {
    const d = huntDoubles();
    const getHuntReturnContext = vi.fn(async () => HUNT);
    const { interaction, painted } = makeInteraction();

    await handleHuntReturn(
      makeCtx({ ...d.services, worldEncounter: { getHuntReturnContext } }),
      interaction as never,
      prov,
      ['42'],
    );

    // Ownership is proven from the session, never from the button.
    expect(getHuntReturnContext).toHaveBeenCalledWith(42, PLAYER_ID);
    // The screen is built from the player's current row, not the button.
    expect(d.services.travel.getStatus).toHaveBeenCalledWith(PLAYER_ID);
    expect(d.getBalances).toHaveBeenCalledWith(PLAYER_ID);
    const text = paintedText(painted);
    expect(text).toContain('Starter Town');
    expect(text).toContain('12'); // energy, unchanged
    // The way back into the normal flow is the ordinary Hunt button.
    expect(customIds(painted[0] as { components?: readonly unknown[] })).toContain(
      'wm|v1|menu|hunt',
    );
  });

  it('does not run a hunt: no Energy, no roll, no cooldown', async () => {
    const d = huntDoubles();
    const { interaction } = makeInteraction();

    await handleHuntReturn(
      makeCtx({ ...d.services, worldEncounter: { getHuntReturnContext: async () => HUNT } }),
      interaction as never,
      prov,
      ['42'],
    );

    expect(d.services.hunt.hunt).not.toHaveBeenCalled();
    expect(d.services.currency.setHuntEnergy).not.toHaveBeenCalled();
    expect(d.services.currency.spendWaifubux).not.toHaveBeenCalled();
    expect(d.services.travel.travel).not.toHaveBeenCalled();
    expect(d.services.session.ensureSession).not.toHaveBeenCalled();
  });

  it('does not re-roll a world encounter', async () => {
    const d = huntDoubles();
    // A world-encounter service whose *rolling* methods explode: reaching
    // either would mean the return path could hand the player a second
    // encounter.
    const worldEncounter = {
      getHuntReturnContext: vi.fn(async () => HUNT),
      tryRollForHunt: vi.fn(async () => {
        throw new Error('tryRollForHunt() must never be called by Back to Hunting');
      }),
      tryRollForTravel: vi.fn(async () => {
        throw new Error('tryRollForTravel() must never be called by Back to Hunting');
      }),
      resolveChoice: vi.fn(async () => {
        throw new Error('resolveChoice() must never be called by Back to Hunting');
      }),
    };
    const { interaction } = makeInteraction();

    await handleHuntReturn(
      makeCtx({ ...d.services, worldEncounter }),
      interaction as never,
      prov,
      ['42'],
    );

    expect(worldEncounter.tryRollForHunt).not.toHaveBeenCalled();
    expect(worldEncounter.tryRollForTravel).not.toHaveBeenCalled();
    expect(worldEncounter.resolveChoice).not.toHaveBeenCalled();
  });

  it('is safe to click repeatedly', async () => {
    const d = huntDoubles();
    const c = makeCtx({
      ...d.services,
      worldEncounter: { getHuntReturnContext: async () => HUNT },
    });

    for (let i = 0; i < 3; i++) {
      const { interaction } = makeInteraction();
      await handleHuntReturn(c, interaction as never, prov, ['42']);
    }

    // Three clicks, three reads, zero writes.
    expect(d.services.travel.getStatus).toHaveBeenCalledTimes(3);
    expect(d.services.hunt.hunt).not.toHaveBeenCalled();
  });

  it('answers a stale encounter id with a friendly message', async () => {
    const d = huntDoubles();
    const getHuntReturnContext = vi.fn(async () => null);
    const { interaction, painted } = makeInteraction();

    await handleHuntReturn(
      makeCtx({ ...d.services, worldEncounter: { getHuntReturnContext } }),
      interaction as never,
      prov,
      ['42'],
    );

    expect(paintedText(painted)).toContain('expired');
    expect(d.services.travel.getStatus).not.toHaveBeenCalled();
    expect(d.services.hunt.hunt).not.toHaveBeenCalled();
  });

  it('refuses another player’s encounter id with the same message', async () => {
    const d = huntDoubles();
    // Models the real lookup: the row exists, but not for this player.
    const getHuntReturnContext = vi.fn(async (_id: number, playerId: number) =>
      playerId === OTHER_PLAYER_ID ? HUNT : null,
    );
    const { interaction, painted } = makeInteraction();

    await handleHuntReturn(
      makeCtx({ ...d.services, worldEncounter: { getHuntReturnContext } }),
      interaction as never,
      prov,
      ['9999'],
    );

    expect(paintedText(painted)).toContain('expired');
    expect(d.services.travel.getStatus).not.toHaveBeenCalled();
  });

  it('refuses a travel-origin id with the same message', async () => {
    const d = huntDoubles();
    // The real `getHuntReturnContext` returns null for `source !== 'hunt'`,
    // so a travel encounter's id is indistinguishable from a forged one.
    const getHuntReturnContext = vi.fn(async () => null);
    const { interaction, painted } = makeInteraction();

    await handleHuntReturn(
      makeCtx({ ...d.services, worldEncounter: { getHuntReturnContext } }),
      interaction as never,
      prov,
      ['42'],
    );

    expect(paintedText(painted)).toContain('expired');
    expect(d.services.travel.getStatus).not.toHaveBeenCalled();
  });

  it('rejects a malformed id without touching any service', async () => {
    const d = huntDoubles();
    const getHuntReturnContext = vi.fn();
    const { interaction, painted } = makeInteraction();

    await handleHuntReturn(
      makeCtx({ ...d.services, worldEncounter: { getHuntReturnContext } }),
      interaction as never,
      prov,
      ['../../etc/passwd'],
    );

    expect(getHuntReturnContext).not.toHaveBeenCalled();
    expect(d.services.travel.getStatus).not.toHaveBeenCalled();
    expect(paintedText(painted)).toContain('expired');
  });
});
