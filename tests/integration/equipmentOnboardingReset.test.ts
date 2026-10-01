/**
 * The staging "Reset Equipment onboarding" control: a full, audited return to
 * the start of the onboarding that touches the onboarding's own three
 * instances and nothing else, and that only exists outside production.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  playerEquipment,
  playerFeatureUnlocks,
  playerLoadoutSlots,
  playerProgressionEvents,
  players,
  species as speciesTable,
} from '../../src/db/schema';
import type { TestAdminControlsConfig } from '../../src/config/config';
import { ADMIN_ACTION_EVENT } from '../../src/modules/admin/adminActionAudit';
import { createCombatStatsService } from '../../src/modules/equipment/combatStatsService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import {
  createEquipmentOnboardingService,
  type EquipmentOnboardingService,
} from '../../src/modules/onboarding/equipmentOnboardingService';
import {
  TestControlsDisabledError,
  createStagingTestControlsService,
  type StagingTestControlsService,
} from '../../src/modules/testControls/stagingTestControlsService';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { GEAR, buildEquipmentServices, grant, starterRoll, type EquipmentServices } from '../helpers/equipmentFixtures';

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let onb: EquipmentOnboardingService;
let controls: StagingTestControlsService;
let speciesId: number;
const config: TestAdminControlsConfig = { enabled: true, deploymentEnv: 'staging' };
const actor = { discordUserId: 'staging-admin', discordGuildId: null };

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db);
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  await svc.definitions.create(GEAR.attack2);
  const combatStats = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  onb = createEquipmentOnboardingService({
    db: t.db,
    equipment: svc.equipment,
    featureUnlocks: svc.featureUnlocks,
    combatStats,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getContent: () => app.content,
    isEnabled: () => true,
  });
  controls = createStagingTestControlsService({
    db: t.db,
    currency: app.currency,
    inventory: app.inventory,
    travel: app.travel,
    progression: app.progression,
    getContent: () => app.content,
    logger: t.logger,
    config,
    equipment: svc.equipment,
    featureUnlocks: svc.featureUnlocks,
    equipmentOnboarding: onb,
  });
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

let seq = 0;
async function setup(): Promise<number> {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-rst-${seq}`, `u-rst-${seq}`);
  const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 280 });
  await t.db.update(players).set({ level: 35, buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
  return playerId;
}

async function complete(playerId: number): Promise<void> {
  for (const step of ['intro', 'attack', 'defense', 'health'] as const) await onb.advance(playerId, step);
  const done = await onb.complete(playerId);
  if (done.kind !== 'complete') throw new Error(`expected complete, got ${done.kind}`);
}

const live = (playerId: number) =>
  t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId)).then((rows) => rows.filter((r) => !r.removedAt));
const slotsOf = (playerId: number) =>
  t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, playerId));
const unlocked = (playerId: number) =>
  t.db.select().from(playerFeatureUnlocks).where(eq(playerFeatureUnlocks.playerId, playerId)).then((r) => r.length > 0);

describe('Reset Equipment onboarding', () => {
  it('returns a completed player to the start, and a replay grants fresh copies', async () => {
    const playerId = await setup();
    await complete(playerId);
    const firstCopies = (await live(playerId)).map((i) => i.id);
    expect(firstCopies).toHaveLength(3);

    const result = await controls.resetEquipmentOnboarding(actor, playerId);
    expect(result.changed).toBe(true);
    expect(result.changes.map((c) => c.field)).toEqual(['equipmentUnlocked', 'onboardingStarters', 'onboardingGrantKeys']);
    expect(result.state.equipmentOnboarding).toMatchObject({ phase: 'pending', nextStep: 'intro', unlocked: false });

    expect(await unlocked(playerId)).toBe(false);
    expect(await live(playerId)).toHaveLength(0);
    expect(await slotsOf(playerId)).toHaveLength(0);
    expect((await onb.getState(playerId)).entry).toBe('begin');

    await complete(playerId);
    const secondCopies = (await live(playerId)).map((i) => i.id);
    expect(secondCopies).toHaveLength(3);
    expect(secondCopies.some((id) => firstCopies.includes(id))).toBe(false);
    expect(await slotsOf(playerId)).toHaveLength(3);
  });

  it('leaves unrelated equipment — owned or equipped — untouched', async () => {
    const playerId = await setup();
    // Better gear in the attack slot, kept by the onboarding.
    await t.db.transaction((tx) =>
      svc.featureUnlocks.unlock(tx, { playerId, featureKey: 'equipment', source: 'admin', actorDiscordId: 'a' }),
    );
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: coil });
    const spare = await grant(t.db, svc, playerId, 'rusty_pipe', { grantKey: `spare-${playerId}`, ...starterRoll('rusty_pipe') });
    await t.db.transaction((tx) =>
      svc.featureUnlocks.revoke(tx, { playerId, featureKey: 'equipment', actorDiscordId: 'a', reason: 'test' }),
    );
    await complete(playerId);

    await controls.resetEquipmentOnboarding(actor, playerId);
    const remaining = (await live(playerId)).map((i) => i.id).sort();
    expect(remaining).toEqual([coil, spare].sort());
    const slots = await slotsOf(playerId);
    expect(slots.map((s) => [s.slot, s.equipmentId])).toEqual([['attack', coil]]);
  });

  it('resets a half-finished onboarding', async () => {
    const playerId = await setup();
    await onb.advance(playerId, 'intro');
    await onb.advance(playerId, 'attack');
    const result = await controls.resetEquipmentOnboarding(actor, playerId);
    expect(result.changes.map((c) => c.field)).toEqual(['onboardingStarters', 'onboardingGrantKeys']);
    expect((await onb.getState(playerId)).state.phase).toBe('pending');
  });

  it('is a clean no-op when there is nothing to reset', async () => {
    const playerId = await setup();
    const result = await controls.resetEquipmentOnboarding(actor, playerId);
    expect(result.changed).toBe(false);
    expect(result.message).toMatch(/nothing to reset/);
  });

  it('is audited: the control row plus each underlying admin action', async () => {
    const playerId = await setup();
    await complete(playerId);
    await controls.resetEquipmentOnboarding(actor, playerId);
    const rows = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(and(eq(playerProgressionEvents.playerId, playerId), eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT)));
    const actions = rows.map((r) => (r.metadata as { action?: string }).action);
    expect(actions).toContain('test_reset_equipment_onboarding');
    expect(actions).toContain('revoke_feature_equipment');
    expect(actions.filter((a) => a === 'remove_equipment')).toHaveLength(3);
    expect(actions).toContain('release_equipment_grant_keys');
    const control = rows.find((r) => (r.metadata as { action?: string }).action === 'test_reset_equipment_onboarding')!;
    expect(control.metadata).toMatchObject({ adminDiscordId: 'staging-admin', changed: true });
  });

  it('refuses at call time once the deployment reads as production, writing nothing', async () => {
    const playerId = await setup();
    await complete(playerId);
    config.deploymentEnv = 'production';
    try {
      await expect(controls.resetEquipmentOnboarding(actor, playerId)).rejects.toBeInstanceOf(TestControlsDisabledError);
    } finally {
      config.deploymentEnv = 'staging';
    }
    expect(await unlocked(playerId)).toBe(true);
    expect(await live(playerId)).toHaveLength(3);
  });

  it('cannot be constructed for production at all', () => {
    expect(() =>
      createStagingTestControlsService({
        db: t.db,
        currency: app.currency,
        inventory: app.inventory,
        travel: app.travel,
        progression: app.progression,
        getContent: () => app.content,
        logger: t.logger,
        config: { enabled: true, deploymentEnv: 'production' },
        equipment: svc.equipment,
        featureUnlocks: svc.featureUnlocks,
      }),
    ).toThrow(TestControlsDisabledError);
  });
});
