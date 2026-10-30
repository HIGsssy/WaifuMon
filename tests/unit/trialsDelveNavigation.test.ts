/**
 * Navigation for Equipment → Combat Trials → Delve: which entries the main
 * menu, the onboarding completion screen and the Trial result screen offer,
 * and that every row they draw stays a valid Discord action row. The
 * decisions themselves (`entryVisible`) are exercised against a real database
 * in `tests/integration/trialsDelveProgression.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildFightResult,
  buildTrialList,
  completedTrialsView,
  ctId,
  DELVE_UNLOCKED_TITLE,
} from '../../src/discord/combatTrialPresenter';
import { dgId, delveLockedView } from '../../src/discord/dungeonPresenter';
import {
  combatTrialsLegendLine,
  dungeonLegendLine,
  handleMenuStart,
  menuComponents,
} from '../../src/discord/commands/waifumon';
import { buildOnboardingView } from '../../src/discord/onboardingPresenter';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type { CombatTrialAttemptView, CombatTrialFightOutcome } from '../../src/modules/combatTrials/combatTrialService';
import { COMBAT_TRIAL_CURRICULUM } from '../../src/modules/combatTrials/trialCurriculum';
import { CombatTrialDefinitionSchema } from '../../src/modules/combat/trialDefinitions';
import { ZERO_COMBAT_MODIFIERS } from '../../src/modules/combat/combatMath';
import { assembleCombatStats } from '../../src/modules/equipment/equipmentMath';
import type { EquipmentOnboardingView } from '../../src/modules/onboarding/equipmentOnboardingService';
import { mapAppErrorToStatus } from '../../src/api/errors';
import { CombatTrialsCompletedError, DelveLockedError } from '../../src/shared/errors';
import { loadShippedContent } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

interface ButtonJson {
  custom_id?: string;
  label?: string;
}
type Rows = readonly { toJSON(): { components: unknown[] } }[];
const buttonsOf = (rows: Rows) => rows.flatMap((r) => r.toJSON().components as ButtonJson[]);
/** Every row holds one to five components: Discord refuses anything else. */
function expectValidRows(rows: Rows) {
  for (const row of rows) {
    const n = row.toJSON().components.length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(5);
  }
}

describe('main menu entries', () => {
  const care = { active: false, enabled: true, currentEnergy: 5 } as never;
  const busy = { active: true, enabled: true, currentEnergy: 5 } as never;
  const ids = (c: never, trials: boolean, delve: boolean) =>
    buttonsOf(menuComponents(c, true, 'available', trials, delve)).map((b) => b.custom_id);

  it.each([
    [true, false, 'Stage B: Trials only'],
    [false, true, 'Stage C: Delve only'],
    [false, false, 'Stage C with no dungeon here: neither'],
    [true, true, 'an optional Trial left and a dungeon here: both'],
  ] as const)('trials=%s delve=%s (%s)', (trials, delve, _stage) => {
    for (const c of [care, busy]) {
      expect(ids(c, trials, delve).includes(ctId.home(0))).toBe(trials);
      expect(ids(c, trials, delve).includes(dgId.home())).toBe(delve);
      expectValidRows(menuComponents(c, true, 'available', trials, delve));
    }
    expect(combatTrialsLegendLine('available', trials) !== '').toBe(trials);
    expect(dungeonLegendLine('available', delve) !== '').toBe(delve);
  });

  it('neither entry shows before Equipment is unlocked, whatever the services say', () => {
    for (const entry of ['hidden', 'begin', 'resume'] as const) {
      const menu = buttonsOf(menuComponents(care, true, entry, true, true)).map((b) => b.custom_id);
      expect(menu).not.toContain(ctId.home(0));
      expect(menu).not.toContain(dgId.home());
    }
  });
});

describe('the main menu asks the services on every paint', () => {
  function ctx(trials: () => Promise<boolean>, delve: () => Promise<boolean>) {
    const warn = vi.fn();
    const services = {
      care: { applyPending: vi.fn(async () => ({ ticksProcessed: 0, stopped: false })), getState: vi.fn(async () => ({ active: false, enabled: false, currentEnergy: 5 })) },
      travel: { getCurrentRegion: vi.fn(async () => 'waifu-valley') },
      quests: { config: { enabled: false } },
      gifts: { listPendingGifts: vi.fn(async () => []) },
      equipmentOnboarding: { getState: vi.fn(async () => ({ entry: 'available' })), content: () => null },
      combatTrials: { entryVisible: vi.fn(trials) },
      dungeonRuns: { entryVisible: vi.fn(delve) },
    };
    const c = {
      config: {},
      logger: { ...silentLogger(), warn },
      content: { regions: [], tables: {} },
      services,
    } as unknown as AppContext;
    return { c, services, warn };
  }
  async function paint(c: AppContext) {
    const painted: { components: Rows }[] = [];
    const i = { replied: false, deferred: false, isButton: () => true, isChatInputCommand: () => false, update: vi.fn(async (b: never) => void painted.push(b)), reply: vi.fn(async (b: never) => void painted.push(b)) };
    await handleMenuStart(c, i as never, { playerId: 7, guildDbId: 1 } as Provisioned);
    return buttonsOf(painted.at(-1)!.components).map((b) => b.custom_id);
  }

  it('offers exactly what entryVisible says, for this player', async () => {
    const stageB = ctx(async () => true, async () => false);
    expect(await paint(stageB.c)).toContain(ctId.home(0));
    expect(await paint(stageB.c)).not.toContain(dgId.home());
    expect(stageB.services.combatTrials.entryVisible).toHaveBeenCalledWith(7);

    const stageC = ctx(async () => false, async () => true);
    const menu = await paint(stageC.c);
    expect(menu).not.toContain(ctId.home(0));
    expect(menu).toContain(dgId.home());
  });

  it('a failing read hides that entry and keeps the menu', async () => {
    const broken = ctx(async () => { throw new Error('db down'); }, async () => true);
    const menu = await paint(broken.c);
    expect(menu).not.toContain(ctId.home(0));
    expect(menu).toContain(dgId.home());
    expect(broken.warn).toHaveBeenCalledOnce();
  });
});

