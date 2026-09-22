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
import { AFFINITIES } from '../../src/db/schema';
import { RACE_CODES } from '../../src/modules/cards/race';
import {
  validateExpeditionContent,
  warnOnRepeatedRewardItems,
} from '../../src/modules/content/loader';
import { evaluateSuitability } from '../../src/modules/expeditions/expeditionMath';
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

const FIXTURE_TIERS = [60, 180, 360, 1080] as const;

/**
 * One enabled mission on every configured tier, all pointing at the same
 * table.
 *
 * A participating region has to cover the whole duration ladder — the board
 * draws one mission per tier — so the *baseline* fixture is a complete pool.
 * A test that wants a single mission still passes one; it is then rejected for
 * whatever that test is about, because the per-mission lints run first.
 */
function completePool(over: Record<string, unknown> = {}): LoadedContent['expeditions'] {
  return FIXTURE_TIERS.map((durationMinutes, i) => ({
    ...ExpeditionDefinitionSchema.parse(
      definition({ key: `desert_run_t${i}`, durationMinutes, ...over }),
    ),
    region: 'thirstlands' as const,
  }));
}

/** A content set with just enough in it for the expedition lints to run. */
function content(over: Partial<LoadedContent> = {}): LoadedContent {
  return {
    ...SHIPPED,
    items: [
      { ...SHIPPED.items[0]!, slug: 'scrap', category: 'salvage' },
      { ...SHIPPED.items[0]!, slug: 'sword', category: 'equipment' },
    ],
    expeditions: completePool(),
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
    expect(parsed.boardSize).toBe(4);
    // No global concurrency default, because there is no global concurrency:
    // a player's ceiling is how many regions they can reach with expedition
    // content in them. The key is still *accepted* so an admin-edited
    // `tables.json` written before the change still loads.
    expect(parsed.maxConcurrent).toBeUndefined();
    expect(ExpeditionsConfigSchema.parse({ maxConcurrent: 3 }).maxConcurrent).toBe(3);
    expect(Object.values(parsed.durations).sort((a, b) => a - b)).toEqual([60, 180, 360, 1080]);
  });

  // An out-of-order threshold list would make a label unreachable rather than
  // merely odd, and nothing downstream would notice.
  it('rejects match thresholds that do not strictly descend', () => {
    expect(
      ExpeditionsConfigSchema.safeParse({
        match: { thresholds: { strong: 0.4, partial: 0.5, weak: 0.3 } },
      }).success,
    ).toBe(false);
  });

  // A tables.json saved through the admin panel before the match-quality
  // change still carries the old block. It must load, and must do nothing.
  it('accepts and ignores the deprecated success bands', () => {
    const parsed = ExpeditionsConfigSchema.safeParse({
      bands: { excellent: 0.8, good: 0.65, fair: 0.5, risky: 0.35 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects two tiers naming the same length', () => {
    expect(
      ExpeditionsConfigSchema.safeParse({ durations: { short: 60, quick: 60 } }).success,
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

  /**
   * The board shows one mission per tier, so a board smaller than the ladder
   * cannot shrink evenly — it would drop the *longest* commitments, which are
   * exactly the ones a player cannot simply wait for.
   */
  it('rejects a board too small to carry one mission per tier', () => {
    expect(
      ExpeditionsConfigSchema.safeParse({
        durations: { short: 60, medium: 180, long: 360, overnight: 1080 },
        boardSize: 3,
      }).success,
    ).toBe(false);
  });

  it('accepts a board exactly the size of the ladder, and a larger one', () => {
    for (const boardSize of [4, 6, 12]) {
      expect(ExpeditionsConfigSchema.safeParse({ boardSize }).success).toBe(true);
    }
  });

  it('ships a board at least as large as the ladder', () => {
    const cfg = SHIPPED.tables.expeditions;
    expect(cfg.boardSize).toBeGreaterThanOrEqual(Object.keys(cfg.durations).length);
  });
});

/**
 * A repeated `itemId` inside one reward group is legal and *warned about*.
 *
 * Both halves matter. Weighted quantity variants of one item are a real
 * authoring device, so the schema must keep accepting them — but the Undercity
 * Dive bonus table shipped with `moonlit_perfume_vial` at two quantities
 * because an entry copied from another group never had its item changed, and
 * nothing said a word. The warning is the word.
 */
describe('warnOnRepeatedRewardItems', () => {
  const capture = () => {
    const lines: { itemId: string; quantities: number[] }[] = [];
    const logger = {
      warn: (ctx: Record<string, unknown>) =>
        lines.push({
          itemId: ctx.itemId as string,
          quantities: ctx.quantities as number[],
        }),
    } as unknown as Parameters<typeof warnOnRepeatedRewardItems>[1];
    return { lines, logger };
  };

  const tableWith = (entries: Record<string, unknown>[]) =>
    ExpeditionRewardTableSchema.parse(
      rewardTable({ groups: [{ id: 'salvage', entries }] }),
    );

  it('warns when one item appears twice at different quantities', () => {
    const { lines, logger } = capture();
    warnOnRepeatedRewardItems(
      [
        tableWith([
          { itemId: 'scrap', weight: 60, quantity: 2 },
          { itemId: 'scrap', weight: 15, quantity: 1 },
        ]),
      ],
      logger,
    );
    expect(lines).toEqual([{ itemId: 'scrap', quantities: [2, 1] }]);
  });

  it('says nothing about a group that names each item once', () => {
    const { lines, logger } = capture();
    warnOnRepeatedRewardItems(
      [
        tableWith([
          { itemId: 'scrap', weight: 60, quantity: 2 },
          { itemId: 'sword', weight: 15, quantity: 1 },
        ]),
      ],
      logger,
    );
    expect(lines).toEqual([]);
  });

  // It is a warning, not a refusal: the whole point is that the shape stays
  // available to authors who mean it.
  it('does not make the repeated item fatal', () => {
    expect(() =>
      warnOnRepeatedRewardItems(
        [
          tableWith([
            { itemId: 'scrap', weight: 60, quantity: 2 },
            { itemId: 'scrap', weight: 15, quantity: 1 },
          ]),
        ],
        capture().logger,
      ),
    ).not.toThrow();
  });

  // The shipped set is the case that matters — the Undercity table is fixed.
  it('has nothing to say about the shipped content set', () => {
    const { lines, logger } = capture();
    warnOnRepeatedRewardItems(SHIPPED.expeditionRewards, logger);
    expect(lines).toEqual([]);
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
  it.each([47, 120, 720])('rejects a duration that is not on the configured ladder (%s)', (durationMinutes) => {
    expectRejection(
      {
        expeditions: [
          {
            ...ExpeditionDefinitionSchema.parse(definition({ durationMinutes })),
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

  /**
   * Tier completeness. The board draws one mission per duration tier, so a
   * region that participates at all must be able to fill every tier — and the
   * failure has to be caught here, at boot, rather than as a permanently short
   * board that reads to a player like "there is no overnight mission tonight".
   */
  describe('tier completeness', () => {
    it('accepts a region covering every tier', () => {
      expect(() => validateExpeditionContent(content())).not.toThrow();
    });

    it('rejects a region that has missions but skips a tier', () => {
      expectRejection(
        { expeditions: completePool().filter((e) => e.durationMinutes !== 1080) },
        /has enabled expeditions but none on duration tier\(s\): 1080/,
      );
    });

    it('names every missing tier, not just the first', () => {
      expectRejection(
        { expeditions: completePool().filter((e) => e.durationMinutes === 60) },
        /duration tier\(s\): 180, 360, 1080/,
      );
    });

    // A disabled mission cannot be shown, so a tier whose only mission is
    // switched off is a gap — the same gap as never having authored one.
    it('does not let a disabled mission stand in for a tier', () => {
      expectRejection(
        {
          expeditions: completePool().map((e) =>
            e.durationMinutes === 180 ? { ...e, enabled: false } : e,
          ),
        },
        /duration tier\(s\): 180/,
      );
    });

    /**
     * A region nobody has authored yet is absent, not incomplete. That is the
     * shipped state of every region but Waifu Valley, and it renders as an
     * empty board rather than a broken one.
     */
    it('exempts a region with no enabled missions at all', () => {
      expect(() =>
        validateExpeditionContent(content({ expeditions: [], expeditionRewards: [] })),
      ).not.toThrow();
      expect(() =>
        validateExpeditionContent(
          content({ expeditions: completePool({ enabled: false }) }),
        ),
      ).not.toThrow();
    });

    // Checked per region, because the board is per region: a complete Valley
    // cannot cover for a half-authored neighbour.
    it('checks each region separately', () => {
      expectRejection(
        {
          expeditions: [
            ...completePool(),
            {
              ...ExpeditionDefinitionSchema.parse(definition({ key: 'tp_only_long' })),
              region: 'twin-peeks' as const,
            },
          ],
        },
        /Region "twin-peeks" has enabled expeditions but none on duration tier\(s\): 60, 180, 1080/,
      );
    });

    // The shipped set is the case that matters: Waifu Valley must satisfy the
    // rule the board relies on.
    it('is satisfied by the shipped Waifu Valley pool', () => {
      const tiers = Object.values(SHIPPED.tables.expeditions.durations);
      const valley = SHIPPED.expeditions.filter(
        (e) => e.region === 'waifu-valley' && e.enabled,
      );
      for (const tier of tiers) {
        expect(valley.some((e) => e.durationMinutes === tier)).toBe(true);
      }
    });
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
    // Shipped content no longer carries the deprecated global slot count.
    expect(SHIPPED.tables.expeditions.maxConcurrent).toBeUndefined();
    const t = SHIPPED.tables.expeditions.match.thresholds;
    expect(t.strong).toBeGreaterThan(t.partial);
    expect(t.partial).toBeGreaterThan(t.weak);
  });

  it('ships the 1h / 3h / 6h / 18h duration ladder', () => {
    expect(SHIPPED.tables.expeditions.durations).toEqual({
      short: 60,
      medium: 180,
      long: 360,
      overnight: 1080,
    });
  });

  /**
   * Waifu Valley is the reference regional pool, not a fixture. Every tier
   * must carry *more than one* mission, because the board draws 4 of the pool
   * at random and a single-mission tier would show the same errand to every
   * player who saw that tier at all — which is the variety problem rotation
   * exists to avoid.
   */
  it('gives Waifu Valley a full pool with at least two missions on every tier', () => {
    const valley = SHIPPED.expeditions.filter((e) => e.region === 'waifu-valley' && e.enabled);
    const tiers = Object.values(SHIPPED.tables.expeditions.durations).sort((a, b) => a - b);
    expect(valley.length).toBeGreaterThanOrEqual(8);
    for (const tier of tiers) {
      expect(valley.filter((e) => e.durationMinutes === tier).length).toBeGreaterThanOrEqual(2);
    }
    // Every one names all three tables, so success, failure and Exceptional
    // are all authored rather than defaulted.
    for (const e of valley) {
      expect(e.exceptionalRewardTable).not.toBeNull();
      expect(e.failureRewardTable).not.toBeNull();
    }
  });

  /**
   * Coverage, not flavour. A pool that quietly asks for the same temperament
   * or the same race over and over turns "build a varied collection" into
   * "own one good Demon", and the omission is invisible until a player with
   * the wrong roster finds every mission reads POOR.
   */
  it('spreads Waifu Valley across every affinity and every race', () => {
    const valley = SHIPPED.expeditions.filter((e) => e.region === 'waifu-valley' && e.enabled);
    for (const affinity of AFFINITIES) {
      expect(valley.some((e) => e.preferredAffinities.includes(affinity))).toBe(true);
    }
    for (const race of RACE_CODES) {
      expect(valley.some((e) => e.preferredRaces.includes(race))).toBe(true);
    }
    // Recommended levels must span a range, so a young collection and a
    // developed one both have somewhere to send somebody.
    const levels = valley.map((e) => e.recommendedLevel);
    expect(Math.min(...levels)).toBeLessThanOrEqual(5);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(25);
    // The overnight tier must not be uniformly end-game: locking the slot for
    // 18 hours has to be an option a mid-level roster can take.
    const overnight = valley.filter((e) => e.durationMinutes === 1080);
    expect(Math.min(...overnight.map((e) => e.recommendedLevel))).toBeLessThanOrEqual(20);
  });

  // Duplicated names or descriptions are the usual symptom of a pool padded
  // out with longer copies of one mission.
  it('gives every Waifu Valley mission its own name and description', () => {
    const valley = SHIPPED.expeditions.filter((e) => e.region === 'waifu-valley');
    expect(new Set(valley.map((e) => e.name)).size).toBe(valley.length);
    expect(new Set(valley.map((e) => e.description)).size).toBe(valley.length);
    expect(new Set(valley.map((e) => e.emoji)).size).toBe(valley.length);
  });
});

/**
 * The shape of the Waifu Valley payout curve **and its size**.
 *
 * Retuning is expected; retuning into a curve that pays linearly, pays the
 * overnight slot *less* per hour than the 6h one, or leans on direct WaifuBux
 * over salvage is a balance change that should be noticed here first.
 *
 * Since the economy re-baseline, the *size* is asserted too. Waifu Valley's
 * benchmark is **~300 WBe per Expedition-enabled region per typical day**,
 * inside a 250–350 band, where WBe is direct WaifuBux plus the sell value of
 * the salvage a run is expected to produce. The region previously paid ~1,252
 * WBe/day on the same measure, almost five times the rest of the repeatable
 * currency economy put together, and nothing anywhere said so. These tests are
 * what says so — deliberately as *ranges and relationships* rather than exact
 * expected values, so ordinary retuning passes and a slipped `rolls: 5` does
 * not.
 */
describe('Waifu Valley reward scaling', () => {
  const tables = new Map(SHIPPED.expeditionRewards.map((t) => [t.id, t]));
  const sell = new Map(SHIPPED.items.map((i) => [i.slug, i.sellValue ?? 0]));

  /** Mean WaifuBux and mean salvage sell value of one table. */
  function value(id: string | null): { waifubux: number; salvage: number } {
    const table = id ? tables.get(id) : undefined;
    if (!table) return { waifubux: 0, salvage: 0 };
    const waifubux = table.waifubux ? (table.waifubux.min + table.waifubux.max) / 2 : 0;
    let salvage = 0;
    for (const group of table.groups.filter((g) => g.enabled)) {
      const entries = group.entries.filter((e) => e.enabled);
      const total = entries.reduce((s, e) => s + e.weight, 0);
      for (const e of entries) {
        salvage +=
          group.rolls * (group.chanceBasisPoints / 10_000) * (e.weight / total) *
          e.quantity * (sell.get(e.itemId) ?? 0);
      }
    }
    return { waifubux, salvage };
  }

  /** WBe: direct currency plus what the salvage sells for. One number. */
  const wbe = (v: { waifubux: number; salvage: number }): number => v.waifubux + v.salvage;

  const valley = SHIPPED.expeditions
    .filter((e) => e.region === 'waifu-valley' && e.enabled)
    .sort((a, b) => a.durationMinutes - b.durationMinutes);
  const perRun = valley.map((e) => {
    const v = value(e.rewardTable);
    return { e, success: v.waifubux + v.salvage, ...v };
  });

  /**
   * The reference deployment: temperament matched, race matched, five levels
   * over the recommendation. Not a best case — `maxChance` caps that — but the
   * case a player who reads the board and picks sensibly actually gets, which
   * is what a "typical day" has to be measured on.
   *
   * Built through the real `evaluateSuitability` rather than a second copy of
   * the arithmetic, so a change to the suitability config moves these numbers
   * instead of silently disagreeing with the game.
   */
  function reference(e: (typeof valley)[number]) {
    return evaluateSuitability({
      definition: e,
      waifu: {
        level: e.recommendedLevel + 5,
        affinity: e.preferredAffinities[0] ?? 'switch',
        race: e.preferredRaces[0] ?? 'human',
      },
      config: SHIPPED.tables.expeditions,
      affinityConfig: SHIPPED.tables.buddyAffinity,
    });
  }

  /**
   * Outcome-weighted WBe for one mission: failure, ordinary success, and the
   * Exceptional promotion that pays the success table *and* the bonus table.
   * Mirrors `rollExpeditionRewards`, which is where that additive rule lives.
   */
  function expectedWbe(e: (typeof valley)[number]): number {
    const { successChance, exceptionalChance } = reference(e);
    const pExceptional = successChance * exceptionalChance;
    const pOrdinary = successChance - pExceptional;
    return (
      (1 - successChance) * wbe(value(e.failureRewardTable)) +
      pOrdinary * wbe(value(e.rewardTable)) +
      pExceptional * (wbe(value(e.rewardTable)) + wbe(value(e.exceptionalRewardTable)))
    );
  }

  const TIERS = [60, 180, 360, 1080] as const;

  /**
   * Compared **by tier mean**, not mission by mission. Two missions on the
   * same tier are allowed — encouraged — to have different reward profiles,
   * so an individual 3h errand may well pay less than an individual 1h one.
   * What must hold is the shape of the ladder between tiers.
   */
  const tierMean = (minutes: number): number => {
    const runs = perRun.filter((r) => r.e.durationMinutes === minutes);
    expect(runs.length).toBeGreaterThan(0);
    return runs.reduce((s, r) => s + r.success, 0) / runs.length;
  };

  /** The same mean, outcome-weighted — what a day of play actually banks. */
  const tierExpected = (minutes: number): number => {
    const runs = valley.filter((e) => e.durationMinutes === minutes);
    expect(runs.length).toBeGreaterThan(0);
    return runs.reduce((s, e) => s + expectedWbe(e), 0) / runs.length;
  };

  it('pays more per run the longer the tier', () => {
    const means = TIERS.map(tierMean);
    for (let i = 1; i < means.length; i += 1) {
      expect(means[i]!).toBeGreaterThan(means[i - 1]!);
    }
  });

  it('does not scale linearly: short tiers pay more per hour, up to the overnight tier', () => {
    const hourly = TIERS.map((t) => tierMean(t) / (t / 60));
    // 1h > 3h > 6h: the short tiers are paid for the attention they demand.
    expect(hourly[0]!).toBeGreaterThan(hourly[1]!);
    expect(hourly[1]!).toBeGreaterThan(hourly[2]!);
    // 18h ≥ 6h per hour: the premium for locking the slot overnight.
    expect(hourly[3]!).toBeGreaterThanOrEqual(hourly[2]!);
  });

  /**
   * The overnight premium is a *convenience* payment, not a better deal than
   * paying attention. If the 18h tier ever out-earned the 3h tier per hour,
   * the duration ladder would invert: the cheapest way to play would also be
   * the most profitable one, and every shorter mission would be decoration.
   */
  it('keeps the overnight premium modest — better than 6h per hour, never better than 3h', () => {
    const hourly = TIERS.map((t) => tierMean(t) / (t / 60));
    expect(hourly[3]!).toBeGreaterThan(hourly[2]!);
    expect(hourly[3]!).toBeLessThan(hourly[1]!);
    // A premium, not a jackpot: at most half again the 6h rate.
    expect(hourly[3]! / hourly[2]!).toBeLessThan(1.5);
  });

  /**
   * A **Waifu Valley balance check, not a design rule.**
   *
   * Waifu Valley is the reference pool: its missions are all ordinary errands
   * on a shared difficulty curve, so a same-tier payout that ran away from the
   * rest would be a tuning slip rather than an intention, and nothing else
   * would notice. This catches that slip *in this region*.
   *
   * It is deliberately **not** a content-validation rule and deliberately not
   * applied to other regions. A later region is expected to want missions this
   * would fail on purpose — a steep level gate, a one-off event mission, a
   * region whose whole identity is high-variance. Those are design decisions,
   * and a unit test written during Phase 5 is the wrong place to veto them.
   *
   * If a Waifu Valley mission ever *should* sit outside the band, name it in
   * `INTENTIONAL_OUTLIERS` with a reason rather than widening the ratio — the
   * point is that the exception is written down and reviewed, not that 1.5 is
   * a meaningful number.
   */
  const SAME_TIER_BAND = 1.5;
  const INTENTIONAL_OUTLIERS: ReadonlySet<string> = new Set<string>();

  it('keeps ordinary same-tier Waifu Valley missions within one balance band', () => {
    for (const tier of TIERS) {
      const runs = perRun
        .filter((r) => r.e.durationMinutes === tier && !INTENTIONAL_OUTLIERS.has(r.e.key))
        .map((r) => r.success);
      if (runs.length < 2) continue;
      expect(Math.max(...runs) / Math.min(...runs)).toBeLessThan(SAME_TIER_BAND);
    }
  });

  it('keeps salvage the main source of value and direct WaifuBux controlled', () => {
    for (const r of perRun) {
      expect(r.salvage).toBeGreaterThan(r.waifubux * 2);
    }
  });

  /**
   * Direct WaifuBux is *secondary*, not absent. A completion has to read as
   * having paid something before the player has been to a shop, which is what
   * stops the result screen from being a list of junk and a promise.
   */
  it('still pays visible direct WaifuBux on every mission', () => {
    for (const r of perRun) {
      expect(r.waifubux).toBeGreaterThan(0);
      expect(r.waifubux / r.success).toBeGreaterThan(0.15);
    }
  });

  it('pays a failure less than a success, and an Exceptional bonus on top', () => {
    for (const { e, success } of perRun) {
      const failure = value(e.failureRewardTable);
      const bonus = value(e.exceptionalRewardTable);
      expect(wbe(failure)).toBeLessThan(success * 0.35);
      expect(wbe(failure)).toBeGreaterThan(0);
      expect(wbe(bonus)).toBeGreaterThan(0);
    }
  });

  /**
   * Consolation has a floor as well as a ceiling. An 18-hour mission that
   * fails and hands back almost nothing is the worst outcome the feature can
   * produce — the slot was locked all night and the player has no evidence it
   * happened. A fifth of the successful payout is "she brought *something*
   * home"; the 35% ceiling above is what stops failing from being fine.
   */
  it('leaves a failure worth bringing home — never near a success, never near nothing', () => {
    for (const { e, success } of perRun) {
      const ratio = wbe(value(e.failureRewardTable)) / success;
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(0.35);
    }
  });

  /**
   * Exceptional stays worth chasing without becoming the budget. It rides on
   * top of a success, so a bonus table worth twice the mission would make the
   * ordinary result feel like a miss; one worth a tenth would make the rarest
   * outcome unrecognisable.
   */
  it('keeps the Exceptional bonus exciting but bounded', () => {
    for (const { e, success } of perRun) {
      const ratio = wbe(value(e.exceptionalRewardTable)) / success;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(1.0);
    }
    // And bounded in expectation: Exceptional is a minority of a mission's EV.
    for (const e of valley) {
      const { successChance, exceptionalChance } = reference(e);
      const contribution =
        (successChance * exceptionalChance * wbe(value(e.exceptionalRewardTable))) /
        expectedWbe(e);
      expect(contribution).toBeGreaterThan(0.02);
      expect(contribution).toBeLessThan(0.2);
    }
  });

  /**
   * ── The regional benchmark ────────────────────────────────────────────────
   *
   * One region, one day, one open mission at a time. Regional concurrency
   * means a day is a 24-hour budget of *slot uptime*, not an unbounded number
   * of deployments, so a play pattern is a way of spending 24 hours.
   *
   * The typical pattern — an overnight mission and a 6h one — is the benchmark
   * the region is tuned to and the number a second region will be authored
   * against. It is asserted as a band rather than a value because every
   * mission in the pool moves it, and a re-tune that lands at 310 is fine
   * while one that lands at 1,200 is the bug this exists to catch.
   */
  const DAY = {
    casual: [[1080, 1]],
    typical: [[1080, 1], [360, 1]],
    active: [[360, 2], [180, 2], [60, 6]],
    aggressive: [[360, 1], [60, 18]],
  } as const satisfies Record<string, readonly (readonly [number, number])[]>;

  const dayWbe = (plan: readonly (readonly [number, number])[]): number =>
    plan.reduce((sum, [minutes, runs]) => sum + tierExpected(minutes) * runs, 0);

  it('pays about 300 WBe on a typical one-region day', () => {
    const typical = dayWbe(DAY.typical);
    expect(typical).toBeGreaterThan(250);
    expect(typical).toBeLessThan(350);
  });

  /**
   * The guardrail the re-baseline exists for. Every pattern is checked, not
   * just the benchmark one, because the way a region runs away is usually a
   * roll count on one long mission — which moves the casual day most and the
   * typical day second.
   */
  it('cannot quietly return to a 1,200 WBe/day region', () => {
    for (const plan of Object.values(DAY)) {
      expect(dayWbe(plan)).toBeLessThan(500);
    }
  });

  /**
   * Interaction is rewarded, but not disproportionately. Cycling 1h missions
   * all day is nineteen collections against the typical day's two; earning
   * meaningfully more for that is the point of the hourly curve, and earning
   * *twice* as much would make the short tier the only real way to play.
   */
  it('rewards frequent play without making it the only way to play', () => {
    const typical = dayWbe(DAY.typical);
    expect(dayWbe(DAY.aggressive)).toBeGreaterThan(typical);
    expect(dayWbe(DAY.aggressive)).toBeLessThan(typical * 1.6);
    // Casual overnight-only play stays within reach of the benchmark: the
    // player who opens the app once a day is not playing a different economy.
    expect(dayWbe(DAY.casual)).toBeGreaterThan(typical * 0.6);
  });

  it('keeps the region salvage-led across a whole day', () => {
    const salvageShare = (plan: readonly (readonly [number, number])[]): number => {
      let salvage = 0;
      let total = 0;
      for (const [minutes, runs] of plan) {
        const tier = valley.filter((v) => v.durationMinutes === minutes);
        for (const e of tier) {
          const share = runs / tier.length;
          salvage += value(e.rewardTable).salvage * share;
          total += wbe(value(e.rewardTable)) * share;
        }
      }
      return salvage / total;
    };
    for (const plan of Object.values(DAY)) {
      expect(salvageShare(plan)).toBeGreaterThan(0.65);
    }
  });

  /**
   * Rare rewards are **not** part of the WBe budget, and must not be used to
   * compensate for a smaller one. The Mythic Contract is a Waifu Valley hook
   * that happens on an Undercity Dive and nowhere else; the Prismatic Charm is
   * a Last Train curio. Both are gated behind an Exceptional result *and* a
   * low basis-point roll, and the product of those two is what makes them feel
   * like a story rather than a drop rate.
   */
  it('keeps the rare regional finds rare', () => {
    const rate = (key: string, itemId: string): number => {
      const e = valley.find((v) => v.key === key)!;
      const { successChance, exceptionalChance } = reference(e);
      const table = tables.get(e.exceptionalRewardTable!)!;
      const group = table.groups.find((g) => g.entries.some((x) => x.itemId === itemId))!;
      const entry = group.entries.find((x) => x.itemId === itemId)!;
      const within = entry.weight / group.entries.reduce((s, x) => s + x.weight, 0);
      return successChance * exceptionalChance * (group.chanceBasisPoints / 10_000) * within;
    };
    // Both well under one in a hundred runs of the mission that carries them.
    for (const [key, itemId] of [
      ['valley_undercity_dive', 'mythic_contract'],
      ['valley_last_train_vigil', 'prismatic_charm'],
    ] as const) {
      const p = rate(key, itemId);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(0.01);
    }
  });

  /**
   * The Undercity bug, pinned open.
   *
   * `valley-undercity-dive-bonus-v3` shipped with `moonlit_perfume_vial` twice
   * in its `rare-find` group — at quantity 2 (weight 60) and quantity 1
   * (weight 15) — because the group was copied from the success table's
   * `flooded-cache` and the third entry's item was never changed back to
   * `velvet_charm`. The schema allows repeated items at different quantities
   * on purpose, and `warnOnRepeatedRewardItems` only warns, so this
   * region-scoped assertion is what actually holds the line for Waifu Valley.
   */
  it('never lists the same item twice in one Waifu Valley reward group', () => {
    const valleyTables = valley.flatMap((e) =>
      [e.rewardTable, e.exceptionalRewardTable, e.failureRewardTable]
        .filter((id): id is string => id !== null)
        .map((id) => tables.get(id)!),
    );
    for (const table of valleyTables) {
      for (const group of table.groups) {
        const ids = group.entries.map((entry) => entry.itemId);
        expect(new Set(ids).size, `${table.id} / ${group.id}`).toBe(ids.length);
      }
    }
  });
});
