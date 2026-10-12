import { describe, expect, it } from 'vitest';
import type { DungeonAction, DungeonRewardBundle } from '@/api/adminDungeons';
import {
  bundleIssueText,
  emptyBundle,
  isLegacyTreasure,
  payoutTiming,
  paysRewards,
  rewardsSummary,
  riskExplanation,
  tableRisk,
  withBundle,
} from '../bundleModel';
import { rewardNames } from '../lootModel';
import { HOARD_BODY, ITEMS } from './lootFixtures';

const names = rewardNames(ITEMS);
const tables = [{ key: 'boss_hoard', name: 'Boss Hoard' }];
const bundle: DungeonRewardBundle = {
  guaranteed: [
    { id: 'g1', grant: { type: 'currency', currency: 'shards', amount: { min: 40, max: 60 } } },
    { id: 'g2', grant: { type: 'currency', currency: 'waifubux', amount: { min: 500, max: 500 } } },
  ],
  chances: [
    {
      id: 'c1',
      chanceBasisPoints: 2500,
      grant: { type: 'item', item: 'velvet_charm', quantity: { min: 1, max: 1 } },
    },
  ],
  tables: [
    { id: 't1', table: 'boss_hoard', draws: 2 },
    { id: 't2', table: 'gone', draws: 1 },
  ],
};
const action = (fields: Partial<DungeonAction>): DungeonAction => ({
  id: 'a',
  type: 'combat',
  ...fields,
});

describe('activity reward bundles', () => {
  it('summarises a bundle in one line', () => {
    expect(rewardsSummary(bundle, names, tables)).toBe(
      '40–60 Baddie Shards · 500 WaifuBux · 25% 1 Velvet Charm · Boss Hoard ×2 · a deleted loot table',
    );
    expect(rewardsSummary(emptyBundle(), names, tables)).toBe('No rewards yet');
  });
  it('says when each kind of activity pays, and never per wave', () => {
    const wave = { enemy: { key: 'slime' } };
    expect(payoutTiming(action({ waves: [wave] }))).toBe(
      'Paid once, when the player wins the fight. A lost fight pays nothing.',
    );
    expect(payoutTiming(action({ type: 'boss', waves: [wave, wave], optional: true }))).toBe(
      'Paid once, when the player wins the final wave of the boss fight. Earlier waves pay nothing, and neither does a lost or skipped fight.',
    );
    expect(payoutTiming(action({ type: 'reward' }))).toBe(
      'Paid once, when the player opens this treasure.',
    );
  });
  it('quotes the dungeon’s own retention, falling back to the defeat rate for abandoning', () => {
    const fallback = riskExplanation({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 5000,
    });
    expect(fallback.atRisk).toContain('keeps 50% on defeat and 50% on abandoning');
    const both = riskExplanation({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 2550,
      abandonCurrencyRetentionBasisPoints: 0,
    });
    expect(both.atRisk).toContain('keeps 25.5% on defeat and 0% on abandoning');
  });
  it('classes a table by everything it can give', () => {
    expect(tableRisk(HOARD_BODY)).toBe('kept');
    expect(tableRisk({ guaranteed: [bundle.guaranteed[0]!], chances: [], pools: [] })).toBe(
      'at_risk',
    );
    expect(tableRisk({ ...HOARD_BODY, guaranteed: [bundle.guaranteed[1]!] })).toBe('mixed');
    expect(tableRisk({ guaranteed: [], chances: [], pools: [] })).toBe('empty');
    // A group that only ever gives Nothing has no reward to class.
    expect(
      tableRisk({
        guaranteed: [],
        chances: [],
        pools: [
          { id: 'p', name: 'Empty', draws: 1, entries: [{ id: 'n', weight: 1, nothing: true }] },
        ],
      }),
    ).toBe('empty');
  });
  it('stores no bundle on a fight with no rewards, and always one on a new treasure', () => {
    const fight = action({ rewards: bundle });
    expect(withBundle(fight, emptyBundle())).toEqual({ id: 'a', type: 'combat' });
    expect(withBundle(fight, bundle)).toEqual(fight);
    expect(withBundle(action({ type: 'reward', rewards: bundle }), emptyBundle()).rewards).toEqual(
      emptyBundle(),
    );
    expect(paysRewards(action({ type: 'rest' }))).toBe(false);
    expect(
      isLegacyTreasure(
        action({
          type: 'reward',
          reward: { rewardTable: null, equipmentRewardTable: null, currency: { min: 0, max: 0 } },
        }),
      ),
    ).toBe(true);
    expect(isLegacyTreasure(action({ type: 'reward', rewards: emptyBundle() }))).toBe(false);
  });
  it('locates a reward issue from a dungeon validation or a Test Roll, without ids', () => {
    const at = (path: string) => `rooms[2].actions[0].rewards.${path}`;
    const label = 'Room "Vault", activity "a_boss"';
    expect(
      bundleIssueText(
        {
          code: 'reward_item_missing',
          path: at('chances[0].grant'),
          message: `${label}, reward "c1": item "velvet_charm" no longer exists.`,
        },
        bundle,
        names,
        ITEMS,
        tables,
      ),
    ).toEqual({
      at: 'c1',
      subject: '“1 Velvet Charm”',
      text: 'This item no longer exists. Pick another item.',
    });
    expect(
      bundleIssueText(
        {
          code: 'reward_table_missing',
          path: at('tables[1]'),
          message: `${label}: loot table "gone" no longer exists.`,
        },
        bundle,
        names,
        ITEMS,
        tables,
      ),
    ).toEqual({
      at: 't2',
      subject: 'a loot table',
      text: 'This loot table was deleted. Remove it or pick another.',
    });
    const inside = bundleIssueText(
      {
        code: 'reward_item_disabled',
        path: at('tables[0].body.guaranteed[0].grant'),
        message: `${label}, loot table "Boss Hoard", reward "scrap": "Old Token" is disabled. Enable it or pick another item.`,
      },
      bundle,
      names,
      ITEMS,
      tables,
    );
    expect(inside).toEqual({
      at: 't1',
      subject: 'the loot table “Boss Hoard”',
      text: 'A reward inside “Boss Hoard” needs repair. "Old Token" is disabled. Enable it or pick another item. Open the table to fix it.',
    });
    expect(
      bundleIssueText(
        {
          code: 'reward_too_many_draws',
          path: 'rooms[2].actions[0].rewards',
          message: `${label}: this activity makes too many random picks (260). The limit is 200.`,
        },
        bundle,
        names,
        ITEMS,
        tables,
      ),
    ).toEqual({
      at: null,
      subject: '',
      text: 'This activity makes too many random picks (260). The limit is 200.',
    });
  });
});
