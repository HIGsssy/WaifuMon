/**
 * Equipment 3.0, phase E3-C: delayed rewards pin the roll configuration when
 * they *promise* gear, and pay it under that pin — against PostgreSQL, through
 * the real dungeon run and expedition lifecycles.
 *
 *  - **Dungeons** pin at run start, in the frozen dependency snapshot, beside
 *    the enemies and reward tables the run already freezes.
 *  - **Expeditions** pin at deploy, beside the snapshotted equipment pools,
 *    and keep it through resolution for the claim.
 *
 * Both sources can only promise N/R/SR today (their schemas stay on
 * `EQUIPMENT_REWARD_RARITIES`), so these tests prove the pin is taken, used,
 * honoured over a later publish, and fails closed — not an SSR+ drop, which
 * no reward schema can author yet. SSR+ under a pin is covered at the grant
 * level in `equipmentHighRarity.test.ts`.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRuns, equipmentEvents, items, playerEquipment, playerExpeditions, species as speciesTable, type SpeciesRow } from '../../src/db/schema';
import {
  ExpeditionDefinitionSchema,
  ExpeditionRewardTableSchema,
  ExpeditionsConfigSchema,
  type ExpeditionRewardTable,
} from '../../src/modules/content/schemas';
import { DungeonRewardBundleSchema } from '../../src/modules/dungeons/content/dungeonRewards';
import type { DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { rollEquipmentInstance } from '../../src/modules/equipment/equipmentRoll';
import { seededRng } from '../../src/shared/random';
import {
  bootstrapEquipmentRollRules,
  createEquipmentRollRulesService,
  loadShippedCombatBonusFile,
  type EquipmentRollRulesService,
} from '../../src/modules/equipment/equipmentRollRulesService';
import type { ManagedRarityRule } from '../../src/modules/equipment/rollRules';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import type { ExpeditionResolutionPlan } from '../../src/modules/expeditions/types';
import { DungeonRewardGrantError } from '../../src/shared/errors';
import { FIXED_RULES, singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { unlockEquipment } from '../helpers/equipmentFixtures';
import { bootstrapApp, CONTENT_DIR, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

/** TEST-ONLY high-rarity rule — publishing it is what moves the rules revision. */
const TEST_SSR: ManagedRarityRule = {
  bonusCountWeightsBp: [0, 10_000, 0, 0],
  families: [{ stat: 'crit_chance_bp', enabled: true, slots: ['attack', 'defense', 'health'], minValue: 500, maxValue: 600, step: 50 }],
  primarySp: null,
  affixes: { mode: 'none' },
};

async function publishNextRevision(rules: EquipmentRollRulesService, weightTweak: number) {
  const draft = await rules.draft();
  const next = structuredClone(draft.rules);
  next.rarities.SSR = { ...TEST_SSR, bonusCountWeightsBp: [weightTweak, 10_000 - weightTweak, 0, 0] };
  const saved = await rules.saveDraft(next, { expectedDraftRevision: draft.draftRevision, actor: 'test' });
  return rules.publish({ expectedDraftRevision: saved.draftRevision, actor: 'test' });
}

const grantEvents = async (playerId: number) =>
  (await (globalDb!).select().from(equipmentEvents).where(eq(equipmentEvents.playerId, playerId))).filter(
    (e) => e.kind === 'granted' && (e.metadata as { rollKind?: string }).rollKind === 'random',
  );
let globalDb: TestDb['db'] | undefined;

// ── dungeons ────────────────────────────────────────────────────────────────

