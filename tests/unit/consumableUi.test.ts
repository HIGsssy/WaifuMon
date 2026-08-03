/**
 * Pure render helpers for the shop/items expansion: price + currency labels,
 * the capture-buff status line, and the item-use result copy.
 */
import { describe, expect, it } from 'vitest';
import {
  currencyLabel,
  effectSummary,
  formatCaptureBonus,
  formatItemUseResult,
  formatPrice,
  renderCaptureBonusLine,
} from '../../src/discord/commands/waifumon';
import type { ItemRow } from '../../src/db/schema';

const item = (overrides: Partial<ItemRow> = {}): ItemRow =>
  ({
    id: 1,
    slug: 'energy_drink',
    name: 'Energy Drink',
    category: 'consumable',
    captureModifier: null,
    isGuaranteedCapture: false,
    purchasable: true,
    buyPrice: 500,
    priceCurrency: 'waifubux',
    dailyStockLimit: null,
    effectType: 'restore_energy_full',
    effectConfig: { restoreToMax: true, exitCareMode: true },
    description: '',
    emoji: '🥤',
    enabled: true,
    ...overrides,
  }) as ItemRow;

describe('currency + price labels', () => {
  it('names the currency explicitly so a price is never ambiguous', () => {
    expect(currencyLabel('waifubux')).toContain('WB');
    expect(currencyLabel('essence')).toContain('Essence');
    expect(formatPrice(500, 'waifubux')).toBe('500 💰 WB');
    expect(formatPrice(40, 'essence')).toBe('40 ✨ Essence');
  });
});

describe('formatCaptureBonus', () => {
  it('renders a flat modifier as a percentage', () => {
    expect(formatCaptureBonus(0.03)).toBe('+3%');
    expect(formatCaptureBonus(0.025)).toBe('+2.5%');
    expect(formatCaptureBonus(0)).toBe('+0%');
  });
});

describe('renderCaptureBonusLine', () => {
  it('shows the bonus amount and charges remaining', () => {
    const line = renderCaptureBonusLine(
      { modifier: 0.03, chargesRemaining: 4, sourceItemSlug: 'microdose' },
      'Microdose',
      '💊',
    );
    expect(line).toContain('Microdose');
    expect(line).toContain('+3%');
    expect(line).toContain('**4** charges left');
  });

  it('singularizes the last charge and omits the field entirely when inactive', () => {
    const line = renderCaptureBonusLine(
      { modifier: 0.03, chargesRemaining: 1, sourceItemSlug: 'microdose' },
      'Microdose',
    );
    expect(line).toContain('**1** charge left');
    expect(renderCaptureBonusLine(null)).toBeNull();
  });
});

describe('effectSummary', () => {
  it('describes each supported effect type', () => {
    expect(effectSummary('restore_energy_full', { restoreToMax: true })).toBe(
      'restores Hunt Energy to full',
    );
    expect(effectSummary('capture_bonus_charges', { captureBonus: 0.03, charges: 5 })).toBe(
      '+3% capture for 5 attempts',
    );
    expect(effectSummary(null, null)).toBe('');
  });
});

describe('formatItemUseResult', () => {
  it('reports the restored energy against the computed max', () => {
    const text = formatItemUseResult({
      kind: 'restore_energy_full',
      item: item(),
      quantityRemaining: 0,
      energyBefore: 3,
      energyAfter: 35,
      maxEnergy: 35,
      careModeExited: false,
      careEnergyGained: 0,
    });
    expect(text).toContain('Energy Drink');
    expect(text).toContain('35/35');
  });

  it('mentions the Care Mode exit and any ticks it credited', () => {
    const text = formatItemUseResult({
      kind: 'restore_energy_full',
      item: item(),
      quantityRemaining: 1,
      energyBefore: 0,
      energyAfter: 10,
      maxEnergy: 10,
      careModeExited: true,
      careEnergyGained: 2,
    });
    expect(text).toContain('Left Care Mode');
    expect(text).toContain('+2');
  });

  it('reports the buff bonus and charges, and marks a refresh as such', () => {
    const fresh = formatItemUseResult({
      kind: 'capture_bonus_charges',
      item: item({ slug: 'microdose', name: 'Microdose', emoji: '💊' }),
      quantityRemaining: 0,
      modifier: 0.03,
      chargesRemaining: 5,
      refreshed: false,
      chargesBefore: 0,
    });
    expect(fresh).toContain('Microdose');
    expect(fresh).toContain('+3%');
    expect(fresh).toContain('**5**');

    const again = formatItemUseResult({
      kind: 'capture_bonus_charges',
      item: item({ slug: 'microdose', name: 'Microdose' }),
      quantityRemaining: 0,
      modifier: 0.03,
      chargesRemaining: 5,
      refreshed: true,
      chargesBefore: 2,
    });
    expect(again).toContain('refreshed');
  });
});