describe('Trial screens around the final clear', () => {
  const T3 = CombatTrialDefinitionSchema.parse({ key: COMBAT_TRIAL_CURRICULUM[2], name: 'Trial 3', description: 'x', enemyKey: 'e', enabled: true, order: 30 });
  const side = { name: 'A', attack: 1, defense: 0, maxHp: 10, remainingHp: 5, modifiers: { ...ZERO_COMBAT_MODIFIERS } };
  const attempt: CombatTrialAttemptView = {
    id: 1, trialKey: T3.key, enemyKey: 'e', result: 'player_victory', endReason: 'defeat', rounds: 1, actions: 1, buddyWaifuId: 1,
    player: side, enemy: { ...side, remainingHp: 0 }, firstClear: true, rewards: null, events: [], combatSeed: 1,
    startedAt: new Date(), completedAt: new Date(),
  };
  const outcome = (over: Partial<CombatTrialFightOutcome>): CombatTrialFightOutcome => ({
    attempt, replayed: false, trial: T3, canFightAgain: true, trialsOpen: true, completedCurriculum: false, ...over,
  });
  const labels = (p: { components?: unknown }) => buttonsOf(p.components as unknown as Rows).map((b) => b.label);

  it('the clear that completes the curriculum announces Delve and offers only the way out', () => {
    const payload = buildFightResult(outcome({ canFightAgain: false, trialsOpen: false, completedCurriculum: true }), { againNonce: 'abcdefgh', itemName: (s) => s });
    const fields = (payload.embeds![0] as { toJSON(): { fields?: { name: string }[] } }).toJSON().fields ?? [];
    expect(fields.map((f) => f.name)).toContain(DELVE_UNLOCKED_TITLE);
    expect(labels(payload)).toEqual(['Back to Waifumon']);
    expectValidRows(payload.components as unknown as Rows);
  });

  it('with optional Trials left it keeps All Trials, never Fight Again', () => {
    const payload = buildFightResult(outcome({ canFightAgain: false, trialsOpen: true, completedCurriculum: true }), { againNonce: 'abcdefgh', itemName: (s) => s });
    expect(labels(payload)).toEqual(['All Trials', 'Back to Waifumon']);
  });

  it('mid-curriculum results are unchanged', () => {
    expect(labels(buildFightResult(outcome({}), { againNonce: 'abcdefgh', itemName: (s) => s }))).toEqual(['Fight Again', 'All Trials', 'Back to Waifumon']);
  });

  it('the list shows how far the curriculum has got, and nothing once it is done', () => {
    const description = (curriculum: { required: number; cleared: number; complete: boolean }) =>
      (buildTrialList({ trials: [], curriculum }, 0).embeds![0] as { toJSON(): { description?: string } }).toJSON().description ?? '';
    expect(description({ required: 3, cleared: 2, complete: false })).toContain('2 / 3 cleared');
    expect(description({ required: 3, cleared: 3, complete: true })).not.toContain('unlock **Delve**');
  });

  it('the completed and Delve-locked screens each lead somewhere live', () => {
    expect(labels(completedTrialsView())).toEqual(['Back to Waifumon']);
    const locked = delveLockedView();
    expect(buttonsOf(locked.components as unknown as Rows).map((b) => b.custom_id)).toEqual([ctId.home(0), expect.stringContaining('|menu|start')]);
  });
});

describe('the onboarding completion screen', () => {
  const ctx = { config: {}, logger: silentLogger(), services: { combatTrials: {} } } as unknown as AppContext;
  const flow = loadShippedContent().onboarding!.equipment!;
  const stats = assembleCombatStats({
    buddy: { waifuId: 9, speciesSlug: 'warband_princess', name: 'Warband Princess', level: 30, baseSp: 200, currentSp: 280 },
    loadoutId: null,
    slots: { attack: null, defense: null, health: null },
  });
  const complete: EquipmentOnboardingView = { kind: 'complete', stats, report: null };
  const ids = (p: { components?: unknown }) => buttonsOf(p.components as unknown as Rows).map((b) => b.custom_id);

  it('points at Combat Trials only while there are Trials left to fight', () => {
    const withTrials = buildOnboardingView(ctx, complete, { npc: null, flow }, null, true);
    const without = buildOnboardingView(ctx, complete, { npc: null, flow }, null, false);
    expect(ids(withTrials)).toContain(ctId.home(0));
    expect(ids(without)).not.toContain(ctId.home(0));
    expect(ids(without)).toHaveLength(1);
    expectValidRows(without.components as unknown as Rows);
    // Callers that do not say keep the old rule: the service is wired.
    expect(ids(buildOnboardingView(ctx, complete, { npc: null, flow }))).toContain(ctId.home(0));
  });
});

describe('shipped content', () => {
  it('carries every curriculum Trial, enabled, so Delve can be unlocked', () => {
    const shipped = loadShippedContent().combatTrials ?? [];
    for (const key of COMBAT_TRIAL_CURRICULUM) {
      expect(shipped.find((t) => t.key === key), key).toMatchObject({ enabled: true });
    }
  });
});

describe('API status of the new refusals', () => {
  it('maps both, so no route turns them into a 500', () => {
    expect(mapAppErrorToStatus(new CombatTrialsCompletedError())).toBe(409);
    expect(mapAppErrorToStatus(new DelveLockedError())).toBe(422);
  });
});
