/**
 * Combat Trials against a real database: the unlock gate, the read models,
 * fights resolved through the real engine with stats from the real
 * `combatStatsService`, persistence and its snapshot semantics, first-clear
 * tracking and its one-time reward, and request-key idempotency (including
 * concurrent double-clicks).
 */
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { combatTrialAttempts, items, playerCurrencies, playerInventory, players, species as speciesTable } from '../../src/db/schema';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import {
  combatTrialCatalogueFromContent,
  createCombatTrialService,
  type CombatTrialService,
} from '../../src/modules/combatTrials/combatTrialService';
import { createCombatEnemyCatalogue, type CombatEnemyDefinition, CombatEnemyDefinitionSchema } from '../../src/modules/combat/enemyDefinitions';
import {
  createCombatTrialCatalogue,
  CombatTrialDefinitionSchema,
  type CombatTrialCatalogue,
  type CombatTrialDefinitionInput,
} from '../../src/modules/combat/trialDefinitions';
import {
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  CombatTrialRequestConflictError,
  CombatTrialUnavailableError,
  FeatureLockedError,
} from '../../src/shared/errors';
import { handleCombatTrialFight, handleCombatTrialView } from '../../src/discord/commands/waifumonCombatTrials';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { createTestDb, silentLogger, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { buildEquipmentServices, grant, starterRoll, unlockEquipment, type EquipmentServices } from '../helpers/equipmentFixtures';

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let stats: CombatStatsService;
let speciesId: number;

/** The catalogue the service reads; tests swap it to edit "content" live. */
let catalogue: CombatTrialCatalogue;
let trials: CombatTrialService;

const enemy = (over: Partial<CombatEnemyDefinition> & { key: string }): CombatEnemyDefinition =>
  CombatEnemyDefinitionSchema.parse({ name: over.key, attack: 1, defense: 0, hp: 10, enabled: true, ...over });
const trial = (over: Partial<CombatTrialDefinitionInput> & { key: string; enemyKey: string; order: number }) =>
  CombatTrialDefinitionSchema.parse({ name: `Trial ${over.key}`, description: 'A test.', enabled: true, ...over });

const ENEMIES = [
  enemy({ key: 'weakling', name: 'Weakling', attack: 1, defense: 0, hp: 10 }),
  enemy({ key: 'brute', name: 'Brute', attack: 100_000, defense: 0, hp: 1_000_000 }),
  // Neither side can finish the other inside the 30-round cap: a draw.
  enemy({ key: 'wall', name: 'Wall', attack: 1, defense: 1_000_000, hp: 1_000_000 }),
  enemy({ key: 'sleeper', name: 'Sleeper', enabled: false }),
];
const TRIALS = [
  trial({
    key: 't_win',
    enemyKey: 'weakling',
    order: 1,
    recommended: { attack: 10 },
    firstClearRewards: { waifubux: 50, items: [{ slug: 'sticky_joystick', quantity: 2 }] },
  }),
  trial({ key: 't_lose', enemyKey: 'brute', order: 2 }),
  trial({ key: 't_draw', enemyKey: 'wall', order: 3 }),
  trial({ key: 't_off', enemyKey: 'weakling', order: 4, enabled: false }),
  trial({ key: 't_sleeper', enemyKey: 'sleeper', order: 5 }),
];

function testCatalogue(enemies = ENEMIES, defs = TRIALS): CombatTrialCatalogue {
  return createCombatTrialCatalogue(defs, createCombatEnemyCatalogue(enemies));
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db);
  stats = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  catalogue = testCatalogue();
  trials = createCombatTrialService({
    db: t.db,
    featureUnlocks: svc.featureUnlocks,
    combatStats: stats,
    currency: app.currency,
    inventory: app.inventory,
    getCatalogue: () => catalogue,
  });
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

let seq = 0;
/**
 * A player with a level-35 Buddy (base SP 100 → Current SP 185) wearing the
 * three onboarding starters: ATK 83 · DEF 65 · HP 370.
 */
async function setup(opts: { buddy?: boolean; unlocked?: boolean; starters?: boolean } = {}) {
  seq += 1;
  catalogue = testCatalogue();
  const { playerId } = await provisionPlayer(app, `g-ct-${seq}`, `u-ct-${seq}`);
  let buddyId: number | null = null;
  if (opts.buddy !== false) {
    const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 35, baseSp: 100, nickname: 'Nebula Nurse' });
    await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
    buddyId = buddy.id;
  }
  if (opts.unlocked !== false) await unlockEquipment(t.db, svc, playerId);
  if (opts.starters !== false && opts.unlocked !== false) {
    for (const [slot, key] of [
      ['attack', 'rusty_pipe'],
      ['defense', 'scrap_plate'],
      ['health', 'dented_lunchbox'],
    ] as const) {
      const id = await grant(t.db, svc, playerId, key, starterRoll(key));
      await svc.equipment.equip(playerId, { slot, equipmentId: id });
    }
  }
  return { playerId, buddyId };
}

