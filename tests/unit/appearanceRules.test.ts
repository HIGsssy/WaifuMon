/**
 * The unlock rules and the content resolver — the two pure modules the whole
 * appearance system rests on.
 *
 * These are the cheapest place to pin the invariants that everything else
 * assumes: that `isUnlocked` is total and boundary-correct, that a species with
 * no authored catalog still resolves to something renderable, and that every
 * appearance always carries a requirement label.
 */
import { describe, expect, it } from 'vitest';
import {
  appearanceForVariant,
  defaultAppearance,
  defaultAssetId,
  formatUnlockLabel,
  implicitStandardAppearance,
  resolveAppearances,
  type AppearanceSpecies,
} from '../../src/modules/appearance/appearanceContent';
import {
  detectNewlyUnlocked,
  isAppearanceUnlocked,
  isUnlocked,
} from '../../src/modules/appearance/appearanceRules';
import type { AppearanceContent } from '../../src/modules/content/schemas';

function appearance(overrides: Partial<AppearanceContent> = {}): AppearanceContent {
  return {
    id: 'standard',
    name: 'Standard',
    cosmeticRarity: 'standard',
    sortOrder: 100,
    tags: [],
    unlock: { type: 'owned' },
    ...overrides,
  } as AppearanceContent;
}

function species(overrides: Partial<AppearanceSpecies> = {}): AppearanceSpecies {
  return {
    slug: 'alley_catgirl',
    contentRating: 'suggestive',
    appearances: undefined,
    ...overrides,
  };
}

describe('isUnlocked', () => {
  it('treats "owned" as always satisfied — the context only exists for an owned copy', () => {
    for (const level of [1, 20, 99]) {
      expect(isUnlocked({ type: 'owned' }, { level })).toBe(true);
    }
  });

  it('gates "level" at exactly `atLevel`, not one above it', () => {
    const unlock = { type: 'level', atLevel: 20 } as const;
    expect(isUnlocked(unlock, { level: 19 })).toBe(false);
    expect(isUnlocked(unlock, { level: 20 })).toBe(true);
    expect(isUnlocked(unlock, { level: 21 })).toBe(true);
  });

  it('is total — an unimplemented future type resolves to locked, never granted', () => {
    // Content validation rejects reserved types, so this is unreachable in
    // practice. It is asserted anyway because the failure mode matters: an
    // unimplemented source must never hand out artwork by accident.
    const reserved = { type: 'event', eventKey: 'winter_2027' } as never;
    expect(isUnlocked(reserved, { level: 99 })).toBe(false);
  });
});

describe('formatUnlockLabel', () => {
  it('synthesizes a readable requirement for every v1 unlock type', () => {
    expect(formatUnlockLabel({ type: 'owned' })).toBe('Owned');
    expect(formatUnlockLabel({ type: 'level', atLevel: 20 })).toBe('Reach Level 20');
  });
});

