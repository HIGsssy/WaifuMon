/**
 * `give_equipment` — a World Encounter effect that hands out one random piece
 * of gear through the shared Equipment reward path, inside the encounter's
 * own resolution transaction.
 *
 * The encounter names only a selector. Which base definition lands, and the
 * instance's multiplier and affix, are the Equipment service's; a bad
 * selector rolls the whole resolution back rather than paying a substitute.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activeWorldEncounters,
  playerCurrencies,
  playerEquipment,
  worldEncounterChoices,
  worldEncounterHistory,
  worldEncounters,
} from '../../src/db/schema';
import { buildEncounterResolved } from '../../src/discord/worldEncounterPresenter';
import type { AppContext } from '../../src/discord/types';
import { affixPoolOf } from '../../src/modules/equipment/affixCatalogue';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { listRewardableDefinitions } from '../../src/modules/equipment/equipmentRewardService';
import { AdminEncounterValidationError } from '../../src/modules/worldEncounters/adminService';
import { planImport, type EncounterPackage } from '../../src/modules/worldEncounters/encounterPackage';
import type { Effect } from '../../src/modules/worldEncounters/types';
import type { EncounterActivation } from '../../src/modules/worldEncounters/worldEncounterService';
import { EquipmentRewardConfigError } from '../../src/shared/errors';
import { WorldEncounterResolvedError } from '../../src/modules/worldEncounters/worldEncounterService';
import { seededRng } from '../../src/shared/random';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { TEST_AFFIXES } from '../helpers/equipmentFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { equipmentRng: seededRng(7), equipmentRewardRng: seededRng(8) });
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-we-gear', 'u-we-gear'));
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await app.gear.definitions.setEnabled('combat_knife', true);
  // A refused resolution correctly leaves its encounter pending; clear it so
  // the one-pending-per-player index admits the next test's encounter.
  await t.db
    .update(activeWorldEncounters)
    .set({ status: 'expired' })
    .where(and(eq(activeWorldEncounters.playerId, playerId), eq(activeWorldEncounters.status, 'pending')));
});

/** An active encounter whose one auto-resolving choice applies `effects`. */
async function activeEncounterWith(
  effects: Effect[],
): Promise<{ activeId: number; choiceId: number; encounterId: number }> {
  seq += 1;
  const [encounter] = await t.db
    .insert(worldEncounters)
    .values({
      slug: `tv_gear_cache_${seq}`,
      name: 'Abandoned Gear Cache',
      description: 'A locker, ajar.',
      type: 'decision',
      rarity: 'common',
      weight: 10,
      lifecycle: 'active',
      huntEligible: true,
      travelEligible: false,
      cooldownSeconds: 0,
      choicesRequired: true,
    })
    .returning();
  const [choice] = await t.db
    .insert(worldEncounterChoices)
    .values({
      encounterId: encounter!.id,
      sortOrder: 0,
      label: 'Rummage',
      checkJson: { type: 'none' },
      successEffectsJson: effects as unknown as Record<string, unknown>[],
      failureEffectsJson: [],
    })
    .returning();
  const [active] = await t.db
    .insert(activeWorldEncounters)
    .values({
      playerId,
      encounterId: encounter!.id,
      source: 'hunt',
      regionId: 'waifu-valley',
      guildId: guildDbId,
      channelId: 'c-we-gear',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  return { activeId: active!.id, choiceId: choice!.id, encounterId: encounter!.id };
}

const gearOf = () => t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));

async function resolveWith(effects: Effect[]) {
  const { activeId, choiceId, encounterId } = await activeEncounterWith(effects);
  const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
  const entry = resolution.effectsApplied.find((e) => e.effect.type === 'give_equipment')!;
  return { activeId, choiceId, encounterId, resolution, entry };
}

const gear = (selector: Record<string, unknown>): Effect => ({ type: 'give_equipment', quantity: 1, ...selector }) as Effect;

