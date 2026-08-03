import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadContent,
  resolveAssetPath,
  validateSpeciesAssets,
} from '../../src/modules/content/loader';
import {
  BuddyAffinityConfigSchema,
  CareModeConfigSchema,
  ItemContentSchema,
  SpeciesContentSchema,
  TablesFileSchema,
} from '../../src/modules/content/schemas';
import { AFFINITIES } from '../../src/db/schema';
import { ContentValidationError } from '../../src/shared/errors';
import { ASSETS_DIR, CONTENT_DIR, loadShippedContent } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

describe('shipped content', () => {
  it('loads and validates, with every referenced image present', () => {
    const content = loadShippedContent();
    // 5 capture items + 2 utility consumables (Energy Drink, Microdose).
    expect(content.items.length).toBe(7);
    expect(content.species.length).toBeGreaterThanOrEqual(5);
    // No shipped species may be auto-disabled by a missing image.
    expect(content.species.filter((s) => !s.enabled)).toEqual([]);
  });

  it('ships Prismatic Charm listed but not purchasable, and Mythic Contract guaranteed + never sold', () => {
    const content = loadShippedContent();
    const prismatic = content.items.find((i) => i.slug === 'prismatic_charm');
    expect(prismatic?.enabled).toBe(true);
    expect(prismatic?.purchasable).toBe(false);
    const mythic = content.items.find((i) => i.slug === 'mythic_contract');
    expect(mythic?.isGuaranteedCapture).toBe(true);
    expect(mythic?.purchasable).toBe(false);
    expect(mythic?.buyPrice).toBeNull();
  });

  it('ships Basic/Silk/Velvet purchasable at the launch prices', () => {
    const content = loadShippedContent();
    const prices = Object.fromEntries(
      content.items
        .filter((i) => i.purchasable && i.category === 'capture')
        .map((i) => [i.slug, i.buyPrice]),
    );
    expect(prices).toEqual({ basic_charm: 25, silk_charm: 75, velvet_charm: 200 });
  });

  it('ships Energy Drink and Microdose with validated effect config and pricing', () => {
    const content = loadShippedContent();
    const drink = content.items.find((i) => i.slug === 'energy_drink');
    expect(drink).toMatchObject({
      category: 'consumable',
      purchasable: true,
      buyPrice: 500,
      priceCurrency: 'waifubux',
      effectType: 'restore_energy_full',
      effectConfig: { restoreToMax: true, exitCareMode: true },
    });

    const microdose = content.items.find((i) => i.slug === 'microdose');
    expect(microdose).toMatchObject({
      category: 'consumable',
      purchasable: true,
      buyPrice: 40,
      priceCurrency: 'essence',
      effectType: 'capture_bonus_charges',
      effectConfig: { captureBonus: 0.03, charges: 5, refreshBehavior: 'refresh' },
    });
  });

  it('leaves every non-effect item with a null effect and WaifuBux pricing', () => {
    const content = loadShippedContent();
    for (const charm of content.items.filter((i) => i.category === 'capture')) {
      expect(charm.effectType, charm.slug).toBeNull();
      expect(charm.effectConfig, charm.slug).toBeNull();
      expect(charm.priceCurrency, charm.slug).toBe('waifubux');
    }
  });
});