describe('dungeon runs pin the roll configuration at start', () => {
  let w: DungeonWorld;
  const gearKey = 't_e3c_pin_gear';
  let n = 0;

  async function startRun() {
    const definition = singleRoomDungeon(
      [
        {
          id: 'pay',
          type: 'reward',
          rewards: DungeonRewardBundleSchema.parse({
            chances: [],
            tables: [],
            guaranteed: [{ id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: [gearKey] } } }],
          }),
        },
      ] as NonNullable<DungeonDefinitionInput['rooms'][number]['actions']>,
      (d) => {
        d.key = `t_e3c_${++n}`;
        d.rooms[0]!.extraction = true;
      },
    );
    await w.publish(definition);
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, definition.key, { seed: 42 });
    return { playerId, start };
  }
  const snapshotOf = async (runId: number) =>
    (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!.dependencySnapshot as Record<string, unknown>;
  const advance = (playerId: number, run: Awaited<ReturnType<typeof startRun>>['start']) => w.act(playerId, run, { type: 'advance' });

  beforeAll(async () => {
    w = await createDungeonWorld({ managedRollRules: true, combatRules: FIXED_RULES });
    globalDb = w.t.db;
    await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
    await w.svc.definitions.create({ key: gearKey, name: 'E3C Pin Gear', slot: 'attack', rarity: 'SR', multiplierMinBp: 4_000, multiplierMaxBp: 6_000, multiplierStepBp: 500 });
  });
  afterAll(async () => {
    await w?.cleanup();
  });

  it('records the published revision at start and pays under it after a newer one publishes', async () => {
    const pinnedRevision = (await w.svc.rollRules!.published()).revision;
    const { playerId, start } = await startRun();
    expect((await snapshotOf(start.id)).equipmentRollPin).toEqual({ rulesRevision: pinnedRevision, affixLibraryRevisions: {} });

    const newer = await publishNextRevision(w.svc.rollRules!, 0);
    expect(newer.revision).toBeGreaterThan(pinnedRevision);

    const { run } = await advance(playerId, start);
    const gear = run.secured.filter((r) => r.kind === 'equipment');
    expect(gear).toHaveLength(1);
    const [event] = await grantEvents(playerId);
    expect(event!.metadata).toMatchObject({ definitionKey: gearKey, rollRulesRevision: pinnedRevision, rollRulesPinned: true });
  });

  it('a run started before E3-C (no pin in its snapshot) pays under the live revision, unchanged for N/R/SR', async () => {
    const { playerId, start } = await startRun();
    await w.t.db
      .update(dungeonRuns)
      .set({ dependencySnapshot: sql`${dungeonRuns.dependencySnapshot} - 'equipmentRollPin'` })
      .where(eq(dungeonRuns.id, start.id));
    const live = await publishNextRevision(w.svc.rollRules!, 100);
    await advance(playerId, start);
    const [event] = await grantEvents(playerId);
    expect(event!.metadata).toMatchObject({ rollRulesRevision: live.revision, rollRulesPinned: false });
  });

  it('pinned or not, an N/R/SR drop is exactly the seeded legacy roll — the published revision changes nothing', async () => {
    const a = await startRun();
    const b = await startRun();
    await w.t.db
      .update(dungeonRuns)
      .set({ dependencySnapshot: sql`${dungeonRuns.dependencySnapshot} - 'equipmentRollPin'` })
      .where(eq(dungeonRuns.id, b.start.id));
    const legacy = (await w.t.db.transaction((tx) => w.svc.rollRules!.forGrant(tx))).combatBonuses;
    const [definition] = await w.svc.definitions.listDefinitions({ q: gearKey });
    for (const { playerId, start } of [a, b]) {
      const drop = (await advance(playerId, start)).run.secured.find((r) => r.kind === 'equipment')!;
      const expected = rollEquipmentInstance(definition!.definition, {
        rng: seededRng(drop.rollSeed!),
        affixes: w.svc.getAffixes(),
        combatBonuses: legacy,
      });
      expect({ rolledMultiplierBp: drop.rolledMultiplierBp, affixKey: drop.affixKey, combatBonuses: drop.combatBonuses }).toEqual({
        rolledMultiplierBp: expected.rolledMultiplierBp,
        affixKey: expected.affixKey,
        combatBonuses: expected.combatBonuses,
      });
    }
  });

  it('a pinned revision that is missing aborts the payout atomically; repairing the pin lets it retry', async () => {
    const { playerId, start } = await startRun();
    const good = (await snapshotOf(start.id)).equipmentRollPin;
    await w.t.db
      .update(dungeonRuns)
      .set({ dependencySnapshot: sql`jsonb_set(${dungeonRuns.dependencySnapshot}, '{equipmentRollPin,rulesRevision}', '9999')` })
      .where(eq(dungeonRuns.id, start.id));
    await expect(advance(playerId, start)).rejects.toBeInstanceOf(DungeonRewardGrantError);
    expect(await w.t.db.select().from(playerEquipment).where(eq(playerEquipment.sourceType, 'dungeon')).then((r) => r.filter((x) => x.playerId === playerId))).toEqual([]);
    await w.t.db
      .update(dungeonRuns)
      .set({ dependencySnapshot: sql`jsonb_set(${dungeonRuns.dependencySnapshot}, '{equipmentRollPin}', ${JSON.stringify(good)}::jsonb)` })
      .where(eq(dungeonRuns.id, start.id));
    const { run } = await advance(playerId, start);
    expect(run.secured.filter((r) => r.kind === 'equipment')).toHaveLength(1);
  });
});

