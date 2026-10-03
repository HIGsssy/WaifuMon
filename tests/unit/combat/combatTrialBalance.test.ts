/**
 * Initial balance of the shipped Trial ladder — seeded simulations through the
 * real engine, with stats derived exactly as `combatStatsService` derives them
 * (`currentSeductivePower` → `deriveStat`).
 *
 * Fights carry the engine's damage variance (90%–110% per hit), so each
 * matchup is played over {@link SEEDS} seeds: "wins" means it wins at least
 * half of them, and the comfortable cases must win every one.
 *
 * These are tuning guards, not exact pins: they assert the *shape* the ladder
 * is meant to have, so a retune that keeps the intent keeps passing.
 *
 *   Trial 1 — onboarding starter gear wins comfortably across the range.
 *   Trial 2 — starter gear wins only with a strong Buddy; improved N gear
 *             noticeably widens that.
 *   Trial 3 — starter gear mostly loses; it starts to reward N / R upgrades.
 *
 * Buddies are Level 35 copies at representative base SP (N 90 … EX 185, per
 * `DEFAULT_SP_RANGES_BY_RARITY`), i.e. Current SP 167 … 342.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { basicAttackController } from '../../../src/modules/combat/combatController';
import { simulateCombat } from '../../../src/modules/combat/combatSimulator';
import { createCombatState } from '../../../src/modules/combat/combatState';
import type { CombatResult } from '../../../src/modules/combat/combatTypes';
import {
  COMBAT_ENEMY_FILE,
  CombatEnemyFileSchema,
  createCombatEnemyCatalogue,
  enemyCombatantInput,
} from '../../../src/modules/combat/enemyDefinitions';
import { COMBAT_TRIAL_FILE, CombatTrialFileSchema, createCombatTrialCatalogue } from '../../../src/modules/combat/trialDefinitions';
import { deriveStat } from '../../../src/modules/equipment/equipmentMath';
import { currentSeductivePower } from '../../../src/modules/power/seductivePower';
import { STARTER_ROLLS } from '../../../src/modules/onboarding/vocabulary';
import { seededRng } from '../../../src/shared/random';
import { CONTENT_DIR } from '../../helpers/fixtures';

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8'));
const enemies = createCombatEnemyCatalogue(CombatEnemyFileSchema.parse(read(COMBAT_ENEMY_FILE)).enemies);
const ladder = createCombatTrialCatalogue(CombatTrialFileSchema.parse(read(COMBAT_TRIAL_FILE)).trials, enemies).available();

/** Multipliers in basis points: [attack, defense, health]. */
const BUILDS = {
  /** Rusty Pipe ×0.45 · Scrap Plate ×0.35 · Dented Lunchbox ×2.00 — what onboarding grants. */
  starter: [STARTER_ROLLS.attack.rolledMultiplierBp, STARTER_ROLLS.defense.rolledMultiplierBp, STARTER_ROLLS.health.rolledMultiplierBp],
  /** Mid-roll better N gear (e.g. Suction-Cup Morningstar, Energy Buckler) and a good Lunchbox. */
  improvedN: [6_500, 5_500, 22_000],
  /** Mid-roll R attack / defense and a top Lunchbox. */
  r: [8_500, 7_500, 26_000],
} as const;
type Build = keyof typeof BUILDS;

/** Level 35 Buddies at representative base SP: weak N … EX. */
const BASE_SP = [90, 100, 110, 125, 140, 155, 170, 185];
const SP = BASE_SP.map((b) => currentSeductivePower(b, 35, 50));

/** Seeded fights per matchup. Fixed seeds, so the file is deterministic. */
const SEEDS = 200;

