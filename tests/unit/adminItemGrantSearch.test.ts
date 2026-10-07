/**
 * The item search behind `/waifumon-admin player grant-item` autocomplete.
 * Pure, so the ranking and the exclusions are pinned without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  ITEM_AUTOCOMPLETE_LIMIT,
  isAdminGrantableItem,
  searchGrantableItems,
} from '../../src/modules/admin/adminItemGrantService';

const item = (slug: string, name: string, category = 'consumable', enabled = true) => ({
  slug,
  name,
  category,
  enabled,
});

const CATALOGUE = [
  item('energy_drink', 'Energy Drink'),
  item('energy_cell', 'Energy Cell', 'material'),
  item('astral_power_cell', 'Astral Power Cell', 'key'),
  item('quickie_coffee', 'Quickie Coffee'),
  item('zz_boost', 'High Energy Tonic'),
  item('old_energy_bar', 'Energy Bar', 'consumable', false),
  item('energy_blade', 'Energy Blade', 'equipment'),
];

const slugs = (query: string, limit?: number) =>
  searchGrantableItems(CATALOGUE, query, limit).map((i) => i.slug);

describe('searchGrantableItems', () => {
  it('matches by display name, prefix matches first', () => {
    expect(slugs('energy')).toEqual(['energy_cell', 'energy_drink', 'zz_boost']);
  });

  it('matches by internal key', () => {
    expect(slugs('zz_bo')).toEqual(['zz_boost']);
    expect(slugs('power_cell')).toEqual(['astral_power_cell']);
  });

  it('is case-insensitive and treats spaces as key separators', () => {
    expect(slugs('ENERGY DRINK')).toEqual(['energy_drink']);
    expect(slugs('  quickie coffee ')).toEqual(['quickie_coffee']);
  });

  it('never offers a disabled item or reserved equipment', () => {
    const all = slugs('');
    expect(all).not.toContain('old_energy_bar');
    expect(all).not.toContain('energy_blade');
    expect(slugs('energy bar')).toEqual([]);
    expect(slugs('blade')).toEqual([]);
  });

  it('lists the catalogue alphabetically for an empty query', () => {
    expect(slugs('')).toEqual([
      'astral_power_cell',
      'energy_cell',
      'energy_drink',
      'zz_boost',
      'quickie_coffee',
    ]);
  });

  it('returns nothing for an unmatched query', () => {
    expect(slugs('nonexistent')).toEqual([]);
  });

  it('respects the limit, and Discord’s by default', () => {
    expect(slugs('', 2)).toHaveLength(2);
    const big = Array.from({ length: 60 }, (_, n) => item(`thing_${n}`, `Thing ${n}`));
    expect(searchGrantableItems(big, 'thing')).toHaveLength(ITEM_AUTOCOMPLETE_LIMIT);
    expect(ITEM_AUTOCOMPLETE_LIMIT).toBe(25);
  });
});

describe('isAdminGrantableItem', () => {
  it.each(['capture', 'material', 'cosmetic', 'consumable', 'salvage', 'key'])(
    'allows enabled %s items',
    (category) => {
      expect(isAdminGrantableItem({ category, enabled: true })).toBe(true);
    },
  );

  it('refuses equipment and anything disabled', () => {
    expect(isAdminGrantableItem({ category: 'equipment', enabled: true })).toBe(false);
    expect(isAdminGrantableItem({ category: 'consumable', enabled: false })).toBe(false);
  });
});
