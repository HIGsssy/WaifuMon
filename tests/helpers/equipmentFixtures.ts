/**
 * Equipment test fixtures.
 *
 * Most equipment tests need a player and some definitions, not the whole game,
 * so this builds just the equipment services against a test database. Tests
 * that need a real Buddy (combat stats) use `bootstrapApp` and pass its
 * collection service in.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { guilds, players } from '../../src/db/schema';
import { createFeatureUnlockService } from '../../src/modules/features/featureUnlockService';
import {
  createEquipmentService,
  type GrantEquipmentInput,
} from '../../src/modules/equipment/equipmentService';
import { createEquipmentDefinitionService } from '../../src/modules/equipment/equipmentDefinitionService';
import { createEquipmentPromotionService } from '../../src/modules/equipment/equipmentImportService';
import {
  EQUIPMENT_AFFIX_POOLS,
  buildAffixCatalogue,
  type EquipmentAffix,
  type EquipmentAffixCatalogue,
} from '../../src/modules/equipment/affixCatalogue';
import { COMBAT_BONUSES_DISABLED, type CombatBonusConfig } from '../../src/modules/equipment/combatBonuses';
import type { Rng } from '../../src/shared/random';
import { STARTER_EQUIPMENT, STARTER_ROLLS } from '../../src/modules/onboarding/vocabulary';
import type { EquipmentSlot } from '../../src/modules/equipment/vocabulary';

/**
 * A small catalogue covering every pool, so any N/R/SR definition can roll.
 * `attack.N` — the pool most tests' gear rolls from — has two enabled affixes
 * and one retired; every other pool has exactly one enabled affix,
 * `<slot>_<rarity>_flair` ("of Attack R Flair").
 */
export const TEST_AFFIX_LIST: EquipmentAffix[] = [
  { key: 'poor_planning', suffix: 'of Poor Planning', pool: 'attack.N', enabled: true },
  { key: 'mild_regret', suffix: 'of Mild Regret', pool: 'attack.N', enabled: true },
  { key: 'retired_flair', suffix: 'of Retired Flair', pool: 'attack.N', enabled: false },
  ...EQUIPMENT_AFFIX_POOLS.filter((pool) => pool !== 'attack.N').map((pool) => {
    const [slot, rarity] = pool.split('.') as [string, string];
    const title = (s: string) => s[0]!.toUpperCase() + s.slice(1);
    return {
      key: `${slot}_${rarity.toLowerCase()}_flair`,
      suffix: `of ${title(slot)} ${rarity} Flair`,
      pool,
      enabled: true,
    };
  }),
];
export const TEST_AFFIXES: EquipmentAffixCatalogue = buildAffixCatalogue(TEST_AFFIX_LIST);

/**
 * Equipment services against a test database, rolling from {@link TEST_AFFIXES}
 * unless told otherwise. Tests that check which affix lands pass a scripted or
 * seeded RNG.
 *
 * Combat bonuses are **disabled** by default (`COMBAT_BONUSES_DISABLED`), so
 * random grants roll **no** secondary bonus and existing scripted rolls keep
 * their draw counts — an intentional feature-off config, not a (now
 * fail-closed) missing catalogue. A test about bonuses passes `combatBonuses`
 * (a getter, so it can be swapped mid-test).
 */
export function buildEquipmentServices(
  db: Db,
  opts: { affixes?: EquipmentAffixCatalogue; rng?: Rng; combatBonuses?: () => CombatBonusConfig | null } = {},
) {
  const featureUnlocks = createFeatureUnlockService(db);
  const affixes = opts.affixes ?? TEST_AFFIXES;
  return {
    featureUnlocks,
    getAffixes: () => affixes,
    equipment: createEquipmentService({
      db,
      featureUnlocks,
      getAffixes: () => affixes,
      getCombatBonuses: opts.combatBonuses ?? (() => COMBAT_BONUSES_DISABLED),
      ...(opts.rng ? { rng: opts.rng } : {}),
    }),
    definitions: createEquipmentDefinitionService(db),
    promotion: createEquipmentPromotionService({ db }),
  };
}

export type EquipmentServices = ReturnType<typeof buildEquipmentServices>;

/** A fresh guild + player, unique per call. Returns the player id. */
export async function createPlayer(db: Db, tag = randomBytes(4).toString('hex')): Promise<number> {
  const [guild] = await db.insert(guilds).values({ discordGuildId: `g-${tag}` }).returning();
  const [player] = await db
    .insert(players)
    .values({ guildId: guild!.id, discordUserId: `u-${tag}` })
    .returning();
  return player!.id;
}

