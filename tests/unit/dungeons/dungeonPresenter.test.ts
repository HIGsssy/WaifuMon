import { embedLength, type ActionRowBuilder, type ButtonBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildAbandonConfirm, buildDungeonDetail, buildDungeonHome, buildExtractConfirm, buildRunScreen, securedSummary } from '../../../src/discord/dungeonPresenter';
import type { DungeonCard, DungeonRunView, DungeonSecuredReward } from '../../../src/modules/dungeons/dungeonRunService';
import type { DungeonFighter } from '../../../src/modules/dungeons/dungeonFighter';
import type { DungeonRewardPlanV2 } from '../../../src/modules/dungeons/engine/lootResolver';
import type { SessionPayload } from '../../../src/discord/ephemeralSession';
import { describeDungeonRun } from '../../../src/modules/dungeons/engine/view';
import { startDungeonRun } from '../../../src/modules/dungeons/engine/step';
import { singleRoomDungeon, testDependencies, TEST_FIGHTER } from '../../helpers/dungeonFixtures';

const fighter: DungeonFighter = {
  waifuId: TEST_FIGHTER.waifuId, name: TEST_FIGHTER.name, attack: TEST_FIGHTER.attack, defense: TEST_FIGHTER.defense, maxHp: TEST_FIGHTER.maxHp,
  formulaVersion: 1, speciesSlug: 'pinned_species', level: 35, currentSp: 100,
  gear: {
    attack: { equipmentId: 1, definitionKey: 'old', name: 'Pipe', rarity: 'N', multiplierBp: 5000 },
    defense: { equipmentId: 2, definitionKey: 'old', name: 'Plate', rarity: 'N', multiplierBp: 5000 },
    health: { equipmentId: 3, definitionKey: 'old', name: 'Lunchbox', rarity: 'N', multiplierBp: 5000 },
  },
};
const options = { itemName: (slug: string) => ({ charm: 'Velvet Charm', salvage: 'Bent Scrap' })[slug as 'charm' | 'salvage'] ?? 'Prize' };
const receipt = (kind: DungeonSecuredReward['kind']): DungeonSecuredReward => {
  const common = { source: 'private_claim_key', step: 1 };
  switch (kind) {
    case 'item': return { ...common, kind, slug: 'charm', quantity: 2 };
    case 'waifubux': return { ...common, kind, amount: 11 };
    case 'equipment': return { ...common, kind, rewardIndex: 0, equipmentId: 987654, definitionKey: 'private_definition_key', dropId: 'private_drop', rollSeed: 7654321,
      displayName: 'Rusted Wrench of Regret', slot: 'attack', rarity: 'SR', rolledMultiplierBp: 4500, affixKey: 'private_affix', combatBonuses: [{ stat: 'crit_chance_bp', valueBp: 425 }] };
    case 'essence': return { ...common, kind, baseAmount: 7, granted: 9, bonusPercent: 25, bonus: 'pinned', balanceAfter: 109 };
    case 'affection': return { ...common, kind, waifuId: fighter.waifuId, name: 'Nebula Nurse', speciesSlug: fighter.speciesSlug,
      baseAmount: 3, granted: 4, bonusPercent: 25, bonus: 'pinned', affectionBefore: 0, affectionAfter: 4 };
  }
};
const plan: DungeonRewardPlanV2 = { v: 2, resolverVersion: 1, snapshotHash: 'private_hash', atRisk: { shards: 999, waifubux: 999 },
  secured: { essence: 999, affection: 999, items: [{ item: 'private_slug', quantity: 999 }], equipment: [] }, lines: [] };
