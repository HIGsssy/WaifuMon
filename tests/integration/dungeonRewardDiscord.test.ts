import { ActionRowBuilder, EmbedBuilder, type ButtonBuilder, type ButtonInteraction } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dungeonRuns, items, playerWaifus, species as speciesTable } from '../../src/db/schema';
import {
  handleDungeonAbandon, handleDungeonAbandonConfirm, handleDungeonAct, handleDungeonExtract,
  handleDungeonExtractConfirm, handleDungeonHome, handleDungeonMove, handleDungeonRun, handleDungeonStart, handleDungeonZone,
} from '../../src/discord/commands/waifumonDungeon';
import { RUN_OVER_NOTICE, STALE_STEP_NOTICE, dgId } from '../../src/discord/dungeonPresenter';
import type { SessionPayload } from '../../src/discord/ephemeralSession';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import type { DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonRewardBundleSchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { insertOwnedWaifu } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

vi.mock('../../src/discord/assets/attachRenderedCard', () => ({ ownedArtworkImage: vi.fn(() => null) }));
vi.mock('../../src/discord/dungeonArtwork', () => ({ dungeonRunSceneArtwork: vi.fn(async () => null), dungeonZoneArtwork: vi.fn(async () => null) }));

let w: DungeonWorld;
let ctx: AppContext;
let n = 0;
const slug = 't11_salvage';
const gearKey = 't11_gear';
const currency = (currency: 'shards' | 'waifubux' | 'essence', amount: number) => ({ type: 'currency' as const, currency, amount: { min: amount, max: amount } });
const rewards = () => DungeonRewardBundleSchema.parse({ guaranteed: [
  { id: 'shards', grant: currency('shards', 45) }, { id: 'bux', grant: currency('waifubux', 501) }, { id: 'essence', grant: currency('essence', 7) },
  { id: 'bond', grant: { type: 'affection', amount: { min: 3, max: 3 } } },
  { id: 'charm', grant: { type: 'item', item: 'basic_charm', quantity: { min: 2, max: 2 } } },
  { id: 'salvage', grant: { type: 'item', item: slug, quantity: { min: 3, max: 3 } } },
  ...['gear_a', 'gear_z'].map((id) => ({ id, grant: { type: 'equipment', selector: { definitionKeys: [gearKey] } } })),
], chances: [], tables: [] });
type Handler = (ctx: AppContext, interaction: ButtonInteraction, prov: Provisioned, args: string[]) => Promise<unknown>;
async function call(handler: Handler, prov: Provisioned, args: string[]) {
  let painted: SessionPayload = {};
  const paint = vi.fn(async (body: string | SessionPayload) => { painted = typeof body === 'string' ? { content: body } : body; });
  const interaction = { replied: false, deferred: false, isButton: () => true, isStringSelectMenu: () => false, update: paint, reply: paint, editReply: paint } as unknown as ButtonInteraction;
  await handler(ctx, interaction, prov, args);
  expect(paint).toHaveBeenCalledTimes(1);
  return painted;
}
const embed = (screen: SessionPayload) => (screen.embeds![0] as EmbedBuilder).toJSON();
const text = (screen: SessionPayload) => [embed(screen).title, embed(screen).description, ...(embed(screen).fields ?? []).map((f) => `${f.name}\n${f.value}`)].join('\n');
const field = (screen: SessionPayload, name: string) => embed(screen).fields?.find((f) => f.name === name)?.value;
const buttons = (screen: SessionPayload) => (screen.components as ActionRowBuilder<ButtonBuilder>[]).flatMap((r) => r.toJSON().components);
const button = (screen: SessionPayload, label: string) => {
  const b = buttons(screen).find((b) => 'label' in b && b.label === label);
  if (!b || !('custom_id' in b)) throw new Error(`Missing ${label}`);
  return b.custom_id!;
};
const argsOf = (id: string) => {
  const parsed = parseCustomId(id);
  if (!parsed || parsed === 'unknown_version') throw new Error('Invalid fixture button');
  return parsed.args;
};
const act = (prov: Provisioned, run: { id: number; step: number }) => call(handleDungeonAct, prov, [String(run.id), String(run.step), 'a']);
async function start(type: 'combat' | 'boss' | 'treasure' = 'treasure', patch: (d: DungeonDefinitionInput) => void = () => {}) {
  const action = type === 'treasure' ? { id: 'pay', type: 'reward' as const, rewards: rewards() }
    : { id: 'pay', type, waves: [{ enemy: { key: 'grunt' } }], rewards: rewards() };
  const definition = singleRoomDungeon([action], (d) => {
    d.key = `t11_${++n}`; d.name = 'Reward Warrens'; d.rooms[0]!.extraction = true;
    d.settings!.defeatCurrencyRetentionBasisPoints = 5000; d.settings!.abandonCurrencyRetentionBasisPoints = 0;
    patch(d);
  });
  await w.publish(definition);
  const { playerId, buddyId } = await w.player();
  const prov = { playerId, guildDbId: 1 } as Provisioned;
  const screen = await call(handleDungeonStart, prov, [definition.key]);
  const run = (await w.runs.activeRun(playerId))!;
  return { playerId, buddyId: buddyId!, prov, screen, run, definition };
}
const row = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.svc.definitions.create({ key: gearKey, name: 'Reward Wrench', slot: 'attack', rarity: 'SR', multiplierMinBp: 4000, multiplierMaxBp: 6000, multiplierStepBp: 500 });
  await w.t.db.insert(items).values({ slug, name: 'Bent Scrap', category: 'salvage' });
  ctx = { config: { assetsDir: '/tmp' }, logger: silentLogger(), content: w.app.content,
    services: { dungeonRuns: w.runs, dungeonContent: w.content, dungeonAllowance: w.allowance, collection: w.app.collection } } as unknown as AppContext;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await w?.cleanup(); });