async function attempts(playerId: number) {
  return t.db.select().from(combatTrialAttempts).where(eq(combatTrialAttempts.playerId, playerId)).orderBy(combatTrialAttempts.id);
}

async function waifubux(playerId: number): Promise<number> {
  const [row] = await t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
  return row!.waifubux;
}

async function itemQty(playerId: number, slug: string): Promise<number> {
  const [row] = await t.db
    .select({ q: playerInventory.quantity })
    .from(playerInventory)
    .innerJoin(items, eq(items.id, playerInventory.itemId))
    .where(and(eq(playerInventory.playerId, playerId), eq(items.slug, slug)));
  return row?.q ?? 0;
}

/* ─────────────────────────── gate ─────────────────────────── */

describe('the Equipment unlock gate', () => {
  it('a locked player cannot list, open or fight a Trial', async () => {
    const { playerId } = await setup({ unlocked: false });
    expect(await trials.isAvailable(playerId)).toBe(false);
    await expect(trials.list(playerId)).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(trials.detail(playerId, 't_win')).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(trials.fight(playerId, 't_win', 'k-locked')).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await attempts(playerId)).toHaveLength(0);
  });

  it('an unlocked player lists enabled Trials in order', async () => {
    const { playerId } = await setup();
    expect(await trials.isAvailable(playerId)).toBe(true);
    const view = await trials.list(playerId);
    expect(view.trials.map((s) => s.trial.key)).toEqual(['t_win', 't_lose', 't_draw']);
    expect(view.trials[0]).toMatchObject({ enemy: { key: 'weakling' }, progress: { cleared: false, attempts: 0, latest: null } });
  });
});

/* ─────────────────────────── availability ─────────────────────────── */

describe('unavailable Trials', () => {
  it('a disabled Trial is excluded from the list and refused on open and fight', async () => {
    const { playerId } = await setup();
    expect((await trials.list(playerId)).trials.map((s) => s.trial.key)).not.toContain('t_off');
    await expect(trials.detail(playerId, 't_off')).rejects.toMatchObject({ reason: 'disabled' });
    await expect(trials.fight(playerId, 't_off', 'k-off')).rejects.toBeInstanceOf(CombatTrialUnavailableError);
  });

  it('a Trial whose enemy is disabled or missing is excluded and refused safely', async () => {
    const { playerId } = await setup();
    expect((await trials.list(playerId)).trials.map((s) => s.trial.key)).not.toContain('t_sleeper');
    await expect(trials.fight(playerId, 't_sleeper', 'k-sleep')).rejects.toMatchObject({ reason: 'enemy_disabled' });
    catalogue = testCatalogue(ENEMIES.filter((e) => e.key !== 'weakling'));
    await expect(trials.fight(playerId, 't_win', 'k-gone')).rejects.toMatchObject({ reason: 'enemy_missing' });
    await expect(trials.fight(playerId, 'no_such_trial', 'k-none')).rejects.toMatchObject({ reason: 'missing' });
    expect(await attempts(playerId)).toHaveLength(0);
  });
});