/** A single-value range: every roll is exactly `bp`, so stat assertions stay exact. */
export function fixedRange(bp: number) {
  return { multiplierMinBp: bp, multiplierMaxBp: bp, multiplierStepBp: 100 } as const;
}

/**
 * Authoring input for one definition per slot, plus overrides. Single-value
 * ranges, so a random grant of these is deterministic; `ranged` is the one
 * definition whose roll actually varies (×0.40–×0.60 in ×0.05 steps).
 */
export const GEAR = {
  attack: { key: 'training_ring', name: 'Training Ring', slot: 'attack', rarity: 'N', ...fixedRange(5_000) },
  attack2: { key: 'plasma_coil_ring', name: 'Plasma Coil Ring', slot: 'attack', rarity: 'SR', ...fixedRange(8_600) },
  defense: { key: 'padded_belt', name: 'Padded Belt', slot: 'defense', rarity: 'N', ...fixedRange(4_000) },
  health: { key: 'basic_harness', name: 'Basic Harness', slot: 'health', rarity: 'N', ...fixedRange(20_000) },
  ranged: {
    key: 'rusty_test_pipe',
    name: 'Rusty Test Pipe',
    slot: 'attack',
    rarity: 'N',
    multiplierMinBp: 4_000,
    multiplierMaxBp: 6_000,
    multiplierStepBp: 500,
  },
} as const;

export async function defineGear(
  svc: EquipmentServices,
  ...keys: (keyof typeof GEAR)[]
): Promise<void> {
  for (const key of keys) await svc.definitions.create(GEAR[key]);
}

export async function unlockEquipment(db: Db, svc: EquipmentServices, playerId: number): Promise<void> {
  await db.transaction((tx) =>
    svc.featureUnlocks.unlock(tx, { playerId, featureKey: 'equipment', source: 'onboarding' }),
  );
}

/**
 * Grant in its own transaction; returns the first new (or covered) instance id.
 *
 * Setup helper, so the default is **deterministic**: an unaffixed fixed roll
 * at the definition's range minimum (the exact multiplier, for the
 * single-value `GEAR` ranges). A test about random generation asks for it —
 * `{ roll: { kind: 'random' } }` — or dictates its own fixed roll.
 */
export async function grant(
  db: Db,
  svc: EquipmentServices,
  playerId: number,
  definitionKey: string,
  over: Partial<GrantEquipmentInput> = {},
): Promise<number> {
  let roll = over.roll;
  if (roll === undefined) {
    const definition = await svc.definitions.getByKey(definitionKey);
    roll = definition
      ? { kind: 'fixed', rolledMultiplierBp: definition.multiplierMinBp, affixKey: null }
      : { kind: 'random' };
  }
  const result = await db.transaction((tx) =>
    svc.equipment.grantEquipment(tx, {
      playerId,
      definitionKey,
      source: { type: 'admin', key: 'test' },
      ...over,
      roll,
    }),
  );
  return result.instances[0]!.id;
}

/**
 * Grant options pinning a seeded starter to its signed-off fixed roll — what
 * the onboarding grants. The seeded starters are ranged, so a plain random
 * grant of one would make a stat assertion depend on the dice.
 */
export function starterRoll(key: string): Pick<GrantEquipmentInput, 'roll'> {
  const slot = (Object.keys(STARTER_EQUIPMENT) as EquipmentSlot[]).find((s) => STARTER_EQUIPMENT[s] === key);
  if (!slot) throw new Error(`${key} is not a starter`);
  return { roll: { kind: 'fixed', ...STARTER_ROLLS[slot] } };
}

/** Expect a Postgres error with this SQLSTATE (drizzle may wrap it). */
export async function expectPgError(promise: Promise<unknown>, sqlstate: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error(`expected SQLSTATE ${sqlstate}, but the statement succeeded`);
  let e = caught as { code?: string; cause?: unknown } | undefined;
  while (e && e.code !== sqlstate && e.cause) e = e.cause as typeof e;
  if (e?.code !== sqlstate) {
    throw new Error(`expected SQLSTATE ${sqlstate}, got ${(caught as { code?: string }).code}: ${String(caught)}`);
  }
}

export async function playerDiscordId(db: Db, playerId: number): Promise<string> {
  const [row] = await db.select({ id: players.discordUserId }).from(players).where(eq(players.id, playerId));
  return row!.id;
}