describe('resolveAppearances', () => {
  it('synthesizes an implicit standard appearance for a species with no catalog', () => {
    const resolved = resolveAppearances(species());
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      id: 'standard',
      unlock: { type: 'owned' },
      unlockLabel: 'Owned',
      cosmeticRarity: 'standard',
      assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'standard' },
    });
  });

  it('treats an empty authored array the same as an absent one', () => {
    expect(resolveAppearances(species({ appearances: [] }))).toEqual([
      implicitStandardAppearance(species()),
    ]);
  });

  it('defaults assetId to the parent species slug and the appearance id', () => {
    const [resolved] = resolveAppearances(
      species({ appearances: [appearance({ id: 'level_20', name: 'Midnight' })] }),
    );
    expect(resolved?.assetId).toEqual(defaultAssetId('alley_catgirl', 'level_20'));
  });

  it('keeps an author-supplied assetId rather than overwriting it', () => {
    const explicit = { kind: 'waifumon', slug: 'alley_catgirl', variant: 'shared_art' } as const;
    const [resolved] = resolveAppearances(
      species({ appearances: [appearance({ id: 'level_20', assetId: explicit })] }),
    );
    expect(resolved?.assetId).toEqual(explicit);
  });

  it('always populates unlockLabel — synthesized when the author omits it', () => {
    const resolved = resolveAppearances(
      species({
        // Distinct sortOrders: resolution is ordered by (sortOrder, id), so
        // relying on authored order would be testing the fixture, not the code.
        appearances: [
          appearance({ id: 'standard', sortOrder: 0 }),
          appearance({ id: 'level_20', sortOrder: 1, unlock: { type: 'level', atLevel: 20 } }),
          appearance({
            id: 'level_40',
            sortOrder: 2,
            unlock: { type: 'level', atLevel: 40 },
            unlockLabel: 'Master her completely',
          }),
        ],
      }),
    );
    expect(resolved.map((a) => a.unlockLabel)).toEqual([
      'Owned',
      'Reach Level 20',
      'Master her completely',
    ]);
    // Every entry, locked or not — the gallery is a journal, not a lock icon.
    expect(resolved.every((a) => a.unlockLabel.length > 0)).toBe(true);
  });

  it('orders by sortOrder then id, deterministically across surfaces', () => {
    const resolved = resolveAppearances(
      species({
        appearances: [
          appearance({ id: 'zeta', sortOrder: 5 }),
          appearance({ id: 'alpha', sortOrder: 5, unlock: { type: 'level', atLevel: 2 } }),
          appearance({ id: 'first', sortOrder: 1, unlock: { type: 'level', atLevel: 3 } }),
        ],
      }),
    );
    expect(resolved.map((a) => a.id)).toEqual(['first', 'alpha', 'zeta']);
  });

  it('falls back to the species content rating when an appearance omits one', () => {
    const [resolved] = resolveAppearances(
      species({ contentRating: 'explicit', appearances: [appearance()] }),
    );
    expect(resolved?.contentRating).toBe('explicit');
  });
});

describe('appearanceForVariant', () => {
  const withCatalog = species({
    appearances: [
      appearance({ id: 'standard' }),
      appearance({ id: 'level_20', name: 'Midnight', unlock: { type: 'level', atLevel: 20 } }),
    ],
  });

  it('resolves the stored variant', () => {
    expect(appearanceForVariant(withCatalog, 'level_20').name).toBe('Midnight');
  });

  it('falls back to the default when the stored variant no longer exists', () => {
    // An author can delete artwork; a copy pointing at it must still render.
    expect(appearanceForVariant(withCatalog, 'deleted_look').id).toBe('standard');
  });

  it('falls back to the default for a null or empty variant', () => {
    expect(appearanceForVariant(withCatalog, null).id).toBe('standard');
    expect(appearanceForVariant(withCatalog, '').id).toBe('standard');
  });

  it('picks the owned entry as the default regardless of ordering', () => {
    const oddOrder = species({
      appearances: [
        appearance({ id: 'level_5', sortOrder: 0, unlock: { type: 'level', atLevel: 5 } }),
        appearance({ id: 'base', sortOrder: 9 }),
      ],
    });
    expect(defaultAppearance(oddOrder).id).toBe('base');
  });
});

describe('detectNewlyUnlocked', () => {
  const catalog = resolveAppearances(
    species({
      appearances: [
        appearance({ id: 'standard', sortOrder: 0 }),
        appearance({ id: 'level_20', sortOrder: 1, unlock: { type: 'level', atLevel: 20 } }),
        appearance({ id: 'level_40', sortOrder: 2, unlock: { type: 'level', atLevel: 40 } }),
      ],
    }),
  );

  it('returns only unlocked entries the copy has not been notified about', () => {
    const fresh = detectNewlyUnlocked(catalog, { level: 25 }, ['standard']);
    expect(fresh.map((a) => a.id)).toEqual(['level_20']);
  });

  it('returns nothing once everything unlocked has been seen', () => {
    expect(detectNewlyUnlocked(catalog, { level: 25 }, ['standard', 'level_20'])).toEqual([]);
  });

  it('surfaces every milestone at once for a copy already past them all', () => {
    // The retroactive-content case: artwork ships for a copy that is already
    // Level 50. All of it is genuinely new *to the player*.
    const fresh = detectNewlyUnlocked(catalog, { level: 50 }, []);
    expect(fresh.map((a) => a.id)).toEqual(['standard', 'level_20', 'level_40']);
  });

  it('never returns a locked entry, however long it has gone unseen', () => {
    const fresh = detectNewlyUnlocked(catalog, { level: 1 }, []);
    expect(fresh.map((a) => a.id)).toEqual(['standard']);
    expect(fresh.every((a) => isAppearanceUnlocked(a, { level: 1 }))).toBe(true);
  });
});