/* ─────────────────────────── stats source ─────────────────────────── */

describe('the player side', () => {
  it('detail shows the authoritative stats and no blocker', async () => {
    const { playerId, buddyId } = await setup();
    const view = await trials.detail(playerId, 't_win');
    expect(view.blocker).toBeNull();
    expect(view.stats).toEqual(await stats.calculateCombatStats(playerId));
    expect(view.stats.buddy).toMatchObject({ waifuId: buddyId, name: 'Nebula Nurse', currentSp: 185 });
    expect(view.stats.stats).toEqual({ attack: 83, defense: 65, maxHp: 370 });
  });

  it('fights with exactly what combatStatsService.snapshotCombatStats returns', async () => {
    const { playerId } = await setup();
    const spy = vi.spyOn(stats, 'snapshotCombatStats');
    const { attempt } = await trials.fight(playerId, 't_win', 'k-spy');
    expect(spy).toHaveBeenCalledTimes(1);
    const snap = await spy.mock.results[0]!.value;
    spy.mockRestore();
    expect(attempt.player).toMatchObject({ attack: snap.stats.attack, defense: snap.stats.defense, maxHp: snap.stats.maxHp });
  });

  it('no active Buddy: detail is blocked and Fight is refused without recording anything', async () => {
    const { playerId } = await setup({ buddy: false });
    const view = await trials.detail(playerId, 't_win');
    expect(view.blocker).toBe('no_buddy');
    expect(view.stats.buddy).toBeNull();
    await expect(trials.fight(playerId, 't_win', 'k-nobuddy')).rejects.toBeInstanceOf(CombatBuddyRequiredError);
    expect(await attempts(playerId)).toHaveLength(0);
  });

  it('an incomplete loadout is blocked and refused', async () => {
    const { playerId } = await setup({ starters: false });
    expect((await trials.detail(playerId, 't_win')).blocker).toBe('incomplete_loadout');
    await expect(trials.fight(playerId, 't_win', 'k-bare')).rejects.toBeInstanceOf(CombatLoadoutIncompleteError);
    expect(await attempts(playerId)).toHaveLength(0);
  });
});

/* ─────────────────────────── results ─────────────────────────── */

describe('recording results', () => {
  it('persists a player victory with both sides snapshotted', async () => {
    const { playerId, buddyId } = await setup();
    const { attempt, replayed } = await trials.fight(playerId, 't_win', 'k-v');
    expect(replayed).toBe(false);
    expect(attempt).toMatchObject({
      trialKey: 't_win',
      enemyKey: 'weakling',
      result: 'player_victory',
      endReason: 'defeat',
      rounds: 1,
      buddyWaifuId: buddyId,
      player: { name: 'Nebula Nurse', attack: 83, defense: 65, maxHp: 370, remainingHp: 370 },
      enemy: { name: 'Weakling', attack: 1, defense: 0, maxHp: 10, remainingHp: 0 },
    });
    const [row] = await attempts(playerId);
    expect(row).toMatchObject({ result: 'player_victory', requestKey: 'k-v', playerAttack: 83, enemyMaxHp: 10 });
    // The engine's own serialisable state and structured events are kept.
    expect(row!.initialState).toMatchObject({ round: 1, turn: 'player', status: 'active', player: { attack: 83 } });
    expect((row!.events as { type: string }[]).map((e) => e.type)).toContain('combat_ended');
  });

  it('persists an enemy victory', async () => {
    const { playerId } = await setup();
    const { attempt } = await trials.fight(playerId, 't_lose', 'k-l');
    expect(attempt).toMatchObject({ result: 'enemy_victory', endReason: 'defeat', firstClear: false, rewards: null });
    expect(attempt.player.remainingHp).toBe(0);
    expect((await attempts(playerId))[0]!.result).toBe('enemy_victory');
  });

  it('persists a draw at the round cap', async () => {
    const { playerId } = await setup();
    const { attempt } = await trials.fight(playerId, 't_draw', 'k-d');
    expect(attempt).toMatchObject({ result: 'draw', endReason: 'round_limit', rounds: 30, firstClear: false });
    expect((await attempts(playerId))[0]!.result).toBe('draw');
  });

  it('losses and draws never count as a clear', async () => {
    const { playerId } = await setup();
    await trials.fight(playerId, 't_lose', 'k-l2');
    await trials.fight(playerId, 't_draw', 'k-d2');
    const view = await trials.list(playerId);
    const byKey = Object.fromEntries(view.trials.map((s) => [s.trial.key, s.progress]));
    expect(byKey.t_lose).toMatchObject({ cleared: false, attempts: 1, latest: { result: 'enemy_victory' } });
    expect(byKey.t_draw).toMatchObject({ cleared: false, attempts: 1, latest: { result: 'draw' } });
  });
});

