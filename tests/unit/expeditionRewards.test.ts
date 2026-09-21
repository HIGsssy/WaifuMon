/**
 * Expedition payout rolling. Pure — no DB, no clock, no content snapshot.
 *
 * The load-bearing claims here are the two the design turns on: that
 * Exceptional Success is **additive**, and that a retried resolution
 * reproduces its first result exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  mergeGrants,
  rollExpeditionRewards,
  rollExpeditionTable,
} from '../../src/modules/expeditions/expeditionRewards';
import {
  ExpeditionRewardTableSchema,
  type ExpeditionRewardTable,
} from '../../src/modules/content/schemas';

function table(over: Record<string, unknown> = {}): ExpeditionRewardTable {
  return ExpeditionRewardTableSchema.parse({
    id: 'test_table',
    waifubux: { min: 100, max: 100 },
    waifuXp: 50,
    groups: [
      {
        id: 'salvage',
        chanceBasisPoints: 10000,
        entries: [{ itemId: 'scrap_a', weight: 1, quantity: 2 }],
      },
    ],
    ...over,
  });
}

/** A table whose only group is certain, so its contents are deterministic. */
const CERTAIN = table();

const BONUS = table({
  id: 'bonus_table',
  waifubux: { min: 500, max: 500 },
  essence: { min: 3, max: 3 },
  waifuXp: 25,
  groups: [
    {
      id: 'rare-find',
      chanceBasisPoints: 10000,
      entries: [{ itemId: 'treasure_map', weight: 1, quantity: 1 }],
    },
  ],
});

const FAILURE = table({
  id: 'failure_table',
  waifubux: { min: 10, max: 10 },
  waifuXp: 5,
  groups: [],
});

describe('rollExpeditionTable', () => {
  it('pays the authored currency, essence and XP', () => {
    const roll = rollExpeditionTable({ table: BONUS, expeditionId: 1, kind: 'bonus' });
    expect(roll.waifubux).toBe(500);
    expect(roll.essence).toBe(3);
    expect(roll.waifuXp).toBe(25);
  });

  it('pays zero for an unauthored currency range rather than throwing', () => {
    const roll = rollExpeditionTable({ table: CERTAIN, expeditionId: 1, kind: 'success' });
    expect(roll.essence).toBe(0);
    expect(roll.playerXp).toBe(0);
  });

  it('draws both ends of a currency range across expedition ids', () => {
    const ranged = table({ waifubux: { min: 1, max: 100 } });
    const drawn = new Set<number>();
    // Enough ids to beat the coupon-collector bound over a 100-wide range; a
    // smaller sample would fail on which values happened to come up rather
    // than on whether the endpoints are reachable at all.
    for (let id = 1; id <= 5000; id += 1) {
      drawn.add(rollExpeditionTable({ table: ranged, expeditionId: id, kind: 'success' }).waifubux);
    }
    // Inclusive at both ends — the property an integer draw has and a scaled
    // float does not.
    expect(drawn.has(1)).toBe(true);
    expect(drawn.has(100)).toBe(true);
  });

  it('carries the table version, defaulting to the id', () => {
    expect(rollExpeditionTable({ table: CERTAIN, expeditionId: 1, kind: 'success' }).tableVersion)
      .toBe('test_table');
    const versioned = table({ version: 'v2-autumn-retune' });
    expect(
      rollExpeditionTable({ table: versioned, expeditionId: 1, kind: 'success' }).tableVersion,
    ).toBe('v2-autumn-retune');
  });

  describe('groups', () => {
    it('is independent between groups — one firing does not displace another', () => {
      const two = table({
        groups: [
          { id: 'a', chanceBasisPoints: 10000, entries: [{ itemId: 'a1', weight: 1 }] },
          { id: 'b', chanceBasisPoints: 10000, entries: [{ itemId: 'b1', weight: 1 }] },
        ],
      });
      const roll = rollExpeditionTable({ table: two, expeditionId: 1, kind: 'success' });
      expect(roll.items.map((i) => i.slug).sort()).toEqual(['a1', 'b1']);
    });

    it('rolls a group `rolls` times', () => {
      const repeated = table({
        groups: [
          { id: 'a', rolls: 3, chanceBasisPoints: 10000, entries: [{ itemId: 'a1', weight: 1 }] },
        ],
      });
      const roll = rollExpeditionTable({ table: repeated, expeditionId: 1, kind: 'success' });
      expect(roll.items).toHaveLength(3);
    });

    it('skips a disabled group entirely', () => {
      const disabled = table({
        groups: [
          {
            id: 'a',
            enabled: false,
            chanceBasisPoints: 10000,
            entries: [{ itemId: 'a1', weight: 1 }],
          },
        ],
      });
      const roll = rollExpeditionTable({ table: disabled, expeditionId: 1, kind: 'success' });
      expect(roll.items).toEqual([]);
      // A deliberate switch-off is not a misconfiguration.
      expect(roll.warnings).toEqual([]);
    });

    // Weights normalize over *enabled* entries, so switching one off
    // redistributes its share rather than leaving a hole.
    it('redistributes a disabled entry’s weight across the rest', () => {
      const partly = table({
        groups: [
          {
            id: 'a',
            chanceBasisPoints: 10000,
            entries: [
              { itemId: 'gone', enabled: false, weight: 9999 },
              { itemId: 'stays', weight: 1 },
            ],
          },
        ],
      });
      for (let id = 1; id <= 50; id += 1) {
        const roll = rollExpeditionTable({ table: partly, expeditionId: id, kind: 'success' });
        expect(roll.items.map((i) => i.slug)).toEqual(['stays']);
      }
    });

    it('warns rather than crashing when a group has no enabled entries', () => {
      const empty = table({
        groups: [
          {
            id: 'a',
            chanceBasisPoints: 10000,
            entries: [{ itemId: 'gone', enabled: false, weight: 1 }],
          },
        ],
      });
      const roll = rollExpeditionTable({ table: empty, expeditionId: 1, kind: 'success' });
      expect(roll.items).toEqual([]);
      expect(roll.warnings).toHaveLength(1);
      expect(roll.warnings[0]?.groupId).toBe('a');
      expect(roll.warnings[0]?.message).toContain('no enabled');
    });

    it('warns about a group that can never drop', () => {
      const never = table({
        groups: [{ id: 'a', chanceBasisPoints: 0, entries: [{ itemId: 'a1', weight: 1 }] }],
      });
      const roll = rollExpeditionTable({ table: never, expeditionId: 1, kind: 'success' });
      expect(roll.items).toEqual([]);
      expect(roll.warnings[0]?.message).toContain('can never drop');
    });

    it('gates a rare group — sometimes firing, usually not', () => {
      const rare = table({
        groups: [{ id: 'rare', chanceBasisPoints: 2000, entries: [{ itemId: 'r', weight: 1 }] }],
      });
      let hits = 0;
      for (let id = 1; id <= 1000; id += 1) {
        hits += rollExpeditionTable({ table: rare, expeditionId: id, kind: 'success' }).items.length;
      }
      // 20% of 1000 with a wide band: this asserts the gate works at all, not
      // that md5 is a perfect uniform source.
      expect(hits).toBeGreaterThan(120);
      expect(hits).toBeLessThan(290);
    });
  });

  // The namespaces are what make the success and bonus rolls independent.
  it('draws differently for the same table rolled in different slots', () => {
    const ranged = table({ waifubux: { min: 1, max: 1000 } });
    const asSuccess = rollExpeditionTable({ table: ranged, expeditionId: 7, kind: 'success' });
    const asBonus = rollExpeditionTable({ table: ranged, expeditionId: 7, kind: 'bonus' });
    expect(asSuccess.waifubux).not.toBe(asBonus.waifubux);
  });
});

