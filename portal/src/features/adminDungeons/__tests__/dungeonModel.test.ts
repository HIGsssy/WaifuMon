import { describe, expect, it } from 'vitest';

import type { DungeonZoneIssue } from '@/api/adminDungeons';
import {
  basisPointsToPercent,
  intOrNull,
  issuesAt,
  issuesOutside,
  newPoolEntry,
  newRewardBand,
  newZone,
  nodesByDepth,
  parseTags,
  percentToBasisPoints,
} from '../dungeonModel';

describe('percent ↔ basis points', () => {
  it('shows basis points as the percentage a human expects', () => {
    expect(basisPointsToPercent(2500)).toBe(25);
    expect(basisPointsToPercent(3333)).toBe(33.33);
    expect(basisPointsToPercent(0)).toBe(0);
    expect(basisPointsToPercent(10_000)).toBe(100);
  });

  it('stores a typed percentage as basis points, clamped to 0–100%', () => {
    expect(percentToBasisPoints(25)).toBe(2500);
    expect(percentToBasisPoints(12.5)).toBe(1250);
    expect(percentToBasisPoints(33.33)).toBe(3333);
    expect(percentToBasisPoints(250)).toBe(10_000);
    expect(percentToBasisPoints(-5)).toBe(0);
    expect(percentToBasisPoints(Number.NaN)).toBe(0);
  });

  it('round-trips every whole basis point', () => {
    for (const bp of [0, 1, 99, 2500, 4999, 10_000])
      expect(percentToBasisPoints(basisPointsToPercent(bp))).toBe(bp);
  });
});

describe('inputs', () => {
  it('reads an optional integer, where empty means none', () => {
    expect(intOrNull('')).toBeNull();
    expect(intOrNull('  ')).toBeNull();
    expect(intOrNull('4')).toBe(4);
  });

  it('normalises a comma list of tags to unique snake_case keys', () => {
    expect(parseTags('Robotic, high risk, robotic,, high-risk ,')).toEqual([
      'robotic',
      'high_risk',
    ]);
    expect(parseTags('')).toEqual([]);
  });
});

describe('new documents', () => {
  it('starts a zone disabled, with a boss required and the default currency', () => {
    const zone = newZone();
    expect(zone).toMatchObject({
      key: '',
      enabled: false,
      rewards: { currencyKey: 'ascension_currency' },
    });
    expect(zone.generation.boss.required).toBe(true);
    expect(zone.generation.minNodes).toBeLessThanOrEqual(zone.generation.maxNodes);
  });

  it('gives a new pool entry the right reference field and an id no other entry has', () => {
    const first = newPoolEntry('combat', 'scrapyard_drone', []);
    expect(first).toMatchObject({
      id: 'scrapyard_drone',
      enemyKey: 'scrapyard_drone',
      enabled: true,
      maxDepth: null,
    });
    expect(first).not.toHaveProperty('eventKey');
    const second = newPoolEntry('combat', 'scrapyard_drone', [first]);
    expect(second.id).toBe('scrapyard_drone_2');
    expect(newPoolEntry('combat', 'scrapyard_drone', [first, second]).id).toBe('scrapyard_drone_3');
    expect(newPoolEntry('event', 'shrine', [])).toMatchObject({ eventKey: 'shrine' });
  });

  it('gives a new band a unique id and no rewards', () => {
    const band = newRewardBand([]);
    expect(band).toMatchObject({
      id: 'band',
      nodeTypes: [],
      rewardTable: null,
      currency: { min: 0, max: 0 },
    });
    expect(newRewardBand([band]).id).toBe('band_2');
  });
});

describe('issue routing', () => {
  const issue = (path: string): DungeonZoneIssue => ({ path, message: path, severity: 'error' });
  const issues = [
    issue('generation'),
    issue('generation.minNodes'),
    issue('pools.combat[1].enemyKey'),
    issue('pools.combat[10].weight'),
    issue('pools.boss'),
    issue('zone'),
  ];

  it('matches a path and everything beneath it, without matching a longer index', () => {
    expect(issuesAt(issues, 'pools.combat[1]').map((i) => i.path)).toEqual([
      'pools.combat[1].enemyKey',
    ]);
    expect(issuesAt(issues, 'pools.combat').map((i) => i.path)).toEqual([
      'pools.combat[1].enemyKey',
      'pools.combat[10].weight',
    ]);
    expect(issuesAt(issues, 'generation').map((i) => i.path)).toEqual([
      'generation',
      'generation.minNodes',
    ]);
    expect(issuesAt(issues, 'pools.boss').map((i) => i.path)).toEqual(['pools.boss']);
  });

  it('finds the issues no section shows', () => {
    expect(issuesOutside(issues, ['generation', 'pools']).map((i) => i.path)).toEqual(['zone']);
  });
});

describe('nodesByDepth', () => {
  it('groups nodes into depth rows, lane 0 first', () => {
    const nodes = [
      { id: 'n3', depth: 2, lane: 1 },
      { id: 'n1', depth: 1, lane: 0 },
      { id: 'n2', depth: 2, lane: 0 },
      { id: 'n4', depth: 3, lane: 0 },
    ];
    expect(nodesByDepth(nodes).map((row) => row.map((n) => n.id))).toEqual([
      ['n1'],
      ['n2', 'n3'],
      ['n4'],
    ]);
  });
});
