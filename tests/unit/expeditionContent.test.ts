/**
 * Expedition content schemas and the cross-file lints. Pure — no DB, no I/O
 * beyond reading the shipped set once.
 *
 * These exist so a broken mission cannot reach a player. Every rule below is
 * fatal at boot, and each one is here because the alternative is a content set
 * that validates cleanly and then fails at a moment nobody is watching.
 */
import { describe, expect, it } from 'vitest';
import {
  ExpeditionDefinitionSchema,
  ExpeditionRewardTableSchema,
  ExpeditionRewardsFileSchema,
  ExpeditionsConfigSchema,
  ExpeditionsFileSchema,
  type LoadedContent,
} from '../../src/modules/content/schemas';
import { validateExpeditionContent } from '../../src/modules/content/loader';
import { ContentValidationError } from '../../src/shared/errors';
import { loadShippedContent } from '../helpers/fixtures';

const SHIPPED = loadShippedContent();

function definition(over: Record<string, unknown> = {}) {
  return {
    key: 'desert_supply_run',
    name: 'Desert Supply Run',
    type: 'supply_run',
    durationMinutes: 360,
    recommendedLevel: 20,
    baseSuccessChance: 0.4,
    rewardTable: 'supply_success',
    ...over,
  };
}

function rewardTable(over: Record<string, unknown> = {}) {
  return {
    id: 'supply_success',
    waifuXp: 80,
    groups: [
      { id: 'salvage', entries: [{ itemId: 'scrap', weight: 100, quantity: 2 }] },
    ],
    ...over,
  };
}

/** A content set with just enough in it for the expedition lints to run. */
function content(over: Partial<LoadedContent> = {}): LoadedContent {
  return {
    ...SHIPPED,
    items: [
      { ...SHIPPED.items[0]!, slug: 'scrap', category: 'salvage' },
      { ...SHIPPED.items[0]!, slug: 'sword', category: 'equipment' },
    ],
    expeditions: [{ ...ExpeditionDefinitionSchema.parse(definition()), region: 'thirstlands' }],
    expeditionRewards: [ExpeditionRewardTableSchema.parse(rewardTable())],
    ...over,
  };
}

const expectRejection = (over: Partial<LoadedContent>, message: RegExp) => {
  expect(() => validateExpeditionContent(content(over))).toThrow(ContentValidationError);
  expect(() => validateExpeditionContent(content(over))).toThrow(message);
};

describe('ExpeditionDefinitionSchema', () => {
  it('accepts a well-formed mission', () => {
    expect(ExpeditionDefinitionSchema.safeParse(definition()).success).toBe(true);
  });

  it('defaults the optional tables to absent rather than inventing one', () => {
    const parsed = ExpeditionDefinitionSchema.parse(definition());
    expect(parsed.exceptionalRewardTable).toBeNull();
    expect(parsed.failureRewardTable).toBeNull();
    expect(parsed.preferredAffinities).toEqual([]);
    expect(parsed.enabled).toBe(true);
  });

  it.each([
    ['a non-snake_case key', { key: 'Desert Supply Run' }],
    ['a base chance of 0', { baseSuccessChance: 0 }],
    ['a base chance of 1', { baseSuccessChance: 1 }],
    ['a zero duration', { durationMinutes: 0 }],
    ['an unknown type', { type: 'picnic' }],
    ['an unknown affinity', { preferredAffinities: ['grumpy'] }],
    ['an unknown race', { preferredRaces: ['dragon'] }],
    ['an unknown reward preview', { rewardPreview: ['jackpot'] }],
    ['a duplicate preferred affinity', { preferredAffinities: ['dominant', 'dominant'] }],
    ['a duplicate preferred race', { preferredRaces: ['demon', 'demon'] }],
    ['an unknown field', { teamComposition: 'pair' }],
  ])('rejects %s', (_label, over) => {
    expect(ExpeditionDefinitionSchema.safeParse(definition(over)).success).toBe(false);
  });

  // V1 is one WaifuMon per mission. The field stays so teams need no schema
  // change later; the value is pinned so nothing ships half-supporting them.
  it('pins teamSize to 1 while keeping the field', () => {
    expect(ExpeditionDefinitionSchema.safeParse(definition({ teamSize: 1 })).success).toBe(true);
    expect(ExpeditionDefinitionSchema.safeParse(definition({ teamSize: 2 })).success).toBe(false);
  });
});

