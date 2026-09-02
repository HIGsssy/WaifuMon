/**
 * The item-effect formatter: mechanics rendered from the structured item
 * columns only, never from the slug and never from the flavour description.
 */
import { describe, expect, it } from 'vitest';
import {
  formatItemEffectLines,
  formatItemEffects,
  formatItemEffectsInline,
} from '../../src/modules/items/itemEffects';
import { formatShopEntry } from '../../src/discord/commands/waifumon';
import type { ItemRow } from '../../src/db/schema';

const item = (overrides: Partial<ItemRow> = {}): ItemRow =>
  ({
    id: 1,
    slug: 'basic_charm',
    name: 'Basic Charm',
    category: 'capture',
    captureModifier: null,
    captureBonus: null,
    captureRarities: null,
    isGuaranteedCapture: false,
    shopRegions: ['waifu-valley'],
    buyPrice: 25,
    priceCurrency: 'waifubux',
    dailyStockLimit: null,
    effectType: null,
    effectConfig: null,
    description: '',
    emoji: '🩷',
    enabled: true,
    ...overrides,
  }) as ItemRow;

describe('formatItemEffects — capture charms', () => {
  it('renders a capture modifier as multiplicative capture power', () => {
    expect(formatItemEffects(item({ captureModifier: 1.5 }))).toEqual([
      { label: 'Capture Power', value: '1.5×' },
    ]);
    expect(formatItemEffectsInline(item({ captureModifier: 2.25 }))).toBe('Capture Power: 2.25×');
    expect(formatItemEffectsInline(item({ captureModifier: 5 }))).toBe('Capture Power: 5×');
  });

  it('renders an additive bonus as a percentage and lists eligible rarities', () => {
    expect(
      formatItemEffectLines(
        item({
          slug: 'shibari_rope',
          captureModifier: 1,
          captureBonus: 0.15,
          captureRarities: ['SSR', 'UR', 'LR', 'EX'],
        }),
      ),
    ).toEqual(['Effect: +15% Capture Chance', 'Effective against: SSR • UR • LR • EX']);

    expect(
      formatItemEffectLines(
        item({ captureModifier: 1, captureBonus: 0.3, captureRarities: ['N', 'R', 'SR'] }),
      ),
    ).toEqual(['Effect: +30% Capture Chance', 'Effective against: N • R • SR']);
  });

  it('omits the rarity line when the item works on everything', () => {
    expect(formatItemEffectLines(item({ captureModifier: 1.5, captureRarities: [] }))).toEqual([
      'Capture Power: 1.5×',
    ]);
  });

  it('states a guaranteed capture instead of any chance maths', () => {
    expect(
      formatItemEffectLines(
        item({ slug: 'mythic_contract', isGuaranteedCapture: true, captureModifier: null }),
      ),
    ).toEqual(['Effect: Guaranteed Capture']);
  });
});

describe('formatItemEffects — consumables', () => {
  it('renders a fixed energy restore with its amount', () => {
    expect(
      formatItemEffectLines(
        item({
          category: 'consumable',
          effectType: 'restore_energy_amount',
          effectConfig: { amount: 5, exitCareMode: true },
        }),
      ),
    ).toEqual(['Effect: Restores 5 Hunt Energy', 'Additional effect: Exits Care Mode']);
  });

  it('renders a full energy restore', () => {
    expect(
      formatItemEffectLines(
        item({
          category: 'consumable',
          effectType: 'restore_energy_full',
          effectConfig: { restoreToMax: true, exitCareMode: true },
        }),
      ),
    ).toEqual(['Effect: Fully restores Hunt Energy', 'Additional effect: Exits Care Mode']);
  });

  it('renders a charged capture bonus with its duration', () => {
    expect(
      formatItemEffectLines(
        item({
          category: 'consumable',
          effectType: 'capture_bonus_charges',
          effectConfig: { captureBonus: 0.03, charges: 5, refreshBehavior: 'refresh' },
        }),
      ),
    ).toEqual(['Effect: +3% Capture Chance', 'Duration: Next 5 capture attempts']);
  });

  it('has nothing to say about an item with no mechanics', () => {
    expect(formatItemEffects(item({ category: 'material' }))).toEqual([]);
  });
});

describe('formatShopEntry', () => {
  it('keeps the flavour description and adds the mechanics beneath it', () => {
    const entry = formatShopEntry(
      item({
        slug: 'shibari_rope',
        name: 'Shibari Rope',
        emoji: '🪢',
        captureModifier: 1,
        captureBonus: 0.15,
        captureRarities: ['SSR', 'UR', 'LR', 'EX'],
        buyPrice: 750,
        description: 'A more elegant bind for the most refined.',
      }),
      'waifubux',
      2,
    );
    expect(entry).toBe(
      '🪢 **Shibari Rope**\n' +
        '*A more elegant bind for the most refined.*\n' +
        'Effect: +15% Capture Chance\n' +
        'Effective against: SSR • UR • LR • EX\n' +
        'Price: **750 💰 WB** · owned ×2',
    );
  });
});
