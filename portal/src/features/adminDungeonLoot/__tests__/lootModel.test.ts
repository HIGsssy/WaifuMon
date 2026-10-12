import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  describeGrant,
  draftOfGrant,
  emptyRewardDraft,
  formOf,
  formatAverage,
  formatChance,
  friendlyLootIssues,
  grantOfDraft,
  moved,
  newEntryId,
  parsePercent,
  parseShare,
  percentText,
  rewardNames,
  shareFractions,
  uniqueKey,
} from '../lootModel';
import { HOARD_BODY, ITEMS, inspect } from './lootFixtures';

const names = rewardNames(ITEMS, inspect(HOARD_BODY).equipmentPools);

describe('percentages and shares', () => {
  it('turns a typed percentage into basis points', () => {
    expect(parsePercent('25')).toEqual({ basisPoints: 2500 });
    expect(parsePercent(' 0.5% ')).toEqual({ basisPoints: 50 });
    expect(parsePercent('99.99')).toEqual({ basisPoints: 9999 });
    expect(percentText(2500)).toBe('25');
    expect(percentText(50)).toBe('0.5');
    expect(percentText(1)).toBe('0.01');
  });
  it('explains 0%, 100% and nonsense instead of correcting them', () => {
    expect(parsePercent('0')).toEqual({ problem: 'A 0% drop never happens. Remove it instead.' });
    expect(parsePercent('100')).toMatchObject({ always: true });
    expect(parsePercent('150')).toEqual({ problem: 'A chance cannot be more than 100%.' });
    expect(parsePercent('0.001')).toHaveProperty('problem');
    expect(parsePercent('lots')).toHaveProperty('problem');
    expect(parseShare('0')).toEqual({
      problem: 'A share of 0 can never be picked. Remove it instead.',
    });
    expect(parseShare('1.5')).toHaveProperty('problem');
    expect(parseShare('60')).toEqual({ share: 60 });
  });
  it('gives each share its slice of the group and skips a share that is not usable yet', () => {
    const { pools } = formOf({ name: '', description: '', tier: null, body: HOARD_BODY });
    expect(shareFractions(pools[0]!.entries)).toEqual([0.6, 0.15, 0.25]);
    const edited = pools[0]!.entries.map((e, i) => (i === 2 ? { ...e, share: '' } : e));
    expect(shareFractions(edited)).toEqual([0.8, 0.2, null]);
  });
  it('never shows a positive chance as 0%, nor an uncertain one as 100%', () => {
    expect(formatChance(0)).toBe('0%');
    expect(formatChance(1)).toBe('100%');
    expect(formatChance(0.25)).toBe('25%');
    expect(formatChance(0.125)).toBe('12.5%');
    expect(formatChance(0.005)).toBe('0.5%');
    expect(formatChance(0.0001)).toBe('0.01%');
    expect(formatChance(0.000001)).toBe('less than 0.01%');
    expect(formatChance(0.9996)).toBe('99.96%');
    expect(formatChance(0.999999)).toBe('more than 99.99%');
    expect(formatAverage(3)).toBe('3');
    expect(formatAverage(2.25)).toBe('2.25');
    expect(formatAverage(0.0001)).toBe('less than 0.01');
    expect(formatAverage(0)).toBe('0');
  });
});

describe('rewards', () => {
  it('stores schema-compatible grants for every reward type', () => {
    const draft = emptyRewardDraft();
    expect(grantOfDraft(draft)).toEqual({ problem: 'Choose what to give.' });
    expect(
      grantOfDraft({ ...draft, kind: 'shards', amount: '40', max: '60', ranged: true }),
    ).toEqual({
      grant: { type: 'currency', currency: 'shards', amount: { min: 40, max: 60 } },
    });
    expect(grantOfDraft({ ...draft, kind: 'waifubux', amount: '500' })).toEqual({
      grant: { type: 'currency', currency: 'waifubux', amount: { min: 500, max: 500 } },
    });
    expect(grantOfDraft({ ...draft, kind: 'item', item: 'bent_gear', amount: '2' })).toEqual({
      grant: { type: 'item', item: 'bent_gear', quantity: { min: 2, max: 2 } },
    });
    expect(grantOfDraft({ ...draft, kind: 'affection', amount: '3' })).toEqual({
      grant: { type: 'affection', amount: { min: 3, max: 3 } },
    });
    expect(grantOfDraft({ ...draft, kind: 'equipment', selector: { rarity: 'R' } })).toEqual({
      grant: { type: 'equipment', selector: { rarity: 'R' } },
    });
  });
  it('refuses amounts outside each type’s limit and upside-down ranges', () => {
    const draft = emptyRewardDraft();
    expect(grantOfDraft({ ...draft, kind: 'affection', amount: '501' })).toEqual({
      problem: 'Enter a whole number from 1 to 500.',
    });
    expect(grantOfDraft({ ...draft, kind: 'essence', amount: '0' })).toHaveProperty('problem');
    expect(grantOfDraft({ ...draft, kind: 'item', amount: '2' })).toEqual({
      problem: 'Choose an item.',
    });
    expect(
      grantOfDraft({ ...draft, kind: 'essence', amount: '9', max: '4', ranged: true }),
    ).toEqual({ problem: 'The highest amount must be at least the lowest.' });
  });
  it('reads a stored grant back into the form and describes it in words', () => {
    const grant = HOARD_BODY.guaranteed[0]!.grant;
    expect(draftOfGrant(grant)).toMatchObject({
      kind: 'item',
      amount: '2',
      max: '4',
      ranged: true,
    });
    expect(describeGrant(grant, names)).toBe('2–4 Bent Gear');
    expect(describeGrant({ type: 'equipment', selector: { rarity: 'R' } }, names)).toBe(
      'R gear (2 possible)',
    );
    expect(
      describeGrant({ type: 'equipment', selector: { definitionKeys: ['iron_plate'] } }, names),
    ).toBe('Iron Plate');
    expect(describeGrant({ type: 'item', item: 'gone', quantity: { min: 1, max: 1 } }, names)).toBe(
      '1 an item that no longer exists',
    );
  });
});

