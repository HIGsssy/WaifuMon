/**
 * Equipment 3.0 effective SP and Delve runs:
 *
 *  - a new run freezes ATK / DEF / HP derived from effective SP (natural SP
 *    plus equipped flat SP), with the SP breakdown recorded for display;
 *  - the fighter's `currentSp` — what event skill checks read — stays the
 *    natural value;
 *  - a run already under way is never recalculated when gear changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveStat } from '../../src/modules/equipment/equipmentMath';
import { eventCheckChance } from '../../src/modules/dungeons/engine/eventChecks';
import { STARTER_ROLLS } from '../../src/modules/onboarding/vocabulary';
import { fixedRange, grant } from '../helpers/equipmentFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let w: DungeonWorld;
const BLADE = { key: 'e3_dg_blade', name: 'Delve Blade', slot: 'attack', rarity: 'SSR', ...fixedRange(10_000) } as const;

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.publish();
  await w.svc.definitions.create(BLADE);
});

afterAll(async () => {
  await w?.cleanup();
});

async function equipBlade(playerId: number, flatSp: number, additional: number) {
  const id = await grant(w.t.db, w.svc, playerId, BLADE.key, {
    roll: {
      kind: 'fixed',
      rolledMultiplierBp: 10_000,
      affixKey: null,
      flatSp,
      combatBonuses: [{ stat: 'flat_sp', valueBp: additional }],
    },
  });
  await w.svc.equipment.equip(playerId, { slot: 'attack', equipmentId: id });
}

describe('effective SP in Delve runs', () => {
  it('a new run freezes effective-SP stats; the fighter keeps natural SP for event checks', async () => {
    const { playerId } = await w.player();
    const natural = (await w.stats.calculateCombatStats(playerId)).sp!.natural;
    await equipBlade(playerId, 20, 11);
    const run = await w.runs.start(playerId, 'test_tunnels', { seed: 3 });
    const effective = natural + 31;
    expect(run.fighter).toMatchObject({
      formulaVersion: 3,
      currentSp: natural,
      equipmentSp: 31,
      effectiveSp: effective,
      attack: deriveStat(effective, 10_000),
      defense: deriveStat(effective, STARTER_ROLLS.defense.rolledMultiplierBp),
      maxHp: deriveStat(effective, STARTER_ROLLS.health.rolledMultiplierBp),
    });
    // Event checks read `fighter.currentSp` (engine/events.ts, engine/step.ts):
    // natural SP, so gear does not move a check's odds.
    const check = { baseChanceBasisPoints: 5_000, maxSpModifierBasisPoints: 3_000 } as Parameters<typeof eventCheckChance>[0];
    expect(eventCheckChance(check, run.fighter.currentSp)).toBe(eventCheckChance(check, natural));
    if (Math.abs(natural - 200) < 150) {
      expect(eventCheckChance(check, run.fighter.currentSp)).not.toBe(eventCheckChance(check, effective));
    }
  });

  it('a run under way keeps its frozen stats when gear changes mid-run', async () => {
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, 'test_tunnels', { seed: 5 });
    const frozen = run.fighter;
    expect(frozen).toMatchObject({ equipmentSp: 0, effectiveSp: frozen.currentSp });
    await equipBlade(playerId, 40, 10);
    // The live calculation moved…
    expect((await w.stats.calculateCombatStats(playerId)).sp!.equipmentBonus).toBe(50);
    // …the run did not, including after a restart.
    expect((await w.runs.activeRun(playerId))!.fighter).toEqual(frozen);
    expect((await w.restartedRuns().activeRun(playerId))!.fighter).toEqual(frozen);
  });
});