describe('schema invariants', () => {
  const baseItem = {
    slug: 'test_item',
    name: 'Test',
    category: 'capture',
    captureModifier: 1,
  };

  it('rejects guaranteed-capture items marked purchasable', () => {
    const result = ItemContentSchema.safeParse({
      ...baseItem,
      isGuaranteedCapture: true,
      purchasable: true,
      buyPrice: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects purchasable items without a buy price', () => {
    const result = ItemContentSchema.safeParse({ ...baseItem, purchasable: true });
    expect(result.success).toBe(false);
  });

  it('rejects unknown content ratings', () => {
    const result = SpeciesContentSchema.safeParse({
      slug: 'x',
      name: 'X',
      rarity: 'N',
      archetype: 'test',
      contentRating: 'wholesome',
      imagePath: 'waifumon/x/standard.png',
    });
    expect(result.success).toBe(false);
  });

  it('defaults an item with no effect to null config and WaifuBux pricing', () => {
    const parsed = ItemContentSchema.parse(baseItem);
    expect(parsed.effectType).toBeNull();
    expect(parsed.effectConfig).toBeNull();
    expect(parsed.priceCurrency).toBe('waifubux');
  });

  it('fills restore_energy_full defaults and rejects capture-only fields on it', () => {
    const ok = ItemContentSchema.parse({
      ...baseItem,
      category: 'consumable',
      captureModifier: null,
      effectType: 'restore_energy_full',
      effectConfig: { restoreToMax: true },
    });
    expect(ok.effectConfig).toEqual({ restoreToMax: true, exitCareMode: true });

    const mixed = ItemContentSchema.safeParse({
      ...baseItem,
      category: 'consumable',
      captureModifier: null,
      effectType: 'restore_energy_full',
      effectConfig: { restoreToMax: true, captureBonus: 0.03 },
    });
    expect(mixed.success).toBe(false);
  });

  it('requires capture-bonus fields and bounds them', () => {
    const ok = ItemContentSchema.parse({
      ...baseItem,
      category: 'consumable',
      captureModifier: null,
      effectType: 'capture_bonus_charges',
      effectConfig: { captureBonus: 0.03, charges: 5 },
    });
    expect(ok.effectConfig).toEqual({
      captureBonus: 0.03,
      charges: 5,
      refreshBehavior: 'refresh',
    });

    const invalid = [
      {},
      { captureBonus: 0.03 },
      { charges: 5 },
      { captureBonus: 0.5, charges: 5 },
      { captureBonus: -0.01, charges: 5 },
      { captureBonus: 0.03, charges: 0 },
      { captureBonus: 0.03, charges: 1.5 },
      { captureBonus: 0.03, charges: 5, restoreToMax: true },
    ];
    for (const effectConfig of invalid) {
      const result = ItemContentSchema.safeParse({
        ...baseItem,
        category: 'consumable',
        captureModifier: null,
        effectType: 'capture_bonus_charges',
        effectConfig,
      });
      expect(result.success, JSON.stringify(effectConfig)).toBe(false);
    }
  });

  it('rejects an unknown effect type, an effect config with no type, and a bad currency', () => {
    expect(
      ItemContentSchema.safeParse({ ...baseItem, effectType: 'mind_control' }).success,
    ).toBe(false);
    expect(
      ItemContentSchema.safeParse({ ...baseItem, effectConfig: { captureBonus: 0.03 } }).success,
    ).toBe(false);
    expect(
      ItemContentSchema.safeParse({ ...baseItem, priceCurrency: 'doubloons' }).success,
    ).toBe(false);
  });
});

describe('species affinity (5D)', () => {
  const baseSpecies = {
    slug: 'affinity_probe',
    name: 'Affinity Probe',
    rarity: 'N',
    archetype: 'test',
    contentRating: 'suggestive',
    imagePath: 'waifumon/x/standard.png',
  };

  it('accepts every valid affinity value', () => {
    for (const affinity of AFFINITIES) {
      const parsed = SpeciesContentSchema.safeParse({ ...baseSpecies, affinity });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.affinity).toBe(affinity);
    }
  });

  it('rejects an invalid affinity value', () => {
    expect(SpeciesContentSchema.safeParse({ ...baseSpecies, affinity: 'brat' }).success).toBe(
      false,
    );
    expect(SpeciesContentSchema.safeParse({ ...baseSpecies, affinity: '' }).success).toBe(false);
    expect(SpeciesContentSchema.safeParse({ ...baseSpecies, affinity: null }).success).toBe(false);
  });

  it('defaults a missing affinity to switch (backward compatibility)', () => {
    const parsed = SpeciesContentSchema.parse(baseSpecies);
    expect(parsed.affinity).toBe('switch');
  });

  it('does not confuse affinity with archetype', () => {
    const parsed = SpeciesContentSchema.parse({
      ...baseSpecies,
      archetype: 'kitsune',
      affinity: 'dominant',
    });
    expect(parsed.archetype).toBe('kitsune');
    expect(parsed.affinity).toBe('dominant');
  });

  it('every shipped species is affinity switch after this patch', () => {
    const content = loadShippedContent();
    expect(content.species.length).toBeGreaterThan(0);
    const offenders = content.species.filter((s) => s.affinity !== 'switch');
    expect(offenders.map((s) => s.slug)).toEqual([]);
  });
});

describe('buddyAffinity config schema (5D)', () => {
  const base = {
    styles: [...AFFINITIES],
    wheel: {
      dominant: 'submissive',
      submissive: 'caregiver',
      caregiver: 'primal',
      primal: 'dominant',
    },
    neutralStyles: ['switch'],
    strongBonusByRarity: { N: 0.01, R: 0.02, SR: 0.03, SSR: 0.04, UR: 0.05, LR: 0.06, EX: 0.06 },
    weakPenaltyByRarity: { N: 0, R: 0, SR: 0, SSR: 0, UR: 0, LR: 0, EX: 0 },
  };

  it('accepts the shipped shape', () => {
    expect(BuddyAffinityConfigSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unknown affinity anywhere in the block', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({ ...base, styles: [...AFFINITIES, 'brat'] }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, dominant: 'brat' },
      }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({ ...base, wheel: { brat: 'submissive' } }).success,
    ).toBe(false);
  });

  it('rejects a wheel edge that gives a neutral style a strength or weakness', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, switch: 'dominant' },
      }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, dominant: 'switch' },
      }).success,
    ).toBe(false);
  });

  it('rejects a style that beats itself', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, dominant: 'dominant' },
      }).success,
    ).toBe(false);
  });

  it('rejects negative bonuses and penalties', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        strongBonusByRarity: { ...base.strongBonusByRarity, N: -0.01 },
      }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        weakPenaltyByRarity: { ...base.weakPenaltyByRarity, N: -0.01 },
      }).success,
    ).toBe(false);
  });

  it('requires a complete rarity ladder for both maps', () => {
    const { EX: _dropped, ...partial } = base.strongBonusByRarity;
    expect(
      BuddyAffinityConfigSchema.safeParse({ ...base, strongBonusByRarity: partial }).success,
    ).toBe(false);
  });

  it('tables.json omitting the block falls back to an all-neutral default', () => {
    const parsed = TablesFileSchema.parse({
      ...loadShippedContent().tables,
      buddyAffinity: undefined,
    });
    expect(parsed.buddyAffinity.wheel).toEqual({});
    expect(parsed.buddyAffinity.neutralStyles).toEqual(['switch']);
    expect(Object.values(parsed.buddyAffinity.strongBonusByRarity).every((v) => v === 0)).toBe(
      true,
    );
  });
});

