/**
 * Pure helpers for the dungeon zone editor: a blank zone, human-facing
 * conversions (percent ↔ basis points, comma lists), and routing server
 * issues to the part of the form that shows them.
 */
import type {
  DungeonBackgroundDoc,
  DungeonNodeType,
  DungeonPoolEntryDoc,
  DungeonPoolKey,
  DungeonRewardBandDoc,
  DungeonZoneDoc,
  DungeonZoneIssue,
} from '@/api/adminDungeons';

export const NODE_TYPE_LABELS: Record<DungeonNodeType, string> = {
  combat: 'Combat',
  elite: 'Elite',
  event: 'Event',
  reward: 'Reward',
  rest: 'Rest',
  miniboss: 'Miniboss',
  boss: 'Boss',
  exit: 'Exit',
};

export const POOL_LABELS: Record<DungeonPoolKey, string> = {
  combat: 'Combat pool',
  elite: 'Elite pool',
  miniboss: 'Miniboss pool',
  boss: 'Boss pool',
  event: 'Event pool',
};

export const DUNGEON_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const DEFAULT_CURRENCY_KEY = 'ascension_currency';

/** A zone that parses but is not yet a dungeon — saved disabled until it is. */
export function newZone(): DungeonZoneDoc {
  return {
    key: '',
    name: '',
    description: '',
    enabled: false,
    order: 0,
    artworkPath: null,
    backgroundArtworkPath: null,
    artworkAssetId: null,
    backgroundAssetId: null,
    backgrounds: [],
    tags: ['initial_tuning'],
    availableRegions: [],
    generation: {
      minNodes: 6,
      maxNodes: 9,
      branching: { minBranches: 0, maxBranches: 1, chanceBasisPoints: 3000, maxLength: 1 },
      extraction: { minDepth: 4, nodeTypes: ['rest', 'exit'], minPoints: 1, windows: [] },
      nodeWeights: { combat: 60, elite: 10, event: 10, reward: 10, rest: 10, miniboss: 0, exit: 0 },
      boss: { required: true },
      rest: { minNodes: 1, maxNodes: 2, minDepth: 2, maxDepth: null, beforeBoss: false },
      depthRanges: { elite: { minDepth: 2, maxDepth: null } },
      required: [],
      limits: [],
      noConsecutive: ['rest'],
      maxConsecutiveSameEnemy: 2,
    },
    nodeSettings: { rest: { healBasisPoints: 3000 } },
    pools: { combat: [], elite: [], miniboss: [], boss: [], event: [] },
    rewards: {
      currencyKey: DEFAULT_CURRENCY_KEY,
      defeatCurrencyRetentionBasisPoints: 2500,
      bands: [],
      completion: { currency: { min: 0, max: 0 }, rewardTable: null },
      extraction: { currency: { min: 0, max: 0 }, rewardTable: null },
    },
  };
}

function uniqueId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** A new entry for `pool`, naming `contentKey`, with an id not yet used there. */
export function newPoolEntry(
  pool: DungeonPoolKey,
  contentKey: string,
  existing: readonly DungeonPoolEntryDoc[],
): DungeonPoolEntryDoc {
  const entry = {
    id: uniqueId(
      contentKey || 'entry',
      existing.map((e) => e.id),
    ),
    enabled: true,
    weight: 10,
    minDepth: 1,
    maxDepth: null,
    tags: [],
  };
  return pool === 'event' ? { ...entry, eventKey: contentKey } : { ...entry, enemyKey: contentKey };
}

/** A background pool entry for a freshly chosen image. */
export function newBackground(
  image: { assetId: string; name?: string } | { artworkPath: string },
  existing: readonly DungeonBackgroundDoc[],
): DungeonBackgroundDoc {
  const label =
    'assetId' in image
      ? (image.name ?? 'background')
      : (image.artworkPath.split('/').pop() ?? 'background');
  const base =
    label
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'background';
  return {
    id: uniqueId(
      base,
      existing.map((b) => b.id),
    ),
    enabled: true,
    weight: 10,
    minDepth: 1,
    maxDepth: null,
    assetId: 'assetId' in image ? image.assetId : null,
    artworkPath: 'assetId' in image ? null : image.artworkPath,
  };
}

export function newRewardBand(existing: readonly DungeonRewardBandDoc[]): DungeonRewardBandDoc {
  return {
    id: uniqueId(
      'band',
      existing.map((b) => b.id),
    ),
    enabled: true,
    minDepth: 1,
    maxDepth: null,
    nodeTypes: [],
    rewardTable: null,
    equipmentRewardTable: null,
    currency: { min: 0, max: 0 },
  };
}

/** 2500 → 25. Two decimals is the precision basis points carry. */
export function basisPointsToPercent(basisPoints: number): number {
  return Math.round(basisPoints) / 100;
}

/** 25 → 2500, clamped to 0–100%. Anything unreadable is 0. */
export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(10_000, Math.max(0, Math.round(percent * 100)));
}

/** An optional integer: empty is null (an open-ended depth, "no limit"). */
export function intOrNull(text: string): number | null {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) ? null : Math.trunc(n);
}

/** `robotic, high_risk` → `['robotic', 'high_risk']`. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) =>
          t
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_'),
        )
        .filter((t) => t !== ''),
    ),
  ];
}

/** The issues at `prefix` exactly, or anywhere beneath it. */
export function issuesAt(issues: readonly DungeonZoneIssue[], prefix: string): DungeonZoneIssue[] {
  return issues.filter(
    (i) => i.path === prefix || i.path.startsWith(`${prefix}.`) || i.path.startsWith(`${prefix}[`),
  );
}

/** Issues the form has no field for — shown in the summary instead. */
export function issuesOutside(
  issues: readonly DungeonZoneIssue[],
  prefixes: readonly string[],
): DungeonZoneIssue[] {
  const shown = new Set(prefixes.flatMap((p) => issuesAt(issues, p)));
  return issues.filter((i) => !shown.has(i));
}

/** Nodes grouped by depth, lane 0 first — the rows a preview renders. */
export function nodesByDepth<T extends { depth: number; lane: number }>(
  nodes: readonly T[],
): T[][] {
  const rows = new Map<number, T[]>();
  for (const node of nodes) rows.set(node.depth, [...(rows.get(node.depth) ?? []), node]);
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row.sort((a, b) => a.lane - b.lane));
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