describe('determinism', () => {
  it('reproduces the same payout for the same expedition id', () => {
    const first = rollExpeditionRewards({
      outcome: 'exceptional',
      expeditionId: 4242,
      successTable: table({ waifubux: { min: 1, max: 1000 } }),
      bonusTable: BONUS,
      failureTable: FAILURE,
    });
    const second = rollExpeditionRewards({
      outcome: 'exceptional',
      expeditionId: 4242,
      successTable: table({ waifubux: { min: 1, max: 1000 } }),
      bonusTable: BONUS,
      failureTable: FAILURE,
    });
    // This is the property that makes a retried resolution safe: a second
    // attempt after a crash computes what the first one did.
    expect(second).toEqual(first);
  });

  it('produces different payouts for different expeditions', () => {
    const ranged = table({ waifubux: { min: 1, max: 100000 } });
    const a = rollExpeditionRewards({
      outcome: 'success',
      expeditionId: 1,
      successTable: ranged,
      bonusTable: null,
      failureTable: null,
    });
    const b = rollExpeditionRewards({
      outcome: 'success',
      expeditionId: 2,
      successTable: ranged,
      bonusTable: null,
      failureTable: null,
    });
    expect(a.waifubux).not.toBe(b.waifubux);
  });
});

describe('Exceptional Success is additive', () => {
  const roll = (outcome: 'failure' | 'success' | 'exceptional') =>
    rollExpeditionRewards({
      outcome,
      expeditionId: 99,
      successTable: CERTAIN,
      bonusTable: BONUS,
      failureTable: FAILURE,
    });

  it('pays the success table alone on an ordinary success', () => {
    const result = roll('success');
    expect(result.waifubux).toBe(100);
    expect(result.waifuXp).toBe(50);
    expect(result.items.map((i) => i.slug)).toEqual(['scrap_a']);
    expect(result.sources.map((s) => s.kind)).toEqual(['success']);
  });

  /**
   * The headline rule. An exceptional result is the ordinary payout **plus**
   * the bonus payout — never the bonus instead of it — so Exceptional is
   * unambiguously better rather than a different distribution to compare.
   */
  it('pays success PLUS bonus on an exceptional success', () => {
    const ordinary = roll('success');
    const exceptional = roll('exceptional');

    expect(exceptional.waifubux).toBe(ordinary.waifubux + 500);
    expect(exceptional.waifuXp).toBe(ordinary.waifuXp + 25);
    expect(exceptional.essence).toBe(ordinary.essence + 3);
    expect(exceptional.items.map((i) => i.slug).sort()).toEqual(['scrap_a', 'treasure_map']);
    expect(exceptional.sources.map((s) => s.kind)).toEqual(['success', 'bonus']);
  });

  it('is never worse than an ordinary success on any axis', () => {
    const ordinary = roll('success');
    const exceptional = roll('exceptional');
    expect(exceptional.waifubux).toBeGreaterThanOrEqual(ordinary.waifubux);
    expect(exceptional.essence).toBeGreaterThanOrEqual(ordinary.essence);
    expect(exceptional.waifuXp).toBeGreaterThanOrEqual(ordinary.waifuXp);
    expect(exceptional.items.length).toBeGreaterThanOrEqual(ordinary.items.length);
  });

  it('adding a bonus table cannot change what the success table pays', () => {
    const withBonus = rollExpeditionRewards({
      outcome: 'exceptional',
      expeditionId: 55,
      successTable: table({ waifubux: { min: 1, max: 1000 } }),
      bonusTable: BONUS,
      failureTable: null,
    });
    const withoutBonus = rollExpeditionRewards({
      outcome: 'success',
      expeditionId: 55,
      successTable: table({ waifubux: { min: 1, max: 1000 } }),
      bonusTable: null,
      failureTable: null,
    });
    // Separate draw namespaces: the success component is identical.
    expect(withBonus.waifubux - 500).toBe(withoutBonus.waifubux);
  });

  it('pays an ordinary success when the mission authored no bonus table', () => {
    const result = rollExpeditionRewards({
      outcome: 'exceptional',
      expeditionId: 99,
      successTable: CERTAIN,
      bonusTable: null,
      failureTable: FAILURE,
    });
    expect(result.waifubux).toBe(100);
    expect(result.sources.map((s) => s.kind)).toEqual(['success']);
  });
});