describe('ExpeditionsFileSchema', () => {
  it('accepts a region file', () => {
    const parsed = ExpeditionsFileSchema.safeParse({
      region: 'thirstlands',
      expeditions: [definition()],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a region file with no missions yet', () => {
    expect(ExpeditionsFileSchema.safeParse({ region: 'thirstlands' }).success).toBe(true);
  });

  it('rejects a region outside the canonical set', () => {
    expect(
      ExpeditionsFileSchema.safeParse({ region: 'narnia', expeditions: [] }).success,
    ).toBe(false);
  });
});

describe('ExpeditionRewardTableSchema', () => {
  it('accepts a table with currency, essence, XP and groups', () => {
    const parsed = ExpeditionRewardTableSchema.safeParse(
      rewardTable({ waifubux: { min: 120, max: 260 }, essence: { min: 0, max: 2 } }),
    );
    expect(parsed.success).toBe(true);
  });

  it('accepts a table with no groups — a pure currency payout', () => {
    expect(ExpeditionRewardTableSchema.safeParse(rewardTable({ groups: [] })).success).toBe(true);
  });

  it('rejects an inverted amount range', () => {
    expect(
      ExpeditionRewardTableSchema.safeParse(rewardTable({ waifubux: { min: 100, max: 10 } }))
        .success,
    ).toBe(false);
  });

  // Group ids key the deterministic draw, so two groups sharing one id would
  // draw *identically* rather than independently.
  it('rejects two groups with the same id', () => {
    const parsed = ExpeditionRewardTableSchema.safeParse(
      rewardTable({
        groups: [
          { id: 'salvage', entries: [{ itemId: 'scrap', weight: 1 }] },
          { id: 'salvage', entries: [{ itemId: 'scrap', weight: 2 }] },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  // The same item at the same quantity twice silently doubles its weight.
  it('rejects the same drop listed twice in one group', () => {
    const parsed = ExpeditionRewardTableSchema.safeParse(
      rewardTable({
        groups: [
          {
            id: 'salvage',
            entries: [
              { itemId: 'scrap', weight: 1, quantity: 2 },
              { itemId: 'scrap', weight: 5, quantity: 2 },
            ],
          },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('allows the same item at different quantities', () => {
    const parsed = ExpeditionRewardTableSchema.safeParse(
      rewardTable({
        groups: [
          {
            id: 'salvage',
            entries: [
              { itemId: 'scrap', weight: 1, quantity: 2 },
              { itemId: 'scrap', weight: 1, quantity: 3 },
            ],
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a duplicate table id in the file', () => {
    expect(
      ExpeditionRewardsFileSchema.safeParse([rewardTable(), rewardTable()]).success,
    ).toBe(false);
  });
});

describe('ExpeditionsConfigSchema', () => {
  it('parses to sane defaults from an empty block', () => {
    const parsed = ExpeditionsConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.maxConcurrent).toBe(1);
    expect(parsed.boardSize).toBe(4);
    expect(Object.values(parsed.durations)).toContain(360);
  });

  // An out-of-order band list would make a band unreachable rather than
  // merely odd, and nothing downstream would notice.
  it('rejects bands that do not strictly descend', () => {
    expect(
      ExpeditionsConfigSchema.safeParse({
        bands: { excellent: 0.5, good: 0.8, fair: 0.4, risky: 0.2 },
      }).success,
    ).toBe(false);
  });

  it('rejects a minimum chance above the maximum', () => {
    expect(
      ExpeditionsConfigSchema.safeParse({ suitability: { minChance: 0.9, maxChance: 0.5 } })
        .success,
    ).toBe(false);
  });

  it('rejects an empty duration ladder', () => {
    expect(ExpeditionsConfigSchema.safeParse({ durations: {} }).success).toBe(false);
  });
});

describe('validateExpeditionContent', () => {
  it('accepts a coherent set', () => {
    expect(() => validateExpeditionContent(content())).not.toThrow();
  });

  it('accepts an empty set — the shipped state until missions are authored', () => {
    expect(() =>
      validateExpeditionContent(content({ expeditions: [], expeditionRewards: [] })),
    ).not.toThrow();
  });

  it('rejects a duplicate key across region files', () => {
    const one = { ...ExpeditionDefinitionSchema.parse(definition()), region: 'thirstlands' as const };
    const two = { ...ExpeditionDefinitionSchema.parse(definition()), region: 'twin-peeks' as const };
    expectRejection({ expeditions: [one, two] }, /Duplicate expedition key/);
  });

  // A free-form duration is how a board ends up offering a 47-minute mission
  // nobody balanced.
  it('rejects a duration that is not on the configured ladder', () => {
    expectRejection(
      {
        expeditions: [
          {
            ...ExpeditionDefinitionSchema.parse(definition({ durationMinutes: 47 })),
            region: 'thirstlands',
          },
        ],
      },
      /not one of the configured tiers/,
    );
  });

  it('rejects an unknown reward table', () => {
    expectRejection(
      {
        expeditions: [
          {
            ...ExpeditionDefinitionSchema.parse(definition({ rewardTable: 'ghost' })),
            region: 'thirstlands',
          },
        ],
      },
      /unknown reward table: ghost/,
    );
  });

  it('rejects an unknown bonus or failure table too', () => {
    for (const field of ['exceptionalRewardTable', 'failureRewardTable']) {
      expectRejection(
        {
          expeditions: [
            {
              ...ExpeditionDefinitionSchema.parse(definition({ [field]: 'ghost' })),
              region: 'thirstlands',
            },
          ],
        },
        /unknown reward table: ghost/,
      );
    }
  });

  // Checked even on a disabled mission: a dangling reference that only fails
  // on the day somebody flips `enabled` is a break that lands on a weekend.
  it('rejects a dangling table reference on a disabled mission', () => {
    expectRejection(
      {
        expeditions: [
          {
            ...ExpeditionDefinitionSchema.parse(
              definition({ enabled: false, rewardTable: 'ghost' }),
            ),
            region: 'thirstlands',
          },
        ],
      },
      /unknown reward table: ghost/,
    );
  });

  it('rejects an enabled mission pointing at a disabled table', () => {
    expectRejection(
      { expeditionRewards: [ExpeditionRewardTableSchema.parse(rewardTable({ enabled: false }))] },
      /is enabled but its rewardTable/,
    );
  });

  it('allows a disabled mission to point at a disabled table', () => {
    expect(() =>
      validateExpeditionContent(
        content({
          expeditions: [
            {
              ...ExpeditionDefinitionSchema.parse(definition({ enabled: false })),
              region: 'thirstlands',
            },
          ],
          expeditionRewards: [
            ExpeditionRewardTableSchema.parse(rewardTable({ enabled: false })),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a reward naming an item that does not exist', () => {
    expectRejection(
      {
        expeditionRewards: [
          ExpeditionRewardTableSchema.parse(
            rewardTable({
              groups: [{ id: 'g', entries: [{ itemId: 'phantom', weight: 1 }] }],
            }),
          ),
        ],
      },
      /unknown item: phantom/,
    );
  });

  /**
   * Equipment is reserved in V1: the schema can describe it, the game has no
   * mechanics for it, and a reward table is the one place an inert item could
   * reach a player's hands.
   */
  it('rejects a reward that awards equipment', () => {
    expectRejection(
      {
        expeditionRewards: [
          ExpeditionRewardTableSchema.parse(
            rewardTable({ groups: [{ id: 'g', entries: [{ itemId: 'sword', weight: 1 }] }] }),
          ),
        ],
      },
      /awards equipment item/,
    );
  });

  // A disabled item is fine: the grant resolves the live row inside the payout
  // transaction, and a disabled item still exists and can still be held.
  it('allows a reward naming a disabled item', () => {
    expect(() =>
      validateExpeditionContent(
        content({
          items: [
            { ...SHIPPED.items[0]!, slug: 'scrap', category: 'salvage', enabled: false },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe('the shipped content set', () => {
  /**
   * Phase 3 ships the engine, not the missions. An empty set is the correct
   * state, and this asserts the loader treats it as a supported configuration
   * rather than a broken one — the same guarantee `bosses.json` has.
   */
  it('validates, whether or not any missions are authored yet', () => {
    expect(() => validateExpeditionContent(SHIPPED)).not.toThrow();
    expect(Array.isArray(SHIPPED.expeditions)).toBe(true);
    expect(Array.isArray(SHIPPED.expeditionRewards)).toBe(true);
  });

  it('carries a parsed expeditions config', () => {
    expect(SHIPPED.tables.expeditions.maxConcurrent).toBe(1);
    expect(SHIPPED.tables.expeditions.bands.excellent).toBeGreaterThan(
      SHIPPED.tables.expeditions.bands.good,
    );
  });
});