/* ─────────────────────────── first clear & rewards ─────────────────────────── */

describe('first clear', () => {
  it('marks the first victory, pays the reward once, and shows Cleared', async () => {
    const { playerId } = await setup();
    const bux = await waifubux(playerId);
    const { attempt } = await trials.fight(playerId, 't_win', 'k-fc1');
    expect(attempt.firstClear).toBe(true);
    expect(attempt.rewards).toEqual({ waifubux: 50, items: [{ slug: 'sticky_joystick', quantity: 2 }] });
    expect(await waifubux(playerId)).toBe(bux + 50);
    expect(await itemQty(playerId, 'sticky_joystick')).toBe(2);

    const progress = (await trials.detail(playerId, 't_win')).progress;
    expect(progress).toMatchObject({ cleared: true, attempts: 1, latest: { result: 'player_victory' } });
    expect(progress.firstClearedAt).toEqual(attempt.completedAt);
  });

  it('a repeat clear does not recreate first-clear state or pay again', async () => {
    const { playerId } = await setup();
    const first = await trials.fight(playerId, 't_win', 'k-r1');
    const bux = await waifubux(playerId);
    const again = await trials.fight(playerId, 't_win', 'k-r2');
    expect(again.replayed).toBe(false);
    expect(again.attempt).toMatchObject({ result: 'player_victory', firstClear: false, rewards: null });
    expect(await waifubux(playerId)).toBe(bux);
    expect(await itemQty(playerId, 'sticky_joystick')).toBe(2);
    const rows = await attempts(playerId);
    expect(rows.filter((r) => r.firstClear).map((r) => r.id)).toEqual([first.attempt.id]);
    const progress = (await trials.detail(playerId, 't_win')).progress;
    expect(progress).toMatchObject({ cleared: true, attempts: 2 });
    expect(progress.firstClearedAt).toEqual(first.attempt.completedAt);
  });

  it('a first clear after earlier losses is still the first clear', async () => {
    const { playerId } = await setup();
    catalogue = testCatalogue(ENEMIES.map((e) => (e.key === 'weakling' ? { ...e, attack: 100_000, hp: 1_000_000 } : e)));
    expect((await trials.fight(playerId, 't_win', 'k-x1')).attempt.result).toBe('enemy_victory');
    catalogue = testCatalogue();
    expect((await trials.fight(playerId, 't_win', 'k-x2')).attempt.firstClear).toBe(true);
  });
});

/* ─────────────────────────── idempotency ─────────────────────────── */

