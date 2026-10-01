import { describe, expect, it } from 'vitest';

import type { RewardGroupDoc } from '@/api/adminRewardTables';
import {
  DRAFT_GROUP,
  basisPointsFromPercent,
  chancePercentLabel,
  groupSummary,
  issueTarget,
  issuesFor,
  newGroup,
  newTable,
  previewLine,
  rowShares,
  selectorOf,
  sharePercentLabel,
  tidyGroup,
} from '../rewardTableModel';

const group = (over: Partial<RewardGroupDoc> = {}): RewardGroupDoc => ({
  id: 'g',
  entries: [
    { itemId: 'a', weight: 3, quantity: 1 },
    { itemId: 'b', weight: 1, quantity: 1, enabled: false },
  ],
  equipment: [{ slot: 'attack', weight: 1 }],
  ...over,
});

describe('chance', () => {
  it('reads basis points as a percentage and back', () => {
    expect(chancePercentLabel(10_000)).toBe('100%');
    expect(chancePercentLabel(25)).toBe('0.25%');
    expect(chancePercentLabel(800)).toBe('8%');
    expect(basisPointsFromPercent('0.25')).toBe(25);
    expect(basisPointsFromPercent('8')).toBe(800);
    expect(basisPointsFromPercent('')).toBeNull();
    expect(basisPointsFromPercent('abc')).toBeNull();
  });
});

describe('rowShares', () => {
  it('normalises over enabled rows of both kinds, like the server pick', () => {
    const shares = rowShares(group());
    expect(shares.items).toEqual([75, null]);
    expect(shares.equipment).toEqual([25]);
    expect(sharePercentLabel(shares.items[0]!)).toBe('75%');
    expect(sharePercentLabel(null)).toBe('—');
  });

  it('gives nothing a share in a disabled group', () => {
    expect(rowShares(group({ enabled: false }))).toEqual({ items: [null, null], equipment: [null] });
  });
});

describe('groupSummary', () => {
  it('says chance, rolls, rows and gear candidates', () => {
    expect(groupSummary(group({ chanceBasisPoints: 800, rolls: 2 }), 3)).toBe(
      'Chance 8% · Rolls 2 · 1 item row · 1 gear row · 3 candidates',
    );
    expect(groupSummary(group({ equipment: [] }), null)).toBe('Chance 100% · Rolls 1 · 1 item row');
    expect(groupSummary(group({ enabled: false }), 3)).toBe('Disabled — never rolls');
  });
});

describe('issues by path', () => {
  const issues = [
    { path: 'buddyXp', message: 't', severity: 'error' as const },
    { path: 'groups[1]', message: 'g', severity: 'error' as const },
    { path: 'groups[1].entries[0].itemId', message: 'i', severity: 'error' as const },
    { path: 'groups[1].equipment[2].definitionKeys[0]', message: 'e', severity: 'warning' as const },
  ];

  it('routes each issue to its table, group or row', () => {
    expect(issueTarget('groups[1].equipment[2].slot')).toEqual({ kind: 'equipment', group: 1, row: 2 });
    expect(issueTarget('groups[3].rolls')).toEqual({ kind: 'group', group: 3 });
    expect(issueTarget('enabled')).toEqual({ kind: 'table' });
    expect(issuesFor(issues, { kind: 'table' }).map((i) => i.message)).toEqual(['t']);
    expect(issuesFor(issues, { kind: 'group', group: 1 }).map((i) => i.message)).toEqual(['g']);
    expect(issuesFor(issues, { kind: 'item', group: 1, row: 0 }).map((i) => i.message)).toEqual(['i']);
    expect(issuesFor(issues, { kind: 'equipment', group: 1, row: 2 }).map((i) => i.message)).toEqual(['e']);
    expect(issuesFor(issues, { kind: 'equipment', group: 1, row: 0 })).toEqual([]);
  });
});

describe('shapes', () => {
  it('starts tables per kind and names new groups uniquely', () => {
    expect(newTable('boss', 'x')).toEqual({ id: 'x', enabled: true, buddyXp: 0, groups: [] });
    expect(newTable('expedition', 'x')).toMatchObject({ waifuXp: 0, playerXp: 0 });
    const table = { ...newTable('boss', 'x'), groups: [group({ id: 'group-2' })] };
    expect(newGroup(table).id).toBe('group-3');
  });

  it('never sends the draft marker or an empty gear list', () => {
    const fresh = newGroup(newTable('boss', 'x'));
    expect(fresh[DRAFT_GROUP]).toBe(true);
    const sent = tidyGroup({ ...fresh, equipment: [] });
    expect(sent).not.toHaveProperty(DRAFT_GROUP);
    expect(sent).not.toHaveProperty('equipment');
  });

  it('strips switch and weight from a gear row to get its selector', () => {
    expect(selectorOf({ slot: 'attack', rarity: 'R', enabled: false, weight: 4 })).toEqual({
      slot: 'attack',
      rarity: 'R',
    });
  });

  it('writes the preview line from the server preview', () => {
    const row = { slot: 'attack', rarity: 'R', weight: 1 };
    expect(previewLine(row, undefined)).toBe('R Attack · checking…');
    expect(
      previewLine(row, {
        eligible: [
          { key: 'k', name: 'Combat Knife', slot: 'attack', rarity: 'R' },
          { key: 's', name: 'Semi-Auto Sidearm', slot: 'attack', rarity: 'R' },
        ],
        issues: [],
      }),
    ).toBe('R Attack · 2 eligible: Combat Knife, Semi-Auto Sidearm');
    expect(previewLine({ weight: 1 }, { eligible: [], issues: [{ path: 'selector', message: 'x' }] })).toBe(
      'Any rarity any slot · nothing eligible',
    );
  });
});
