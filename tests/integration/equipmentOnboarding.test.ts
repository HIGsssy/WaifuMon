/**
 * The Equipment onboarding against a real database: the whole lifecycle, and
 * every way it can be retried, raced, abandoned, interrupted or found in an
 * odd state.
 *
 * The properties under test:
 *  - each starter is granted at most once per player, whatever happens;
 *  - completion is atomic — unlock and equip commit together or not at all,
 *    and nothing is unlocked or equipped without a Buddy;
 *  - an occupied slot is never overwritten;
 *  - progress is recovered from the database alone (fresh service instance);
 *  - stats always come from the combat-stat service, which needs no unlock.
 */
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  equipmentEvents,
  playerEquipment,
  playerFeatureUnlocks,
  playerLoadoutSlots,
  playerLoadouts,
  playerWaifus,
  players,
  species as speciesTable,
} from '../../src/db/schema';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import { deriveStat } from '../../src/modules/equipment/equipmentMath';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import {
  createEquipmentOnboardingService,
  type EquipmentOnboardingService,
  type EquipmentOnboardingView,
} from '../../src/modules/onboarding/equipmentOnboardingService';
import { equipmentOnboardingLevelLabels } from '../../src/modules/onboarding/onboardingState';
import { EQUIPMENT_ONBOARDING_SOURCE_REF, onboardingGrantKey } from '../../src/modules/onboarding/vocabulary';
import { createProgressionService } from '../../src/modules/progression/progressionService';
import { FeatureLockedError } from '../../src/shared/errors';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import {
  GEAR,
  buildEquipmentServices,
  grant,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let combat: CombatStatsService;
let speciesId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db);
  combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
  });
  // The shipped seed, exactly as startup applies it.
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  await svc.definitions.create(GEAR.attack2); // Plasma Coil Ring ×0.86 — "better gear"
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

function onboarding(opts: { enabled?: boolean; db?: TestDb['db']; content?: App['content'] } = {}): EquipmentOnboardingService {
  const db = opts.db ?? t.db;
  const services = opts.db ? buildEquipmentServices(db) : svc;
  return createEquipmentOnboardingService({
    db,
    equipment: services.equipment,
    featureUnlocks: services.featureUnlocks,
    combatStats: opts.db
      ? createCombatStatsService({
          db,
          resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
          getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
        })
      : combat,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getContent: () => opts.content ?? app.content,
    isEnabled: () => opts.enabled ?? true,
  });
}

