/**
 * A small in-memory Dungeon Loot catalogue behind the real API client
 * functions, so pages are exercised through the calls they actually make.
 * It keeps the server's rules that the UI depends on: optimistic revisions,
 * delete restrictions, and where issues and equipment pools are reported.
 */
import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { vi } from 'vitest';
import * as loot from '@/api/adminDungeonLootTables';
import * as dungeons from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { LootTableEditorPage } from '../LootTableEditorPage';
import { LootTablesListPage } from '../LootTablesListPage';
import { selectorKey } from '../lootModel';

export const WRITE = ['dungeons.read', 'dungeons.write'];
export const READ = ['dungeons.read'];

export const ITEMS: dungeons.DungeonReferenceData['items'] = [
  { slug: 'bent_gear', name: 'Bent Gear', category: 'salvage', enabled: true, maxOwned: null },
  { slug: 'founders_badge', name: 'Founder’s Badge', category: 'key', enabled: true, maxOwned: 1 },
  { slug: 'old_token', name: 'Old Token', category: 'consumable', enabled: false, maxOwned: null },
  { slug: 'tonic', name: 'Tonic', category: 'consumable', enabled: true, maxOwned: null },
  { slug: 'tunnel_key', name: 'Tunnel Key', category: 'key', enabled: true, maxOwned: null },
  {
    slug: 'velvet_charm',
    name: 'Velvet Charm',
    category: 'capture',
    enabled: true,
    maxOwned: null,
  },
];
export const GEAR = [
  { key: 'bolt_cutter', name: 'Bolt Cutter', slot: 'attack', rarity: 'R', enabled: true },
  { key: 'heart_locket', name: 'Heart Locket', slot: 'health', rarity: 'SR', enabled: true },
  { key: 'iron_plate', name: 'Iron Plate', slot: 'defense', rarity: 'R', enabled: true },
  { key: 'rusted_wrench', name: 'Rusted Wrench', slot: 'attack', rarity: 'N', enabled: true },
];
const matching = (selector: loot.EquipmentRewardSelector) =>
  GEAR.filter(
    (piece) =>
      (!selector.slot || piece.slot === selector.slot) &&
      (!selector.rarity || piece.rarity === selector.rarity) &&
      (!selector.definitionKeys || selector.definitionKeys.includes(piece.key)),
  );

const grantsOf = (body: loot.DungeonLootTableBody) => [
  ...body.guaranteed.map((e, i) => ({ grant: e.grant, path: `body.guaranteed[${i}].grant` })),
  ...body.chances.map((e, i) => ({ grant: e.grant, path: `body.chances[${i}].grant` })),
  ...body.pools.flatMap((pool, p) =>
    pool.entries.flatMap((e, i) =>
      'grant' in e ? [{ grant: e.grant, path: `body.pools[${p}].entries[${i}].grant` }] : [],
    ),
  ),
];
/** The dependency checks the editor shows, reported where and how the server reports them. */
export function inspect(body: loot.DungeonLootTableBody) {
  const issues: dungeons.DungeonIssue[] = [];
  const equipmentPools: loot.DungeonLootTable['equipmentPools'] = {};
  const error = (code: string, path: string, message: string) =>
    issues.push({ code, severity: 'error', path, message: `Loot table, reward "x": ${message}` });
  for (const { grant, path } of grantsOf(body)) {
    if (grant.type === 'item') {
      const item = ITEMS.find((i) => i.slug === grant.item);
      if (!item) error('reward_item_missing', path, 'missing');
      else if (!item.enabled) error('reward_item_disabled', path, 'disabled');
      else if (item.maxOwned !== null) error('reward_item_capped', path, 'capped');
    }
    if (grant.type === 'equipment') {
      const pieces = matching(grant.selector);
      if (pieces.length) equipmentPools[selectorKey(grant.selector)] = pieces;
      else error('reward_equipment_empty', path, 'empty');
    }
  }
  if (!body.guaranteed.length && !body.chances.length && !body.pools.length)
    issues.push({
      code: 'reward_empty',
      severity: 'warning',
      path: 'body',
      message: 'Loot table: this Rewards section gives nothing yet.',
    });
  return { issues, equipmentPools };
}