describe('request-key idempotency', () => {
  it('a retried request returns the same attempt and pays nothing more', async () => {
    const { playerId } = await setup();
    const first = await trials.fight(playerId, 't_win', 'k-same');
    const bux = await waifubux(playerId);
    const retry = await trials.fight(playerId, 't_win', 'k-same');
    expect(retry.replayed).toBe(true);
    expect(retry.attempt).toEqual(first.attempt);
    expect(await attempts(playerId)).toHaveLength(1);
    expect(await waifubux(playerId)).toBe(bux);
  });

  it('concurrent double-clicks create one attempt and one reward', async () => {
    const { playerId } = await setup();
    const bux = await waifubux(playerId);
    const results = await Promise.all(Array.from({ length: 5 }, () => trials.fight(playerId, 't_win', 'k-race')));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.attempt.id)).size).toBe(1);
    expect(await attempts(playerId)).toHaveLength(1);
    expect(await waifubux(playerId)).toBe(bux + 50);
    expect(await itemQty(playerId, 'sticky_joystick')).toBe(2);
  });

  it('concurrent first clears under different keys pay exactly once', async () => {
    const { playerId } = await setup();
    const bux = await waifubux(playerId);
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((k) => trials.fight(playerId, 't_win', `k-par-${k}`)));
    expect(results.filter((r) => r.attempt.firstClear)).toHaveLength(1);
    expect(await attempts(playerId)).toHaveLength(4);
    expect(await waifubux(playerId)).toBe(bux + 50);
  });

  it('a key already used for another Trial is refused, leaving the original intact', async () => {
    const { playerId } = await setup();
    await trials.fight(playerId, 't_lose', 'k-cross');
    await expect(trials.fight(playerId, 't_win', 'k-cross')).rejects.toBeInstanceOf(CombatTrialRequestConflictError);
    const rows = await attempts(playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trialKey).toBe('t_lose');
  });

  it('keys are per player: another player may use the same key', async () => {
    const a = await setup();
    const b = await setup();
    await trials.fight(a.playerId, 't_win', 'k-shared');
    const other = await trials.fight(b.playerId, 't_win', 'k-shared');
    expect(other.replayed).toBe(false);
  });

  it('a failed fight records nothing, so the same key works once the problem is fixed', async () => {
    const { playerId, buddyId } = await setup();
    await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
    await expect(trials.fight(playerId, 't_win', 'k-fix')).rejects.toBeInstanceOf(CombatBuddyRequiredError);
    await t.db.update(players).set({ buddyWaifuId: buddyId }).where(eq(players.id, playerId));
    expect((await trials.fight(playerId, 't_win', 'k-fix')).replayed).toBe(false);
  });
});

/* ─────────────────────────── snapshots ─────────────────────────── */

describe('history is a snapshot', () => {
  it('stores the starting stats of both sides', async () => {
    const { playerId } = await setup();
    await trials.fight(playerId, 't_lose', 'k-snap');
    const [row] = await attempts(playerId);
    expect(row).toMatchObject({
      playerAttack: 83,
      playerDefense: 65,
      playerMaxHp: 370,
      enemyName: 'Brute',
      enemyAttack: 100_000,
      enemyDefense: 0,
      enemyMaxHp: 1_000_000,
      trialKey: 't_lose',
      enemyKey: 'brute',
    });
  });

  it('a content edit after the attempt does not rewrite the stored result', async () => {
    const { playerId } = await setup();
    const before = await trials.fight(playerId, 't_win', 'k-edit');
    catalogue = testCatalogue(
      ENEMIES.map((e) => (e.key === 'weakling' ? { ...e, name: 'Renamed', attack: 999, defense: 999, hp: 9_999 } : e)),
    );
    const replay = await trials.fight(playerId, 't_win', 'k-edit');
    expect(replay.replayed).toBe(true);
    expect(replay.attempt).toEqual(before.attempt);
    expect(replay.attempt.enemy).toEqual({
      name: 'Weakling',
      attack: 1,
      defense: 0,
      maxHp: 10,
      remainingHp: 0,
      // Enemies carry no combat modifiers.
      modifiers: { critChanceBp: 0, critDamageBonusBp: 0, doubleAttackChanceBp: 0, armorPenetrationBp: 0, lifestealBp: 0 },
    });
    expect((await trials.list(playerId)).trials[0]!.progress.cleared).toBe(true);
  });

  it('a Buddy change after the attempt does not rewrite the stored player side', async () => {
    const { playerId } = await setup();
    const before = await trials.fight(playerId, 't_win', 'k-swap');
    const other = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 50, baseSp: 190, nickname: 'Other' });
    await t.db.update(players).set({ buddyWaifuId: other.id }).where(eq(players.id, playerId));
    const replay = await trials.fight(playerId, 't_win', 'k-swap');
    expect(replay.attempt.player).toEqual(before.attempt.player);
  });
});

