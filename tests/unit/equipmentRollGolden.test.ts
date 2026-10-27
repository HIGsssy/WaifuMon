/**
 * The Equipment 3.0 compatibility gate: every shipped N/R/SR definition, 200
 * fixed seeds each — 6,000 random rolls — must produce exactly the rolls the
 * pre-3.0 engine produced, drawing exactly the same random numbers in the same
 * order.
 *
 * The fixture (`tests/fixtures/equipmentRollGolden.json`) was recorded from the
 * engine at `3fbb802`, before any Equipment 3.0 change, over the shipped
 * `equipment.seed.json`, `affixes.json` and `combatBonuses.json`. It is never
 * regenerated to make a failure go away: a difference here is a change to
 * existing loot. (`UPDATE_EQUIPMENT_ROLL_GOLDEN=1` rewrites it; that is only
 * legitimate when the shipped content itself is deliberately changed.)
 *
 * One line per roll:
 *
 *   `<multiplierBp>|<affixKey>|<stat>:<valueBp>,…|<min>-<max>=<result>;…`
 *
 * The last field is every `intInclusive` call the roll made, in order — the
 * draw count and draw order are part of the contract, not only the outcome.
 * The seed for roll `n` (1…200) of the definition at catalogue index `i` is
 * `(i + 1) * 1000 + n`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAffixCatalogue, EquipmentAffixFileSchema } from '../../src/modules/equipment/affixCatalogue';
import {
  combatBonusCatalogueFromFile,
  EquipmentCombatBonusFileSchema,
} from '../../src/modules/equipment/combatBonuses';
import { rollEquipmentInstance } from '../../src/modules/equipment/equipmentRoll';
import { loadEquipmentSeedCatalogue } from '../../src/modules/equipment/seed';
import { seededRng, type Rng } from '../../src/shared/random';
import { CONTENT_DIR } from '../helpers/fixtures';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'equipmentRollGolden.json');
const SEEDS_PER_DEFINITION = 200;

function readJson(...parts: string[]): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, ...parts), 'utf8'));
}

/** Wraps a seeded RNG and records every `intInclusive` call. */
function recordingRng(seed: number): { rng: Rng; draws: string[] } {
  const inner = seededRng(seed);
  const draws: string[] = [];
  return {
    draws,
    rng: {
      next: () => {
        draws.push('next');
        return inner.next();
      },
      intInclusive(min, max) {
        const result = inner.intInclusive(min, max);
        draws.push(`${min}-${max}=${result}`);
        return result;
      },
    },
  };
}

function computeGolden(): Record<string, string[]> {
  const definitions = loadEquipmentSeedCatalogue(CONTENT_DIR);
  const affixes = buildAffixCatalogue(
    EquipmentAffixFileSchema.parse(readJson('equipment', 'affixes.json')).affixes,
  );
  const combatBonuses = combatBonusCatalogueFromFile(
    EquipmentCombatBonusFileSchema.parse(readJson('equipment', 'combatBonuses.json')),
  );
  const out: Record<string, string[]> = {};
  definitions.forEach((definition, i) => {
    const lines: string[] = [];
    for (let n = 1; n <= SEEDS_PER_DEFINITION; n += 1) {
      const { rng, draws } = recordingRng((i + 1) * 1000 + n);
      const roll = rollEquipmentInstance(definition, { rng, affixes, combatBonuses });
      const bonuses = roll.combatBonuses.map((b) => `${b.stat}:${b.valueBp}`).join(',');
      lines.push(`${roll.rolledMultiplierBp}|${roll.affixKey ?? ''}|${bonuses}|${draws.join(';')}`);
    }
    out[definition.key] = lines;
  });
  return out;
}

describe('N/R/SR random rolls are byte-identical to the pre-3.0 engine', () => {
  const actual = computeGolden();

  if (process.env.UPDATE_EQUIPMENT_ROLL_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>;

  it('covers all 30 shipped definitions, 200 seeds each (6,000 rolls)', () => {
    expect(Object.keys(expected)).toHaveLength(30);
    expect(Object.values(expected).reduce((n, lines) => n + lines.length, 0)).toBe(6000);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.keys(expected))('%s: every roll and every draw is unchanged', (key) => {
    expect(actual[key]).toEqual(expected[key]);
  });
});