export const HOARD_BODY: loot.DungeonLootTableBody = {
  guaranteed: [
    { id: 'scrap', grant: { type: 'item', item: 'bent_gear', quantity: { min: 2, max: 4 } } },
  ],
  chances: [
    {
      id: 'essence',
      chanceBasisPoints: 3000,
      grant: { type: 'currency', currency: 'essence', amount: { min: 5, max: 10 } },
    },
  ],
  pools: [
    {
      id: 'gear',
      name: 'Boss gear',
      draws: 1,
      entries: [
        { id: 'rare', weight: 60, grant: { type: 'equipment', selector: { rarity: 'R' } } },
        { id: 'epic', weight: 15, grant: { type: 'equipment', selector: { rarity: 'SR' } } },
        { id: 'none', weight: 25, nothing: true },
      ],
    },
  ],
};
export function table(
  key: string,
  name: string,
  body: loot.DungeonLootTableBody,
  extra: Partial<loot.DungeonLootTable> = {},
): loot.DungeonLootTable {
  return {
    key,
    name,
    description: '',
    tier: null,
    body,
    contentHash: `sha256:${key}`,
    revision: 1,
    archivedAt: null,
    origin: 'portal',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-09T12:00:00.000Z',
    createdBy: 'Whistler',
    updatedBy: 'Whistler',
    ...inspect(body),
    ...extra,
  };
}
const EMPTY_BODY: loot.DungeonLootTableBody = { guaranteed: [], chances: [], pools: [] };
const NO_USE: loot.DungeonLootTableUsage = { drafts: [], published: [] };
const published = (dungeonKey: string, name: string, revision: number) => ({
  kind: 'published' as const,
  dungeonKey,
  name,
  enabled: true,
  revisionId: revision,
  revision,
  current: true,
  snapshotStatus: 'embedded' as const,
});
const draft = (dungeonKey: string, name: string) => ({
  kind: 'draft' as const,
  dungeonKey,
  name,
  enabled: true,
  draftRevision: 3,
});

const source = (dropId: string, mode: 'guaranteed' | 'chance' | 'pool') => ({
  dropId,
  source: 'table' as const,
  mode,
  tableKey: 'test_roll_table',
  tableReferenceId: 'table',
  tableDraw: 0,
});
/** The server's exact analysis of `HOARD_BODY` rolled once. */
export const HOARD_ANALYSIS: loot.DungeonRewardAnalysis = {
  resolverVersion: 1,
  snapshotHash: 'sha256:preview',
  rewards: [
    {
      reward: { type: 'currency', currency: 'essence' },
      riskClass: 'secured',
      expectedQuantity: 2.25,
      chanceAtLeastOnce: 0.3,
      contributions: [],
    },
    ...['bolt_cutter', 'iron_plate'].map((definitionKey) => ({
      reward: { type: 'equipment' as const, definitionKey },
      riskClass: 'secured' as const,
      expectedQuantity: 0.3,
      chanceAtLeastOnce: 0.3,
      contributions: [],
    })),
    {
      reward: { type: 'equipment', definitionKey: 'heart_locket' },
      riskClass: 'secured',
      expectedQuantity: 0.15,
      chanceAtLeastOnce: 0.15,
      contributions: [],
    },
    {
      reward: { type: 'item', item: 'bent_gear' },
      riskClass: 'secured',
      expectedQuantity: 3,
      chanceAtLeastOnce: 1,
      contributions: [],
    },
  ],
  expectedEquipmentPieces: 0.75,
  chanceAnyEquipment: 0.75,
  equipmentCandidateCount: 3,
  noRewardChance: 0,
  sources: [
    {
      ...source('d1', 'pool'),
      poolId: 'gear',
      poolName: 'Boss gear',
      poolPick: 0,
      rewards: [
        {
          reward: { type: 'equipment', definitionKey: 'bolt_cutter' },
          probability: 0.3,
          expectedQuantity: 0.3,
        },
        {
          reward: { type: 'equipment', definitionKey: 'iron_plate' },
          probability: 0.3,
          expectedQuantity: 0.3,
        },
        {
          reward: { type: 'equipment', definitionKey: 'heart_locket' },
          probability: 0.15,
          expectedQuantity: 0.15,
        },
      ],
      noRewardChance: 0.25,
    },
  ],
};
/** One sample roll of `HOARD_BODY`: the guaranteed item, a missed chance, and a gear pick. */
export const HOARD_ROLL: loot.DungeonRewardPlanV2 = {
  v: 2,
  resolverVersion: 1,
  snapshotHash: 'sha256:preview',
  atRisk: { shards: 0, waifubux: 0 },
  secured: {
    essence: 0,
    affection: 0,
    items: [{ item: 'bent_gear', quantity: 3 }],
    equipment: [{ dropId: 'd3', definitionKey: 'iron_plate', rollSeed: 99 }],
  },
  lines: [
    {
      ...source('d1', 'guaranteed'),
      entryId: 'scrap',
      hit: true,
      grant: { type: 'item', item: 'bent_gear', quantity: 3 },
      rolls: { quantity: { min: 2, max: 4, value: 3 } },
    },
    {
      ...source('d2', 'chance'),
      entryId: 'essence',
      hit: false,
      missReason: 'chance_missed',
      rolls: { chance: { value: 7000, chanceBasisPoints: 3000 } },
    },
    {
      ...source('d3', 'pool'),
      poolId: 'gear',
      poolName: 'Boss gear',
      poolPick: 0,
      entryId: 'rare',
      hit: true,
      grant: { type: 'equipment', definitionKey: 'iron_plate', rollSeed: 99 },
      rolls: {
        pool: { value: 10, weight: 60, totalWeight: 100 },
        equipment: { selectorKey: 'slot=*;rarity=R;keys=*', candidateCount: 2, index: 1 },
      },
    },
  ],
};
const NOTHING_ANALYSIS: loot.DungeonRewardAnalysis = {
  resolverVersion: 1,
  snapshotHash: 'sha256:preview',
  rewards: [],
  expectedEquipmentPieces: 0,
  chanceAnyEquipment: 0,
  equipmentCandidateCount: 0,
  noRewardChance: 1,
  sources: [],
};
export function rollResult(
  body: loot.DungeonLootTableBody,
  extra: Partial<loot.DungeonTestRollResult> = {},
): loot.DungeonTestRollResult {
  const hoard = body.pools.some((pool) => pool.id === 'gear');
  const { issues, equipmentPools } = inspect(body);
  const blocked = issues.some((i) => i.severity === 'error');
  return {
    seed: 424242,
    roll: blocked
      ? null
      : hoard
        ? HOARD_ROLL
        : {
            ...HOARD_ROLL,
            secured: { ...HOARD_ROLL.secured, items: [], equipment: [] },
            lines: [],
          },
    analysis: blocked ? null : hoard ? HOARD_ANALYSIS : NOTHING_ANALYSIS,
    issues,
    items: {},
    equipmentPools: blocked ? {} : equipmentPools,
    ...extra,
  };
}