function fight(trialIndex: number, build: Build, currentSp: number, seed = 1): CombatResult {
  const [atk, def, hp] = BUILDS[build];
  const { enemy } = ladder[trialIndex]!;
  const state = createCombatState({
    player: { id: 'buddy:1', name: 'Buddy', attack: deriveStat(currentSp, atk), defense: deriveStat(currentSp, def), maxHp: deriveStat(currentSp, hp) },
    enemy: enemyCombatantInput(enemy),
  });
  return simulateCombat(state, { player: basicAttackController, enemy: basicAttackController }, { rng: seededRng(seed) });
}

const fights = (trialIndex: number, build: Build, sp: number) =>
  Array.from({ length: SEEDS }, (_, seed) => fight(trialIndex, build, sp, seed));
const winRate = (trialIndex: number, build: Build, sp: number) =>
  fights(trialIndex, build, sp).filter((r) => r.result === 'player_victory').length / SEEDS;
/** The SP values at which the build wins the Trial at least half the time. */
const wins = (trialIndex: number, build: Build) => SP.filter((sp) => winRate(trialIndex, build, sp) >= 0.5);
const hpLeft = (r: CombatResult) => r.finalState.player.currentHp / r.finalState.player.maxHp;

describe('the shipped Trial ladder', () => {
  it('is three Trials over the three starter enemies', () => {
    expect(ladder.map((l) => l.enemy.key)).toEqual(['scrapyard_drone', 'alley_bruiser', 'security_automaton']);
    expect(SP).toEqual([167, 185, 204, 231, 259, 287, 315, 342]);
  });

  it('Trial 1: starter gear wins comfortably across the whole range', () => {
    for (const sp of SP) {
      // Every seed, not most: variance must not turn the first Trial into a coin flip.
      for (const r of fights(0, 'starter', sp)) {
        expect(r.result, `SP ${sp}`).toBe('player_victory');
        expect(hpLeft(r), `SP ${sp}`).toBeGreaterThan(0.4);
      }
    }
  });

  it('Trial 2: starter gear wins with a strong Buddy only, and improved N gear clearly helps', () => {
    const starter = wins(1, 'starter');
    const improved = wins(1, 'improvedN');
    expect(starter.length).toBeGreaterThan(0);
    expect(starter.length).toBeLessThan(SP.length);
    expect(starter).toContain(SP[SP.length - 1]);
    expect(starter).not.toContain(SP[0]);
    expect(improved.length).toBeGreaterThanOrEqual(starter.length + 2);
  });

  it('Trial 2 is meaningfully harder than Trial 1', () => {
    const meanHpLeft = (results: CombatResult[]) =>
      results.reduce((sum, r) => sum + (r.result === 'player_victory' ? hpLeft(r) : 0), 0) / results.length;
    for (const sp of SP) {
      expect(meanHpLeft(fights(1, 'starter', sp)), `SP ${sp}`).toBeLessThan(meanHpLeft(fights(0, 'starter', sp)));
    }
  });

  it('Trial 3: starter gear mostly loses; N / R upgrades start to win it', () => {
    const starter = wins(2, 'starter');
    const improved = wins(2, 'improvedN');
    const r = wins(2, 'r');
    expect(starter.length).toBeLessThanOrEqual(1);
    expect(improved.length).toBeGreaterThan(starter.length);
    expect(r.length).toBeGreaterThan(improved.length);
    // Below this the Buddy needs better than mid-roll R gear.
    expect(r).not.toContain(SP[0]);
  });

  it('variance only blurs the edges: almost every matchup is still decided one way', () => {
    // A ladder where most cells were coin flips would make the recommendations meaningless.
    const rates = [0, 1, 2].flatMap((t) => (Object.keys(BUILDS) as Build[]).flatMap((b) => SP.map((sp) => winRate(t, b, sp))));
    const decided = rates.filter((r) => r <= 0.05 || r >= 0.95).length;
    expect(decided / rates.length).toBeGreaterThan(0.85);
  });

  it('Trial 3 requires stronger stats than Trial 1', () => {
    expect(wins(2, 'starter').length).toBeLessThan(wins(0, 'starter').length);
  });
});
