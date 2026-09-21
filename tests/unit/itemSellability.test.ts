/**
 * Item-schema rules introduced by the Expeditions item foundation: the three
 * new categories, `sellValue`, and the two-key lock on selling a key item.
 * Pure — no DB, no I/O.
 *
 * The thing under test is *refusal*. Every rule here exists because the
 * alternative is a content set that boots fine and then does something
 * irreversible to a player's inventory, so each case asserts the parse fails
 * and names the field an author would have to fix.
 */
import { describe, expect, it } from 'vitest';
import { ItemContentSchema } from '../../src/modules/content/schemas';
import { ITEM_CATEGORIES, SHOP_ITEM_CATEGORIES } from '../../src/db/schema';

/** The smallest item that parses; each test varies exactly one thing. */
function item(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'test_item',
    name: 'Test Item',
    category: 'salvage',
    captureModifier: null,
    ...overrides,
  };
}

const parse = (overrides: Record<string, unknown> = {}) =>
  ItemContentSchema.safeParse(item(overrides));

/** Every message an author would be shown, flattened for substring matching. */
function messages(result: ReturnType<typeof parse>): string {
  return result.success ? '' : result.error.issues.map((i) => i.message).join('\n');
}

describe('item categories', () => {
  it.each(['salvage', 'key', 'equipment'])('accepts the new category %s', (category) => {
    expect(parse({ category }).success).toBe(true);
  });

  it('rejects a category outside the closed set', () => {
    expect(parse({ category: 'treasure' }).success).toBe(false);
  });

  // The database CHECK is generated from this list, so a drift between the two
  // is a migration nobody wrote. Asserting the membership here is what makes
  // adding a category to one place and not the other a failing test.
  it('keeps the shop categories a strict subset of all categories', () => {
    for (const category of SHOP_ITEM_CATEGORIES) {
      expect(ITEM_CATEGORIES).toContain(category);
    }
    // Selling is not the mirror of buying: salvage is vendorable and never
    // purchasable, which is the whole point of keeping these two lists apart.
    expect(SHOP_ITEM_CATEGORIES as readonly string[]).not.toContain('salvage');
  });
});

describe('sellValue', () => {
  it('defaults to null — an item is not sellable unless an author said so', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sellValue).toBeNull();
  });

  it('accepts a positive integer', () => {
    const result = parse({ sellValue: 40 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sellValue).toBe(40);
  });

  // 0 is the second spelling of "not sellable", and the database rejects it
  // for the same reason: one fact, one spelling.
  it.each([
    ['zero', 0],
    ['a negative value', -10],
    ['a fractional value', 12.5],
  ])('rejects %s', (_label, sellValue) => {
    expect(parse({ sellValue }).success).toBe(false);
  });

  it('allows salvage to be sellable without being buyable', () => {
    const result = parse({ category: 'salvage', sellValue: 30 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shopRegions).toEqual([]);
      expect(result.data.buyPrice).toBeNull();
    }
  });

  // The pre-existing shop rule still holds against the new categories, which
  // is what stops salvage appearing on a shelf by way of a stray region id.
  it('still refuses to stock a salvage item in a shop', () => {
    const result = parse({
      category: 'salvage',
      sellValue: 30,
      shopRegions: ['waifu-valley'],
      buyPrice: 100,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('shop_regions requires category');
  });
});

describe('key items', () => {
  it('parses a key item with no sellValue', () => {
    expect(parse({ category: 'key' }).success).toBe(true);
  });

  // The acceptance criterion, stated directly: one field is not enough.
  it('refuses a sellable key item without explicitlySellable', () => {
    const result = parse({ category: 'key', sellValue: 500 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('explicitlySellable: true');
  });

  it('accepts a sellable key item when both fields agree', () => {
    const result = parse({ category: 'key', sellValue: 500, explicitlySellable: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sellValue).toBe(500);
      expect(result.data.explicitlySellable).toBe(true);
    }
  });

  // A flag that does nothing reads as a flag that does something, which is how
  // an item ships unsellable for a month after somebody "made it sellable".
  it('refuses explicitlySellable without a sellValue', () => {
    const result = parse({ category: 'key', explicitlySellable: true });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('inert without a sellValue');
  });

  it('refuses explicitlySellable on a non-key category', () => {
    const result = parse({ category: 'salvage', sellValue: 30, explicitlySellable: true });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('only applies to category "key"');
  });
});