describe('paying gear', () => {
  it('Any N Attack grants one N attack instance and persists it', async () => {
    const { entry, activeId } = await resolveWith([gear({ slot: 'attack', rarity: 'N' })]);
    expect(entry.applied).toBe(true);
    expect(entry.equipment!.slot).toBe('attack');
    expect(entry.equipment!.rarity).toBe('N');
    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, entry.equipment!.equipmentId));
    expect(row!.playerId).toBe(playerId);
    expect(row!.sourceType).toBe('encounter');
    expect(row!.sourceKey).toMatch(/^tv_gear_cache_/);
    expect(row!.grantKey).toBe(`world_encounter:${activeId}:effect:0:0`);
    expect(row!.rolledMultiplierBp).toBe(entry.equipment!.rolledMultiplierBp);
  });

  it('Any R Defense grants one R defense instance with an affix from its own pool', async () => {
    const { entry } = await resolveWith([gear({ slot: 'defense', rarity: 'R' })]);
    const definition = (await app.gear.definitions.getByKey(entry.equipment!.definitionKey))!;
    expect(definition.slot).toBe('defense');
    expect(definition.rarity).toBe('R');
    expect(TEST_AFFIXES.get(entry.equipment!.affixKey!)!.pool).toBe(affixPoolOf(definition));
  });

  it('an explicit whitelist grants one of the named definitions', async () => {
    const { entry } = await resolveWith([gear({ definitionKeys: ['combat_knife', 'semi_auto_sidearm'] })]);
    expect(['combat_knife', 'semi_auto_sidearm']).toContain(entry.equipment!.definitionKey);
  });

  it('two gear effects on one choice are two distinct instances', async () => {
    const before = (await gearOf()).length;
    const { resolution } = await resolveWith([gear({ rarity: 'N' }), gear({ rarity: 'R' })]);
    const ids = resolution.effectsApplied.map((e) => e.equipment?.equipmentId);
    expect(new Set(ids).size).toBe(2);
    expect((await gearOf()).length).toBe(before + 2);
  });

  it('records the generated instance on the history row', async () => {
    const { entry, encounterId } = await resolveWith([gear({ rarity: 'N' })]);
    const [history] = await t.db
      .select()
      .from(worldEncounterHistory)
      .where(eq(worldEncounterHistory.encounterId, encounterId));
    const applied = (history!.effectsAppliedJson as { equipment?: { equipmentId: number } }[]).find((e) => e.equipment);
    expect(applied!.equipment!.equipmentId).toBe(entry.equipment!.equipmentId);
  });
});

describe('retries', () => {
  it('a resolved encounter cannot pay its gear twice', async () => {
    const { activeId, choiceId } = await activeEncounterWith([gear({ rarity: 'R' })]);
    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const after = (await gearOf()).length;
    await expect(app.worldEncounter.resolveChoice({ activeId, playerId, choiceId })).rejects.toBeInstanceOf(
      WorldEncounterResolvedError,
    );
    expect((await gearOf()).length).toBe(after);
  });

  it('a replay of the effect grant key returns the same instance instead of a second draw', async () => {
    const { entry, activeId } = await resolveWith([gear({ rarity: 'R' })]);
    const replay = await t.db.transaction((tx) =>
      app.equipmentRewards.grantRandomEquipmentReward(tx, {
        playerId,
        selector: { rarity: 'R' },
        source: { type: 'encounter' },
        grantKey: `world_encounter:${activeId}:effect:0`,
        rng: seededRng(123456),
      }),
    );
    expect(replay.alreadyGranted).toBe(true);
    expect(replay.equipmentId).toBe(entry.equipment!.equipmentId);
    expect(replay.definitionKey).toBe(entry.equipment!.definitionKey);
    expect(replay.affixKey).toBe(entry.equipment!.affixKey);
    expect(replay.rolledMultiplierBp).toBe(entry.equipment!.rolledMultiplierBp);
  });
});

describe('failure leaves no partial resolution', () => {
  it('a selector with nothing eligible rolls back every effect, the history and the resolution', async () => {
    const [before] = await t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
    const gearBefore = (await gearOf()).length;
    const { activeId, choiceId, encounterId } = await activeEncounterWith([
      { type: 'waifubux_gain', amount: 500 },
      gear({ rarity: 'N' }),
      gear({ slot: 'health', rarity: 'SR' }),
    ]);
    await expect(app.worldEncounter.resolveChoice({ activeId, playerId, choiceId })).rejects.toBeInstanceOf(
      EquipmentRewardConfigError,
    );
    const [after] = await t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
    expect(after!.waifubux).toBe(before!.waifubux);
    expect((await gearOf()).length).toBe(gearBefore);
    const [active] = await t.db.select().from(activeWorldEncounters).where(eq(activeWorldEncounters.id, activeId));
    expect(active!.status).toBe('pending');
    const history = await t.db
      .select()
      .from(worldEncounterHistory)
      .where(eq(worldEncounterHistory.encounterId, encounterId));
    expect(history).toEqual([]);
  });

  it('a whitelist naming a since-disabled definition is refused, not substituted', async () => {
    const { activeId, choiceId } = await activeEncounterWith([gear({ definitionKeys: ['combat_knife'] })]);
    await app.gear.definitions.setEnabled('combat_knife', false);
    const gearBefore = (await gearOf()).length;
    await expect(app.worldEncounter.resolveChoice({ activeId, playerId, choiceId })).rejects.toThrow(/disabled/);
    expect((await gearOf()).length).toBe(gearBefore);
  });
});

