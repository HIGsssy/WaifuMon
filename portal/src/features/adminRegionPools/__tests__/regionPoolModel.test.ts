/** Region Pool editor bookkeeping: weights, local changes, grouping, diffs and number words. */
import { describe, expect, it } from 'vitest';

import {
  entriesOf,
  entryDiff,
  factsIndex,
  formatDelta,
  formatPercent,
  groupRows,
  localChanges,
  parseWeight,
  rowsOf,
} from '../regionPoolModel';
import { CATALOGUE } from './regionPoolFixtures';

describe('regionPoolModel', () => {
  it('accepts only the server weight range and sends bad text through for the server to name', () => {
    expect(parseWeight('1')).toBe(1);
    expect(parseWeight(' 1000000 ')).toBe(1_000_000);
    expect(parseWeight('0')).toBeNull();
    expect(parseWeight('1000001')).toBeNull();
    expect(parseWeight('2.5')).toBeNull();
    expect(parseWeight('')).toBeNull();
    expect(entriesOf([{ species: 'a', weight: '0' }])).toEqual([{ species: 'a', weight: 0 }]);
  });

  it('tells added, removed and reweighted rows apart from the saved draft', () => {
    const saved = [
      { species: 'a', weight: 1 },
      { species: 'b', weight: 2 },
    ];
    const rows = [...rowsOf(saved).filter((r) => r.species !== 'a'), { species: 'c', weight: '1' }];
    rows[0] = { species: 'b', weight: '3' };
    expect(localChanges(saved, rows)).toEqual({ added: ['c'], removed: ['a'], reweighted: ['b'] });
    expect(localChanges(saved, rowsOf(saved))).toEqual({ added: [], removed: [], reweighted: [] });
  });

  it('groups rows N → LR, then EX, keeping empty hunted tiers and putting unknown species last', () => {
    const facts = factsIndex([], CATALOGUE);
    const groups = groupRows(
      [
        { species: 'ex_goddess', weight: '1' },
        { species: 'sr_idol', weight: '1' },
        { species: 'mystery', weight: '1' },
      ],
      facts,
    );
    expect(groups.map((g) => g.rarity)).toEqual([
      'N',
      'R',
      'SR',
      'SSR',
      'UR',
      'LR',
      'EX',
      'unknown',
    ]);
    expect(groups.find((g) => g.rarity === 'SR')!.rows).toEqual([
      { species: 'sr_idol', weight: '1', index: 1 },
    ]);
    expect(groups.find((g) => g.rarity === 'unknown')!.rows[0]!.species).toBe('mystery');
  });

  it('diffs two revisions by membership and weight', () => {
    expect(
      entryDiff(
        [
          { species: 'a', weight: 1 },
          { species: 'b', weight: 1 },
        ],
        [
          { species: 'b', weight: 4 },
          { species: 'c', weight: 2 },
        ],
      ),
    ).toEqual({
      added: [{ species: 'c', weight: 2 }],
      removed: [{ species: 'a', weight: 1 }],
      reweighted: [{ species: 'b', from: 1, to: 4 }],
    });
  });

  it('formats small chances without rounding them to zero', () => {
    expect(formatPercent(0.6)).toBe('60.0%');
    expect(formatPercent(0.075)).toBe('7.50%');
    expect(formatPercent(0.00037)).toBe('0.037%');
    expect(formatPercent(0.0000012)).toBe('0.00012%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe('—');
    expect(formatDelta(0.00833)).toBe('+0.833 pts');
    expect(formatDelta(-0.1)).toBe('−10.0 pts');
  });
});
