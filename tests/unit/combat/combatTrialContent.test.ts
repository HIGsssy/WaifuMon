/**
 * Combat Trial content: the shipped ladder, the schema, the catalogue's
 * availability rules, and the loader's cross-file checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CombatEnemyDefinitionSchema, createCombatEnemyCatalogue } from '../../../src/modules/combat/enemyDefinitions';
import {
  COMBAT_TRIAL_FILE,
  COMBAT_TRIAL_KEY_MAX_LENGTH,
  CombatTrialDefinitionSchema,
  CombatTrialFileSchema,
  createCombatTrialCatalogue,
} from '../../../src/modules/combat/trialDefinitions';
import { readContentFiles, validateCombatTrialContent } from '../../../src/modules/content/loader';
import { ContentValidationError } from '../../../src/shared/errors';
import { CONTENT_DIR } from '../../helpers/fixtures';

const base = { key: 'test_trial', name: 'Test', description: 'A test.', enemyKey: 'test_enemy', enabled: true, order: 1 };
const file = (trials: unknown[]) => ({ format: 'waifumon-combat-trials', version: 1, trials });
const issues = (raw: unknown) => {
  const r = CombatTrialFileSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('shipped Trials', () => {
  const shipped = CombatTrialFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, COMBAT_TRIAL_FILE), 'utf8')));

  it('is a three-step ladder over the three starter enemies, tagged as initial tuning', () => {
    expect(shipped.trials.map((t) => t.enemyKey)).toEqual(['scrapyard_drone', 'alley_bruiser', 'security_automaton']);
    for (const t of shipped.trials) {
      expect(t.enabled).toBe(true);
      expect(t.tags).toContain('initial_tuning');
      expect(t.recommended).not.toBeNull();
      expect(t.firstClearRewards?.waifubux).toBeGreaterThan(0);
    }
    const orders = shipped.trials.map((t) => t.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('recommendations rise from Trial to Trial', () => {
    const [a, b, c] = shipped.trials.map((t) => t.recommended!);
    for (const stat of ['attack', 'defense', 'hp'] as const) {
      expect(b![stat]!).toBeGreaterThan(a![stat]!);
      expect(c![stat]!).toBeGreaterThan(b![stat]!);
    }
  });

  it('arrives through the content loader and passes the cross-file checks', () => {
    const content = readContentFiles(CONTENT_DIR);
    expect(content.combatTrials?.map((t) => t.key)).toEqual(shipped.trials.map((t) => t.key));
    expect(() => validateCombatTrialContent(content)).not.toThrow();
  });
});

describe('Trial schema', () => {
  it('accepts a minimal Trial and defaults the optional fields', () => {
    const t = CombatTrialDefinitionSchema.parse(base);
    expect(t).toMatchObject({ recommended: null, artworkPath: null, backgroundArtworkPath: null, firstClearRewards: null, tags: [] });
  });

  it('never carries enemy stats — unknown keys are refused', () => {
    expect(issues(file([{ ...base, attack: 10 }]))).not.toEqual([]);
    expect(issues(file([{ ...base, hp: 10 }]))).not.toEqual([]);
  });

  it('refuses duplicate keys, bad keys, and keys too long for a custom id', () => {
    expect(issues(file([base, base])).join()).toMatch(/duplicate trial key/);
    expect(issues(file([{ ...base, key: 'Bad Key' }]))).not.toEqual([]);
    expect(issues(file([{ ...base, key: 'a'.repeat(COMBAT_TRIAL_KEY_MAX_LENGTH + 1) }]))).not.toEqual([]);
  });

  it('refuses unsafe artwork paths', () => {
    expect(issues(file([{ ...base, artworkPath: '../secret.webp' }]))).not.toEqual([]);
    expect(issues(file([{ ...base, backgroundArtworkPath: '/abs/bg.webp' }]))).not.toEqual([]);
    expect(issues(file([{ ...base, backgroundArtworkPath: 'combat/backgrounds/test_trial.webp' }]))).toEqual([]);
  });

  it('refuses negative recommendations and malformed rewards', () => {
    expect(issues(file([{ ...base, recommended: { attack: -1 } }]))).not.toEqual([]);
    expect(issues(file([{ ...base, firstClearRewards: { waifubux: -5 } }]))).not.toEqual([]);
    expect(issues(file([{ ...base, firstClearRewards: { items: [{ slug: 'x', quantity: 0 }] } }]))).not.toEqual([]);
  });
});

describe('Trial catalogue', () => {
  const enemies = createCombatEnemyCatalogue([
    CombatEnemyDefinitionSchema.parse({ key: 'on', name: 'On', attack: 1, defense: 0, hp: 1, enabled: true }),
    CombatEnemyDefinitionSchema.parse({ key: 'off', name: 'Off', attack: 1, defense: 0, hp: 1, enabled: false }),
  ]);
  const t = (over: Record<string, unknown>) => CombatTrialDefinitionSchema.parse({ ...base, ...over });
  const catalogue = createCombatTrialCatalogue(
    [
      t({ key: 'late', enemyKey: 'on', order: 30 }),
      t({ key: 'early', enemyKey: 'on', order: 10 }),
      t({ key: 'disabled', enemyKey: 'on', order: 20, enabled: false }),
      t({ key: 'enemy_off', enemyKey: 'off', order: 40 }),
      t({ key: 'enemy_gone', enemyKey: 'nobody', order: 50 }),
    ],
    enemies,
  );

  it('lists only fightable Trials, in authored order', () => {
    expect(catalogue.available().map((a) => a.trial.key)).toEqual(['early', 'late']);
  });

  it('explains why a Trial is unavailable', () => {
    expect(catalogue.resolve('early').status).toBe('available');
    expect(catalogue.resolve('missing')).toMatchObject({ status: 'unavailable', reason: 'missing' });
    expect(catalogue.resolve('disabled')).toMatchObject({ status: 'unavailable', reason: 'disabled' });
    expect(catalogue.resolve('enemy_off')).toMatchObject({ status: 'unavailable', reason: 'enemy_disabled' });
    expect(catalogue.resolve('enemy_gone')).toMatchObject({ status: 'unavailable', reason: 'enemy_missing' });
  });
});

describe('cross-file validation', () => {
  const content = readContentFiles(CONTENT_DIR);
  const withTrials = (trials: unknown[]) => ({ ...content, combatTrials: trials.map((x) => CombatTrialDefinitionSchema.parse(x)) });

  it('refuses a Trial naming an unknown enemy', () => {
    expect(() => validateCombatTrialContent(withTrials([{ ...base, enemyKey: 'nobody_here' }]))).toThrow(ContentValidationError);
  });

  it('refuses a reward naming an unknown item', () => {
    const trial = { ...base, enemyKey: 'scrapyard_drone', firstClearRewards: { items: [{ slug: 'no_such_item', quantity: 1 }] } };
    expect(() => validateCombatTrialContent(withTrials([trial]))).toThrow(/unknown item "no_such_item"/);
  });

  it('refuses two enabled Trials sharing an order', () => {
    const a = { ...base, key: 'a', enemyKey: 'scrapyard_drone' };
    const b = { ...base, key: 'b', enemyKey: 'scrapyard_drone' };
    expect(() => validateCombatTrialContent(withTrials([a, b]))).toThrow(/share order/);
    expect(() => validateCombatTrialContent(withTrials([a, { ...b, enabled: false }]))).not.toThrow();
  });
});
