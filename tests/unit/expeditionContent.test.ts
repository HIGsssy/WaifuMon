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
import { RACE_CODES, resolveRace } from '../../src/modules/cards/race';
import {
  validateExpeditionContent,
  warnOnRepeatedRewardItems,
} from '../../src/modules/content/loader';
import { evaluateSuitability } from '../../src/modules/expeditions/expeditionMath';
import { evaluateMatch } from '../../src/modules/expeditions/expeditionMatch';
import { buildBoard } from '../../src/modules/expeditions/expeditionBoard';
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

/**
 * ── Twin Peeks ─────────────────────────────────────────────────────────────
 *
 * Twin Peeks is the second authored region, and it is deliberately **not** a
 * second Waifu Valley. The Valley is the salvage economy: it pays you in
 * things worth selling. The Peeks is the fog dividend — it pays you in things
 * worth keeping, and takes a lower direct-WaifuBux cut to afford them.
 *
 * These guardrails are **regional on purpose**. They are a separate block
 * rather than a widening of the Waifu Valley ones because the two regions are
 * tuned to different profiles, and a rule that held both would have to be
 * loose enough to hold neither. Where a number differs from the Valley's, the
 * comment says why.
 *
 * The shared contract — the ~300 WBe/day scale, the duration ladder, the
 * failure floor, the additive Exceptional — is asserted here too, at the same
 * strength. Identity is a different *composition* of the same budget, never a
 * quieter board wearing a theme.
 */
