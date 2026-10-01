/**
 * Equipment onboarding content: the shipped starter catalogue, the reusable
 * Patch NPC, and the narrative schema that must name exactly the flow's steps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EquipmentOnboardingContentSchema,
  NpcsFileSchema,
} from '../../src/modules/content/onboardingSchemas';
import { validateOnboardingContent } from '../../src/modules/content/loader';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { parseEquipmentDefinition } from '../../src/modules/equipment/definitionSchema';
import { loadEquipmentSeedCatalogue } from '../../src/modules/equipment/seed';
import { createProgressionService } from '../../src/modules/progression/progressionService';
import { equipmentOnboardingLevelLabels } from '../../src/modules/onboarding/onboardingState';
import { isMultiplierInRange } from '../../src/modules/equipment/equipmentRoll';
import {
  EQUIPMENT_ONBOARDING_STEPS,
  STARTER_EQUIPMENT,
  STARTER_ROLLS,
  STARTER_SLOTS,
} from '../../src/modules/onboarding/vocabulary';
import { ContentValidationError } from '../../src/shared/errors';
import { CONTENT_DIR, loadShippedContent } from '../helpers/fixtures';

const readJson = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, rel), 'utf8'));
const shippedFlow = () => readJson('onboarding/equipment.json') as Record<string, unknown>;

describe('shipped starter catalogue', () => {
  const catalogue = loadEquipmentSeedCatalogue(CONTENT_DIR);

  const range = (min: number, max: number, step: number) => ({
    multiplierMinBp: min,
    multiplierMaxBp: max,
    multiplierStepBp: step,
  });

  it.each([
    ['rusty_pipe', 'Rusty Pipe', 'Still hits. Still embarrassing.', 'attack', range(4000, 6000, 500)],
    ['scrap_plate', 'Scrap Plate', 'Bolted together hope.', 'defense', range(3000, 5000, 500)],
    ['dented_lunchbox', 'Dented Lunchbox', 'Keeps something alive.', 'health', range(18000, 26000, 2000)],
  ])('%s is exactly as signed off', (key, name, description, slot, bp) => {
    const def = catalogue.find((d) => d.key === key)!;
    expect(def).toBeDefined();
    expect(def).toMatchObject({ name, description, slot, rarity: 'N', ...bp, enabled: true });
    expect(def.tags).toEqual(['starter', 'onboarding']);
    expect(def.artworkPath).toBeNull();
    expect(def.shopRegions).toEqual([]);
    // And it passes the authoring schema on its own, not only as a package.
    expect(() => parseEquipmentDefinition(def)).not.toThrow();
  });

  it('the onboarding grants each starter a fixed, unaffixed roll inside its range', () => {
    expect(STARTER_ROLLS).toEqual({
      attack: { rolledMultiplierBp: 4500, affixKey: null },
      defense: { rolledMultiplierBp: 3500, affixKey: null },
      health: { rolledMultiplierBp: 20000, affixKey: null },
    });
    for (const slot of STARTER_SLOTS) {
      const def = catalogue.find((d) => d.key === STARTER_EQUIPMENT[slot])!;
      expect(isMultiplierInRange(def, STARTER_ROLLS[slot].rolledMultiplierBp)).toBe(true);
    }
  });

  it('matches the keys the onboarding grants, and nothing else', () => {
    expect(catalogue.map((d) => d.key).sort()).toEqual(Object.values(STARTER_EQUIPMENT).sort());
  });
});

describe('Patch', () => {
  it('is a reusable NPC, not an onboarding-specific one', () => {
    const npcs = NpcsFileSchema.parse(readJson('npcs.json'));
    const patch = npcs.find((n) => n.key === 'patch')!;
    expect(patch.name).toBe('Patch');
    expect(patch.portraitPath).toBeNull();
    // Nothing in the definition ties Patch to the onboarding.
    expect(JSON.stringify(patch).toLowerCase()).not.toMatch(/onboarding|tutorial/);
  });

  it('rejects duplicate keys, unknown fields and escaping portraits', () => {
    const patch = { key: 'patch', name: 'Patch' };
    expect(NpcsFileSchema.safeParse([patch, patch]).success).toBe(false);
    expect(NpcsFileSchema.safeParse([{ ...patch, onboarding: true }]).success).toBe(false);
    expect(NpcsFileSchema.safeParse([{ ...patch, portraitPath: '../secret.png' }]).success).toBe(false);
    expect(NpcsFileSchema.safeParse([{ ...patch, key: 'Patch!' }]).success).toBe(false);
  });
});

describe('onboarding narrative schema', () => {
  it('accepts the shipped file, which names exactly the flow steps', () => {
    const parsed = EquipmentOnboardingContentSchema.parse(shippedFlow());
    expect(Object.keys(parsed.steps)).toEqual([...EQUIPMENT_ONBOARDING_STEPS]);
    expect(parsed.npc).toBe('patch');
    expect(parsed.steps.attack.button).toBe('Take the Rusty Pipe');
    expect(parsed.steps.explain.button).toBe('Gear up');
    expect(parsed.steps.complete.title).toBe('Equipment Unlocked');
    expect(parsed.steps.complete.button).toBe('Back to Waifumon');
    expect(parsed.levelUpLabel).toBe('🔧 Equipment training available — check the Waifumon menu.');
  });

  it('carries no draft placeholders', () => {
    expect(JSON.stringify(shippedFlow())).not.toMatch(/\[DRAFT\]|TODO|TBD/i);
  });

  const withSteps = (steps: Record<string, unknown>) => ({ ...shippedFlow(), steps });

  it('fails a missing step', () => {
    const { health: _omit, ...steps } = shippedFlow().steps as Record<string, unknown>;
    expect(EquipmentOnboardingContentSchema.safeParse(withSteps(steps)).success).toBe(false);
  });

  it('fails an extra or misspelt step', () => {
    const steps = shippedFlow().steps as Record<string, unknown>;
    expect(EquipmentOnboardingContentSchema.safeParse(withSteps({ ...steps, bonus: steps.intro })).success).toBe(false);
    const { attack, ...rest } = steps;
    expect(EquipmentOnboardingContentSchema.safeParse(withSteps({ ...rest, atack: attack })).success).toBe(false);
  });

  it('requires the no-Buddy screen on explain', () => {
    const steps = shippedFlow().steps as Record<string, Record<string, unknown>>;
    const { noBuddy: _omit, ...explain } = steps.explain!;
    expect(EquipmentOnboardingContentSchema.safeParse(withSteps({ ...steps, explain })).success).toBe(false);
  });

  it('requires some speech on every step', () => {
    const steps = shippedFlow().steps as Record<string, Record<string, unknown>>;
    const silent = { title: 'Quiet', button: 'Go', artworkPath: null };
    expect(EquipmentOnboardingContentSchema.safeParse(withSteps({ ...steps, intro: silent })).success).toBe(false);
  });

  it('rejects an artwork path that escapes the assets directory', () => {
    const steps = shippedFlow().steps as Record<string, Record<string, unknown>>;
    const intro = { ...steps.intro, artworkPath: '../../etc/passwd.png' };
    expect(EquipmentOnboardingContentSchema.safeParse(withSteps({ ...steps, intro })).success).toBe(false);
  });

  it('rejects a button label Discord would refuse', () => {
    const steps = shippedFlow().steps as Record<string, Record<string, unknown>>;
    const intro = { ...steps.intro, button: 'x'.repeat(81) };
    expect(EquipmentOnboardingContentSchema.safeParse(withSteps({ ...steps, intro })).success).toBe(false);
  });
});

describe('content loading', () => {
  it('loads Patch and the narrative from the shipped tree', () => {
    const content = loadShippedContent();
    expect(content.npcs?.map((n) => n.key)).toContain('patch');
    expect(content.onboarding?.equipment?.flow).toBe('equipment');
  });

  it('refuses a narrative that names an unknown NPC', () => {
    const flow = EquipmentOnboardingContentSchema.parse({ ...shippedFlow(), npc: 'nobody' });
    const content = { npcs: [], onboarding: { equipment: flow } } as unknown as LoadedContent;
    expect(() => validateOnboardingContent(content)).toThrow(ContentValidationError);
  });

  it('is a no-op for snapshots without onboarding content', () => {
    expect(() => validateOnboardingContent({} as LoadedContent)).not.toThrow();
  });
});

describe('the level-35 label on level-up screens', () => {
  const content = loadShippedContent();
  const label = content.onboarding!.equipment!.levelUpLabel;
  const progression = (enabled: boolean) =>
    createProgressionService({
      config: content.tables.progression,
      baseMaxEnergy: content.tables.energy.baseMax,
      extraLevelRewardLabels: (level) => equipmentOnboardingLevelLabels(level, { enabled, label }),
    });

  it('is appended after the tables.json rewards at level 35 only', () => {
    const svc = progression(true);
    expect(svc.describeLevelRewards(35).at(-1)).toBe(label);
    expect(svc.describeLevelRewards(34)).not.toContain(label);
    expect(svc.describeLevelRewards(36)).not.toContain(label);
  });

  it('is absent while the onboarding is switched off', () => {
    expect(progression(false).describeLevelRewards(35)).not.toContain(label);
  });

  it('leaves a progression service built without the hook unchanged', () => {
    const plain = createProgressionService({
      config: content.tables.progression,
      baseMaxEnergy: content.tables.energy.baseMax,
    });
    expect(plain.describeLevelRewards(35)).toEqual(progression(true).describeLevelRewards(35).slice(0, -1));
  });
});
