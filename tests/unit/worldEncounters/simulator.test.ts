/**
 * The admin N-roll simulator — pure logic, no DB, no services.
 *
 * These test the **real** `simulateChoice` exported from the admin route
 * module. The previous version of this file re-implemented the simulator
 * inline "so the tests use the same shape and formula the route implements",
 * which meant it happily certified an expected-value calculator as a
 * simulator: the copy and the original agreed with each other and neither
 * agreed with the name. Testing the shipped function is the whole point.
 *
 * The properties worth pinning are the ones that distinguish a simulation
 * from arithmetic: different seeds give different runs, the same seed gives
 * the same run, the observed rate converges on the formula as N grows without
 * ever equalling it exactly, and the effect totals are the ones those
 * particular rolls earned.
 */
import { describe, expect, it } from 'vitest';
import { simulateChoice } from '../../../src/api/routes/v1/admin/encounters';
import type { EncounterCheckContext, LoadedEncounter } from '../../../src/modules/worldEncounters/types';

type Choice = LoadedEncounter['choices'][number];

const buddy = {
  waifuId: 0,
  speciesSlug: 't',
  speciesName: 't',
  level: 10,
  affinity: 'dominant' as const,
  baseSp: 80,
  currentSp: 80,
  rarity: 'R',
  raceTags: ['valkyrie'],
};
const ctx: EncounterCheckContext = {
  playerId: 0,
  playerLevel: 20,
  buddy,
  buddyBonusPercent: 0,
};

function choice(overrides: Partial<Choice> = {}): Choice {
  return {
    id: 1,
    sortOrder: 0,
    label: 'Test',
    emoji: null,
    requirements: {},
    check: { type: 'sp', difficulty: 60 },
    successEffects: [{ type: 'waifubux_gain', amount: 100 }],
    failureEffects: [{ type: 'waifubux_loss', amount: 50 }],
    ...overrides,
  } as Choice;
}

describe('simulator: runs N independent rolls', () => {
  it('is reproducible for a given seed', () => {
    const c = choice();
    expect(simulateChoice(c, { rolls: 1000 }, ctx, 12345)).toEqual(
      simulateChoice(c, { rolls: 1000 }, ctx, 12345),
    );
  });

  it('produces a different run for a different seed', () => {
    // The distinguishing property. An expected-value calculator cannot fail
    // this test — it passes it by being unable to vary at all.
    const c = choice();
    const a = simulateChoice(c, { rolls: 500 }, ctx, 1);
    const b = simulateChoice(c, { rolls: 500 }, ctx, 2);
    expect(a.successes).not.toBe(b.successes);
  });

  it('does not simply return round(rolls × chance)', () => {
    // Across a spread of seeds at least one run must miss the closed-form
    // answer, or the "simulation" is arithmetic wearing a seed parameter.
    const c = choice();
    const expected = simulateChoice(c, { rolls: 200 }, ctx, 0).expectedSuccessRate;
    const closedForm = Math.round(200 * expected);
    const observed = [1, 2, 3, 4, 5, 6, 7, 8].map(
      (seed) => simulateChoice(c, { rolls: 200 }, ctx, seed).successes,
    );
    expect(observed.some((n) => n !== closedForm)).toBe(true);
  });

  it('reports successes and failures that account for every roll', () => {
    const result = simulateChoice(choice(), { rolls: 777 }, ctx, 99);
    expect(result.rolls).toBe(777);
    expect(result.successes + result.failures).toBe(777);
    expect(result.successRate).toBeCloseTo(result.successes / 777, 12);
  });

  it('converges on the formula as the roll count grows', () => {
    const c = choice();
    const small = simulateChoice(c, { rolls: 50 }, ctx, 7);
    const large = simulateChoice(c, { rolls: 10_000 }, ctx, 7);
    expect(Math.abs(large.successRateDeviation)).toBeLessThan(
      Math.abs(small.successRateDeviation) + 0.05,
    );
    // Four standard errors is a ~1-in-16,000 tail; a fair sampler stays inside
    // it, and a broken one (wrong probability, biased RNG) does not.
    expect(Math.abs(large.successRateDeviation)).toBeLessThan(
      4 * large.successRateStdError,
    );
  });

  it('shrinks the reported standard error as N grows', () => {
    const c = choice();
    const small = simulateChoice(c, { rolls: 100 }, ctx, 3);
    const large = simulateChoice(c, { rolls: 10_000 }, ctx, 3);
    expect(large.successRateStdError).toBeLessThan(small.successRateStdError);
  });
});

describe('simulator: reward aggregation', () => {
  it('credits each roll to exactly one branch', () => {
    const result = simulateChoice(choice(), { rolls: 1000 }, ctx, 42);
    expect(result.waifubuxGained).toBe(result.successes * 100);
    expect(result.waifubuxLost).toBe(result.failures * 50);
    expect(result.netWaifubux).toBe(result.waifubuxGained - result.waifubuxLost);
    expect(result.netWaifubuxPerRoll).toBeCloseTo(result.netWaifubux / 1000, 12);
  });

  it('reports the closed-form expectation alongside the observed net', () => {
    const result = simulateChoice(choice(), { rolls: 1000 }, ctx, 42);
    const p = result.expectedSuccessRate;
    expect(result.expectedNetWaifubuxPerRoll).toBeCloseTo(p * 100 + (1 - p) * -50, 10);
  });

  it('never fires the failure branch for a `none` check', () => {
    const result = simulateChoice(
      choice({
        check: { type: 'none' },
        failureEffects: [{ type: 'waifubux_loss', amount: 5000 }],
      }),
      { rolls: 100 },
      ctx,
      5,
    );
    expect(result.successes).toBe(100);
    expect(result.failures).toBe(0);
    expect(result.waifubuxLost).toBe(0);
  });

  it('counts item frequency across both branches', () => {
    const result = simulateChoice(
      choice({
        successEffects: [{ type: 'give_item', slug: 'basic_charm', quantity: 1 }],
        failureEffects: [{ type: 'consume_item', slug: 'basic_charm', quantity: 2 }],
      }),
      { rolls: 1000 },
      ctx,
      11,
    );
    expect(result.itemFrequency.basic_charm).toBe(
      result.successes * 1 + result.failures * 2,
    );
  });

  it('counts follow-up markers once per roll that produced one', () => {
    const result = simulateChoice(
      choice({
        successEffects: [{ type: 'trigger_waifumon_encounter' }],
        failureEffects: [],
      }),
      { rolls: 300 },
      ctx,
      13,
    );
    expect(result.followUpFrequency.trigger_waifumon_encounter).toBe(result.successes);
  });

  it('echoes the seed so a reported run can be reproduced', () => {
    expect(simulateChoice(choice(), { rolls: 10 }, ctx, 8675309).seed).toBe(8675309);
  });
});

describe('simulator: mutation-free', () => {
  it('leaves the choice and the context object untouched', () => {
    const c = choice();
    const beforeChoice = JSON.stringify(c);
    const beforeCtx = JSON.stringify(ctx);
    simulateChoice(c, { rolls: 2000 }, ctx, 1);
    expect(JSON.stringify(c)).toBe(beforeChoice);
    expect(JSON.stringify(ctx)).toBe(beforeCtx);
  });
});
