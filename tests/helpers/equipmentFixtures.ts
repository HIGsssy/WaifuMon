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

export function buildEquipmentServices(db: Db) {
  const featureUnlocks = createFeatureUnlockService(db);
  return {
    featureUnlocks,
    equipment: createEquipmentService({ db, featureUnlocks }),
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

/** Authoring input for one definition per slot, plus overrides. */
export const GEAR = {
  attack: { key: 'training_ring', name: 'Training Ring', slot: 'attack', rarity: 'N', attackBp: 5_000 },
  attack2: { key: 'plasma_coil_ring', name: 'Plasma Coil Ring', slot: 'attack', rarity: 'SR', attackBp: 8_600 },
  defense: { key: 'padded_belt', name: 'Padded Belt', slot: 'defense', rarity: 'N', defenseBp: 4_000 },
  health: { key: 'basic_harness', name: 'Basic Harness', slot: 'health', rarity: 'N', healthBp: 20_000 },
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

/** Grant in its own transaction; returns the first new (or covered) instance id. */
export async function grant(
  db: Db,
  svc: EquipmentServices,
  playerId: number,
  definitionKey: string,
  over: Partial<GrantEquipmentInput> = {},
): Promise<number> {
  const result = await db.transaction((tx) =>
    svc.equipment.grantEquipment(tx, {
      playerId,
      definitionKey,
      source: { type: 'admin', key: 'test' },
      ...over,
    }),
  );
  return result.instances[0]!.id;
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