describe('Twin Peeks reward scaling', () => {
  const tables = new Map(SHIPPED.expeditionRewards.map((t) => [t.id, t]));
  const items = new Map(SHIPPED.items.map((i) => [i.slug, i]));
  const sell = new Map(SHIPPED.items.map((i) => [i.slug, i.sellValue ?? 0]));

  /** Mean WaifuBux, salvage sell value, Essence and XP of one table. */
  function value(id: string | null) {
    const table = id ? tables.get(id) : undefined;
    if (!table) return { waifubux: 0, salvage: 0, essence: 0, waifuXp: 0, playerXp: 0 };
    const mid = (r?: { min: number; max: number }) => (r ? (r.min + r.max) / 2 : 0);
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
    return {
      waifubux: mid(table.waifubux),
      salvage,
      essence: mid(table.essence),
      waifuXp: table.waifuXp,
      playerXp: table.playerXp,
    };
  }
  const wbe = (v: { waifubux: number; salvage: number }): number => v.waifubux + v.salvage;

  const peeks = SHIPPED.expeditions
    .filter((e) => e.region === 'twin-peeks' && e.enabled)
    .sort((a, b) => a.durationMinutes - b.durationMinutes);
  const valley = SHIPPED.expeditions.filter((e) => e.region === 'waifu-valley' && e.enabled);
  const perRun = peeks.map((e) => {
    const v = value(e.rewardTable);
    return { e, success: wbe(v), ...v };
  });

  /** The same reference deployment the Waifu Valley block measures on. */
  function reference(e: (typeof peeks)[number]) {
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

  /** Outcome-weighted mean of one reward axis. Mirrors `rollExpeditionRewards`. */
  function expectedOf(
    e: (typeof peeks)[number],
    axis: 'wbe' | 'essence' | 'waifuXp' | 'playerXp',
  ): number {
    const { successChance, exceptionalChance } = reference(e);
    const pExceptional = successChance * exceptionalChance;
    const pOrdinary = successChance - pExceptional;
    const read = (id: string | null) => {
      const v = value(id);
      return axis === 'wbe' ? wbe(v) : v[axis];
    };
    const s = read(e.rewardTable);
    return (
      (1 - successChance) * read(e.failureRewardTable) +
      pOrdinary * s +
      pExceptional * (s + read(e.exceptionalRewardTable))
    );
  }
  const expectedWbe = (e: (typeof peeks)[number]) => expectedOf(e, 'wbe');

  const TIERS = [60, 180, 360, 1080] as const;
  const tierMean = (minutes: number): number => {
    const runs = perRun.filter((r) => r.e.durationMinutes === minutes);
    expect(runs.length).toBeGreaterThan(0);
    return runs.reduce((s, r) => s + r.success, 0) / runs.length;
  };
  const tierExpected = (minutes: number, axis: 'wbe' | 'essence' | 'waifuXp' | 'playerXp') => {
    const runs = peeks.filter((e) => e.durationMinutes === minutes);
    expect(runs.length).toBeGreaterThan(0);
    return runs.reduce((s, e) => s + expectedOf(e, axis), 0) / runs.length;
  };

  /** Twin Peeks' own salvage set. Nothing here may come from the Valley. */
  const PEEKS_SALVAGE = [
    'ridge_road_postcard',
    'bathhouse_locker_token',
    'chipped_enamel_pie_plate',
    'snapped_board_binding',
    'survey_flag_bundle',
    'geothermal_core_sample',
  ] as const;

  const peeksTables = peeks.flatMap((e) =>
    [e.rewardTable, e.exceptionalRewardTable, e.failureRewardTable]
      .filter((id): id is string => id !== null)
      .map((id) => tables.get(id)!),
  );

  // ── pool shape ───────────────────────────────────────────────────────────

  it('gives Twin Peeks a full pool with at least two missions on every tier', () => {
    expect(peeks.length).toBeGreaterThanOrEqual(8);
    for (const tier of TIERS) {
      expect(peeks.filter((e) => e.durationMinutes === tier).length).toBeGreaterThanOrEqual(2);
    }
    for (const e of peeks) {
      expect(e.exceptionalRewardTable).not.toBeNull();
      expect(e.failureRewardTable).not.toBeNull();
    }
  });

  it('gives every Twin Peeks mission its own name, description and emoji', () => {
    expect(new Set(peeks.map((e) => e.name)).size).toBe(peeks.length);
    expect(new Set(peeks.map((e) => e.description)).size).toBe(peeks.length);
    expect(new Set(peeks.map((e) => e.emoji)).size).toBe(peeks.length);
    // And none of them is a Waifu Valley mission wearing a hat.
    const valleyNames = new Set(valley.map((e) => e.name));
    for (const e of peeks) expect(valleyNames.has(e.name)).toBe(false);
  });

  it('spreads Twin Peeks across every affinity and every race', () => {
    for (const affinity of AFFINITIES) {
      expect(peeks.some((e) => e.preferredAffinities.includes(affinity))).toBe(true);
    }
    for (const race of RACE_CODES) {
      expect(peeks.some((e) => e.preferredRaces.includes(race))).toBe(true);
    }
    const levels = peeks.map((e) => e.recommendedLevel);
    // Arriving in the region must not require an endgame roster: the Caravan
    // Pass unlocks at player level 15, and a first-time visitor's collection
    // is not built around Twin Peeks yet.
    expect(Math.min(...levels)).toBeLessThanOrEqual(5);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(25);
    const overnight = peeks.filter((e) => e.durationMinutes === 1080);
    expect(Math.min(...overnight.map((e) => e.recommendedLevel))).toBeLessThanOrEqual(20);
  });

  /**
   * Twin Peeks must give *different* parts of a collection something to do.
   * A pool that repeated the Valley's pairs would mean the roster a player
   * built for the Valley is the roster that plays the Peeks, and the second
   * region would add commitment slots rather than reasons to collect.
   */
  it('does not reproduce a Waifu Valley affinity/race requirement pair', () => {
    const fingerprint = (e: (typeof peeks)[number]) =>
      `${[...e.preferredAffinities].sort().join('+')}|${[...e.preferredRaces].sort().join('+')}`;
    const valleyPairs = new Set(valley.map(fingerprint));
    for (const e of peeks) {
      expect(valleyPairs.has(fingerprint(e)), `${e.key} duplicates a Waifu Valley pair`).toBe(
        false,
      );
    }
  });

  /**
   * A stated requirement nobody can meet is a mission that reads POOR forever.
   * PERFECT is "every stated requirement met", so it is reachable only if some
   * obtainable species carries one of the preferred affinities *and* one of
   * the preferred races. Checked against the real resolver, because race is
   * derived content rather than a column.
   */
  it('leaves a PERFECT MATCH path open on every Twin Peeks mission', () => {
    const roster = SHIPPED.species
      .filter((s) => s.enabled)
      .map((s) => ({ affinity: s.affinity, race: resolveRace(s) }));
    for (const e of peeks) {
      const reachable = roster.some(
        (s) =>
          evaluateMatch({
            definition: e,
            waifu: { level: e.recommendedLevel, affinity: s.affinity, race: s.race },
            config: SHIPPED.tables.expeditions,
            affinityConfig: SHIPPED.tables.buddyAffinity,
          }).quality === 'PERFECT_MATCH',
      );
      expect(reachable, `${e.key} has no PERFECT MATCH path in the obtainable collection`).toBe(
        true,
      );
    }
  });

  /**
   * A mission that states only *one* preference list cannot produce a
   * WEAK_MATCH: with two scored requirements the mean score can never land in
   * the weak band, so the label silently disappears from that mission's
   * candidate list. That is acceptable occasionally — a deliberately forgiving
   * entry mission, a mission that is about *who* rather than *what* — and a
   * problem if it becomes the house style.
   */
  it('uses single-preference missions sparingly', () => {
    const twoAxis = peeks.filter(
      (e) => e.preferredAffinities.length === 0 || e.preferredRaces.length === 0,
    );
    expect(twoAxis.length).toBeLessThanOrEqual(2);
  });

  // ── salvage identity ─────────────────────────────────────────────────────

  it('pays Twin Peeks salvage, never Waifu Valley salvage', () => {
    const valleyTables = valley.flatMap((e) =>
      [e.rewardTable, e.exceptionalRewardTable, e.failureRewardTable]
        .filter((id): id is string => id !== null)
        .map((id) => tables.get(id)!),
    );
    const salvageIn = (set: typeof peeksTables) =>
      new Set(
        set.flatMap((t) =>
          t.groups.flatMap((g) =>
            g.entries.map((e) => e.itemId).filter((id) => items.get(id)?.category === 'salvage'),
          ),
        ),
      );
    expect([...salvageIn(peeksTables)].sort()).toEqual([...PEEKS_SALVAGE].sort());
    for (const id of salvageIn(valleyTables)) {
      expect((PEEKS_SALVAGE as readonly string[]).includes(id)).toBe(false);
    }
  });

  /**
   * Sellability rides on the canonical `sellValue` model, and the ladder stays
   * on the Valley's scale: Twin Peeks unlocks later, which is not a reason for
   * its scrap to be worth more. Rare salvage stays rare by *drop rate*, and
   * common salvage stays cheap enough to give a 1h table real granularity.
   */
  it('keeps Twin Peeks salvage on the established value ladder', () => {
    const values = PEEKS_SALVAGE.map((slug) => {
      const item = items.get(slug);
      expect(item, `${slug} is not a shipped item`).toBeDefined();
      expect(item!.category).toBe('salvage');
      expect(item!.enabled).toBe(true);
      expect(item!.shopRegions).toEqual([]);
      expect(item!.sellValue).toBeGreaterThan(0);
      return item!.sellValue!;
    });
    const valleySalvage = SHIPPED.items
      .filter((i) => i.category === 'salvage' && !(PEEKS_SALVAGE as readonly string[]).includes(i.slug))
      .map((i) => i.sellValue ?? 0);
    expect(Math.min(...values)).toBeLessThanOrEqual(10);
    expect(Math.max(...values)).toBeLessThanOrEqual(Math.max(...valleySalvage));
    // Enough distinct steps that a short mission can be priced without either
    // rounding to nothing or jumping a tier.
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThanOrEqual(5);
  });

  // ── the curve ────────────────────────────────────────────────────────────

  it('pays more per run the longer the tier', () => {
    const means = TIERS.map(tierMean);
    for (let i = 1; i < means.length; i += 1) expect(means[i]!).toBeGreaterThan(means[i - 1]!);
  });

  it('preserves the duration curve: 1h > 3h > 6h per hour, with a modest 18h premium', () => {
    const hourly = TIERS.map((t) => tierMean(t) / (t / 60));
    expect(hourly[0]!).toBeGreaterThan(hourly[1]!);
    expect(hourly[1]!).toBeGreaterThan(hourly[2]!);
    expect(hourly[3]!).toBeGreaterThan(hourly[2]!);
    expect(hourly[3]!).toBeLessThan(hourly[1]!);
    expect(hourly[3]! / hourly[2]!).toBeLessThan(1.5);
  });

  /**
   * The Valley asserts `salvage > waifubux * 2`. Twin Peeks is held to a
   * *stricter* ratio, because "lower direct WaifuBux emphasis" is the half of
   * its identity that shows up inside the WBe budget — the rest of the
   * difference is Essence and keepables, which WBe deliberately cannot see.
   */
  it('takes a smaller direct-WaifuBux cut than Waifu Valley', () => {
    for (const r of perRun) {
      expect(r.waifubux, r.e.key).toBeGreaterThan(0);
      expect(r.salvage, r.e.key).toBeGreaterThan(r.waifubux * 2.8);
      // Still visible on the result screen before the player reaches a shop.
      expect(r.waifubux / r.success, r.e.key).toBeGreaterThan(0.12);
      expect(r.waifubux / r.success, r.e.key).toBeLessThan(0.26);
    }
  });

  it('pays a failure less than a success, and an Exceptional bonus on top', () => {
    for (const { e, success } of perRun) {
      expect(wbe(value(e.exceptionalRewardTable)), e.key).toBeGreaterThan(0);
      const ratio = wbe(value(e.failureRewardTable)) / success;
      // Same floor and ceiling as the Valley: an 18-hour failure must still
      // come home with something, and failing must still cost.
      expect(ratio, e.key).toBeGreaterThan(0.15);
      expect(ratio, e.key).toBeLessThan(0.35);
    }
  });

  /**
   * Twin Peeks is the more variable region, expressed as reward-table
   * composition rather than as a hidden chance nobody can see. Its bonus
   * tables are allowed to be worth proportionally more of a success than the
   * Valley's, and they carry the regional keepables — but Exceptional stays a
   * minority of the expected value, or the ordinary success stops mattering.
   */
  it('keeps the Exceptional bonus bigger than the Valley\'s, and still bounded', () => {
    for (const { e, success } of perRun) {
      const ratio = wbe(value(e.exceptionalRewardTable)) / success;
      expect(ratio, e.key).toBeGreaterThan(0.4);
      expect(ratio, e.key).toBeLessThan(1.0);
    }
    for (const e of peeks) {
      const { successChance, exceptionalChance } = reference(e);
      const contribution =
        (successChance * exceptionalChance * wbe(value(e.exceptionalRewardTable))) /
        expectedWbe(e);
      expect(contribution, e.key).toBeGreaterThan(0.02);
      expect(contribution, e.key).toBeLessThan(0.2);
    }
    // Every Exceptional table pays something a success table cannot: Essence,
    // a charm, a consumable. Otherwise "exceptional" is just "more scrap".
    for (const e of peeks) {
      const bonus = tables.get(e.exceptionalRewardTable!)!;
      const keepables = bonus.groups.flatMap((g) =>
        g.entries.filter((x) => items.get(x.itemId)?.category !== 'salvage'),
      );
      expect((bonus.essence?.max ?? 0) > 0 || keepables.length > 0, e.key).toBe(true);
    }
  });

  // ── the regional benchmark ───────────────────────────────────────────────

  const DAY = {
    casual: [[1080, 1]],
    typical: [[1080, 1], [360, 1]],
    active: [[360, 2], [180, 2], [60, 6]],
    aggressive: [[360, 1], [60, 18]],
  } as const satisfies Record<string, readonly (readonly [number, number])[]>;

  const day = (
    plan: readonly (readonly [number, number])[],
    axis: 'wbe' | 'essence' | 'waifuXp' | 'playerXp',
  ): number => plan.reduce((sum, [minutes, runs]) => sum + tierExpected(minutes, axis) * runs, 0);

  /**
   * Same ~300 WBe/day scale as Waifu Valley, and deliberately toward the lower
   * half of the band: Twin Peeks buys its Essence and its keepables out of the
   * same budget rather than on top of it. The floor is what stops "regional
   * identity" from being used to ship a quietly weaker board.
   */
  it('pays a comparable ~300 WBe on a typical one-region day', () => {
    const typical = day(DAY.typical, 'wbe');
    expect(typical).toBeGreaterThan(250);
    expect(typical).toBeLessThan(350);
  });

  it('cannot quietly become a runaway region', () => {
    for (const plan of Object.values(DAY)) expect(day(plan, 'wbe')).toBeLessThan(500);
  });

  it('rewards frequent play without making it the only way to play', () => {
    const typical = day(DAY.typical, 'wbe');
    expect(day(DAY.aggressive, 'wbe')).toBeGreaterThan(typical);
    expect(day(DAY.aggressive, 'wbe')).toBeLessThan(typical * 1.6);
    expect(day(DAY.casual, 'wbe')).toBeGreaterThan(typical * 0.6);
  });

  /**
   * ── The Essence benchmark ────────────────────────────────────────────────
   *
   * The fog dividend, as a number. Twin Peeks pays several times the Valley's
   * Essence on the same WBe budget — that is the identity — while staying a
   * modest share of a player's actual daily Essence income (hunt finds, daily
   * quests and duplicate conversion together run well into three figures). A
   * Prismatic Charm costs 1,750 Essence, and Twin Peeks must shorten that
   * cycle noticeably without paying for one on its own.
   */
  it('pays the regional Essence dividend, without trivialising the Essence sinks', () => {
    const typical = day(DAY.typical, 'essence');
    expect(typical).toBeGreaterThan(15);
    expect(typical).toBeLessThan(26);
    // Several times the Valley's, on a comparable WBe budget.
    const valleyTypical = [
      [1080, 1],
      [360, 1],
    ].reduce((sum, [minutes, runs]) => {
      const runsOnTier = valley.filter((e) => e.durationMinutes === minutes);
      const mean =
        runsOnTier.reduce((s, e) => {
          const { successChance, exceptionalChance } = evaluateSuitability({
            definition: e,
            waifu: {
              level: e.recommendedLevel + 5,
              affinity: e.preferredAffinities[0] ?? 'switch',
              race: e.preferredRaces[0] ?? 'human',
            },
            config: SHIPPED.tables.expeditions,
            affinityConfig: SHIPPED.tables.buddyAffinity,
          });
          const pExc = successChance * exceptionalChance;
          return (
            s +
            (successChance - pExc) * value(e.rewardTable).essence +
            pExc * (value(e.rewardTable).essence + value(e.exceptionalRewardTable).essence) +
            (1 - successChance) * value(e.failureRewardTable).essence
          );
        }, 0) / runsOnTier.length;
      return sum + mean * runs!;
    }, 0);
    expect(typical).toBeGreaterThan(valleyTypical * 2);
    // Never a Prismatic Charm a week on Expeditions alone.
    expect(day(DAY.aggressive, 'essence')).toBeLessThan(1750 / 7);
  });

  /**
   * Expedition XP is a deliberate passive progression path and was **not**
   * reduced when the currency was re-baselined. Twin Peeks tracks the Valley's
   * scale rather than escalating because it unlocks later: a second region
   * already doubles a player's XP throughput by existing.
   */
  it('keeps Expedition XP on the Waifu Valley scale rather than escalating it', () => {
    const waifuXp = day(DAY.typical, 'waifuXp');
    const playerXp = day(DAY.typical, 'playerXp');
    expect(waifuXp).toBeGreaterThan(450);
    expect(waifuXp).toBeLessThan(750);
    expect(playerXp).toBeGreaterThan(100);
    expect(playerXp).toBeLessThan(180);
  });

  // ── rare finds ───────────────────────────────────────────────────────────

  /**
   * Twin Peeks' chase is the **Full Body Massage** — a full Hunt Energy
   * restore, found in the treatment room the March slide buried. It is an item
   * that already exists (an affection-gift drop), so the region gets a chase
   * without a new powerful item being minted for it, and it is the region's
   * thesis in one object: the Peeks sends you home with something worth
   * keeping, not something worth selling.
   *
   * Everything in a Twin Peeks bonus table that is not salvage is held to the
   * same ceiling as the Valley's Mythic Contract — under one in a hundred runs
   * of the mission that carries it. That is also what keeps the region's shop
   * worth visiting: Shibari Rope and Wandering Hand appear as finds rarely
   * enough that buying them stays the way you get them.
   */
  it('keeps the regional finds rare, and the shop worth shopping at', () => {
    const rate = (e: (typeof peeks)[number], itemId: string): number => {
      const { successChance, exceptionalChance } = reference(e);
      const table = tables.get(e.exceptionalRewardTable!)!;
      const group = table.groups.find((g) => g.entries.some((x) => x.itemId === itemId))!;
      const entry = group.entries.find((x) => x.itemId === itemId)!;
      const within = entry.weight / group.entries.reduce((s, x) => s + x.weight, 0);
      return successChance * exceptionalChance * (group.chanceBasisPoints / 10_000) * within;
    };
    let nonSalvage = 0;
    for (const e of peeks) {
      const table = tables.get(e.exceptionalRewardTable!)!;
      for (const group of table.groups) {
        for (const entry of group.entries) {
          if (items.get(entry.itemId)?.category === 'salvage') continue;
          nonSalvage += 1;
          const p = rate(e, entry.itemId);
          expect(p, `${e.key} / ${entry.itemId}`).toBeGreaterThan(0);
          expect(p, `${e.key} / ${entry.itemId}`).toBeLessThan(0.01);
        }
      }
    }
    expect(nonSalvage).toBeGreaterThanOrEqual(6);

    // The chase itself, named so it cannot be quietly retuned or dropped.
    const dig = peeks.find((e) => e.key === 'peeks_avalanche_shed_dig')!;
    const chase = rate(dig, 'full_body_massage');
    expect(chase).toBeGreaterThan(0.001);
    expect(chase).toBeLessThan(0.006);
    // Never sold anywhere, so the Expedition is a genuine second path to it.
    expect(items.get('full_body_massage')!.shopRegions).toEqual([]);
    // And it is not a WBe reward wearing a disguise: it cannot be vendored.
    expect(items.get('full_body_massage')!.sellValue ?? 0).toBe(0);
  });

  it('never lists the same item twice in one Twin Peeks reward group', () => {
    for (const table of peeksTables) {
      for (const group of table.groups) {
        const ids = group.entries.map((entry) => entry.itemId);
        expect(new Set(ids).size, `${table.id} / ${group.id}`).toBe(ids.length);
      }
    }
  });

  /**
   * Rotation has to *reach* every mission. A pool entry the board can never
   * draw is content nobody will ever see, and because the draw is a stable
   * hash of `(player, region, window, key)` that failure would be silent and
   * permanent for the affected player rather than intermittent.
   */
  it('exposes every Twin Peeks mission over enough rotations, for any player', () => {
    const config = SHIPPED.tables.expeditions;
    const durations = Object.values(config.durations);
    for (const playerId of [1, 2, 17, 4242]) {
      const seen = new Set<string>();
      for (let window = 0; window < 200; window += 1) {
        for (const mission of buildBoard({
          playerId,
          regionId: 'twin-peeks',
          expeditions: SHIPPED.expeditions,
          durations,
          boardSize: config.boardSize,
          rotationHours: config.rotationHours,
          now: new Date(window * config.rotationHours * 3_600_000),
        })) {
          seen.add(mission.key);
        }
      }
      expect(seen.size, `player ${playerId}`).toBe(peeks.length);
    }
  });
});

/**
 * ── The regional economy benchmark ─────────────────────────────────────────
 *
 * The one economic rule that applies to **every** Expedition-enabled region,
 * present and future:
 *
 *     ~250-350 WBe per region per typical day.
 *
 * It is a **per-region** benchmark, not a global player ceiling. Regional
 * concurrency is intentionally rewarding: unlocking another Expedition-enabled
 * region raises a player's passive capacity by roughly one region's worth, and
 * that is the payoff for getting there. There is deliberately no global WBe
 * cap, no diminishing-return multiplier, no concurrency penalty and no
 * deployment fee — see the header of `expeditionService.ts` for why, and for
 * why future scaling belongs in sinks rather than in quieter rewards.
 *
 * This block therefore checks each region **independently** and never sums
 * them. It is also deliberately thin: it asserts *size* and nothing about
 * *composition*, because composition is where regional identity lives. Waifu
 * Valley is salvage-led; Twin Peeks is Essence-and-keepables-led; both are
 * correct, and a global composition rule would have to forbid one of them. The
 * per-region blocks above own those assertions.
 *
 * A region added later is picked up here automatically, which is the point: a
 * new region's first economic test should not have to be written by hand.
 */
describe('the regional Expedition economy benchmark', () => {
  const tables = new Map(SHIPPED.expeditionRewards.map((t) => [t.id, t]));
  const sell = new Map(SHIPPED.items.map((i) => [i.slug, i.sellValue ?? 0]));

  /** WBe of one table: direct WaifuBux plus expected salvage sell value. */
  function wbe(id: string | null): number {
    const table = id ? tables.get(id) : undefined;
    if (!table) return 0;
    let total = table.waifubux ? (table.waifubux.min + table.waifubux.max) / 2 : 0;
    for (const group of table.groups.filter((g) => g.enabled)) {
      const entries = group.entries.filter((e) => e.enabled);
      const weight = entries.reduce((s, e) => s + e.weight, 0);
      for (const e of entries) {
        total +=
          group.rolls * (group.chanceBasisPoints / 10_000) * (e.weight / weight) *
          e.quantity * (sell.get(e.itemId) ?? 0);
      }
    }
    return total;
  }

  function expectedWbe(e: LoadedContent['expeditions'][number]): number {
    const { successChance, exceptionalChance } = evaluateSuitability({
      definition: e,
      waifu: {
        level: e.recommendedLevel + 5,
        affinity: e.preferredAffinities[0] ?? 'switch',
        race: e.preferredRaces[0] ?? 'human',
      },
      config: SHIPPED.tables.expeditions,
      affinityConfig: SHIPPED.tables.buddyAffinity,
    });
    const pExceptional = successChance * exceptionalChance;
    const pOrdinary = successChance - pExceptional;
    const success = wbe(e.rewardTable);
    return (
      (1 - successChance) * wbe(e.failureRewardTable) +
      pOrdinary * success +
      pExceptional * (success + wbe(e.exceptionalRewardTable))
    );
  }

  /** The benchmark day: one overnight mission and one 6h, per region. */
  const TYPICAL_DAY = [
    [1080, 1],
    [360, 1],
  ] as const;

  const authoredRegions = [
    ...new Set(SHIPPED.expeditions.filter((e) => e.enabled).map((e) => e.region)),
  ].sort();

  it('has at least one authored region to measure', () => {
    expect(authoredRegions.length).toBeGreaterThan(0);
  });

  it.each(authoredRegions)(
    'pays %s about 250-350 WBe on a typical day, measured on its own',
    (region) => {
      const pool = SHIPPED.expeditions.filter((e) => e.region === region && e.enabled);
      const total = TYPICAL_DAY.reduce((sum, [minutes, runs]) => {
        const tier = pool.filter((e) => e.durationMinutes === minutes);
        expect(tier.length, `${region} has no ${minutes}m mission`).toBeGreaterThan(0);
        const mean = tier.reduce((s, e) => s + expectedWbe(e), 0) / tier.length;
        return sum + mean * runs;
      }, 0);
      expect(total, `${region} typical day`).toBeGreaterThan(250);
      expect(total, `${region} typical day`).toBeLessThan(350);
    },
  );

  /**
   * A later region does not pay less for being later.
   *
   * Region order is an unlock gate, not an economic tier, and the temptation
   * to taper each new region is exactly how a game ends up with content nobody
   * plays once they have seen it. Held as a *band* between the best and worst
   * region rather than as equality, so the identity differences the per-region
   * blocks encourage stay legal.
   */
  it('does not taper later regions', () => {
    const totals = authoredRegions.map((region) => {
      const pool = SHIPPED.expeditions.filter((e) => e.region === region && e.enabled);
      return TYPICAL_DAY.reduce((sum, [minutes, runs]) => {
        const tier = pool.filter((e) => e.durationMinutes === minutes);
        return sum + (tier.reduce((s, e) => s + expectedWbe(e), 0) / tier.length) * runs;
      }, 0);
    });
    if (totals.length < 2) return;
    expect(Math.max(...totals) / Math.min(...totals)).toBeLessThan(1.4);
  });

  /**
   * The absences, pinned.
   *
   * `ExpeditionsConfigSchema` is `.strict()`, so a field it does not declare
   * is a load error rather than a silently ignored key. That makes "there is
   * no deployment fee" testable: the config cannot grow one without this
   * failing, which is the moment to have the conversation rather than the
   * moment to discover it in a changelog.
   */
  it('has no deployment fee, global cap, or concurrency multiplier in its config', () => {
    const config = SHIPPED.tables.expeditions as unknown as Record<string, unknown>;
    for (const forbidden of [
      'deploymentFee',
      'deployCost',
      'globalWbeCap',
      'dailyRewardCap',
      'concurrencyPenalty',
      'concurrencyMultiplier',
      'diminishingReturns',
      'regionMultiplier',
    ]) {
      expect(config[forbidden], forbidden).toBeUndefined();
      // And the schema refuses to learn one by accident.
      expect(
        ExpeditionsConfigSchema.safeParse({ [forbidden]: 1 }).success,
        `${forbidden} must not be accepted by the config schema`,
      ).toBe(false);
    }
    // `maxConcurrent` survives as a parsed-and-ignored legacy key. It must
    // stay ignored: reading it again would reintroduce a global slot ceiling.
    expect(SHIPPED.tables.expeditions.maxConcurrent).toBeUndefined();
  });
});

/**
 * ── Flaccid Foothills ──────────────────────────────────────────────────────
 *
 * The third authored region, and the one that makes "regional identity" a
 * system rather than a coincidence. Three regions now pay three genuinely
 * different things out of the same ~300 WBe budget:
 *
 *   - **Waifu Valley** — the salvage economy. Things worth selling.
 *   - **Twin Peeks** — the fog dividend. Essence and things worth keeping.
 *   - **Flaccid Foothills** — the long road. Things worth *becoming*.
 *
 * The Foothills identity is not a theme chosen for variety: it is what the
 * shipped pack already says. Four of the six species in the entire game
 * carrying a `buddy_xp_gain` Buddy Bonus sit in this region's encounter pool
 * (`clockwork_astronomer`, `gym_oni`, `valkyrie_recruit`,
 * `blood_moon_priestess`), its one XP-granting World Encounter is
 * `ff_hot_spring` (`buddy_xp: 20`), and its residents are farmhands, quarry
 * units, orchard pickers and a ridge patrol that "keeps no off-season". It is
 * the region about honest repetitive work on a road that changes you.
 *
 * So Foothills pays **XP** — roughly half again what either other region pays,
 * of both kinds — and pays correspondingly little Essence and few keepables.
 * Because Expedition Waifu XP is locked to the copy that was sent
 * (`player_expeditions_waifu_active_uq`, and the claim path reads `waifu_id`
 * off the row), a training region is also a *rotation* region: the way to
 * develop a roster here is to keep sending different members.
 *
 * As with the other regional blocks, these bands are Foothills' own. Its
 * Exceptional results are deliberately **less** WBe-swingy than Twin Peeks'
 * and carry their upside as XP instead, so a shared Exceptional rule would
 * have to be loose enough to mean nothing.
 */
describe('Flaccid Foothills reward scaling', () => {
  const tables = new Map(SHIPPED.expeditionRewards.map((t) => [t.id, t]));
  const items = new Map(SHIPPED.items.map((i) => [i.slug, i]));
  const sell = new Map(SHIPPED.items.map((i) => [i.slug, i.sellValue ?? 0]));

  function value(id: string | null) {
    const table = id ? tables.get(id) : undefined;
    if (!table) return { waifubux: 0, salvage: 0, essence: 0, waifuXp: 0, playerXp: 0 };
    const mid = (r?: { min: number; max: number }) => (r ? (r.min + r.max) / 2 : 0);
    let salvage = 0;
    for (const group of table.groups.filter((g) => g.enabled)) {
      const entries = group.entries.filter((e) => e.enabled);
      const weight = entries.reduce((s, e) => s + e.weight, 0);
      for (const e of entries) {
        salvage +=
          group.rolls * (group.chanceBasisPoints / 10_000) * (e.weight / weight) *
          e.quantity * (sell.get(e.itemId) ?? 0);
      }
    }
    return {
      waifubux: mid(table.waifubux), salvage, essence: mid(table.essence),
      waifuXp: table.waifuXp, playerXp: table.playerXp,
    };
  }
  const wbe = (v: { waifubux: number; salvage: number }): number => v.waifubux + v.salvage;

  const regionPool = (region: string) =>
    SHIPPED.expeditions
      .filter((e) => e.region === region && e.enabled)
      .sort((a, b) => a.durationMinutes - b.durationMinutes);

  const foothills = regionPool('flaccid-foothills');
  const elsewhere = SHIPPED.expeditions.filter(
    (e) => e.enabled && e.region !== 'flaccid-foothills',
  );
  const perRun = foothills.map((e) => {
    const v = value(e.rewardTable);
    return { e, success: wbe(v), ...v };
  });

  function reference(e: (typeof foothills)[number]) {
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

  type Axis = 'wbe' | 'essence' | 'waifuXp' | 'playerXp';
  function expectedOf(e: LoadedContent['expeditions'][number], axis: Axis): number {
    const { successChance, exceptionalChance } = evaluateSuitability({
      definition: e,
      waifu: {
        level: e.recommendedLevel + 5,
        affinity: e.preferredAffinities[0] ?? 'switch',
        race: e.preferredRaces[0] ?? 'human',
      },
      config: SHIPPED.tables.expeditions,
      affinityConfig: SHIPPED.tables.buddyAffinity,
    });
    const pExceptional = successChance * exceptionalChance;
    const pOrdinary = successChance - pExceptional;
    const read = (id: string | null) => {
      const v = value(id);
      return axis === 'wbe' ? wbe(v) : v[axis];
    };
    const s = read(e.rewardTable);
    return (
      (1 - successChance) * read(e.failureRewardTable) +
      pOrdinary * s +
      pExceptional * (s + read(e.exceptionalRewardTable))
    );
  }
  const expectedWbe = (e: (typeof foothills)[number]) => expectedOf(e, 'wbe');

  const TIERS = [60, 180, 360, 1080] as const;
  const tierMean = (minutes: number): number => {
    const runs = perRun.filter((r) => r.e.durationMinutes === minutes);
    expect(runs.length).toBeGreaterThan(0);
    return runs.reduce((s, r) => s + r.success, 0) / runs.length;
  };

  /** Typical day for any region: one overnight mission and one 6h. */
  const typicalDay = (region: string, axis: Axis): number => {
    const pool = regionPool(region);
    return ([[1080, 1], [360, 1]] as const).reduce((sum, [minutes, runs]) => {
      const tier = pool.filter((e) => e.durationMinutes === minutes);
      expect(tier.length, `${region} ${minutes}m`).toBeGreaterThan(0);
      return sum + (tier.reduce((s, e) => s + expectedOf(e, axis), 0) / tier.length) * runs;
    }, 0);
  };

  /** Foothills' own salvage set. Nothing here may come from another region. */
  const FOOTHILLS_SALVAGE = [
    'split_fence_rail',
    'undelivered_wax_seal',
    'quarry_grit_pouch',
    'leaning_cairn_stone',
    'orchard_brandy_jar',
    'skyfreight_ballast_weight',
  ] as const;

  const tablesOf = (pool: readonly LoadedContent['expeditions'][number][]) =>
    pool.flatMap((e) =>
      [e.rewardTable, e.exceptionalRewardTable, e.failureRewardTable]
        .filter((id): id is string => id !== null)
        .map((id) => tables.get(id)!),
    );
  const foothillsTables = tablesOf(foothills);

  // ── pool shape ───────────────────────────────────────────────────────────

  it('gives Flaccid Foothills a full pool with at least two missions on every tier', () => {
    expect(foothills.length).toBeGreaterThanOrEqual(8);
    for (const tier of TIERS) {
      expect(foothills.filter((e) => e.durationMinutes === tier).length).toBeGreaterThanOrEqual(2);
    }
    for (const e of foothills) {
      expect(e.exceptionalRewardTable, e.key).not.toBeNull();
      expect(e.failureRewardTable, e.key).not.toBeNull();
    }
  });

  it('gives every Foothills mission its own name, description and emoji', () => {
    expect(new Set(foothills.map((e) => e.name)).size).toBe(foothills.length);
    expect(new Set(foothills.map((e) => e.description)).size).toBe(foothills.length);
    expect(new Set(foothills.map((e) => e.emoji)).size).toBe(foothills.length);
    const taken = new Set(elsewhere.map((e) => e.name));
    for (const e of foothills) expect(taken.has(e.name), e.key).toBe(false);
  });

  it('spreads Flaccid Foothills across every affinity and every race', () => {
    for (const affinity of AFFINITIES) {
      expect(foothills.some((e) => e.preferredAffinities.includes(affinity)), affinity).toBe(true);
    }
    for (const race of RACE_CODES) {
      expect(foothills.some((e) => e.preferredRaces.includes(race)), race).toBe(true);
    }
    const levels = foothills.map((e) => e.recommendedLevel);
    // The route unlocks at player level 20, but a first visitor's *collection*
    // is not built around this region, so the entry rung stays low.
    expect(Math.min(...levels)).toBeLessThanOrEqual(5);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(25);
    const overnight = foothills.filter((e) => e.durationMinutes === 1080);
    expect(Math.min(...overnight.map((e) => e.recommendedLevel))).toBeLessThanOrEqual(20);
  });

  /**
   * Checked against **both** prior regions. With three regions authored, the
   * risk is no longer accidental repetition of one pool but convergence: three
   * boards that all want the same Demon and the same Valkyrie, so a player's
   * second and third region add slots without adding reasons to collect.
   */
  it('does not reproduce a Waifu Valley or Twin Peeks requirement pair', () => {
    const fingerprint = (e: LoadedContent['expeditions'][number]) =>
      `${[...e.preferredAffinities].sort().join('+')}|${[...e.preferredRaces].sort().join('+')}`;
    const taken = new Set(elsewhere.map(fingerprint));
    for (const e of foothills) {
      expect(taken.has(fingerprint(e)), `${e.key} duplicates an existing pair`).toBe(false);
    }
  });

  it('leaves a PERFECT MATCH path open on every Foothills mission', () => {
    const roster = SHIPPED.species
      .filter((s) => s.enabled)
      .map((s) => ({ affinity: s.affinity, race: resolveRace(s) }));
    for (const e of foothills) {
      const reachable = roster.some(
        (s) =>
          evaluateMatch({
            definition: e,
            waifu: { level: e.recommendedLevel, affinity: s.affinity, race: s.race },
            config: SHIPPED.tables.expeditions,
            affinityConfig: SHIPPED.tables.buddyAffinity,
          }).quality === 'PERFECT_MATCH',
      );
      expect(reachable, `${e.key} has no PERFECT MATCH path`).toBe(true);
    }
  });

  it('uses single-preference missions sparingly', () => {
    const twoAxis = foothills.filter(
      (e) => e.preferredAffinities.length === 0 || e.preferredRaces.length === 0,
    );
    expect(twoAxis.length).toBeLessThanOrEqual(2);
  });

  // ── salvage identity ─────────────────────────────────────────────────────

  it('pays Foothills salvage, and no other region pays it', () => {
    const salvageIn = (set: typeof foothillsTables) =>
      new Set(
        set.flatMap((t) =>
          t.groups.flatMap((g) =>
            g.entries.map((e) => e.itemId).filter((id) => items.get(id)?.category === 'salvage'),
          ),
        ),
      );
    expect([...salvageIn(foothillsTables)].sort()).toEqual([...FOOTHILLS_SALVAGE].sort());
    for (const id of salvageIn(tablesOf(elsewhere))) {
      expect((FOOTHILLS_SALVAGE as readonly string[]).includes(id), id).toBe(false);
    }
  });

  it('keeps Foothills salvage on the established value ladder', () => {
    const values = FOOTHILLS_SALVAGE.map((slug) => {
      const item = items.get(slug);
      expect(item, slug).toBeDefined();
      expect(item!.category).toBe('salvage');
      expect(item!.enabled).toBe(true);
      expect(item!.shopRegions).toEqual([]);
      expect(item!.sellValue).toBeGreaterThan(0);
      return item!.sellValue!;
    });
    const others = SHIPPED.items
      .filter(
        (i) =>
          i.category === 'salvage' &&
          !(FOOTHILLS_SALVAGE as readonly string[]).includes(i.slug),
      )
      .map((i) => i.sellValue ?? 0);
    // Unlocking third is not a reason for the scrap to be worth more.
    expect(Math.max(...values)).toBeLessThanOrEqual(Math.max(...others));
    // Low-value granularity, so a 1h table can be priced without rounding to
    // nothing or jumping a tier.
    expect(Math.min(...values)).toBeLessThanOrEqual(10);
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThanOrEqual(5);
  });

  // ── the curve ────────────────────────────────────────────────────────────

  it('pays more per run the longer the tier', () => {
    const means = TIERS.map(tierMean);
    for (let i = 1; i < means.length; i += 1) expect(means[i]!).toBeGreaterThan(means[i - 1]!);
  });

  it('preserves the duration curve: 1h > 3h > 6h per hour, with a modest 18h premium', () => {
    const hourly = TIERS.map((t) => tierMean(t) / (t / 60));
    expect(hourly[0]!).toBeGreaterThan(hourly[1]!);
    expect(hourly[1]!).toBeGreaterThan(hourly[2]!);
    expect(hourly[3]!).toBeGreaterThan(hourly[2]!);
    expect(hourly[3]!).toBeLessThan(hourly[1]!);
    expect(hourly[3]! / hourly[2]!).toBeLessThan(1.5);
  });

  it('keeps direct WaifuBux secondary to salvage inside the WBe budget', () => {
    for (const r of perRun) {
      expect(r.waifubux, r.e.key).toBeGreaterThan(0);
      expect(r.salvage, r.e.key).toBeGreaterThan(r.waifubux * 2.8);
      expect(r.waifubux / r.success, r.e.key).toBeGreaterThan(0.12);
      expect(r.waifubux / r.success, r.e.key).toBeLessThan(0.28);
    }
  });

  it('pays a failure less than a success, and an Exceptional bonus on top', () => {
    for (const { e, success } of perRun) {
      expect(wbe(value(e.exceptionalRewardTable)), e.key).toBeGreaterThan(0);
      const ratio = wbe(value(e.failureRewardTable)) / success;
      expect(ratio, e.key).toBeGreaterThan(0.15);
      expect(ratio, e.key).toBeLessThan(0.35);
    }
  });

  /**
   * Foothills' Exceptional personality, which is the region's identity showing
   * up in the shape of a table rather than only in its totals.
   *
   * Twin Peeks makes excelling *lucrative*: its bonus tables are worth 48-91%
   * of a success in WBe. Foothills makes excelling **developmental** — a
   * smaller WBe bump, and a large slug of XP on top of an already XP-heavy
   * success. A player who reads a Foothills Exceptional result sees the copy
   * they sent jump levels, not a pile of scrap.
   */
  it('makes Exceptional developmental rather than lucrative', () => {
    for (const { e, success } of perRun) {
      const ratio = wbe(value(e.exceptionalRewardTable)) / success;
      expect(ratio, e.key).toBeGreaterThan(0.25);
      expect(ratio, e.key).toBeLessThan(0.6);
      // The upside that *is* there: the bonus table pays at least 40% again of
      // the success table's Waifu XP.
      const xp = value(e.exceptionalRewardTable).waifuXp / value(e.rewardTable).waifuXp;
      expect(xp, `${e.key} bonus XP share`).toBeGreaterThan(0.4);
    }
    // Still a minority of expected value, so an ordinary success matters.
    for (const e of foothills) {
      const { successChance, exceptionalChance } = reference(e);
      const contribution =
        (successChance * exceptionalChance * wbe(value(e.exceptionalRewardTable))) /
        expectedWbe(e);
      expect(contribution, e.key).toBeGreaterThan(0.02);
      expect(contribution, e.key).toBeLessThan(0.2);
    }
  });

  // ── the identity, as numbers ─────────────────────────────────────────────

  /**
   * The point of the whole exercise: a player running all three regions should
   * want all three *for different reasons*. That is only true if the reward
   * profiles are measurably different, so it is asserted rather than described.
   *
   * Deliberately expressed as **comparisons between regions**, not as absolute
   * thresholds — retuning any region moves these together, and what must
   * survive retuning is the ordering, not the numbers.
   */
  it('is the development region: most XP, least Essence, same WBe band', () => {
    const REGIONS = ['waifu-valley', 'twin-peeks', 'flaccid-foothills'] as const;
    const waifuXp = Object.fromEntries(REGIONS.map((r) => [r, typicalDay(r, 'waifuXp')]));
    const playerXp = Object.fromEntries(REGIONS.map((r) => [r, typicalDay(r, 'playerXp')]));
    const essence = Object.fromEntries(REGIONS.map((r) => [r, typicalDay(r, 'essence')]));

    // Noticeably better for training — a third again, at least — than either
    // other region, on both XP tracks.
    for (const other of ['waifu-valley', 'twin-peeks'] as const) {
      expect(waifuXp['flaccid-foothills']!, `wXP vs ${other}`).toBeGreaterThan(
        waifuXp[other]! * 1.35,
      );
      expect(playerXp['flaccid-foothills']!, `pXP vs ${other}`).toBeGreaterThan(
        playerXp[other]! * 1.35,
      );
    }
    // But not a runaway: an XP region that pays triple stops being a choice
    // and starts being the only place worth deploying.
    expect(waifuXp['flaccid-foothills']!).toBeLessThan(
      Math.max(waifuXp['waifu-valley']!, waifuXp['twin-peeks']!) * 2,
    );

    // It buys that with Essence: the lowest of the three, and far below the
    // region whose identity Essence actually is.
    expect(essence['flaccid-foothills']!).toBeLessThan(essence['waifu-valley']!);
    expect(essence['flaccid-foothills']!).toBeLessThan(essence['twin-peeks']! * 0.4);

    // And not with WBe — the shared budget holds. (The per-region band is
    // asserted for every authored region in its own block above.)
    const wbeDay = typicalDay('flaccid-foothills', 'wbe');
    expect(wbeDay).toBeGreaterThan(250);
    expect(wbeDay).toBeLessThan(350);
  });

  it('rewards frequent play without making it the only way to play', () => {
    const day = (plan: readonly (readonly [number, number])[]) =>
      plan.reduce((sum, [minutes, runs]) => {
        const tier = foothills.filter((e) => e.durationMinutes === minutes);
        return sum + (tier.reduce((s, e) => s + expectedWbe(e), 0) / tier.length) * runs;
      }, 0);
    const typical = day([[1080, 1], [360, 1]]);
    expect(day([[360, 1], [60, 18]])).toBeGreaterThan(typical);
    expect(day([[360, 1], [60, 18]])).toBeLessThan(typical * 1.6);
    expect(day([[1080, 1]])).toBeGreaterThan(typical * 0.6);
    for (const plan of [[[1080, 1]], [[1080, 1], [360, 1]], [[360, 2], [180, 2], [60, 6]], [[360, 1], [60, 18]]] as const) {
      expect(day(plan)).toBeLessThan(500);
    }
  });

  // ── rare finds and the shop ──────────────────────────────────────────────

  /**
   * The Foothills chase is the **Trophy Wife Charm** — the region's own
   * 1,400-WaifuBux shop exclusive, which multiplies capture chance on UR and
   * LR targets only. It is an existing, region-native item rather than a new
   * one: nothing in the catalogue embodies "training", and minting a powerful
   * XP artifact to fill this slot would be inventing a mechanic to satisfy a
   * pattern. (A genuine training key item is noted as a Phase 6 hook instead.)
   *
   * Every non-salvage drop in a Foothills bonus table is held under one in a
   * hundred runs, which is what keeps the region's shop — two energy
   * consumables, an affection bouquet and this charm — worth actually
   * visiting. Promotion off the ridge is a story, not a supply line.
   */
  it('keeps the regional finds rare, and the Foothills shop worth shopping at', () => {
    const rate = (e: (typeof foothills)[number], itemId: string): number => {
      const { successChance, exceptionalChance } = reference(e);
      const table = tables.get(e.exceptionalRewardTable!)!;
      const group = table.groups.find((g) => g.entries.some((x) => x.itemId === itemId))!;
      const entry = group.entries.find((x) => x.itemId === itemId)!;
      const within = entry.weight / group.entries.reduce((s, x) => s + x.weight, 0);
      return successChance * exceptionalChance * (group.chanceBasisPoints / 10_000) * within;
    };

    const shopSlugs = new Set(
      SHIPPED.items.filter((i) => i.shopRegions.includes('flaccid-foothills')).map((i) => i.slug),
    );
    let nonSalvage = 0;
    let shopFinds = 0;
    for (const e of foothills) {
      const table = tables.get(e.exceptionalRewardTable!)!;
      for (const group of table.groups) {
        for (const entry of group.entries) {
          if (items.get(entry.itemId)?.category === 'salvage') continue;
          nonSalvage += 1;
          if (shopSlugs.has(entry.itemId)) shopFinds += 1;
          const p = rate(e, entry.itemId);
          expect(p, `${e.key} / ${entry.itemId}`).toBeGreaterThan(0);
          expect(p, `${e.key} / ${entry.itemId}`).toBeLessThan(0.01);
        }
      }
    }
    expect(nonSalvage).toBeGreaterThanOrEqual(5);
    expect(shopFinds).toBeGreaterThan(0);

    // Expensive regional stock never appears on a *success* table — only
    // behind an Exceptional result.
    for (const e of foothills) {
      for (const group of tables.get(e.rewardTable)!.groups) {
        for (const entry of group.entries) {
          const item = items.get(entry.itemId)!;
          if (!item.shopRegions.includes('flaccid-foothills')) continue;
          expect(item.buyPrice ?? 0, `${e.key} success table stocks ${entry.itemId}`)
            .toBeLessThanOrEqual(150);
        }
      }
    }

    // The chase itself, named so it cannot be quietly retuned away.
    const drill = foothills.find((e) => e.key === 'foothills_off_season_drill')!;
    const chase = rate(drill, 'trophy_wife_charm');
    expect(chase).toBeGreaterThan(0.001);
    expect(chase).toBeLessThan(0.006);
    const charm = items.get('trophy_wife_charm')!;
    expect(charm.shopRegions).toEqual(['flaccid-foothills']);
    // Not a WBe reward in disguise: it cannot be vendored.
    expect(charm.sellValue ?? 0).toBe(0);
  });

  it('never lists the same item twice in one Foothills reward group', () => {
    for (const table of foothillsTables) {
      for (const group of table.groups) {
        const ids = group.entries.map((entry) => entry.itemId);
        expect(new Set(ids).size, `${table.id} / ${group.id}`).toBe(ids.length);
      }
    }
  });

  it('exposes every Foothills mission over enough rotations, for any player', () => {
    const config = SHIPPED.tables.expeditions;
    const durations = Object.values(config.durations);
    for (const playerId of [1, 2, 17, 4242]) {
      const seen = new Set<string>();
      for (let window = 0; window < 200; window += 1) {
        for (const mission of buildBoard({
          playerId,
          regionId: 'flaccid-foothills',
          expeditions: SHIPPED.expeditions,
          durations,
          boardSize: config.boardSize,
          rotationHours: config.rotationHours,
          now: new Date(window * config.rotationHours * 3_600_000),
        })) {
          seen.add(mission.key);
        }
      }
      expect(seen.size, `player ${playerId}`).toBe(foothills.length);
    }
  });
});

/**
 * ── Thirstlands ────────────────────────────────────────────────────────────
 *
 * The fourth authored region, and the first one whose identity is a *shape*
 * rather than a second currency. Thirstlands pays the same family as Waifu
 * Valley — WaifuBux and salvage, nothing else — on the same ~300 WBe budget,
 * and is still meant to feel nothing like it:
 *
 *   - **Waifu Valley** — ordinary scavenging. Reliable income, and salvage
 *     that is the residue of ordinary life: a bent token, an unsent letter.
 *   - **Thirstlands** — a resource frontier. The same money arrives in lumps,
 *     and the salvage is what somebody was carrying or using for a reason and
 *     did not come back for.
 *
 * That difference is expressed three ways, and each one is asserted below
 * because none of them is visible in a WBe total:
 *
 *   1. **Composition** — the region takes a *smaller* direct-WaifuBux cut than
 *      any other (12–18%, against the Valley's ~27%), so the haul is the pay.
 *   2. **Variance** — most of a Thirstlands table's expected value sits behind
 *      low-probability gates rather than in guaranteed rolls. A run is more
 *      often mediocre and occasionally much better, at the same long-run EV.
 *   3. **A steeper ladder** — six salvage items spanning 8 → 255 WaifuBux,
 *      against the Valley's flatter spread, so the lumps are worth waiting for.
 *
 * What is deliberately *not* here: Essence (Twin Peeks owns that niche and
 * this region pays less of it than the Valley does), XP escalation (the
 * Foothills own that), and any item that gestures at a system which does not
 * exist yet. The maps, writs, unidentified components and buried rings this
 * region's missions talk about live in **mission text only** — no key items,
 * no equipment, nothing a player could sell today and regret when those
 * systems ship.
 */
describe('Thirstlands reward scaling', () => {
  const tables = new Map(SHIPPED.expeditionRewards.map((t) => [t.id, t]));
  const items = new Map(SHIPPED.items.map((i) => [i.slug, i]));
  const sell = new Map(SHIPPED.items.map((i) => [i.slug, i.sellValue ?? 0]));

  /** The region's own salvage, in ladder order. Named so it cannot drift. */
  const THIRSTLANDS_SALVAGE = [
    'spent_blasting_cap',
    'dust_choked_rig_filter',
    'sand_scoured_bearing',
    'surveyors_brass_dial',
    'strongbox_hinge_plate',
    'canyon_cut_gemstone',
  ] as const;

  /**
   * Mean **and variance** of a table's salvage, in WaifuBux.
   *
   * The variance matters here in a way it does not in the other regional
   * blocks: it is the arithmetic form of "pays in lumps". One group is a
   * Bernoulli gate in front of a weighted pick, repeated `rolls` times and
   * independent of every other group, so the moments add.
   */
  function value(id: string | null) {
    const table = id ? tables.get(id) : undefined;
    if (!table) {
      return { waifubux: 0, salvage: 0, essence: 0, waifuXp: 0, playerXp: 0, variance: 0, gated: 0 };
    }
    const mid = (r?: { min: number; max: number }) => (r ? (r.min + r.max) / 2 : 0);
    let salvage = 0;
    let variance = 0;
    /** Expected salvage drawn from groups rarer than 1-in-4. */
    let gated = 0;
    for (const group of table.groups.filter((g) => g.enabled)) {
      const entries = group.entries.filter((e) => e.enabled);
      const weight = entries.reduce((s, e) => s + e.weight, 0);
      const q = group.chanceBasisPoints / 10_000;
      const worth = (e: (typeof entries)[number]) => e.quantity * (sell.get(e.itemId) ?? 0);
      const m1 = entries.reduce((s, e) => s + (e.weight / weight) * worth(e), 0);
      const m2 = entries.reduce((s, e) => s + (e.weight / weight) * worth(e) ** 2, 0);
      const mean = q * m1;
      salvage += group.rolls * mean;
      variance += group.rolls * (q * m2 - mean ** 2);
      if (group.chanceBasisPoints <= 2_500) gated += group.rolls * mean;
    }
    return {
      waifubux: mid(table.waifubux),
      salvage,
      essence: mid(table.essence),
      waifuXp: table.waifuXp,
      playerXp: table.playerXp,
      variance,
      gated,
    };
  }
  const wbe = (v: { waifubux: number; salvage: number }): number => v.waifubux + v.salvage;

  const regionPool = (region: string) =>
    SHIPPED.expeditions
      .filter((e) => e.region === region && e.enabled)
      .sort((a, b) => a.durationMinutes - b.durationMinutes);

  const thirstlands = regionPool('thirstlands');
  const valley = regionPool('waifu-valley');
  const elsewhere = SHIPPED.expeditions.filter((e) => e.enabled && e.region !== 'thirstlands');
  const perRun = thirstlands.map((e) => {
    const v = value(e.rewardTable);
    return { e, success: wbe(v), ...v };
  });

  function reference(e: (typeof thirstlands)[number]) {
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

  function expectedWbe(e: (typeof thirstlands)[number]): number {
    const { successChance, exceptionalChance } = reference(e);
    const pExceptional = successChance * exceptionalChance;
    const pOrdinary = successChance - pExceptional;
    const success = wbe(value(e.rewardTable));
    return (
      (1 - successChance) * wbe(value(e.failureRewardTable)) +
      pOrdinary * success +
      pExceptional * (success + wbe(value(e.exceptionalRewardTable)))
    );
  }

  const TIERS = [60, 180, 360, 1080] as const;
  const tierMean = (pool: typeof thirstlands, minutes: number): number => {
    const runs = pool.filter((e) => e.durationMinutes === minutes);
    expect(runs.length).toBeGreaterThan(0);
    return runs.reduce((s, e) => s + wbe(value(e.rewardTable)), 0) / runs.length;
  };
  const tierExpected = (minutes: number): number => {
    const runs = thirstlands.filter((e) => e.durationMinutes === minutes);
    return runs.reduce((s, e) => s + expectedWbe(e), 0) / runs.length;
  };

  const tablesOf = (pool: readonly LoadedContent['expeditions'][number][]) =>
    pool
      .flatMap((e) => [e.rewardTable, e.exceptionalRewardTable, e.failureRewardTable])
      .filter((id): id is string => id != null)
      .map((id) => tables.get(id)!);
  const thirstlandsTables = tablesOf(thirstlands);

  // ── pool shape ───────────────────────────────────────────────────────────

  it('gives Thirstlands a full pool with at least two missions on every tier', () => {
    expect(thirstlands.length).toBeGreaterThanOrEqual(9);
    for (const tier of TIERS) {
      expect(
        thirstlands.filter((e) => e.durationMinutes === tier).length,
        `${tier}m tier`,
      ).toBeGreaterThanOrEqual(2);
    }
    for (const e of thirstlands) {
      expect(e.exceptionalRewardTable, e.key).not.toBeNull();
      expect(e.failureRewardTable, e.key).not.toBeNull();
    }
  });

  it('gives every Thirstlands mission its own name, description and emoji', () => {
    expect(new Set(thirstlands.map((e) => e.name)).size).toBe(thirstlands.length);
    expect(new Set(thirstlands.map((e) => e.description)).size).toBe(thirstlands.length);
    expect(new Set(thirstlands.map((e) => e.emoji)).size).toBe(thirstlands.length);
    const taken = new Set(elsewhere.map((e) => e.name));
    for (const e of thirstlands) expect(taken.has(e.name), e.key).toBe(false);
  });

  it('spreads Thirstlands across every affinity and every race', () => {
    for (const affinity of AFFINITIES) {
      expect(
        thirstlands.some((e) => e.preferredAffinities.includes(affinity)),
        affinity,
      ).toBe(true);
    }
    for (const race of RACE_CODES) {
      expect(thirstlands.some((e) => e.preferredRaces.includes(race)), race).toBe(true);
    }
    const levels = thirstlands.map((e) => e.recommendedLevel);
    // The road costs 2,000 WaifuBux at player level 25, but a first visitor's
    // *roster* is not built around this region, so the entry rung stays low.
    expect(Math.min(...levels)).toBeLessThanOrEqual(6);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(25);
    const overnight = thirstlands.filter((e) => e.durationMinutes === 1080);
    expect(Math.min(...overnight.map((e) => e.recommendedLevel))).toBeLessThanOrEqual(20);
  });

  it('does not reproduce a requirement pair from any earlier region', () => {
    const fingerprint = (e: LoadedContent['expeditions'][number]) =>
      `${[...e.preferredAffinities].sort().join('+')}|${[...e.preferredRaces].sort().join('+')}`;
    const taken = new Set(elsewhere.map(fingerprint));
    for (const e of thirstlands) {
      expect(taken.has(fingerprint(e)), `${e.key} duplicates an existing pair`).toBe(false);
    }
  });

  it('leaves a PERFECT MATCH path open on every Thirstlands mission', () => {
    const roster = SHIPPED.species
      .filter((s) => s.enabled)
      .map((s) => ({ affinity: s.affinity, race: resolveRace(s) }));
    for (const e of thirstlands) {
      const reachable = roster.some(
        (s) =>
          evaluateMatch({
            definition: e,
            waifu: { level: e.recommendedLevel, affinity: s.affinity, race: s.race },
            config: SHIPPED.tables.expeditions,
            affinityConfig: SHIPPED.tables.buddyAffinity,
          }).quality === 'PERFECT_MATCH',
      );
      expect(reachable, `${e.key} has no PERFECT MATCH path`).toBe(true);
    }
  });

  it('uses single-preference missions sparingly', () => {
    const oneAxis = thirstlands.filter(
      (e) => e.preferredAffinities.length === 0 || e.preferredRaces.length === 0,
    );
    expect(oneAxis.length).toBeLessThanOrEqual(2);
  });

  /**
   * The board reads as a frontier before a single number is compared. Waifu
   * Valley is errands — six of its eleven missions are supply runs and
   * escorts; Thirstlands is work you have to dig for.
   */
  it('leans on recovery work rather than errands', () => {
    const recovery = thirstlands.filter((e) =>
      (['excavation', 'salvage_dive', 'scouting'] as const).includes(
        e.type as 'excavation' | 'salvage_dive' | 'scouting',
      ),
    );
    expect(recovery.length).toBeGreaterThanOrEqual(Math.ceil(thirstlands.length / 2));
    const errands = thirstlands.filter((e) => e.type === 'supply_run' || e.type === 'escort');
    expect(errands.length).toBeLessThanOrEqual(2);
    // The overnight slot is the region's set piece, not another night shift.
    expect(thirstlands.some((e) => e.durationMinutes === 1080 && e.type === 'salvage_dive')).toBe(
      true,
    );
  });

  // ── salvage identity ─────────────────────────────────────────────────────

  it('pays Thirstlands salvage, and no other region pays it', () => {
    const salvageIn = (set: typeof thirstlandsTables) =>
      new Set(
        set.flatMap((t) =>
          t.groups.flatMap((g) =>
            g.entries.map((e) => e.itemId).filter((id) => items.get(id)?.category === 'salvage'),
          ),
        ),
      );
    expect([...salvageIn(thirstlandsTables)].sort()).toEqual([...THIRSTLANDS_SALVAGE].sort());
    for (const id of salvageIn(tablesOf(elsewhere))) {
      expect((THIRSTLANDS_SALVAGE as readonly string[]).includes(id), id).toBe(false);
    }
  });

  /**
   * A **steeper** ladder than the Valley's, not a richer one. Unlocking fourth
   * is not a reason for the scrap to be worth more, so the top rung stays
   * under the most valuable salvage already in the game; what changes is the
   * spread between the bottom rung and the top, which is what makes a gated
   * find feel like a find.
   */
  it('keeps Thirstlands salvage on a steeper value ladder than the Valley', () => {
    const values = THIRSTLANDS_SALVAGE.map((slug) => {
      const item = items.get(slug);
      expect(item, slug).toBeDefined();
      expect(item!.category).toBe('salvage');
      expect(item!.enabled).toBe(true);
      // Salvage is vendorable without ever being purchasable.
      expect(item!.shopRegions, slug).toEqual([]);
      expect(item!.buyPrice ?? 0, slug).toBe(0);
      expect(item!.sellValue, slug).toBeGreaterThan(0);
      return item!.sellValue!;
    });
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThanOrEqual(6);
    // Granular at the bottom, so a 1h table can be priced without rounding to
    // nothing — and mundane, because not every object should look important.
    expect(Math.min(...values)).toBeLessThanOrEqual(10);

    const others = SHIPPED.items
      .filter(
        (i) =>
          i.category === 'salvage' && !(THIRSTLANDS_SALVAGE as readonly string[]).includes(i.slug),
      )
      .map((i) => i.sellValue ?? 0);
    expect(Math.max(...values)).toBeLessThanOrEqual(Math.max(...others));

    // Steeper: fewer rungs covering a wider multiple than the Valley's pool.
    const valleySalvage = new Set(
      tablesOf(valley).flatMap((t) =>
        t.groups.flatMap((g) =>
          g.entries.map((e) => e.itemId).filter((id) => items.get(id)?.category === 'salvage'),
        ),
      ),
    );
    const valleyValues = [...valleySalvage].map((id) => items.get(id)!.sellValue ?? 0);
    const spread = (v: number[]) => Math.max(...v) / Math.min(...v);
    expect(values.length).toBeLessThan(valleyValues.length);
    expect(spread(values)).toBeGreaterThan(spread(valleyValues) * 0.55);
  });

  // ── the curve ────────────────────────────────────────────────────────────

  it('pays more per run the longer the tier', () => {
    const means = TIERS.map((t) => tierMean(thirstlands, t));
    for (let i = 1; i < means.length; i += 1) expect(means[i]!).toBeGreaterThan(means[i - 1]!);
  });

  it('preserves the duration curve: 1h > 3h > 6h per hour, with a modest 18h premium', () => {
    const hourly = TIERS.map((t) => tierMean(thirstlands, t) / (t / 60));
    expect(hourly[0]!).toBeGreaterThan(hourly[1]!);
    expect(hourly[1]!).toBeGreaterThan(hourly[2]!);
    expect(hourly[3]!).toBeGreaterThan(hourly[2]!);
    expect(hourly[3]!).toBeLessThan(hourly[1]!);
    expect(hourly[3]! / hourly[2]!).toBeLessThan(1.5);
  });

  // ── composition: the haul is the pay ─────────────────────────────────────

  /**
   * The narrowest direct-WaifuBux cut of any region, and a floor under it.
   * The floor is not decoration: because so much of this region's value hides
   * behind gates, a run whose salvage rolls badly has to have paid *something*
   * on its own, or a successful mission reads as a bug.
   */
  it('takes the smallest direct-WaifuBux cut of any region, but never zero', () => {
    for (const r of perRun) {
      expect(r.waifubux, r.e.key).toBeGreaterThan(0);
      expect(r.waifubux / r.success, r.e.key).toBeGreaterThan(0.12);
      expect(r.waifubux / r.success, r.e.key).toBeLessThan(0.18);
    }
    const share = (pool: typeof thirstlands) => {
      const totals = pool.map((e) => value(e.rewardTable));
      const wb = totals.reduce((s, v) => s + v.waifubux, 0);
      const sal = totals.reduce((s, v) => s + v.salvage, 0);
      return sal / (wb + sal);
    };
    const mine = share(thirstlands);
    expect(mine).toBeGreaterThan(0.82);
    expect(mine).toBeLessThan(0.88);
    // Materially more salvage-led than the region it shares its economy with.
    expect(mine).toBeGreaterThan(share(valley) + 0.08);
  });

  // ── variance: the Valley pays reliably, the Thirstlands pays in lumps ────

  /**
   * The identity, stated as arithmetic.
   *
   * Two regions can pay the same WBe/day and feel completely different, and
   * this is the measurement that tells them apart. Asserted on **every tier**
   * rather than on a regional average, because an average can be carried by
   * one swingy mission — the Valley's own `room_twelve_turnover` is swingier
   * than most of this region and proves the point.
   */
  it('runs materially higher salvage variance than Waifu Valley, tier for tier', () => {
    const cv = (e: LoadedContent['expeditions'][number]) => {
      const v = value(e.rewardTable);
      return Math.sqrt(v.variance) / v.salvage;
    };
    const meanCv = (pool: typeof thirstlands, tier: number) => {
      const runs = pool.filter((e) => e.durationMinutes === tier);
      return runs.reduce((s, e) => s + cv(e), 0) / runs.length;
    };
    for (const tier of TIERS) {
      expect(meanCv(thirstlands, tier), `${tier}m variance`).toBeGreaterThan(
        meanCv(valley, tier),
      );
    }
  });

  /**
   * *Where* the value sits, which is the mechanism behind the variance above.
   *
   * In the Valley most of a table's expected salvage comes out of groups that
   * almost always fire; here most of it sits behind gates rarer than one in
   * four. That is what makes an ordinary Thirstlands run modest and an
   * occasional one much better at the same long-run EV.
   */
  it('hides most of its expected salvage behind low-probability finds', () => {
    const gatedShare = (pool: typeof thirstlands) => {
      const totals = pool.map((e) => value(e.rewardTable));
      return (
        totals.reduce((s, v) => s + v.gated, 0) / totals.reduce((s, v) => s + v.salvage, 0)
      );
    };
    const mine = gatedShare(thirstlands);
    expect(mine).toBeGreaterThan(0.6);
    expect(mine).toBeGreaterThan(gatedShare(valley) * 2);
    for (const r of perRun) {
      expect(r.gated / r.salvage, r.e.key).toBeGreaterThan(0.4);
    }
  });

  /**
   * Lumpy is not the same as punishing. A player who succeeds and comes back
   * with nothing but pocket change is having a bad run, not hitting a bug, so
   * the rate at which that happens stays inside the range the Valley already
   * ships rather than becoming its own kind of difficulty.
   */
  it('does not make an empty haul more common than the Valley already allows', () => {
    const empty = (e: LoadedContent['expeditions'][number]) => {
      const table = tables.get(e.rewardTable)!;
      let p = 1;
      for (const group of table.groups.filter((g) => g.enabled)) {
        const worth = group.entries
          .filter((x) => x.enabled)
          .reduce((s, x) => s + x.quantity * (sell.get(x.itemId) ?? 0), 0);
        if (worth <= 0) continue;
        p *= (1 - group.chanceBasisPoints / 10_000) ** group.rolls;
      }
      return p;
    };
    const ceiling = Math.max(...valley.map(empty));
    for (const e of thirstlands) expect(empty(e), e.key).toBeLessThanOrEqual(ceiling);
  });

  // ── failure and Exceptional ──────────────────────────────────────────────

  it('pays a failure less than a success, and an Exceptional bonus on top', () => {
    for (const { e, success } of perRun) {
      expect(wbe(value(e.exceptionalRewardTable)), e.key).toBeGreaterThan(0);
      const ratio = wbe(value(e.failureRewardTable)) / success;
      expect(ratio, e.key).toBeGreaterThan(0.15);
      expect(ratio, e.key).toBeLessThan(0.35);
    }
  });

  /**
   * Exceptional here is **one better find**, not a second haul.
   *
   * A bonus table that repeated the success table's structure would pay the
   * player more of the same junk at a moment that is supposed to be the story
   * of the run. So every Exceptional table carries at most one salvage group,
   * and that group rolls once: the result is a single object worth talking
   * about, which is the Thirstlands version of excelling.
   */
  it('makes Exceptional one interesting find rather than a second haul', () => {
    for (const e of thirstlands) {
      const table = tables.get(e.exceptionalRewardTable!)!;
      const salvageGroups = table.groups.filter((g) =>
        g.entries.some((x) => items.get(x.itemId)?.category === 'salvage'),
      );
      expect(salvageGroups.length, `${e.key} bonus table`).toBe(1);
      expect(salvageGroups[0]!.rolls, `${e.key} bonus rolls`).toBe(1);
      // And it is drawn from the top of the ladder, never the bottom.
      const floor = Math.min(
        ...salvageGroups[0]!.entries.map((x) => sell.get(x.itemId) ?? 0),
      );
      expect(floor, `${e.key} bonus floor`).toBeGreaterThanOrEqual(42);
    }
    for (const { e, success } of perRun) {
      const ratio = wbe(value(e.exceptionalRewardTable)) / success;
      expect(ratio, e.key).toBeGreaterThan(0.4);
      expect(ratio, e.key).toBeLessThan(1.0);
    }
    // Bounded in expectation: exciting, never the budget.
    for (const e of thirstlands) {
      const { successChance, exceptionalChance } = reference(e);
      const contribution =
        (successChance * exceptionalChance * wbe(value(e.exceptionalRewardTable))) /
        expectedWbe(e);
      expect(contribution, e.key).toBeGreaterThan(0.02);
      expect(contribution, e.key).toBeLessThan(0.2);
    }
  });

  // ── the budget ───────────────────────────────────────────────────────────

  const DAY = {
    casual: [[1080, 1]],
    typical: [[1080, 1], [360, 1]],
    active: [[360, 2], [180, 2], [60, 6]],
    aggressive: [[360, 1], [60, 18]],
  } as const satisfies Record<string, readonly (readonly [number, number])[]>;

  const dayWbe = (plan: readonly (readonly [number, number])[]): number =>
    plan.reduce((sum, [minutes, runs]) => sum + tierExpected(minutes) * runs, 0);

  /**
   * Authored to **275–300 WBe** on the benchmark day, inside the 250–350 band
   * every region shares. Held as a band rather than a value so ordinary
   * retuning passes; the point is that a later region is neither a payday nor
   * a taper.
   */
  it('pays a peer 275-300 WBe on a typical one-region day', () => {
    const typical = dayWbe(DAY.typical);
    expect(typical).toBeGreaterThan(270);
    expect(typical).toBeLessThan(310);
  });

  it('cannot quietly become a runaway region', () => {
    for (const plan of Object.values(DAY)) expect(dayWbe(plan)).toBeLessThan(500);
  });

  it('rewards frequent play without making it the only way to play', () => {
    const typical = dayWbe(DAY.typical);
    expect(dayWbe(DAY.aggressive)).toBeGreaterThan(typical);
    expect(dayWbe(DAY.aggressive)).toBeLessThan(typical * 1.6);
    expect(dayWbe(DAY.casual)).toBeGreaterThan(typical * 0.6);
  });

  // ── the niches it does not take ──────────────────────────────────────────

  /**
   * Twin Peeks owns elevated Essence and the Foothills own elevated XP. This
   * region is allowed to pay both at background rates and nothing more —
   * which, for Essence, means *below* the Valley, not merely below Twin Peeks.
   *
   * Worth stating because the pull exists: the two strongest Essence Buddy
   * Bonuses in the game (`tak_belly_dancer` at +75%, `goblin_gemcutter` at
   * +50%) are both Thirstlands residents. That is a Buddy-side channel and it
   * stays one; the Expedition board must not become a second.
   */
  it('takes neither the Essence nor the XP niche', () => {
    const mean = (pool: typeof thirstlands, pick: (v: ReturnType<typeof value>) => number) =>
      pool.reduce((s, e) => s + pick(value(e.rewardTable)), 0) / pool.length;

    const essence = mean(thirstlands, (v) => v.essence);
    expect(essence).toBeLessThan(mean(valley, (v) => v.essence));
    expect(essence).toBeLessThan(mean(regionPool('twin-peeks'), (v) => v.essence) * 0.25);

    // XP stays on the Valley scale, tier for tier, and well under the Foothills.
    const foothills = regionPool('flaccid-foothills');
    for (const tier of TIERS) {
      const xpOf = (pool: typeof thirstlands) => {
        const runs = pool.filter((e) => e.durationMinutes === tier);
        return runs.reduce((s, e) => s + value(e.rewardTable).waifuXp, 0) / runs.length;
      };
      const mine = xpOf(thirstlands);
      expect(mine, `${tier}m waifu XP`).toBeGreaterThan(xpOf(valley) * 0.8);
      expect(mine, `${tier}m waifu XP`).toBeLessThan(xpOf(valley) * 1.2);
      expect(mine, `${tier}m waifu XP`).toBeLessThan(xpOf(foothills));
    }
  });

  // ── the shop, and the systems that do not exist yet ──────────────────────

  /**
   * The regional shop stays the way to get regional stock.
   *
   * Thirstlands sells four things, two of them daily-limited premium sinks —
   * the Thirst Trap Flask (950 WaifuBux, 3 a day) and the Mouthful of Mercy
   * (920, 3 a day). A table that handed either out would not be generous, it
   * would delete the limit. They are named here so the absence is deliberate
   * and survives a retune.
   */
  it('never puts premium Thirstlands stock in a reward table', () => {
    const forbidden = ['thirst_trap_flask', 'mouthful_of_mercy', 'booty_sweat'];
    for (const table of thirstlandsTables) {
      for (const group of table.groups) {
        for (const entry of group.entries) {
          expect(forbidden, `${table.id} / ${entry.itemId}`).not.toContain(entry.itemId);
        }
      }
    }
    // Nothing purchasable at all reaches a *success* table.
    for (const e of thirstlands) {
      for (const group of tables.get(e.rewardTable)!.groups) {
        for (const entry of group.entries) {
          expect(
            items.get(entry.itemId)!.shopRegions,
            `${e.key} success table stocks ${entry.itemId}`,
          ).toEqual([]);
        }
      }
    }
  });

  it('keeps the regional finds rare, and the Thirstlands shop worth shopping at', () => {
    const rate = (e: (typeof thirstlands)[number], itemId: string): number => {
      const { successChance, exceptionalChance } = reference(e);
      const table = tables.get(e.exceptionalRewardTable!)!;
      const group = table.groups.find((g) => g.entries.some((x) => x.itemId === itemId))!;
      const entry = group.entries.find((x) => x.itemId === itemId)!;
      const within = entry.weight / group.entries.reduce((s, x) => s + x.weight, 0);
      return successChance * exceptionalChance * (group.chanceBasisPoints / 10_000) * within;
    };

    let nonSalvage = 0;
    for (const e of thirstlands) {
      for (const group of tables.get(e.exceptionalRewardTable!)!.groups) {
        for (const entry of group.entries) {
          if (items.get(entry.itemId)?.category === 'salvage') continue;
          nonSalvage += 1;
          const p = rate(e, entry.itemId);
          expect(p, `${e.key} / ${entry.itemId}`).toBeGreaterThan(0);
          expect(p, `${e.key} / ${entry.itemId}`).toBeLessThan(0.01);
        }
      }
    }
    expect(nonSalvage).toBeGreaterThanOrEqual(4);

    // The one piece of Thirstlands shop stock a mission can produce, named so
    // it cannot be quietly widened.
    const wake = thirstlands.find((e) => e.key === 'thirst_procession_wake')!;
    const collar = rate(wake, 'claim_collar');
    expect(collar).toBeGreaterThan(0.001);
    expect(collar).toBeLessThan(0.008);
    const item = items.get('claim_collar')!;
    expect(item.shopRegions).toEqual(['thirstlands']);
    // Not a WBe reward in disguise: it cannot be vendored.
    expect(item.sellValue ?? 0).toBe(0);
  });

  /**
   * The breadcrumbs stay breadcrumbs.
   *
   * These missions talk about a chart that stops at a junction, a component
   * the mechanic cannot place, a writ with a name crossed out twice and a
   * caravan whose rings you leave where they are. None of that is an item,
   * and it must not become one by accident before key items, equipment and
   * the encounter-gating language exist. Until then, everything this region
   * hands over is ordinary sellable salvage a player can vendor without ever
   * having destroyed a key.
   */
  it('hands out nothing that a future key-item or equipment system would want back', () => {
    for (const table of thirstlandsTables) {
      for (const group of table.groups) {
        for (const entry of group.entries) {
          const item = items.get(entry.itemId)!;
          expect(['salvage', 'capture'], `${table.id} / ${item.slug}`).toContain(item.category);
          if (item.category !== 'salvage') continue;
          // Sellable today, and sellable without a second opt-in — which is
          // exactly what a `key` item is not.
          expect(item.sellValue ?? 0, item.slug).toBeGreaterThan(0);
          expect(item.explicitlySellable ?? false, item.slug).toBe(false);
        }
      }
    }
    // And the fiction is carried by the missions, not by inert objects.
    const prose = thirstlands.map((e) => `${e.name} ${e.description}`.toLowerCase()).join(' ');
    for (const thread of ['chart', 'writ', 'not built anywhere', 'rings']) {
      expect(prose, thread).toContain(thread);
    }
  });

  it('never lists the same item twice in one Thirstlands reward group', () => {
    for (const table of thirstlandsTables) {
      for (const group of table.groups) {
        const ids = group.entries.map((entry) => entry.itemId);
        expect(new Set(ids).size, `${table.id} / ${group.id}`).toBe(ids.length);
      }
    }
  });

  it('exposes every Thirstlands mission over enough rotations, for any player', () => {
    const config = SHIPPED.tables.expeditions;
    const durations = Object.values(config.durations);
    for (const playerId of [1, 2, 17, 4242]) {
      const seen = new Set<string>();
      for (let window = 0; window < 200; window += 1) {
        for (const mission of buildBoard({
          playerId,
          regionId: 'thirstlands',
          expeditions: SHIPPED.expeditions,
          durations,
          boardSize: config.boardSize,
          rotationHours: config.rotationHours,
          now: new Date(window * config.rotationHours * 3_600_000),
        })) {
          seen.add(mission.key);
        }
      }
      expect(seen.size, `player ${playerId}`).toBe(thirstlands.length);
    }
  });

  /**
   * The board a player actually opens, on the day the region ships: full, one
   * mission per tier, and no longer the empty rectangle it rendered while the
   * region had a shop, a pass and fifteen residents but nothing to do.
   */
  it('fills a board on every rotation', () => {
    const config = SHIPPED.tables.expeditions;
    const durations = Object.values(config.durations);
    for (let window = 0; window < 12; window += 1) {
      const board = buildBoard({
        playerId: 7,
        regionId: 'thirstlands',
        expeditions: SHIPPED.expeditions,
        durations,
        boardSize: config.boardSize,
        rotationHours: config.rotationHours,
        now: new Date(window * config.rotationHours * 3_600_000),
      });
      expect(board.length, `window ${window}`).toBe(config.boardSize);
      expect(new Set(board.map((m) => m.durationMinutes)).size, `window ${window}`).toBe(
        TIERS.length,
      );
    }
  });
});