type Bundle = dungeons.DungeonRewardBundle;
const average = (range: { min: number; max: number }) => (range.min + range.max) / 2;
const analysed = (grant: loot.DungeonRewardGrant): loot.DungeonAnalysedReward =>
  grant.type === 'currency'
    ? { type: 'currency', currency: grant.currency }
    : grant.type === 'item'
      ? { type: 'item', item: grant.item }
      : grant.type === 'affection'
        ? { type: 'affection' }
        : { type: 'equipment', definitionKey: matching(grant.selector)[0]?.key ?? 'none' };
const amountOf = (grant: loot.DungeonRewardGrant) =>
  grant.type === 'equipment' ? 1 : average(grant.type === 'item' ? grant.quantity : grant.amount);
/**
 * A stand-in for the server's Test Roll of an activity bundle: exact figures
 * for the activity's own rewards, the fixed `HOARD_*` data for each roll of
 * the hoard table, and the dependency problems reported where the server
 * reports them. Chance drops always miss in the sample roll.
 */
export function bundleRoll(
  input: loot.DungeonBundleTestRollInput,
  tables: readonly loot.DungeonLootTable[],
): loot.DungeonTestRollResult {
  const bundle: Bundle = input.bundle;
  const issues: dungeons.DungeonIssue[] = [];
  const equipmentPools: loot.DungeonTestRollResult['equipmentPools'] = {};
  const label = 'Room "Preview", activity "reward"';
  const at = 'rooms[0].actions[0].rewards';
  (['guaranteed', 'chances'] as const).forEach((list) =>
    bundle[list].forEach((entry, i) => {
      const found = inspect({
        guaranteed: [{ id: entry.id, grant: entry.grant }],
        chances: [],
        pools: [],
      });
      Object.assign(equipmentPools, found.equipmentPools);
      for (const issue of found.issues)
        issues.push({
          ...issue,
          path: `${at}.${list}[${i}].grant`,
          message: `${label}, reward "${entry.id}": problem`,
        });
      if (
        entry.grant.type === 'currency' &&
        entry.grant.currency === 'shards' &&
        !input.progressionCurrency
      )
        issues.push({
          code: 'reward_shards_unset',
          severity: 'error',
          path: `${at}.${list}[${i}].grant`,
          message: `${label}, reward "${entry.id}": this dungeon has no Baddie Shard currency set, so it cannot pay Shards.`,
        });
    }),
  );
  bundle.tables.forEach((ref, i) => {
    const table = tables.find((t) => t.key === ref.table);
    if (!table)
      issues.push({
        code: 'reward_table_missing',
        severity: 'error',
        path: `${at}.tables[${i}]`,
        message: `${label}: loot table "${ref.table}" no longer exists.`,
      });
    else if (table.archivedAt)
      issues.push({
        code: 'reward_table_archived',
        severity: 'error',
        path: `${at}.tables[${i}]`,
        message: `${label}, loot table "${table.name}" is archived. Restore it or pick another.`,
      });
    else Object.assign(equipmentPools, table.equipmentPools);
  });
  const base = { seed: input.seed ?? 424242, issues, items: {}, equipmentPools };
  if (issues.some((i) => i.severity === 'error'))
    return { ...base, roll: null, analysis: null, equipmentPools: {} };

  const rewards = new Map<string, loot.DungeonRewardAnalysis['rewards'][number]>();
  const add = (reward: loot.DungeonAnalysedReward, probability: number, quantity: number) => {
    const key = JSON.stringify(reward);
    const entry = rewards.get(key) ?? {
      reward,
      riskClass:
        reward.type === 'currency' && reward.currency !== 'essence' ? 'at_risk' : 'secured',
      expectedQuantity: 0,
      chanceAtLeastOnce: 0,
      contributions: [],
    };
    entry.expectedQuantity += quantity;
    entry.chanceAtLeastOnce = 1 - (1 - entry.chanceAtLeastOnce) * (1 - probability);
    rewards.set(key, entry);
  };
  const lines: loot.DungeonResolvedRewardLine[] = [];
  const plan: loot.DungeonRewardPlanV2 = {
    v: 2,
    resolverVersion: 1,
    snapshotHash: 'sha256:preview',
    atRisk: { shards: 0, waifubux: 0 },
    secured: { essence: 0, affection: 0, items: [], equipment: [] },
    lines,
  };
  for (const entry of bundle.guaranteed) {
    const grant = entry.grant;
    add(analysed(grant), 1, amountOf(grant));
    const dropId = `g:${entry.id}`;
    const direct = {
      dropId,
      source: 'guaranteed' as const,
      mode: 'guaranteed' as const,
      entryId: entry.id,
      hit: true,
      rolls: {},
    };
    if (grant.type === 'currency') {
      if (grant.currency === 'essence') plan.secured.essence += grant.amount.min;
      else plan.atRisk[grant.currency] += grant.amount.min;
      lines.push({
        ...direct,
        grant: { type: 'currency', currency: grant.currency, amount: grant.amount.min },
      });
    } else if (grant.type === 'item') {
      plan.secured.items.push({ item: grant.item, quantity: grant.quantity.min });
      lines.push({
        ...direct,
        grant: { type: 'item', item: grant.item, quantity: grant.quantity.min },
      });
    } else if (grant.type === 'affection') {
      plan.secured.affection += grant.amount.min;
      lines.push({ ...direct, grant: { type: 'affection', amount: grant.amount.min } });
    } else {
      const definitionKey = matching(grant.selector)[0]!.key;
      plan.secured.equipment.push({ dropId, definitionKey, rollSeed: 1 });
      lines.push({ ...direct, grant: { type: 'equipment', definitionKey, rollSeed: 1 } });
    }
  }
  let nothing = bundle.guaranteed.length ? 0 : 1;
  for (const entry of bundle.chances) {
    const probability = entry.chanceBasisPoints / 10_000;
    add(analysed(entry.grant), probability, probability * amountOf(entry.grant));
    nothing *= 1 - probability;
    lines.push({
      dropId: `c:${entry.id}`,
      source: 'chance',
      mode: 'chance',
      entryId: entry.id,
      hit: false,
      missReason: 'chance_missed',
      rolls: { chance: { value: 9999, chanceBasisPoints: entry.chanceBasisPoints } },
    });
  }
  const sources: loot.DungeonRewardAnalysis['sources'] = [];
  let gear = 0;
  for (const ref of bundle.tables) {
    if (ref.table !== 'scrapheap_boss_hoard') continue;
    nothing = 0;
    gear += HOARD_ANALYSIS.expectedEquipmentPieces * ref.draws;
    for (const reward of HOARD_ANALYSIS.rewards)
      add(reward.reward, reward.chanceAtLeastOnce, reward.expectedQuantity * ref.draws);
    const where = { tableKey: ref.table, tableReferenceId: ref.id };
    sources.push({ ...HOARD_ANALYSIS.sources[0]!, ...where });
    for (let draw = 0; draw < ref.draws; draw++) {
      for (const line of HOARD_ROLL.lines)
        lines.push({
          ...line,
          ...where,
          dropId: `${ref.id}:${draw}:${line.dropId}`,
          tableDraw: draw,
        });
      plan.secured.items.push({ item: 'bent_gear', quantity: 3 });
      plan.secured.equipment.push({
        dropId: `${ref.id}:${draw}`,
        definitionKey: 'iron_plate',
        rollSeed: 99,
      });
    }
  }
  return {
    ...base,
    roll: plan,
    analysis: {
      resolverVersion: 1,
      snapshotHash: 'sha256:preview',
      rewards: [...rewards.values()],
      expectedEquipmentPieces:
        gear + bundle.guaranteed.filter((e) => e.grant.type === 'equipment').length,
      chanceAnyEquipment: gear > 0 ? 0.75 : 0,
      equipmentCandidateCount: gear > 0 ? 3 : 0,
      noRewardChance: nothing,
      sources,
    },
  };
}