describe('the form and its body', () => {
  it('round-trips a table body exactly', () => {
    const form = formOf({ name: 'Hoard', description: '', tier: 'boss', body: HOARD_BODY });
    expect(bodyOf(form)).toEqual({ body: HOARD_BODY, problems: [] });
  });
  it('holds back the body and names each problem while a number is unusable', () => {
    const form = formOf({ name: '', description: '', tier: null, body: HOARD_BODY });
    form.chances[0]!.percent = '0';
    form.pools[0]!.picks = '11';
    form.pools[0]!.name = ' ';
    const result = bodyOf(form);
    expect(result.body).toBeNull();
    expect(result.problems.map((p) => p.at)).toEqual([
      'name',
      'essence',
      'gear:name',
      'gear:picks',
    ]);
  });
  it('keeps entry IDs when rows are reordered, and makes valid new ones', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(moved(rows, 0, 1).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(moved(rows, 0, -1)).toBe(rows);
    expect(newEntryId('g', () => '0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      'g_0f8fad5bd9cb469fa16570867728950e',
    );
    expect(newEntryId('p')).toMatch(/^p_[0-9a-f]{32}$/);
  });
  it('finds a free key for a copy', () => {
    expect(uniqueKey('tunnel_cache_copy', ['tunnel_cache'])).toBe('tunnel_cache_copy');
    expect(uniqueKey('tunnel_cache', ['tunnel_cache', 'tunnel_cache_2'])).toBe('tunnel_cache_3');
    expect(uniqueKey('', [])).toBe('loot_table');
  });
});

describe('server issues in creator language', () => {
  it('places each issue beside its row and never repeats an entry id', () => {
    const body = {
      ...HOARD_BODY,
      chances: [
        {
          id: 'c_secret',
          chanceBasisPoints: 500,
          grant: { type: 'item' as const, item: 'old_token', quantity: { min: 1, max: 1 } },
        },
      ],
    };
    const friendly = friendlyLootIssues(
      [
        {
          code: 'reward_item_disabled',
          severity: 'error',
          path: 'body.chances[0].grant',
          message: 'Loot table, reward "c_secret": "Old Token" is disabled.',
        },
        {
          code: 'reward_pool_all_nothing',
          severity: 'warning',
          path: 'body.pools[0]',
          message: 'Loot table: "Boss gear" can only ever give Nothing.',
        },
        {
          code: 'reward_too_much_gear',
          severity: 'error',
          path: 'body',
          message:
            'Loot table: this activity could drop up to 14 gear pieces at once. The limit is 10.',
        },
        {
          code: 'reward_equipment_empty',
          severity: 'error',
          path: 'rooms[0].actions[0].rewards.tables[0].body.pools[0].entries[1].grant',
          message: 'Room "Preview", activity "reward", loot table "Test table", reward "epic": no',
        },
      ],
      body,
      names,
      ITEMS,
    );
    expect(friendly.map((i) => [i.at, i.text])).toEqual([
      ['c_secret', 'Old Token is disabled. Enable it or pick another item.'],
      ['gear', '“Boss gear” can only ever give Nothing.'],
      [null, 'One roll of this table could drop up to 14 gear pieces at once. The limit is 10.'],
      ['epic', 'No gear matches “SR gear”. Loosen the choice.'],
    ]);
    expect(friendly.map((i) => i.text).join(' ')).not.toMatch(/c_secret|epic"/);
  });
});