/* ─────────────────────────── shipped content ─────────────────────────── */

describe('shipped Trials', () => {
  it('a starter-geared Level 35 Buddy clears Trial 1 and is paid its first-clear reward', async () => {
    const { playerId } = await setup();
    catalogue = combatTrialCatalogueFromContent(app.content);
    expect(catalogue.available().map((a) => a.trial.key)).toEqual([
      'trial_scrapyard_drone',
      'trial_alley_bruiser',
      'trial_security_automaton',
    ]);
    const bux = await waifubux(playerId);
    const { attempt } = await trials.fight(playerId, 'trial_scrapyard_drone', 'k-ship');
    expect(attempt).toMatchObject({ result: 'player_victory', firstClear: true });
    const reward = catalogue.get('trial_scrapyard_drone')!.firstClearRewards!;
    expect(await waifubux(playerId)).toBe(bux + reward.waifubux);
    const [row] = await t.db.select({ n: count() }).from(combatTrialAttempts).where(eq(combatTrialAttempts.playerId, playerId));
    expect(row!.n).toBe(1);
  });
});

/* ─────────────────────────── through Discord ─────────────────────────── */

describe('through the Discord handlers', () => {
  function click() {
    const painted: { content?: string; components?: { toJSON(): unknown }[] }[] = [];
    const paint = vi.fn(async (body: unknown) => {
      painted.push(body as (typeof painted)[number]);
    });
    const i = { replied: false, deferred: false, isButton: () => true, update: paint, reply: paint, editReply: paint, followUp: paint };
    return { i: i as never, last: () => painted[painted.length - 1]! };
  }
  const fightId = (p: { components?: { toJSON(): unknown }[] }) =>
    (p.components ?? [])
      .flatMap((r) => (r.toJSON() as { components: { custom_id?: string }[] }).components)
      .map((c) => c.custom_id ?? '')
      .find((id) => id.startsWith('wm|v1|ct|fight|'))!;

  it('a double-clicked Fight button creates one attempt and pays once', async () => {
    const { playerId } = await setup();
    const ctx = {
      config: { assetsDir: './assets' },
      logger: silentLogger(),
      content: app.content,
      services: { combatTrials: trials, collection: app.collection },
    } as unknown as AppContext;
    const prov = { playerId, guildDbId: 1 } as Provisioned;

    const view = click();
    await handleCombatTrialView(ctx, view.i, prov, ['t_win']);
    const args = fightId(view.last()).split('|').slice(4);
    const bux = await waifubux(playerId);

    const clicks = [click(), click(), click()];
    await Promise.all(clicks.map((c) => handleCombatTrialFight(ctx, c.i, prov, args)));
    expect(await attempts(playerId)).toHaveLength(1);
    expect(await waifubux(playerId)).toBe(bux + 50);
    expect(clicks.filter((c) => c.last().content?.includes('already resolved'))).toHaveLength(2);

    // Fight Again carries a fresh nonce: a genuine second fight.
    const again = click();
    await handleCombatTrialFight(ctx, again.i, prov, fightId(clicks[0]!.last()).split('|').slice(4));
    expect(await attempts(playerId)).toHaveLength(2);
    expect(await waifubux(playerId)).toBe(bux + 50);
  });
});