let seq = 0;
/** A level-35 player with a Buddy at 280 Current SP (Base 280 at level 1). */
async function setup(opts: { level?: number; buddy?: boolean } = {}) {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-onb-${seq}`, `u-onb-${seq}`);
  await t.db.update(players).set({ level: opts.level ?? 35 }).where(eq(players.id, playerId));
  let buddyId: number | null = null;
  if (opts.buddy !== false) {
    const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 280, nickname: 'Warband Princess' });
    buddyId = buddy.id;
    await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
  }
  return { playerId, buddyId };
}

async function setBuddy(playerId: number, waifuId: number | null): Promise<void> {
  await t.db.update(players).set({ buddyWaifuId: waifuId }).where(eq(players.id, playerId));
}

async function setLevel(playerId: number, level: number): Promise<void> {
  await t.db.update(players).set({ level }).where(eq(players.id, playerId));
}

async function instancesOf(playerId: number) {
  return t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
}

async function unlockRows(playerId: number) {
  return t.db.select().from(playerFeatureUnlocks).where(eq(playerFeatureUnlocks.playerId, playerId));
}

async function loadoutCount(playerId: number): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(playerLoadouts).where(eq(playerLoadouts.playerId, playerId));
  return row!.n;
}

/** Slot → equipped instance id, for the active loadout. */
async function equippedSlots(playerId: number): Promise<Record<string, number>> {
  const rows = await t.db
    .select({ slot: playerLoadoutSlots.slot, equipmentId: playerLoadoutSlots.equipmentId })
    .from(playerLoadoutSlots)
    .innerJoin(playerLoadouts, eq(playerLoadouts.id, playerLoadoutSlots.loadoutId))
    .where(and(eq(playerLoadoutSlots.playerId, playerId), eq(playerLoadouts.isActive, true)));
  return Object.fromEntries(rows.map((r) => [r.slot, r.equipmentId]));
}

async function onboardingEquipEvents(playerId: number) {
  const rows = await t.db
    .select()
    .from(equipmentEvents)
    .where(and(eq(equipmentEvents.playerId, playerId), eq(equipmentEvents.kind, 'equipped')));
  return rows.filter((r) => (r.metadata as { reason?: string }).reason === 'onboarding');
}

/** Hand-over steps only — up to (not including) the completion. */
async function walkToExplain(onb: EquipmentOnboardingService, playerId: number): Promise<EquipmentOnboardingView> {
  await onb.advance(playerId, 'intro');
  await onb.advance(playerId, 'attack');
  await onb.advance(playerId, 'defense');
  return onb.advance(playerId, 'health');
}

/* ─────────────────────────── lifecycle ─────────────────────────── */

describe('full lifecycle', () => {
  it('walks intro → three hand-overs → explain → complete, granting, equipping and unlocking', async () => {
    const onb = onboarding();
    const { playerId } = await setup();

    expect((await onb.getState(playerId)).entry).toBe('begin');
    expect(await onb.open(playerId)).toEqual({ kind: 'intro' });
    expect(await instancesOf(playerId)).toHaveLength(0); // opening writes nothing

    const afterIntro = await onb.advance(playerId, 'intro');
    expect(afterIntro).toMatchObject({ kind: 'handover', step: 'attack', item: { definition: { key: 'rusty_pipe' } } });
    expect(await instancesOf(playerId)).toHaveLength(0); // hearing Patch out writes nothing

    expect(await onb.advance(playerId, 'attack')).toMatchObject({ kind: 'handover', step: 'defense' });
    expect((await onb.getState(playerId)).entry).toBe('resume');
    expect(await onb.advance(playerId, 'defense')).toMatchObject({ kind: 'handover', step: 'health' });

    const explain = await onb.advance(playerId, 'health');
    expect(explain.kind).toBe('explain');
    if (explain.kind !== 'explain') throw new Error('unreachable');
    // Real Buddy, real Current SP, previewed with slot overrides before any unlock.
    expect(explain.stats.buddy).toMatchObject({ name: 'Warband Princess', currentSp: 280 });
    expect(explain.stats.stats).toEqual({ attack: 126, defense: 98, maxHp: 560 });
    expect(await unlockRows(playerId)).toHaveLength(0);
    expect(await loadoutCount(playerId)).toBe(0); // the preview wrote nothing

    const done = await onb.advance(playerId, 'explain');
    expect(done.kind).toBe('complete');
    if (done.kind !== 'complete') throw new Error('unreachable');
    expect(done.report?.equipped.map((e) => e.slot)).toEqual(['attack', 'defense', 'health']);
    expect(done.stats.stats).toEqual({ attack: 126, defense: 98, maxHp: 560 });
    expect(done.stats).toEqual(await combat.calculateCombatStats(playerId));

    const instances = await instancesOf(playerId);
    expect(instances).toHaveLength(3);
    expect(instances.every((i) => i.sourceType === 'onboarding' && i.sourceKey === 'equipment')).toBe(true);
    expect(instances.map((i) => i.grantKey).sort()).toEqual(
      (['attack', 'defense', 'health'] as const).map((s) => `${onboardingGrantKey(playerId, s)}:0`).sort(),
    );
    const [unlock] = await unlockRows(playerId);
    expect(unlock).toMatchObject({ featureKey: 'equipment', source: 'onboarding', sourceRef: EQUIPMENT_ONBOARDING_SOURCE_REF });
    const slots = await equippedSlots(playerId);
    expect(Object.keys(slots).sort()).toEqual(['attack', 'defense', 'health']);
    expect(await onboardingEquipEvents(playerId)).toHaveLength(3);

    const after = await onb.getState(playerId);
    expect(after.state.phase).toBe('completed');
    expect(after.entry).toBe('available');
    expect(await onb.overview(playerId)).toMatchObject({ kind: 'overview', stats: { stats: { attack: 126 } } });
  });

  it('a completed player re-opening or replaying gets the overview, and nothing changes', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await walkToExplain(onb, playerId);
    await onb.complete(playerId);
    const before = await instancesOf(playerId);

    expect((await onb.open(playerId)).kind).toBe('overview');
    expect((await onb.advance(playerId, 'attack')).kind).toBe('overview');
    const again = await onb.complete(playerId);
    expect(again).toMatchObject({ kind: 'complete', report: null });
    expect(await instancesOf(playerId)).toEqual(before);
    expect(await onboardingEquipEvents(playerId)).toHaveLength(3);
  });
});

/* ─────────────────────────── eligibility ─────────────────────────── */

describe('eligibility', () => {
  it('level 34 is not offered and every entry point writes nothing', async () => {
    const onb = onboarding();
    const { playerId } = await setup({ level: 34 });
    const snapshot = await onb.getState(playerId);
    expect(snapshot.state.phase).toBe('not_eligible');
    expect(snapshot.entry).toBe('hidden');
    expect(await onb.open(playerId)).toEqual({ kind: 'unavailable', reason: 'not_eligible' });
    expect(await onb.advance(playerId, 'intro')).toEqual({ kind: 'unavailable', reason: 'not_eligible' });
    expect(await onb.advance(playerId, 'attack')).toEqual({ kind: 'unavailable', reason: 'not_eligible' });
    expect(await onb.complete(playerId)).toEqual({ kind: 'unavailable', reason: 'not_eligible' });
    expect(await onb.overview(playerId)).toEqual({ kind: 'unavailable', reason: 'not_eligible' });
    expect(await instancesOf(playerId)).toHaveLength(0);
    expect(await unlockRows(playerId)).toHaveLength(0);
  });

  it('an existing high-level player is offered with no backfill', async () => {
    const { playerId } = await setup({ level: 80 });
    expect((await onboarding().getState(playerId)).entry).toBe('begin');
  });

  it('lowering the level after the onboarding started does not hide or reset it', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await onb.advance(playerId, 'intro');
    await onb.advance(playerId, 'attack');
    await setLevel(playerId, 10);
    const snapshot = await onb.getState(playerId);
    expect(snapshot.state).toMatchObject({ phase: 'in_progress', nextStep: 'defense' });
    expect(snapshot.entry).toBe('resume');
    expect(await onb.open(playerId)).toMatchObject({ kind: 'handover', step: 'defense' });
  });

  it('an admin-created unlock counts as completed: no onboarding, no grants', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await t.db.transaction((tx) =>
      svc.featureUnlocks.unlock(tx, {
        playerId,
        featureKey: 'equipment',
        source: 'admin',
        actorDiscordId: 'admin-1',
      }),
    );
    expect((await onb.getState(playerId)).state.phase).toBe('completed');
    expect((await onb.open(playerId)).kind).toBe('overview');
    expect((await onb.advance(playerId, 'attack')).kind).toBe('overview');
    expect(await instancesOf(playerId)).toHaveLength(0);
  });
});

/* ─────────────────────────── idempotency and races ─────────────────────────── */

describe('retries and races', () => {
  it('concurrent presses of the same step grant one instance', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await onb.advance(playerId, 'intro');
    await Promise.all(Array.from({ length: 6 }, () => onb.advance(playerId, 'attack')));
    const instances = await instancesOf(playerId);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.slot).toBe('attack');
  });

  it('a stale earlier button repaints the current step and writes nothing', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await onb.advance(playerId, 'intro');
    await onb.advance(playerId, 'attack');
    expect(await onb.advance(playerId, 'attack')).toMatchObject({ kind: 'handover', step: 'defense' });
    expect(await onb.advance(playerId, 'intro')).toMatchObject({ kind: 'handover', step: 'defense' });
    // A forged later step cannot skip ahead.
    expect(await onb.advance(playerId, 'health')).toMatchObject({ kind: 'handover', step: 'defense' });
    expect(await onb.complete(playerId)).toMatchObject({ kind: 'handover', step: 'defense' });
    expect(await instancesOf(playerId)).toHaveLength(1);
    expect(await unlockRows(playerId)).toHaveLength(0);
  });

  it('concurrent completions unlock once and equip each slot once', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await walkToExplain(onb, playerId);
    const results = await Promise.all(Array.from({ length: 5 }, () => onb.complete(playerId)));
    expect(results.every((r) => r.kind === 'complete')).toBe(true);
    expect(await unlockRows(playerId)).toHaveLength(1);
    expect(await instancesOf(playerId)).toHaveLength(3);
    expect(Object.keys(await equippedSlots(playerId)).sort()).toEqual(['attack', 'defense', 'health']);
    expect(await onboardingEquipEvents(playerId)).toHaveLength(3);
  });

  it('an abandoned flow resumes from the database with a fresh service instance', async () => {
    const first = onboarding();
    const { playerId } = await setup();
    await first.advance(playerId, 'intro');
    await first.advance(playerId, 'attack');
    await first.advance(playerId, 'defense');

    const restarted = onboarding(); // a new process, same database
    expect((await restarted.getState(playerId)).state).toMatchObject({ phase: 'in_progress', nextStep: 'health' });
    expect(await restarted.open(playerId)).toMatchObject({ kind: 'handover', step: 'health' });
    await restarted.advance(playerId, 'health');
    expect((await restarted.complete(playerId)).kind).toBe('complete');
    expect(await instancesOf(playerId)).toHaveLength(3);
  });
});

/* ─────────────────────────── existing gear ─────────────────────────── */

describe('existing gear', () => {
  it('a player who already owns a starter gets the onboarding copy too, and that copy is equipped', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    const adminPipe = await grant(t.db, svc, playerId, 'rusty_pipe', { grantKey: `admin-pipe-${playerId}` });
    await walkToExplain(onb, playerId);
    await onb.complete(playerId);

    const pipes = (await instancesOf(playerId)).filter((i) => i.slot === 'attack');
    expect(pipes).toHaveLength(2);
    const onboardingPipe = pipes.find((p) => p.sourceType === 'onboarding')!;
    expect((await equippedSlots(playerId)).attack).toBe(onboardingPipe.id);
    expect((await equippedSlots(playerId)).attack).not.toBe(adminPipe);
  });

  it('never overwrites an occupied slot, even with weaker gear', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    // Unlocked once, equipped something better, then the unlock was revoked.
    await t.db.transaction((tx) =>
      svc.featureUnlocks.unlock(tx, { playerId, featureKey: 'equipment', source: 'admin', actorDiscordId: 'admin-1' }),
    );
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: coil });
    await t.db.transaction((tx) =>
      svc.featureUnlocks.revoke(tx, { playerId, featureKey: 'equipment', actorDiscordId: 'admin-1', reason: 'test' }),
    );

    await walkToExplain(onb, playerId);
    const done = await onb.complete(playerId);
    if (done.kind !== 'complete') throw new Error(`expected complete, got ${done.kind}`);
    expect(done.report?.kept).toEqual([{ slot: 'attack', equipmentId: coil }]);
    expect(done.report?.equipped.map((e) => e.slot)).toEqual(['defense', 'health']);
    const slots = await equippedSlots(playerId);
    expect(slots.attack).toBe(coil);
    expect(done.stats.loadout.slots.attack?.definitionKey).toBe('plasma_coil_ring');
  });

  it('a removed onboarding starter counts as granted but is not equipped', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await onb.advance(playerId, 'intro');
    await onb.advance(playerId, 'attack');
    const [pipe] = await instancesOf(playerId);
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId, equipmentId: pipe!.id, reason: 'test', actorDiscordId: 'admin-1' }),
    );
    expect((await onb.getState(playerId)).state).toMatchObject({ phase: 'in_progress', nextStep: 'defense' });
    await onb.advance(playerId, 'defense');
    await onb.advance(playerId, 'health');

    const done = await onb.complete(playerId);
    if (done.kind !== 'complete') throw new Error(`expected complete, got ${done.kind}`);
    expect(done.report?.equipped.map((e) => e.slot)).toEqual(['defense', 'health']);
    expect((await equippedSlots(playerId)).attack).toBeUndefined();
    // Not re-granted: the key still names the removed copy.
    expect((await instancesOf(playerId)).filter((i) => i.slot === 'attack')).toHaveLength(1);
  });
});

/* ─────────────────────────── definitions ─────────────────────────── */

describe('starter definitions', () => {
  it('a disabled starter is still granted by the onboarding', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await svc.definitions.setEnabled('scrap_plate', false);
    try {
      await onb.advance(playerId, 'intro');
      await onb.advance(playerId, 'attack');
      expect(await onb.advance(playerId, 'defense')).toMatchObject({ kind: 'handover', step: 'health' });
      expect((await instancesOf(playerId)).some((i) => i.slot === 'defense')).toBe(true);
    } finally {
      await svc.definitions.setEnabled('scrap_plate', true);
    }
  });

  it('a missing starter definition makes the onboarding not ready, and nothing is offered', async () => {
    const empty = await createTestDb(); // no starters seeded
    try {
      const onb = onboarding({ db: empty.db });
      const [guild] = await empty.pool.query(`insert into guilds (discord_guild_id) values ('g-empty') returning id`).then((r) => r.rows);
      const [player] = await empty.pool
        .query(`insert into players (guild_id, discord_user_id, level) values ($1, 'u-empty', 50) returning id`, [guild.id])
        .then((r) => r.rows);
      const readiness = await onb.isReady();
      expect(readiness.ready).toBe(false);
      expect(readiness.missingDefinitions.sort()).toEqual(['dented_lunchbox', 'rusty_pipe', 'scrap_plate']);
      const snapshot = await onb.getState(Number(player.id));
      expect(snapshot.state.phase).toBe('eligible_unavailable');
      expect(snapshot.entry).toBe('hidden');
      expect(await onb.open(Number(player.id))).toEqual({ kind: 'unavailable', reason: 'not_ready' });
    } finally {
      await empty.cleanup();
    }
  });

  it('missing narrative content makes the onboarding not ready', async () => {
    const onb = onboarding({ content: { ...app.content, onboarding: { equipment: null } } });
    const { playerId } = await setup();
    expect((await onb.isReady()).contentMissing).toBe(true);
    expect((await onb.getState(playerId)).entry).toBe('hidden');
  });
});

/* ─────────────────────────── the Buddy ─────────────────────────── */

describe('the Buddy requirement', () => {
  it('with no Buddy, the explanation prompts for one and completion neither unlocks nor equips', async () => {
    const onb = onboarding();
    const { playerId } = await setup({ buddy: false });
    expect(await walkToExplain(onb, playerId)).toEqual({ kind: 'needs_buddy' });
    expect(await onb.complete(playerId)).toEqual({ kind: 'needs_buddy' });
    expect(await unlockRows(playerId)).toHaveLength(0);
    expect(await loadoutCount(playerId)).toBe(0);
    expect(await instancesOf(playerId)).toHaveLength(3); // the hand-overs stand
    expect((await onb.getState(playerId)).state).toMatchObject({ phase: 'in_progress', nextStep: 'explain' });

    const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 200 });
    await setBuddy(playerId, buddy.id);
    expect((await onb.open(playerId)).kind).toBe('explain');
    expect((await onb.complete(playerId)).kind).toBe('complete');
    expect(await unlockRows(playerId)).toHaveLength(1);
  });

  it('a Buddy swapped before completion is the one the final stats use', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    const explain = await walkToExplain(onb, playerId);
    expect(explain).toMatchObject({ kind: 'explain', stats: { buddy: { currentSp: 280 } } });

    // Base 150 at level 21 → Current SP 225.
    const other = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 21, baseSp: 150, nickname: 'Champ' });
    await setBuddy(playerId, other.id);
    expect(await onb.open(playerId)).toMatchObject({ kind: 'explain', stats: { buddy: { waifuId: other.id } } });

    const done = await onb.complete(playerId);
    if (done.kind !== 'complete') throw new Error(`expected complete, got ${done.kind}`);
    const sp = done.stats.buddy!.currentSp;
    expect(done.stats.buddy!.waifuId).toBe(other.id);
    expect(sp).not.toBe(280);
    expect(done.stats.stats).toEqual({
      attack: deriveStat(sp, 4500),
      defense: deriveStat(sp, 3500),
      maxHp: deriveStat(sp, 20000),
    });
  });

  it('a released Buddy blocks completion', async () => {
    const onb = onboarding();
    const { playerId, buddyId } = await setup();
    await walkToExplain(onb, playerId);
    await t.db.update(playerWaifus).set({ releasedAt: new Date() }).where(eq(playerWaifus.id, buddyId!));
    expect(await onb.complete(playerId)).toEqual({ kind: 'needs_buddy' });
    expect(await unlockRows(playerId)).toHaveLength(0);
    expect(await loadoutCount(playerId)).toBe(0);
  });
});

/* ─────────────────────────── policy boundaries ─────────────────────────── */

describe('policy boundaries', () => {
  it('combat stats preview with slot overrides before the unlock, and write nothing', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await walkToExplain(onb, playerId);
    const ids = Object.fromEntries((await instancesOf(playerId)).map((i) => [i.slot, i.id]));
    expect(await svc.featureUnlocks.isUnlocked(playerId, 'equipment')).toBe(false);
    const preview = await combat.calculateCombatStats(playerId, { slotOverrides: ids });
    expect(preview.isComplete).toBe(true);
    expect(preview.stats).toEqual({ attack: 126, defense: 98, maxHp: 560 });
    expect(await loadoutCount(playerId)).toBe(0);
  });

  it('normal grants never equip, before or after the onboarding', async () => {
    const onb = onboarding();
    const { playerId } = await setup();
    await grant(t.db, svc, playerId, 'plasma_coil_ring');
    expect(await loadoutCount(playerId)).toBe(0);
    await walkToExplain(onb, playerId);
    await onb.complete(playerId);
    const before = await equippedSlots(playerId);
    await grant(t.db, svc, playerId, 'plasma_coil_ring');
    expect(await equippedSlots(playerId)).toEqual(before);
  });

  it('equipForOnboarding refuses without the unlock and skips non-onboarding gear', async () => {
    const { playerId } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await expect(
      t.db.transaction((tx) => svc.equipment.equipForOnboarding(tx, playerId, { attack: coil })),
    ).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await loadoutCount(playerId)).toBe(0);

    await t.db.transaction((tx) =>
      svc.featureUnlocks.unlock(tx, { playerId, featureKey: 'equipment', source: 'admin', actorDiscordId: 'admin-1' }),
    );
    const report = await t.db.transaction((tx) => svc.equipment.equipForOnboarding(tx, playerId, { attack: coil }));
    expect(report.skipped).toEqual([{ slot: 'attack', equipmentId: coil, reason: 'not_onboarding' }]);
    expect(await equippedSlots(playerId)).toEqual({});
  });
});

/* ─────────────────────────── the switch ─────────────────────────── */

describe('EQUIPMENT_ONBOARDING_ENABLED off', () => {
  it('offers nothing and writes nothing', async () => {
    const off = onboarding({ enabled: false });
    const { playerId } = await setup();
    const snapshot = await off.getState(playerId);
    expect(snapshot.state.phase).toBe('eligible_unavailable');
    expect(snapshot.entry).toBe('hidden');
    for (const view of [await off.open(playerId), await off.advance(playerId, 'intro'), await off.complete(playerId)]) {
      expect(view).toEqual({ kind: 'unavailable', reason: 'disabled' });
    }
    expect(await instancesOf(playerId)).toHaveLength(0);
  });

  it('pauses an in-progress onboarding without losing it', async () => {
    const { playerId } = await setup();
    await onboarding().advance(playerId, 'intro');
    await onboarding().advance(playerId, 'attack');
    const off = onboarding({ enabled: false });
    expect((await off.getState(playerId)).entry).toBe('hidden');
    expect(await off.advance(playerId, 'defense')).toEqual({ kind: 'unavailable', reason: 'disabled' });
    expect(await instancesOf(playerId)).toHaveLength(1);
    expect(await onboarding().open(playerId)).toMatchObject({ kind: 'handover', step: 'defense' });
  });

  it('keeps the unlock, the gear and the overview for a completed player', async () => {
    const { playerId } = await setup();
    const on = onboarding();
    await walkToExplain(on, playerId);
    await on.complete(playerId);
    const off = onboarding({ enabled: false });
    expect((await off.getState(playerId)).entry).toBe('available');
    expect(await off.overview(playerId)).toMatchObject({ kind: 'overview', stats: { stats: { attack: 126 } } });
    expect(await off.open(playerId)).toMatchObject({ kind: 'overview' });
    expect(await unlockRows(playerId)).toHaveLength(1);
    expect(Object.keys(await equippedSlots(playerId))).toHaveLength(3);
  });
});

/* ─────────────────────────── level-up label ─────────────────────────── */

describe('the level-35 label', () => {
  it('rides on the real level-up event when XP crosses 35, and only then', async () => {
    const label = app.content.onboarding!.equipment!.levelUpLabel;
    const progression = createProgressionService({
      config: app.content.tables.progression,
      baseMaxEnergy: app.content.tables.energy.baseMax,
      extraLevelRewardLabels: (level) => equipmentOnboardingLevelLabels(level, { enabled: true, label }),
    });
    const { playerId } = await setup({ level: 1 });
    const xpTo = async (level: number) => {
      const [row] = await t.db.select({ xp: players.xp }).from(players).where(eq(players.id, playerId));
      return progression.cumulativeXpForLevel(level) - row!.xp;
    };
    const to34 = await t.db.transaction(async (tx) =>
      progression.grantXp(tx, playerId, { eventType: 'test', xpDelta: await xpTo(34) }),
    );
    expect(to34.levelUps.flatMap((l) => l.rewardLabels)).not.toContain(label);
    const to36 = await t.db.transaction(async (tx) =>
      progression.grantXp(tx, playerId, { eventType: 'test', xpDelta: await xpTo(36) }),
    );
    expect(to36.levelUps.find((l) => l.toLevel === 35)?.rewardLabels).toContain(label);
    expect(to36.levelUps.find((l) => l.toLevel === 36)?.rewardLabels).not.toContain(label);
    // A label only: reaching 35 changes no equipment state.
    expect(await instancesOf(playerId)).toHaveLength(0);
    expect(await unlockRows(playerId)).toHaveLength(0);
  });
});