describe('v2 rewards through real Discord handlers', () => {
  it.each(['combat', 'boss', 'treasure'] as const)('%s paints actual items, equipment and both risk totals after commit', async (type) => {
    const { playerId, prov, run } = await start(type);
    const before = await w.app.currency.getBalances(playerId);
    const screen = await act(prov, run);
    expect(field(screen, 'At Risk')).toContain('501 WaifuBux');
    expect(field(screen, '🎁 At Risk earned')).toContain('+45 Ascension Tokens');
    const kept = field(screen, '🎁 Kept this step')!;
    expect(kept).toContain('+2 Basic Charm'); expect(kept).toContain('+3 Bent Scrap'); expect(kept).toContain('+7 Essence'); expect(kept).toContain('Affection → **Nebula Nurse**');
    const view = await w.runs.run(playerId, run.id);
    for (const gear of view.secured.filter((r) => r.kind === 'equipment')) {
      expect(kept).toContain(gear.displayName); expect(kept).toContain(`×${(gear.rolledMultiplierBp / 10000).toFixed(2)}`);
    }
    expect((await w.app.currency.getBalances(playerId)).waifubux).toBe(before.waifubux);
    expect(view.latestAtRisk).toEqual({ shards: 45, waifubux: 501 });
    const homeScreen = await call((c, i, p) => handleDungeonHome(c, i, p), prov, []);
    expect(field(homeScreen, 'At Risk')).toContain('501 WaifuBux');
    const again = await act(prov, run);
    expect(again.content).toBe(STALE_STEP_NOTICE); expect(text(again)).toContain('7 Essence');
    expect((await row(run.id)).step).toBe(1);
  });

  it.each(['essence_gain', 'affection_gain'] as const)('renders pinned %s after switching Buddy', async (effectId) => {
    const { playerId, buddyId } = await w.player();
    const [copy] = await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId!));
    const [meta] = await w.t.db.select().from(speciesTable).where(eq(speciesTable.id, copy!.speciesId));
    const species = w.app.content.species.find((s) => s.slug === meta!.slug)!;
    const original = species.buddyBonus;
    species.buddyBonus = { name: 'Pinned', flavorText: '', effectId, value: 25 };
    let run;
    try {
      const definition = singleRoomDungeon([{ id: 'pay', type: 'reward', rewards: rewards() }], (d) => { d.key = `t11_bonus_${++n}`; d.rooms[0]!.extraction = true; });
      await w.publish(definition); run = await w.runs.start(playerId, definition.key, { seed: 42 });
    } finally { species.buddyBonus = original; }
    const other = await insertOwnedWaifu(w.t.db, { playerId, speciesId: copy!.speciesId, level: 35, baseSp: 100, nickname: 'Other Buddy' });
    await w.app.collection.setBuddy(playerId, other.id);
    const screen = await act({ playerId, guildDbId: 1 } as Provisioned, run);
    const kept = field(screen, '🎁 Kept this step')!;
    expect(kept).toContain(effectId === 'essence_gain' ? '+9 Essence (7 base, +25% Buddy bonus)' : '+4 Affection → **Nebula Nurse** (3 base, +25% Buddy bonus)');
    expect(kept).not.toContain('Other Buddy');
  });

  it('pre-entry rules use actual abandonment settings and display causes no write', async () => {
    const { prov, definition, run } = await start('treasure', (d) => { d.settings!.abandonCurrencyRetentionBasisPoints = 1750; });
    const before = await row(run.id);
    const screen = await call(handleDungeonZone, prov, [definition.key]);
    expect(field(screen, 'Currency risk')).toContain('Defeated: keep 50%');
    expect(field(screen, 'Currency risk')).toContain('Abandon: keep 17.5%');
    expect(await row(run.id)).toEqual(before);
  });

  it('abandon confirmation quotes losses without settling, refuses stale confirmation and settles once', async () => {
    const { playerId, prov, run } = await start('treasure', (d) => { d.settings!.abandonCurrencyRetentionBasisPoints = 5000; });
    const early = await call(handleDungeonAbandonConfirm, prov, [String(run.id)]);
    const before = await row(run.id); expect(await row(run.id)).toEqual(before);
    await act(prov, run);
    const stale = await call(handleDungeonAbandon, prov, argsOf(button(early, 'Abandon Run')));
    expect(stale.content).toBe(STALE_STEP_NOTICE); expect((await row(run.id)).status).toBe('active');
    const confirmation = await call(handleDungeonAbandonConfirm, prov, [String(run.id)]);
    expect(text(confirmation)).toContain('At risk: 45 · Keep: **22** · Lose: 23');
    expect(text(confirmation)).toContain('At risk: 501 · Keep: **250** · Lose: 251');
    const wallet = await w.app.currency.getBalances(playerId);
    const id = button(confirmation, 'Abandon Run');
    const ends = await Promise.all([call(handleDungeonAbandon, prov, argsOf(id)), call(handleDungeonAbandon, prov, argsOf(id))]);
    expect(ends.filter((s) => s.content === RUN_OVER_NOTICE)).toHaveLength(1);
    expect(field(ends[0]!, 'Result')).toContain('Earned: 501 · Banked: **250** · Lost: 251');
    expect((await w.app.currency.getBalances(playerId)).waifubux).toBe(wallet.waifubux + 250);
    expect(await w.balance(playerId)).toBe(22);
    const again = await call(handleDungeonAbandon, prov, argsOf(id)); expect(again.content).toBe(RUN_OVER_NOTICE);
    expect((await w.runs.history(run.id)).filter((e) => e.type === 'abandon')).toHaveLength(1);
  });

  it('historical step-less abandon buttons refresh confirmation rather than settle new amounts', async () => {
    const { prov, run } = await start();
    await act(prov, run);
    const old = await call(handleDungeonAbandon, prov, [String(run.id)]);
    expect(text(old)).toContain('Abandon: keep 0%'); expect(button(old, 'Abandon Run')).toBe(dgId.abandon(run.id, 1));
    expect((await row(run.id)).status).toBe('active');
  });

  it.each(['completed', 'extracted', 'defeated'] as const)('%s shows committed per-currency settlement', async (outcome) => {
    const { prov, run } = await start('treasure', (d) => {
      if (outcome === 'completed') d.rooms[0]!.actions![0]!.outcomes = { claimed: { type: 'end_run', outcome: 'completed' } };
      if (outcome === 'defeated') d.rooms[0]!.actions!.push({ id: 'loss', type: 'combat', waves: [{ enemy: { key: 'brute' } }] });
    });
    let screen = await act(prov, run);
    if (outcome === 'extracted') {
      const confirm = await call(handleDungeonExtractConfirm, prov, [String(run.id)]);
      expect(text(confirm)).toContain('45 Ascension Tokens and 501 WaifuBux');
      screen = await call(handleDungeonExtract, prov, argsOf(button(confirm, 'Extract')));
    } else if (outcome === 'defeated') screen = await act(prov, { id: run.id, step: 1 });
    const banked = outcome === 'defeated' ? 250 : 501;
    expect(field(screen, 'Result')).toContain(`WaifuBux — Earned: 501 · Banked: **${banked}** · Lost: ${501 - banked}`);
    expect(field(screen, 'Kept — yours to keep')).toContain('7 Essence');
    const loaded = await call(handleDungeonRun, prov, [String(run.id)]); expect(text(loaded)).toBe(text(screen));
  });

  it('failed delivery paints only the recoverable error; successful retry paints committed receipts', async () => {
    const { prov, run, playerId } = await start('boss');
    const before = await row(run.id);
    const wallet = await w.app.currency.getBalances(playerId);
    vi.spyOn(w.app.collection, 'awardCopyAffection').mockRejectedValueOnce(new Error('injected failure'));
    const failed = await act(prov, run);
    expect(failed.content).toContain('progress has not advanced'); expect(failed.embeds ?? []).toEqual([]);
    expect(await row(run.id)).toEqual(before); expect(await w.app.currency.getBalances(playerId)).toEqual(wallet);
    const retry = await act(prov, run); expect(field(retry, '🎁 Kept this step')).toContain('Reward Wrench');
  });

  it('does not repeat newly earned rewards on retreat/re-entry', async () => {
    const { prov, run } = await start('treasure', (d) => {
      d.rooms[0]!.actions = [];
      d.rooms.push({ id: 'loot', actions: [{ id: 'pay', type: 'reward', rewards: rewards(), outcomes: { claimed: { type: 'retreat' } } }] });
      d.connections!.push({ id: 'to_loot', from: 'hall', to: 'loot' });
    });
    await call(handleDungeonMove, prov, [String(run.id), '0', 'to_loot']);
    await act(prov, { id: run.id, step: 1 });
    const before = await w.app.currency.getBalances(prov.playerId);
    for (let i = 0; i < 2; i++) {
      const current = await w.runs.run(prov.playerId, run.id);
      await call(handleDungeonMove, prov, [String(run.id), String(current.step), 'to_loot']);
      const screen = await act(prov, { id: run.id, step: current.step + 1 });
      expect(field(screen, '🎁 At Risk earned')).toBeUndefined(); expect(field(screen, '🎁 Kept this step')).toBeUndefined();
      expect(field(screen, 'Kept')).toContain('7 Essence'); expect(field(screen, 'At Risk')).toContain('501 WaifuBux');
      expect((await w.runs.run(prov.playerId, run.id)).latestAtRisk).toBeNull();
    }
    expect(await w.app.currency.getBalances(prov.playerId)).toEqual(before);
  });
});