// ── expeditions ─────────────────────────────────────────────────────────────

describe('expeditions pin the roll configuration at deploy', () => {
  let t: TestDb;
  let app: App;
  let rules: EquipmentRollRulesService;
  let demon: SpeciesRow;
  let seq = 0;

  function installGearTable(): void {
    const table: ExpeditionRewardTable = ExpeditionRewardTableSchema.parse({
      id: 'gear_success',
      waifubux: { min: 10, max: 10 },
      groups: [{ id: 'gear', chanceBasisPoints: 10_000, equipment: [{ weight: 1, rarity: 'R' }] }],
    });
    app.content.expeditions = [
      {
        ...ExpeditionDefinitionSchema.parse({
          key: 'gear_run',
          name: 'Gear Run',
          type: 'salvage_dive',
          durationMinutes: 360,
          recommendedLevel: 10,
          baseSuccessChance: 0.5,
          rewardTable: 'gear_success',
          exceptionalRewardTable: null,
          failureRewardTable: null,
        }),
        region: 'waifu-valley',
      },
    ];
    app.content.expeditionRewards = [table];
    app.content.tables.expeditions = ExpeditionsConfigSchema.parse({ enabled: true });
  }

  async function deployed() {
    seq += 1;
    const { playerId } = await provisionPlayer(app, 'g-e3c-exp', `u-e3c-exp-${seq}`);
    await unlockEquipment(t.db, app.gear, playerId);
    const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: demon.id, level: 10 });
    const view = await app.expeditions.deploy(playerId, 'gear_run', waifu.id);
    await t.db
      .update(playerExpeditions)
      .set({ completesAt: sql`now() - interval '1 minute'`, successChance: 1, exceptionalChance: 0 })
      .where(eq(playerExpeditions.id, view.id));
    return { playerId, id: view.id };
  }
  const planOf = async (id: number) =>
    (await t.db.select().from(playerExpeditions).where(eq(playerExpeditions.id, id)))[0]!.resolutionPlan as unknown as ExpeditionResolutionPlan;

  beforeAll(async () => {
    t = await createTestDb();
    globalDb = t.db;
    rules = createEquipmentRollRulesService({ db: t.db });
    app = await bootstrapApp(t, { equipmentRollRules: rules });
    await bootstrapEquipmentRollRules(t.db, loadShippedCombatBonusFile(CONTENT_DIR));
    await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
    await t.db.insert(items).values({ slug: 'exp_gear_scrap', name: 'Gear Scrap', category: 'salvage', sellValue: 5 }).onConflictDoNothing();
    [demon] = (await t.db.select().from(speciesTable).where(eq(speciesTable.affinity, 'dominant')).limit(1)) as [SpeciesRow];
    installGearTable();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it('records the pin at deploy, keeps it through resolution, and the claim pays under it', async () => {
    const pinned = (await rules.published()).revision;
    const { playerId, id } = await deployed();
    expect((await planOf(id)).equipmentRollPin).toEqual({ rulesRevision: pinned, affixLibraryRevisions: {} });
    await publishNextRevision(rules, 0);
    await app.expeditions.getActive(playerId); // lazy resolution trims the plan
    expect((await planOf(id)).equipmentRollPin).toEqual({ rulesRevision: pinned, affixLibraryRevisions: {} });
    const result = await app.expeditions.claim(playerId, id);
    expect(result.equipmentGranted).toHaveLength(1);
    const [event] = await grantEvents(playerId);
    expect(event!.metadata).toMatchObject({ rollRulesRevision: pinned, rollRulesPinned: true });
  });

  it('a plan written before E3-C (no pin) claims under the live revision', async () => {
    const { playerId, id } = await deployed();
    await t.db
      .update(playerExpeditions)
      .set({ resolutionPlan: sql`${playerExpeditions.resolutionPlan} - 'equipmentRollPin'` })
      .where(eq(playerExpeditions.id, id));
    const live = await publishNextRevision(rules, 200);
    await app.expeditions.claim(playerId, id);
    const [event] = await grantEvents(playerId);
    expect(event!.metadata).toMatchObject({ rollRulesRevision: live.revision, rollRulesPinned: false });
  });
});