describe('failure', () => {
  it('pays the failure table and nothing from the success table', () => {
    const result = rollExpeditionRewards({
      outcome: 'failure',
      expeditionId: 99,
      successTable: CERTAIN,
      bonusTable: BONUS,
      failureTable: FAILURE,
    });
    expect(result.waifubux).toBe(10);
    expect(result.waifuXp).toBe(5);
    expect(result.items).toEqual([]);
    expect(result.sources.map((s) => s.kind)).toEqual(['failure']);
  });

  it('pays nothing when the mission authored no failure table', () => {
    const result = rollExpeditionRewards({
      outcome: 'failure',
      expeditionId: 99,
      successTable: CERTAIN,
      bonusTable: BONUS,
      failureTable: null,
    });
    expect(result).toMatchObject({ waifubux: 0, essence: 0, waifuXp: 0, items: [] });
  });

  /**
   * The consolation is a property of the *mission*, not of the deployment.
   * Nothing in this signature can see the suitability band, which is the
   * structural reason two players failing the same mission draw from the same
   * table however well-matched their copies were.
   */
  it('cannot vary with suitability, because it never sees it', () => {
    const a = rollExpeditionRewards({
      outcome: 'failure',
      expeditionId: 1234,
      successTable: CERTAIN,
      bonusTable: null,
      failureTable: FAILURE,
    });
    const b = rollExpeditionRewards({
      outcome: 'failure',
      expeditionId: 1234,
      successTable: CERTAIN,
      bonusTable: null,
      failureTable: FAILURE,
    });
    expect(a).toEqual(b);
  });
});

describe('mergeGrants', () => {
  it('sums stacks of the same item', () => {
    expect(
      mergeGrants([
        { slug: 'scrap', quantity: 2 },
        { slug: 'scrap', quantity: 3 },
        { slug: 'map', quantity: 1 },
      ]),
    ).toEqual([
      { slug: 'scrap', quantity: 5 },
      { slug: 'map', quantity: 1 },
    ]);
  });

  it('merges across the success and bonus tables', () => {
    const shared = table({
      groups: [
        { id: 'g', chanceBasisPoints: 10000, entries: [{ itemId: 'scrap_a', weight: 1, quantity: 2 }] },
      ],
    });
    const sharedBonus = table({
      id: 'bonus',
      groups: [
        { id: 'g', chanceBasisPoints: 10000, entries: [{ itemId: 'scrap_a', weight: 1, quantity: 5 }] },
      ],
    });
    const result = rollExpeditionRewards({
      outcome: 'exceptional',
      expeditionId: 1,
      successTable: shared,
      bonusTable: sharedBonus,
      failureTable: null,
    });
    // One +7 write, not a +2 and a +5.
    expect(result.items).toEqual([{ slug: 'scrap_a', quantity: 7 }]);
  });

  it('returns nothing for nothing', () => {
    expect(mergeGrants([])).toEqual([]);
  });
});