describe('careMode config schema', () => {
  const base = {
    enabled: true,
    intervalMinutes: 30,
    energyPerTick: 1,
    recoveryCap: 20,
    waifuXpPerTick: 2,
    affectionPerTick: 1,
  };
  it('accepts the shipped shape', () => {
    expect(CareModeConfigSchema.safeParse(base).success).toBe(true);
  });
  it('rejects a non-positive intervalMinutes', () => {
    expect(CareModeConfigSchema.safeParse({ ...base, intervalMinutes: 0 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, intervalMinutes: -5 }).success).toBe(false);
  });
  it('rejects negative per-tick fields', () => {
    expect(CareModeConfigSchema.safeParse({ ...base, energyPerTick: -1 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, waifuXpPerTick: -1 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, affectionPerTick: -1 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, recoveryCap: -1 }).success).toBe(false);
  });
  it('requires all fields (no defaults except enabled)', () => {
    expect(CareModeConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe('asset validation', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const species = (imagePath: string) =>
    SpeciesContentSchema.parse({
      slug: 'ghost',
      name: 'Ghost',
      rarity: 'N',
      archetype: 'spirit',
      contentRating: 'suggestive',
      imagePath,
    });

  it('disables species whose image is missing (never renders a broken card)', () => {
    const result = validateSpeciesAssets([species('waifumon/nope/standard.png')], ASSETS_DIR, silentLogger());
    expect(result[0]?.enabled).toBe(false);
  });

  it('keeps species whose image exists enabled', () => {
    const result = validateSpeciesAssets(
      [species('waifumon/neon_kitsune/standard.png')],
      ASSETS_DIR,
      silentLogger(),
    );
    expect(result[0]?.enabled).toBe(true);
  });

  it('rejects image paths escaping the assets directory', () => {
    expect(() => resolveAssetPath(ASSETS_DIR, '../secrets.txt')).toThrow(ContentValidationError);
  });

  it('fails startup loudly on a dailyPackage slug that is not an item', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-content-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'species'));
    fs.copyFileSync(path.join(CONTENT_DIR, 'items.json'), path.join(dir, 'items.json'));
    fs.copyFileSync(
      path.join(CONTENT_DIR, 'species', 'placeholders.json'),
      path.join(dir, 'species', 'placeholders.json'),
    );
    fs.writeFileSync(
      path.join(dir, 'tables.json'),
      JSON.stringify({
        energy: { baseMax: 25 },
        inventory: { captureCapacity: 50 },
        dailyPackage: { waifubux: 100, items: { nonexistent_charm: 1 } },
      }),
    );
    expect(() => loadContent(dir, ASSETS_DIR, silentLogger())).toThrow(ContentValidationError);
  });
});
