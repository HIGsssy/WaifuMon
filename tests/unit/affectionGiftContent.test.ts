/**
 * Content-schema and cross-file validation for the Affection Gift System and
 * the new capture-item fields. Pure — no DB, no I/O.
 *
 * The point of these is that bad *content* fails loudly at load time rather
 * than minting a gift nobody can claim or an item whose bonus is silently
 * inert.
 */
import { describe, expect, it } from 'vitest';
import { validateContentSet } from '../../src/modules/content/loader';
import {
  AffectionGiftsConfigSchema,
  ItemContentSchema,
  TablesFileSchema,
  type LoadedContent,
} from '../../src/modules/content/schemas';
import { computeCaptureChance } from '../../src/modules/capture/captureMath';
import { isCaptureItemEligible } from '../../src/modules/capture/captureService';
import { ContentValidationError } from '../../src/shared/errors';
import { loadShippedContent } from '../helpers/fixtures';
import type { ItemRow } from '../../src/db/schema';

const SHIPPED = loadShippedContent();

// ───────────────────────── gift config validation ───────────────────────

describe('AffectionGiftsConfigSchema', () => {
  const valid = {
    enabled: true,
    tiers: [{ minAffection: 500, dailyChance: 0.1, guaranteeAfter: 7, tier: 'low' }],
    lootTable: [{ slug: 'quickie_coffee', quantity: 1, weight: 100 }],
  };

  it('accepts the shipped shape', () => {
    expect(AffectionGiftsConfigSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['a fractional weight', { weight: 10.5 }],
    ['a zero weight', { weight: 0 }],
    ['a negative weight', { weight: -5 }],
  ])('rejects %s', (_label, patch) => {
    const parsed = AffectionGiftsConfigSchema.safeParse({
      ...valid,
      lootTable: [{ ...valid.lootTable[0], ...patch }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-positive guarantee', () => {
    const parsed = AffectionGiftsConfigSchema.safeParse({
      ...valid,
      tiers: [{ ...valid.tiers[0], guaranteeAfter: 0 }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a chance outside [0, 1]', () => {
    expect(
      AffectionGiftsConfigSchema.safeParse({
        ...valid,
        tiers: [{ ...valid.tiers[0], dailyChance: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it('rejects tiers that are not ascending and distinct', () => {
    const parsed = AffectionGiftsConfigSchema.safeParse({
      ...valid,
      tiers: [
        { minAffection: 1500, dailyChance: 0.15, guaranteeAfter: 6, tier: 'mid' },
        { minAffection: 500, dailyChance: 0.1, guaranteeAfter: 7, tier: 'low' },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate loot slugs', () => {
    expect(
      AffectionGiftsConfigSchema.safeParse({
        ...valid,
        lootTable: [valid.lootTable[0], valid.lootTable[0]],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty table while enabled, but allows one while disabled', () => {
    expect(
      AffectionGiftsConfigSchema.safeParse({ ...valid, lootTable: [] }).success,
    ).toBe(false);
    expect(
      AffectionGiftsConfigSchema.safeParse({ enabled: false, tiers: [], lootTable: [] })
        .success,
    ).toBe(true);
  });

  it('defaults to disabled when tables.json omits the block', () => {
    const { affectionGifts, ...rest } = SHIPPED.tables as Record<string, unknown>;
    void affectionGifts;
    const parsed = TablesFileSchema.safeParse(rest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.affectionGifts.enabled).toBe(false);
  });
});

// ──────────────────── cross-file loot table validation ──────────────────

describe('validateContentSet — gift loot references', () => {
  function withGiftTable(
    lootTable: Array<{ slug: string; quantity: number; weight: number }>,
    items = SHIPPED.items,
  ): LoadedContent {
    return {
      ...SHIPPED,
      items,
      tables: {
        ...SHIPPED.tables,
        affectionGifts: { ...SHIPPED.tables.affectionGifts, lootTable },
      },
    };
  }

  it('passes on the shipped content', () => {
    expect(() => validateContentSet(SHIPPED)).not.toThrow();
  });

  it('rejects an unknown item slug', () => {
    expect(() =>
      validateContentSet(withGiftTable([{ slug: 'not_a_real_item', quantity: 1, weight: 1 }])),
    ).toThrow(ContentValidationError);
  });

  it('rejects a disabled item slug', () => {
    const items = SHIPPED.items.map((i) =>
      i.slug === 'quickie_coffee' ? { ...i, enabled: false } : i,
    );
    expect(() =>
      validateContentSet(
        withGiftTable([{ slug: 'quickie_coffee', quantity: 1, weight: 1 }], items),
      ),
    ).toThrow(/disabled item slug: quickie_coffee/);
  });

  it('ignores the loot table entirely while gifts are disabled', () => {
    const content: LoadedContent = {
      ...SHIPPED,
      tables: {
        ...SHIPPED.tables,
        affectionGifts: {
          ...SHIPPED.tables.affectionGifts,
          enabled: false,
          lootTable: [{ slug: 'not_a_real_item', quantity: 1, weight: 1 }],
        },
      },
    };
    expect(() => validateContentSet(content)).not.toThrow();
  });
});

// ───────────────────── capture-item content validation ──────────────────

describe('ItemContentSchema — capture fields', () => {
  const base = {
    slug: 'test_item',
    name: 'Test',
    category: 'capture',
    captureModifier: 1,
  };

  it('accepts an additive bonus with a rarity gate', () => {
    const parsed = ItemContentSchema.safeParse({
      ...base,
      captureBonus: 0.3,
      captureRarities: ['N', 'R', 'SR'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.captureRarities).toEqual(['N', 'R', 'SR']);
  });

  it('normalizes an empty rarity list to "every rarity"', () => {
    const parsed = ItemContentSchema.safeParse({ ...base, captureRarities: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.captureRarities).toBeNull();
  });

  it('rejects a capture bonus on a non-capture item', () => {
    expect(
      ItemContentSchema.safeParse({
        ...base,
        category: 'consumable',
        captureModifier: null,
        captureBonus: 0.3,
      }).success,
    ).toBe(false);
  });

  it('rejects a capture bonus on a guaranteed-capture item', () => {
    expect(
      ItemContentSchema.safeParse({
        ...base,
        captureModifier: null,
        isGuaranteedCapture: true,
        captureBonus: 0.3,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown rarity and a duplicated one', () => {
    expect(
      ItemContentSchema.safeParse({ ...base, captureRarities: ['SSS'] }).success,
    ).toBe(false);
    expect(
      ItemContentSchema.safeParse({ ...base, captureRarities: ['N', 'N'] }).success,
    ).toBe(false);
  });

  it('rejects a bonus above the direct-item ceiling', () => {
    expect(ItemContentSchema.safeParse({ ...base, captureBonus: 0.9 }).success).toBe(false);
  });

  it('validates the new energy effect config by type', () => {
    expect(
      ItemContentSchema.safeParse({
        slug: 'coffee',
        name: 'Coffee',
        category: 'consumable',
        captureModifier: null,
        effectType: 'restore_energy_amount',
        effectConfig: { amount: 5, exitCareMode: true },
      }).success,
    ).toBe(true);
    // Zero, fractional, and foreign fields are all rejected by name.
    expect(
      ItemContentSchema.safeParse({
        slug: 'coffee',
        name: 'Coffee',
        category: 'consumable',
        captureModifier: null,
        effectType: 'restore_energy_amount',
        effectConfig: { amount: 0 },
      }).success,
    ).toBe(false);
    expect(
      ItemContentSchema.safeParse({
        slug: 'coffee',
        name: 'Coffee',
        category: 'consumable',
        captureModifier: null,
        effectType: 'restore_energy_amount',
        effectConfig: { amount: 5, charges: 3 },
      }).success,
    ).toBe(false);
  });
});

// ────────────────────────── eligibility + math ──────────────────────────

describe('isCaptureItemEligible', () => {
  const item = (captureRarities: string[] | null) =>
    ({ captureRarities }) as unknown as ItemRow;

  it('treats null and empty as "every rarity" — that is what a charm is', () => {
    for (const rarity of ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX']) {
      expect(isCaptureItemEligible(item(null), rarity)).toBe(true);
      expect(isCaptureItemEligible(item([]), rarity)).toBe(true);
    }
  });

  it('gates on the configured list, never on a slug', () => {
    const cuffs = item(['N', 'R', 'SR']);
    expect(isCaptureItemEligible(cuffs, 'SR')).toBe(true);
    expect(isCaptureItemEligible(cuffs, 'SSR')).toBe(false);
    const rope = item(['SSR', 'UR', 'LR', 'EX']);
    expect(isCaptureItemEligible(rope, 'SSR')).toBe(true);
    expect(isCaptureItemEligible(rope, 'SR')).toBe(false);
  });
});

describe('computeCaptureChance — the item bonus term', () => {
  const config = SHIPPED.tables.capture;

  it('is additive in probability points, not a multiplier', () => {
    const plain = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'SR',
      captureModifier: 1,
      config,
    });
    const withBonus = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'SR',
      captureModifier: 1,
      config,
      itemCaptureBonus: 0.3,
    });
    expect(withBonus - plain).toBeCloseTo(0.3, 10);
    // A 30% *increase* would land at 0.286 — the difference is the whole point.
    expect(withBonus).not.toBeCloseTo(plain * 1.3, 3);
  });

  it.each([
    ['SR', 0.3, 0.52],
    ['SSR', 0.15, 0.27],
    ['UR', 0.15, 0.21],
    ['LR', 0.15, 0.18],
  ])('%s + %f lands at %f', (rarity, bonus, expected) => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: rarity as 'SR',
        captureModifier: 1,
        config,
        itemCaptureBonus: bonus as number,
      }),
    ).toBeCloseTo(expected as number, 10);
  });

  it('stacks with the other additive terms and still respects the clamp', () => {
    const stacked = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'SR',
      captureModifier: 1,
      config,
      buddyAffinityModifier: 0.01,
      captureBonusModifier: 0.03,
      itemCaptureBonus: 0.3,
    });
    expect(stacked).toBeCloseTo(0.56, 10);

    const clamped = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'N',
      captureModifier: 2.25,
      config,
      itemCaptureBonus: 0.3,
    });
    expect(clamped).toBe(config.maxChance);
  });

  it('a guaranteed capture ignores the bonus and the max clamp alike', () => {
    expect(
      computeCaptureChance({
        guaranteed: true,
        baseCaptureRate: null,
        rarity: 'LR',
        captureModifier: null,
        config,
        itemCaptureBonus: 0.15,
      }),
    ).toBe(1);
    expect(config.maxChance).toBeLessThan(1);
  });
});