const apiError = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new PortalApiError({ status, code, message, ...(details ? { details } : {}) });

export function install() {
  const world = {
    tables: [
      table('scrapheap_boss_hoard', 'Scrapheap Boss Hoard', HOARD_BODY, {
        description: 'Main loot for the Service Tunnels foreman.',
        tier: 'boss',
        revision: 3,
      }),
      table(
        'tunnel_cache',
        'Tunnel Cache',
        {
          ...EMPTY_BODY,
          guaranteed: [
            {
              id: 'shards',
              grant: { type: 'currency', currency: 'shards', amount: { min: 10, max: 10 } },
            },
            {
              id: 'bux',
              grant: { type: 'currency', currency: 'waifubux', amount: { min: 50, max: 50 } },
            },
          ],
        },
        { tier: 'common' },
      ),
      table('old_stash', 'Old Stash', EMPTY_BODY, {
        tier: 'rare',
        archivedAt: '2026-10-05T12:00:00.000Z',
        revision: 2,
      }),
      table('pinned_stash', 'Pinned Stash', EMPTY_BODY, {
        archivedAt: '2026-10-05T12:00:00.000Z',
      }),
    ] as loot.DungeonLootTable[],
    usage: {
      scrapheap_boss_hoard: {
        drafts: [draft('tunnels', 'Service Tunnels')],
        published: [published('tunnels', 'Service Tunnels', 4), published('mine', 'Old Mine', 2)],
      },
      pinned_stash: { drafts: [draft('mine', 'Old Mine')], published: [] },
    } as Record<string, loot.DungeonLootTableUsage>,
  };
  const find = (key: string) => {
    const found = world.tables.find((t) => t.key === key);
    if (!found)
      throw apiError(404, 'DUNGEON_LOOT_TABLE_NOT_FOUND', 'That loot table could not be found.');
    return found;
  };
  const at = (key: string, expectedRevision: number) => {
    const found = find(key);
    if (found.revision !== expectedRevision)
      throw apiError(
        409,
        'DUNGEON_LOOT_TABLE_STALE',
        'This loot table changed since you opened it.',
        {
          key,
          expectedRevision,
          currentRevision: found.revision,
          updatedBy: found.updatedBy,
          updatedAt: found.updatedAt,
        },
      );
    return found;
  };
  const replace = (next: loot.DungeonLootTable) => {
    world.tables = world.tables.map((t) => (t.key === next.key ? next : t));
    return structuredClone(next);
  };

  vi.spyOn(dungeons, 'getDungeonReference').mockResolvedValue({
    lootTables: [],
    items: ITEMS,
    actionTypes: [],
    reservedActionTypes: {},
    enemies: [],
    rewardTables: [],
    currencies: [],
    regions: [],
  } as unknown as dungeons.DungeonReferenceData);
  vi.spyOn(dungeons, 'publishDungeon');
  vi.spyOn(loot, 'listDungeonLootTables').mockImplementation(async (filter = {}) => ({
    tables: structuredClone(
      world.tables.filter(
        (t) =>
          (filter.includeArchived || t.archivedAt === null) &&
          (filter.tier === undefined || t.tier === filter.tier) &&
          (!filter.search || t.name.toLowerCase().includes(filter.search.toLowerCase())),
      ),
    ),
  }));
  vi.spyOn(loot, 'getDungeonLootTable').mockImplementation(async (key) =>
    structuredClone(find(key)),
  );
  vi.spyOn(loot, 'createDungeonLootTable').mockImplementation(async (input) => {
    if (world.tables.some((t) => t.key === input.key))
      throw apiError(
        409,
        'DUNGEON_LOOT_TABLE_KEY_TAKEN',
        'Another dungeon loot table already uses that key.',
      );
    const created = table(input.key, input.name, input.body, {
      description: input.description ?? '',
      tier: input.tier ?? null,
    });
    world.tables.push(created);
    return structuredClone(created);
  });
  vi.spyOn(loot, 'updateDungeonLootTable').mockImplementation(async (key, input) => {
    const current = at(key, input.expectedRevision);
    const body = input.body ?? current.body;
    return replace({
      ...current,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      tier: input.tier === undefined ? current.tier : input.tier,
      body,
      ...inspect(body),
      revision: current.revision + 1,
    });
  });
  vi.spyOn(loot, 'archiveDungeonLootTable').mockImplementation(async (key, revision) =>
    replace({
      ...at(key, revision),
      archivedAt: '2026-10-11T12:00:00.000Z',
      revision: revision + 1,
    }),
  );
  vi.spyOn(loot, 'restoreDungeonLootTable').mockImplementation(async (key, revision) =>
    replace({ ...at(key, revision), archivedAt: null, revision: revision + 1 }),
  );
  vi.spyOn(loot, 'deleteDungeonLootTable').mockImplementation(async (key, revision) => {
    const current = at(key, revision);
    const usage = world.usage[key] ?? NO_USE;
    if (current.archivedAt === null || usage.drafts.length > 0)
      throw apiError(409, 'DUNGEON_LOOT_TABLE_DELETE_REFUSED', 'This table is still needed.', {
        key,
        reason: current.archivedAt === null ? 'not_archived' : 'in_use',
        usage,
      });
    world.tables = world.tables.filter((t) => t.key !== key);
    return { deleted: true };
  });
  vi.spyOn(loot, 'duplicateDungeonLootTable').mockImplementation(async (key, input) => {
    const original = find(key);
    const copy = table(input.key, input.name ?? original.name, original.body, {
      description: original.description,
      tier: original.tier,
    });
    world.tables.push(copy);
    return structuredClone(copy);
  });
  vi.spyOn(loot, 'getDungeonLootTableUsage').mockImplementation(
    async (key) => world.usage[key] ?? NO_USE,
  );
  vi.spyOn(loot, 'getDungeonLootTableHistory').mockResolvedValue({ events: [] });
  vi.spyOn(loot, 'validateDungeonLootTable').mockImplementation(async (raw) => {
    const body = raw as loot.DungeonLootTableBody;
    const report = inspect(body);
    return {
      valid: !report.issues.some((i) => i.severity === 'error'),
      body,
      contentHash: 'sha256:validated',
      ...report,
    };
  });
  vi.spyOn(loot, 'testRollDungeonRewards').mockImplementation(async (input) =>
    bundleRoll(input, world.tables),
  );
  vi.spyOn(loot, 'testRollDungeonLootTable').mockImplementation(async (input) =>
    rollResult(input.tableBody, input.seed === undefined ? {} : { seed: input.seed }),
  );
  return world;
}

function Stub({ label }: { label: string }) {
  const { key } = useParams();
  return <p>{key ? `${label} ${key}` : label}</p>;
}
export function renderLoot(path = '/admin/dungeons/loot', permissions = WRITE) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/admin/dungeons" element={<Stub label="Dungeons page" />} />
      <Route path="/admin/dungeons/definitions/:key" element={<Stub label="Dungeon editor" />} />
      <Route path="/admin/dungeons/loot" element={<LootTablesListPage />} />
      <Route path="/admin/dungeons/loot/new" element={<LootTableEditorPage />} />
      <Route path="/admin/dungeons/loot/:key" element={<LootTableEditorPage />} />
    </Routes>,
    { wrapper },
  );
}
/** Session and query context for one shared component on its own. */
export function renderPart(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
