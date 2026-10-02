/**
 * `content/equipment/workshop.json` — strict validation, the shipped V1
 * tuning, and the rules that keep the loop a sink.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EquipmentWorkshopFileSchema,
  salvageYieldList,
  salvageYieldOf,
  workshopArtworkCandidates,
  workshopConfigFromFile,
} from '../../src/modules/equipment/workshopConfig';
import { dismantleBlocker } from '../../src/modules/equipment/equipmentWorkshopService';

const SHIPPED = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'content', 'equipment', 'workshop.json'), 'utf8'),
);

const recipe = (over: Record<string, unknown> = {}) => ({
  key: 'standard_rebuild',
  name: 'Standard Rebuild',
  rarity: 'N',
  componentCost: 5,
  waifubuxCost: 250,
  enabled: true,
  ...over,
});
const file = (over: Record<string, unknown> = {}) => ({
  format: 'waifumon-equipment-workshop',
  version: 1,
  salvageYields: { N: 1, R: 4, SR: 12 },
  recipes: [recipe()],
  ...over,
});

const issues = (input: unknown) => {
  const parsed = EquipmentWorkshopFileSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('the shipped Workshop file', () => {
  it('is valid and carries the V1 tuning', () => {
    const config = workshopConfigFromFile(EquipmentWorkshopFileSchema.parse(SHIPPED));
    expect(config.salvageYields).toEqual({ N: 1, R: 4, SR: 12 });
    // No Workshop image ships yet: null, never a placeholder path.
    expect(config.artworkPath).toBeNull();
    expect(
      config.recipes.map((r) => [r.key, r.name, r.rarity, r.componentCost, r.waifubuxCost, r.enabled]),
    ).toEqual([
      ['standard_rebuild', 'Standard Rebuild', 'N', 5, 250, true],
      ['improved_rebuild', 'Improved Rebuild', 'R', 15, 750, true],
      ['advanced_rebuild', 'Advanced Rebuild', 'SR', 40, 2000, true],
    ]);
  });
});

describe('validation', () => {
  it('accepts a minimal file', () => {
    expect(issues(file())).toEqual([]);
  });

  it.each([
    ['an unknown top-level field', file({ sellPrices: {} }), 'Unrecognized key'],
    ['a wrong format', file({ format: 'waifumon-equipment' }), 'format'],
    ['an unknown rarity yield', file({ salvageYields: { N: 1, XR: 3 } }), 'unknown rarity "XR"'],
    ['a zero yield', file({ salvageYields: { N: 0 } }), 'salvageYields.N'],
    ['a fractional cost', file({ recipes: [recipe({ componentCost: 5.5 })] }), 'componentCost'],
    ['a negative WaifuBux cost', file({ recipes: [recipe({ waifubuxCost: -1 })] }), 'waifubuxCost'],
    ['an SSR recipe (no random SSR yet)', file({ recipes: [recipe({ rarity: 'SSR' })] }), 'rarity'],
    ['a recipe naming a definition', file({ recipes: [recipe({ definitionKey: 'rusty_pipe' })] }), 'Unrecognized key'],
    ['a duplicate key', file({ recipes: [recipe(), recipe({ name: 'Again' })] }), 'duplicate recipe key'],
    ['a bad key', file({ recipes: [recipe({ key: 'Standard Rebuild' })] }), 'snake_case'],
  ])('refuses %s', (_label, input, expected) => {
    expect(issues(input).join('\n')).toContain(expected);
  });

  it('refuses a recipe that costs no more Components than its output salvages for', () => {
    // fabricate 4 → dismantle 4 would be free; 3 would print Components.
    for (const componentCost of [3, 4]) {
      expect(issues(file({ recipes: [recipe({ rarity: 'R', componentCost })] })).join('\n')).toContain(
        'must exceed the R salvage yield (4)',
      );
    }
    expect(issues(file({ recipes: [recipe({ rarity: 'R', componentCost: 5 })] }))).toEqual([]);
  });
});

describe('yields', () => {
  const config = workshopConfigFromFile(EquipmentWorkshopFileSchema.parse(file()));

  it('values a configured rarity and refuses to guess any other', () => {
    expect(salvageYieldOf(config, 'R')).toBe(4);
    for (const rarity of ['SSR', 'UR', 'EX', 'constructor', '']) expect(salvageYieldOf(config, rarity)).toBeNull();
    expect(salvageYieldOf(null, 'N')).toBeNull();
    expect(salvageYieldList(config)).toEqual([
      { rarity: 'N', components: 1 },
      { rarity: 'R', components: 4 },
      { rarity: 'SR', components: 12 },
    ]);
  });

  it('decides dismantle eligibility in the service’s order', () => {
    const item = (over: Partial<{ equipped: boolean; isFavorite: boolean; isLocked: boolean; rarity: string }> = {}) => ({
      equipped: over.equipped ?? false,
      isFavorite: over.isFavorite ?? false,
      isLocked: over.isLocked ?? false,
      definition: { rarity: over.rarity ?? 'N' },
    });
    expect(dismantleBlocker(item(), config)).toBeNull();
    expect(dismantleBlocker(item({ equipped: true, isFavorite: true, isLocked: true }), config)).toBe('equipped');
    expect(dismantleBlocker(item({ isFavorite: true, isLocked: true }), config)).toBe('favorite');
    expect(dismantleBlocker(item({ isLocked: true }), config)).toBe('locked');
    expect(dismantleBlocker(item({ rarity: 'SSR' }), config)).toBe('unsupported_rarity');
    expect(dismantleBlocker(item(), null)).toBe('unsupported_rarity');
  });
});

describe('artwork', () => {
  it('accepts a safe relative image path under the convention', () => {
    const parsed = EquipmentWorkshopFileSchema.parse(file({ artworkPath: 'equipment/workshop/patch-workshop.webp' }));
    expect(workshopConfigFromFile(parsed).artworkPath).toBe('equipment/workshop/patch-workshop.webp');
  });

  it('allows null, and treats an absent field as null', () => {
    expect(workshopConfigFromFile(EquipmentWorkshopFileSchema.parse(file({ artworkPath: null }))).artworkPath).toBeNull();
    expect(workshopConfigFromFile(EquipmentWorkshopFileSchema.parse(file())).artworkPath).toBeNull();
  });

  it.each([
    ['traversal', '../secrets/patch.webp'],
    ['nested traversal', 'equipment/../../etc/passwd.png'],
    ['an absolute path', '/etc/patch.webp'],
    ['a URL', 'https://example.com/patch.webp'],
    ['a backslash', 'equipment\\workshop\\patch.webp'],
    ['a non-image extension', 'equipment/workshop/patch.svg'],
    ['an empty string', ''],
  ])('refuses %s', (_label, artworkPath) => {
    expect(issues(file({ artworkPath })).join('\n')).toMatch(/artworkPath/);
  });

  const workshop = { artworkPath: 'equipment/workshop/patch-workshop.webp' };
  const patch = { portraitPath: 'npcs/patch.png' };

  it('prefers the Workshop artwork over Patch’s portrait', () => {
    expect(workshopArtworkCandidates(workshop, patch)).toEqual([
      { source: 'workshop', relativePath: 'equipment/workshop/patch-workshop.webp' },
      { source: 'patch', relativePath: 'npcs/patch.png' },
    ]);
  });

  it('falls back to Patch’s portrait, then to nothing (text-only)', () => {
    expect(workshopArtworkCandidates({ artworkPath: null }, patch)).toEqual([{ source: 'patch', relativePath: 'npcs/patch.png' }]);
    expect(workshopArtworkCandidates(null, { portraitPath: null })).toEqual([]);
    expect(workshopArtworkCandidates(null, null)).toEqual([]);
  });
});