function view(): DungeonRunView {
  const definition = singleRoomDungeon([]);
  const ctx = { definition, dependencies: testDependencies(), fighter, runKey: '1' };
  const state = startDungeonRun(ctx, 42).state;
  const core = describeDungeonRun(state, ctx);
  const secured = ['item', 'equipment', 'essence', 'affection'].map((kind) => receipt(kind as DungeonSecuredReward['kind']));
  return { id: 1, status: 'active', step: 1,
    dungeon: { key: 'test', name: 'Rust Warrens', description: '', revision: 1, artwork: { assetId: null, artworkPath: null }, background: { assetId: null, artworkPath: null } },
    fighter: structuredClone(fighter), core: { ...core, step: 1, unbankedCurrency: 45, unbankedWaifubux: 501,
      recent: [{ kind: 'reward', roomId: 'hall', actionId: 'pay', claimKey: 'private_claim_key', plan }] },
    enemy: null, roomBackground: { assetId: null, artworkPath: null }, combatEvents: null,
    currency: { key: 'private_currency', singularName: 'Baddie Shard', pluralName: 'Baddie Shards', icon: '◆' },
    defeatRetentionBasisPoints: 5000, abandonRetentionBasisPoints: 0, rewardFormat: 'v2',
    atRisk: { shards: 45, waifubux: 501 }, latestAtRisk: { shards: 45, waifubux: 501 },
    secured, latestSecured: secured, settlement: null, startedAt: new Date(0), completedAt: null,
  };
}
const embed = (payload: SessionPayload) => {
  const e = payload.embeds![0]!;
  return 'toJSON' in e ? e.toJSON() : e;
};
const rowsOf = (payload: SessionPayload) => payload.components as ActionRowBuilder<ButtonBuilder>[];
const textOf = (payload: SessionPayload) => {
  const e = embed(payload);
  return [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`)].join('\n');
};
const field = (payload: SessionPayload, name: string) => embed(payload).fields?.find((f) => f.name === name)?.value;
function assertLimits(payload: SessionPayload) {
  const e = embed(payload);
  expect(embedLength(e)).toBeLessThanOrEqual(6000);
  expect(e.title?.length ?? 0).toBeLessThanOrEqual(256);
  expect(e.description?.length ?? 0).toBeLessThanOrEqual(4096);
  expect(e.fields?.length ?? 0).toBeLessThanOrEqual(25);
  for (const f of e.fields ?? []) { expect(f.name.length).toBeLessThanOrEqual(256); expect(f.value.length).toBeLessThanOrEqual(1024); expect(f.value.trim().length).toBeGreaterThan(0); }
  expect(payload.components?.length ?? 0).toBeLessThanOrEqual(5);
  expect(payload.content?.length ?? 0).toBeLessThanOrEqual(2000);
  for (const row of rowsOf(payload) ?? []) {
    const json = row.toJSON();
    expect(json.components.length).toBeLessThanOrEqual(5);
    for (const button of json.components) if ('custom_id' in button) expect(button.custom_id?.length).toBeLessThanOrEqual(100);
  }
}
const card = (extra: Partial<DungeonCard> = {}): DungeonCard => ({ key: 'test', name: 'Rust Warrens', description: '', artwork: { assetId: null, artworkPath: null },
  background: { assetId: null, artworkPath: null }, roomCount: 2, hasBoss: true, currency: view().currency, balance: 12345,
  defeatRetentionBasisPoints: 5000, abandonRetentionBasisPoints: 0, rewardFormat: 'v2', ...extra });
const daily = { periodKey: 'test', limit: 3, used: 1, remaining: 2, resetsAt: new Date(0) };

describe('committed reward screens', () => {
  it('separates actual secured receipts and committed currency totals, never predicted values', () => {
    const screen = buildRunScreen(view(), options);
    expect(field(screen, 'At Risk')).toBe('◆ 45 Baddie Shards\n501 WaifuBux');
    expect(field(screen, '🎁 At Risk earned')).toContain('+501 WaifuBux');
    const kept = field(screen, '🎁 Kept this step')!;
    expect(kept).toContain('+2 Velvet Charm');
    expect(kept).toContain('+9 Essence (7 base, +25% Buddy bonus)');
    expect(kept).toContain('♥ +4 Affection → **Nebula Nurse** (3 base, +25% Buddy bonus)');
    expect(kept).toContain('Rusted Wrench of Regret');
    expect(kept).toContain('(SR) · Attack · ×0.45 · +4.25% Crit Chance');
    for (const secret of ['999', 'private_claim_key', 'private_hash', 'private_slug', 'private_definition_key', '987654', '7654321', 'private_affix']) expect(textOf(screen)).not.toContain(secret);
    assertLimits(screen);
  });
  it('uses the receipt recipient even when fighter display data differ', () => {
    const run = view(); run.fighter.name = 'A different Buddy';
    expect(field(buildRunScreen(run, options), '🎁 Kept this step')).toContain('Affection → **Nebula Nurse**');
  });
  it('does not paint a failed/uncommitted plan as granted or empty', () => {
    const run = view(); run.latestAtRisk = null; run.latestSecured = []; run.secured = [];
    const screen = buildRunScreen(run, options);
    expect(field(screen, '🎁 Kept this step')).toBeUndefined();
    expect(field(screen, '🎁 At Risk earned')).toBeUndefined();
    expect(textOf(screen)).not.toContain('999');
    expect(textOf(screen)).not.toContain('No rewards this time');
  });
  it('handles an empty committed claim without inventing rewards', () => {
    const run = view(); run.latestAtRisk = { shards: 0, waifubux: 0 }; run.latestSecured = []; run.secured = [];
    expect(field(buildRunScreen(run, options), '🎁 Rewards')).toBe('No rewards this time.');
  });
  it('groups inventory receipts and retains actual, unbonused historical amounts', () => {
    const run = view(); const essence = receipt('essence'); if (essence.kind !== 'essence') throw new Error();
    essence.granted = 7; essence.bonus = 'not_pinned'; essence.bonusPercent = 0;
    run.latestSecured = [receipt('item'), receipt('item'), essence];
    const kept = field(buildRunScreen(run, options), '🎁 Kept this step')!;
    expect(kept).toContain('+4 Velvet Charm'); expect(kept).toContain('+7 Essence'); expect(kept).not.toContain('Buddy bonus');
  });
  it('shows both unbanked totals when resuming from home', () => {
    const screen = buildDungeonHome({ region: { id: 'test', name: 'Valley' }, dungeons: [], activeRun: view(), blocker: null, daily }, options);
    expect(field(screen, 'At Risk')).toContain('501 WaifuBux'); expect(field(screen, 'Kept')).toContain('4 Affection → Nebula Nurse'); assertLimits(screen);
  });
  it('never reveals missing item slugs', () => {
    const run = view(); run.latestSecured = [{ kind: 'item', source: 'private', step: 1, slug: 'secret_missing_slug', quantity: 2 }];
    const screen = buildRunScreen(run, { itemName: (slug) => slug });
    expect(textOf(screen)).not.toContain('secret_missing_slug'); expect(textOf(screen)).toContain('Unknown item');
  });
});

describe('risk explanations and confirmations', () => {
  it.each([[0, 0, 0, 45, 501], [5000, 22, 250, 23, 251], [2500, 11, 125, 34, 376]])('abandon at %i bp quotes exact per-currency truncation', (retention, shards, bux, shardLoss, buxLoss) => {
    const run = view(); run.abandonRetentionBasisPoints = retention;
    const before = structuredClone(run);
    const screen = buildAbandonConfirm(run);
    expect(textOf(screen)).toContain(`At risk: 45 · Keep: **${shards}** · Lose: ${shardLoss}`);
    expect(textOf(screen)).toContain(`At risk: 501 · Keep: **${bux}** · Lose: ${buxLoss}`);
    expect(textOf(screen)).toContain('equipment, items, Essence and affection remain yours');
    expect(rowsOf(screen)[0]!.toJSON().components[0]).toMatchObject({ custom_id: 'wm|v1|dg|ab|1|1' });
    expect(run).toEqual(before); assertLimits(screen);
  });
  it('falls back to defeat retention when the abandonment setting is absent', () => {
    const run = view(); delete run.abandonRetentionBasisPoints;
    expect(textOf(buildAbandonConfirm(run))).toContain('Abandon: keep 50%');
  });
  it('extract confirmation quotes both currencies without mutating state', () => {
    const run = view(); const before = structuredClone(run);
    expect(textOf(buildExtractConfirm(run))).toContain('45 Baddie Shards and 501 WaifuBux'); expect(run).toEqual(before);
  });
  it('shows configured retention and legacy fallback on dungeon cards', () => {
    const d = card({ abandonRetentionBasisPoints: 1750 });
    const home = buildDungeonHome({ region: { id: 'test', name: 'Valley' }, dungeons: [d], activeRun: null, blocker: null, daily }, options);
    expect(textOf(home)).toContain('Defeated: keep 50%'); expect(textOf(home)).toContain('Abandon: keep 17.5%');
    const old = card(); delete old.abandonRetentionBasisPoints;
    expect(textOf(buildDungeonHome({ region: { id: 'test', name: 'Valley' }, dungeons: [old], activeRun: null, blocker: null, daily }, options))).toContain('Abandon: keep 50%');
  });
  it('bounds pre-run detail while keeping the risk rules', () => {
    const screen = buildDungeonDetail({ dungeon: card({ description: 'Long description '.repeat(400) }),
      stats: { buddy: null } as never, blocker: 'no_buddy', activeRunId: null, daily }, options);
    expect(field(screen, 'Currency risk')).toContain('Abandon: keep 0%'); assertLimits(screen);
  });
});

describe('settlement receipts and compatibility', () => {
  it('keeps legacy immediately granted WaifuBux secured inside a mixed-format revision', () => {
    const run = view();
    run.latestAtRisk = { shards: 5, waifubux: 0 }; run.latestSecured = [receipt('waifubux'), receipt('item')]; run.secured = run.latestSecured;
    run.core.recent = [{ kind: 'reward', roomId: 'hall', actionId: 'legacy', claimKey: 'private', plan: { currency: 5, waifubux: 11, items: [], equipment: [] } }];
    const screen = buildRunScreen(run, options);
    expect(field(screen, '🎁 Kept this step')).toContain('11 WaifuBux');
    expect(field(screen, '🎁 At Risk earned')).not.toContain('WaifuBux');
    expect(field(screen, 'At Risk')).toContain('501 WaifuBux');
  });
  it('does not invent settlement amounts for a historical ended view with no receipt', () => {
    const run = view(); run.status = 'completed'; run.core.phase = 'ended'; run.settlement = null;
    const screen = buildRunScreen(run, options);
    expect(field(screen, 'Result')).toBe('—');
    expect(field(screen, 'Result')).not.toContain('Banked');
  });
  it.each(['completed', 'extracted', 'defeated', 'abandoned'] as const)('%s displays actual committed earned/banked/lost values', (outcome) => {
    const run = view(); run.status = outcome; run.core.phase = 'ended';
    run.settlement = { outcome, cause: 'scripted', roomId: 'hall', finalHp: 100, earned: 45, banked: 22, lost: 23, retentionBasisPoints: 10000,
      waifubux: { earned: 501, banked: 250, lost: 251 }, bankingSkipped: null, balanceAfter: 1000 };
    const screen = buildRunScreen(run, options);
    expect(field(screen, 'Result')).toContain('Earned: 45 · Banked: **22** · Lost: 23');
    expect(field(screen, 'Result')).toContain('Earned: 501 · Banked: **250** · Lost: 251');
    expect(field(screen, 'Kept — yours to keep')).toContain('9 Essence'); assertLimits(screen);
  });
  it('reports actual skipped Shards independently of committed WaifuBux', () => {
    const run = view(); run.core.phase = 'ended';
    run.settlement = { outcome: 'extracted', cause: 'extraction', roomId: 'hall', finalHp: 100, earned: 45, banked: 0, lost: 45, retentionBasisPoints: 10000,
      waifubux: { earned: 501, banked: 501, lost: 0 }, bankingSkipped: 'currency_disabled', balanceAfter: null };
    const result = field(buildRunScreen(run, options), 'Result')!;
    expect(result).toContain('Banked: **0** · Lost: 45'); expect(result).toContain('Banked: **501** · Lost: 0');
  });
  it('keeps legacy WaifuBux secured and historical settlement fields readable', () => {
    const run = view(); delete run.rewardFormat; delete run.latestAtRisk; run.core.unbankedWaifubux = 0;
    run.secured = [receipt('waifubux'), receipt('item')]; run.latestSecured = run.secured;
    run.core.recent = [{ kind: 'reward', roomId: 'hall', actionId: 'pay', claimKey: 'private', plan: { currency: 5, waifubux: 11, items: [], equipment: [] } }];
    const active = buildRunScreen(run, options);
    expect(field(active, '🎁 Rewards')).toContain('+11 WaifuBux'); expect(field(active, 'Secured')).toContain('11 WaifuBux'); expect(field(active, 'At Risk')).toBeUndefined();
    run.core.phase = 'ended'; run.settlement = { outcome: 'defeated', cause: 'hp_zero', roomId: 'hall', finalHp: 0, earned: 45, banked: 22, lost: 23, retentionBasisPoints: 5000, bankingSkipped: null, balanceAfter: 22 };
    expect(field(buildRunScreen(run, options), 'Result')).toContain('Kept (50%): **◆ 22 Baddie Shards**');
    expect(field(buildRunScreen(run, options), 'Result')).not.toContain('WaifuBux');
  });
});

describe('long reward bundles', () => {
  it('keeps the entire embed budget even when fields alone exceed6000', () => {
    const run = view();
    run.core.room.description = '';
    run.core.recent = Array.from({ length: 10 }, (_, waveIndex) => ({ kind: 'wave' as const, roomId: 'hall', actionId: 'fight', waveCount: 10,
      wave: { waveIndex, enemyKey: 'enemy', enemyName: 'A'.repeat(200), result: 'player_victory' as const, reason: 'defeat' as const, rounds: 100,
        hpBefore: 2000000000, hpAfter: 2000000000, enemyMaxHp: 2000000000, enemyHpAfter: 0,
        lifestealHealed: 2000000000, playerCrits: 0, playerBonusAttacks: 0, combatSeed: 1 } }));
    run.core.connections = Array.from({ length: 50 }, (_, i) => ({ id: `connection_${i}`, label: 'Route '.repeat(14), kind: 'path' as const,
      toRoomId: 'hall', toRoomName: 'Hall', toRoomCompleted: false, open: i < 25, lockedText: 'Locked '.repeat(30) }));
    const gear = receipt('equipment'); run.latestSecured = Array.from({ length: 20 }, () => ({ ...gear, displayName: 'Wrench '.repeat(25) })); run.secured = run.latestSecured;
    const screen = buildRunScreen(run, { ...options, status: 'A'.repeat(3000) });
    expect(field(screen, 'At Risk')).toContain('501 WaifuBux'); expect(field(screen, '🎁 Kept this step')).toContain('more rewards');
    assertLimits(screen);
  });
  it('counts omitted rewards, groups items and keeps important currency totals under every Discord limit', () => {
    const run = view();
    const gear = receipt('equipment');
    run.latestSecured = [receipt('essence'), ...Array.from({ length: 100 }, (_, i) => ({ ...gear, displayName: `Award ${i} ${'x'.repeat(190)}` }))];
    run.secured = run.latestSecured;
    run.core.room.description = 'Room narrative '.repeat(100);
    run.core.recent = Array.from({ length: 100 }, () => ({ kind: 'rest' as const, roomId: 'hall', actionId: 'rest', hpBefore: 1, hpAfter: 2, healBasisPoints: 10 }));
    const screen = buildRunScreen(run, options);
    expect(field(screen, '🎁 Kept this step')).toMatch(/and \d+ more rewards/);
    expect(field(screen, 'At Risk')).toContain('501 WaifuBux'); expect(field(screen, '🎁 Kept this step')).toContain('+9 Essence');
    expect(textOf(screen)).toContain('more activity results'); assertLimits(screen);
  });
  it('groups repeated inventory lines in the cumulative kept summary', () => {
    expect(securedSummary([receipt('item'), receipt('item')], options.itemName)).toBe('4 Velvet Charm');
  });
});