describe('authoring', () => {
  const encounterInput = (effect: Record<string, unknown>) => ({
    slug: `tv_authored_gear_${++seq}`,
    name: 'Authored Cache',
    type: 'decision',
    rarity: 'common',
    lifecycle: 'draft',
    choices: [{ label: 'Open', successEffects: [effect] }],
  });

  it('saves a valid gear selector', async () => {
    const saved = await app.worldEncounterAdmin.upsert(
      encounterInput({ type: 'give_equipment', slot: 'defense', rarity: 'R' }) as never,
    );
    expect(saved.choices[0]!.successEffects[0]).toEqual({ type: 'give_equipment', slot: 'defense', rarity: 'R', quantity: 1 });
  });

  it.each([
    ['an unknown definition', { definitionKeys: ['imaginary_blade'] }, /imaginary_blade/],
    ['a slot/rarity with nothing in it', { slot: 'health', rarity: 'R' }, /no enabled equipment definition/],
    ['an explicit key of the wrong rarity', { rarity: 'N', definitionKeys: ['combat_knife'] }, /is R/],
  ])('refuses %s at save time', async (_label, selector, pattern) => {
    const err = await app.worldEncounterAdmin
      .upsert(encounterInput({ type: 'give_equipment', ...selector }) as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminEncounterValidationError);
    expect(String((err as AdminEncounterValidationError).issues ?? (err as Error).message)).toMatch(pattern);
  });

  it('refuses an authored affix or multiplier outright', async () => {
    await expect(
      app.worldEncounterAdmin.upsert(encounterInput({ type: 'give_equipment', affixKey: 'poor_planning' }) as never),
    ).rejects.toBeInstanceOf(AdminEncounterValidationError);
    await expect(
      app.worldEncounterAdmin.upsert(encounterInput({ type: 'give_equipment', rolledMultiplierBp: 9000 }) as never),
    ).rejects.toBeInstanceOf(AdminEncounterValidationError);
  });

  it('an import plan refuses a selector this server cannot pay', async () => {
    const pkg = {
      format: 'waifumon-world-encounters',
      version: 1,
      exportedAt: new Date().toISOString(),
      label: null,
      encounters: [
        {
          ...encounterInput({ type: 'give_equipment', definitionKeys: ['imaginary_blade'] }),
          lifecycle: 'draft',
        },
      ],
      vendors: [],
    } as unknown as EncounterPackage;
    const plan = planImport(pkg, {
      existingEncounters: new Map(),
      existingVendors: new Map(),
      itemSlugs: new Set(),
      speciesSlugs: new Set(),
      equipmentDefinitions: await listRewardableDefinitions(t.db),
    });
    expect(plan.issues.some((i) => i.code === 'invalid_equipment_reward' && /imaginary_blade/.test(i.message))).toBe(true);
  });
});

describe('presentation', () => {
  it('shows the generated name and formatted multiplier — never the affix key or basis points', async () => {
    const { resolution, entry } = await resolveWith([gear({ definitionKeys: ['combat_knife'] })]);
    const ctx = { config: { assetsDir: './assets' } } as unknown as AppContext;
    const activation = {
      activeId: 1,
      encounter: { id: 1, slug: 'x', name: 'Cache', description: 'd', rarity: 'common', artworkPath: null, choices: [] },
      buddy: null,
      buddyBonusPercent: 0,
      choiceViews: [],
    } as unknown as EncounterActivation;
    const view = buildEncounterResolved(ctx, activation, resolution);
    const text = JSON.stringify(view.embeds!.map((e) => (e as { toJSON(): unknown }).toJSON()));
    const affix = TEST_AFFIXES.get(entry.equipment!.affixKey!)!;
    expect(text).toContain(`Combat Knife ${affix.suffix}`);
    expect(text).toContain(`ATK ×${(entry.equipment!.rolledMultiplierBp / 10_000).toFixed(2)}`);
    expect(text).not.toContain(affix.key);
    expect(text).not.toContain(String(entry.equipment!.rolledMultiplierBp));
    expect(text).not.toContain('attack.R');
  });
});
