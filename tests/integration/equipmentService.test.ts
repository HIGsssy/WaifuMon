/**
 * The equipment service against a real database: granting, listing, equip
 * and unequip, flags, admin removal, and the feature unlock that gates
 * changing what is equipped.
 */
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  equipmentEvents,
  playerEquipment,
  playerFeatureUnlocks,
  playerLoadoutSlots,
  playerLoadouts,
  playerProgressionEvents,
} from '../../src/db/schema';
import { ADMIN_ACTION_EVENT } from '../../src/modules/admin/adminActionAudit';
import {
  EquipmentDefinitionDisabledError,
  EquipmentDefinitionNotFoundError,
  EquipmentLockedError,
  EquipmentNotOwnedError,
  EquipmentSlotMismatchError,
  EquipmentValidationError,
  FeatureLockedError,
  LoadoutConflictError,
} from '../../src/shared/errors';
import { createTestDb, type TestDb } from '../helpers/testDb';
import {
  fixedRange,
  buildEquipmentServices,
  createPlayer,
  defineGear,
  grant,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

let t: TestDb;
let svc: EquipmentServices;

beforeAll(async () => {
  t = await createTestDb();
  svc = buildEquipmentServices(t.db);
  await defineGear(svc, 'attack', 'attack2', 'defense', 'health');
});

afterAll(async () => {
  await t?.cleanup();
});

async function eventCount(playerId: number, kind?: string): Promise<number> {
  const [row] = await t.db
    .select({ n: count() })
    .from(equipmentEvents)
    .where(
      kind
        ? and(eq(equipmentEvents.playerId, playerId), eq(equipmentEvents.kind, kind))
        : eq(equipmentEvents.playerId, playerId),
    );
  return row!.n;
}

async function loadoutCount(playerId: number): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(playerLoadouts).where(eq(playerLoadouts.playerId, playerId));
  return row!.n;
}

/** Run a rejecting call and return what it threw. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('grantEquipment', () => {
  it('creates instances with the slot and source copied, and never equips', async () => {
    const player = await createPlayer(t.db);
    const result = await t.db.transaction((tx) =>
      svc.equipment.grantEquipment(tx, {
        playerId: player,
        definitionKey: 'plasma_coil_ring',
        quantity: 3,
        source: { type: 'encounter', key: 'tp_narrow_ledge' },
        actorDiscordId: 'admin-1',
      }),
    );
    expect(result.alreadyGranted).toBe(false);
    expect(result.newInstanceIds).toHaveLength(3);
    expect(result.definition).toMatchObject({ key: 'plasma_coil_ring', slot: 'attack', multiplierMinBp: 8_600 });
    for (const instance of result.instances) {
      expect(instance).toMatchObject({ slot: 'attack', sourceType: 'encounter', sourceKey: 'tp_narrow_ledge', equipped: false, rolledMultiplierBp: 8_600, affixKey: 'attack_sr_flair' });
    }
    const rows = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, player));
    expect(rows.every((r) => r.grantedBy === 'admin-1' && r.grantKey === null && r.removedAt === null)).toBe(true);
    expect(await eventCount(player, 'granted')).toBe(3);
    // Rewards never equip: not even a loadout is created.
    expect(await loadoutCount(player)).toBe(0);
  });

  it('works before the feature is unlocked', async () => {
    const player = await createPlayer(t.db);
    expect(await svc.featureUnlocks.isUnlocked(player, 'equipment')).toBe(false);
    await grant(t.db, svc, player, 'training_ring');
    expect((await svc.equipment.listEquipment(player)).items).toHaveLength(1);
  });

  it('is idempotent on its grant key', async () => {
    const player = await createPlayer(t.db);
    const input = {
      playerId: player,
      definitionKey: 'training_ring',
      quantity: 2,
      source: { type: 'expedition' as const, key: 'valley_stockroom_squeeze' },
      grantKey: `exp:${player}`,
    };
    const first = await t.db.transaction((tx) => svc.equipment.grantEquipment(tx, input));
    const second = await t.db.transaction((tx) => svc.equipment.grantEquipment(tx, input));
    expect(first.alreadyGranted).toBe(false);
    expect(second.alreadyGranted).toBe(true);
    expect(second.newInstanceIds).toEqual([]);
    expect(second.instances.map((i) => i.id)).toEqual(first.instances.map((i) => i.id));
    expect(await eventCount(player, 'granted')).toBe(2);
    const keys = (await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, player))).map(
      (r) => r.grantKey,
    );
    expect(keys.sort()).toEqual([`exp:${player}:0`, `exp:${player}:1`]);
  });

  it('refuses a grant key already used for another player', async () => {
    const a = await createPlayer(t.db);
    const b = await createPlayer(t.db);
    await grant(t.db, svc, a, 'training_ring', { grantKey: `shared:${a}` });
    await expect(grant(t.db, svc, b, 'training_ring', { grantKey: `shared:${a}` })).rejects.toThrow(
      /already used for a different player or definition/,
    );
  });

  it('refuses an unknown or disabled definition, unless paying out an already-won reward', async () => {
    const player = await createPlayer(t.db);
    await expect(grant(t.db, svc, player, 'no_such_gear')).rejects.toBeInstanceOf(EquipmentDefinitionNotFoundError);
    await svc.definitions.create({ key: 'retired_ring', name: 'Retired Ring', slot: 'attack', rarity: 'N', ...fixedRange(4_000), enabled: false });
    await expect(grant(t.db, svc, player, 'retired_ring')).rejects.toBeInstanceOf(EquipmentDefinitionDisabledError);
    await expect(grant(t.db, svc, player, 'retired_ring', { allowDisabled: true })).resolves.toBeGreaterThan(0);
  });

  it.each([0, 6, 1.5])('refuses quantity %s', async (quantity) => {
    const player = await createPlayer(t.db);
    await expect(grant(t.db, svc, player, 'training_ring', { quantity })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('feature gating', () => {
  it('refuses equip, unequip and flags until Equipment is unlocked', async () => {
    const player = await createPlayer(t.db);
    const ring = await grant(t.db, svc, player, 'training_ring');
    await expect(svc.equipment.equip(player, { slot: 'attack', equipmentId: ring })).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(svc.equipment.unequip(player, { slot: 'attack' })).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(svc.equipment.setFlags(player, ring, { isFavorite: true })).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await loadoutCount(player)).toBe(0);

    await unlockEquipment(t.db, svc, player);
    const result = await svc.equipment.equip(player, { slot: 'attack', equipmentId: ring });
    expect(result.changed).toBe(true);
    expect(result.loadout.slots.attack?.id).toBe(ring);
  });
});

describe('equip and unequip', () => {
  let player: number;
  let ring: number;
  let coil: number;
  let belt: number;

  beforeAll(async () => {
    player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    ring = await grant(t.db, svc, player, 'training_ring');
    coil = await grant(t.db, svc, player, 'plasma_coil_ring');
    belt = await grant(t.db, svc, player, 'padded_belt');
  });

  it('reads a virtual empty loadout before anything is equipped', async () => {
    const fresh = await createPlayer(t.db);
    expect(await svc.equipment.getActiveLoadout(fresh)).toEqual({
      loadoutId: null,
      name: 'Default',
      slots: { attack: null, defense: null, health: null },
    });
    expect(await loadoutCount(fresh)).toBe(0);
  });

  it('equips, creating the Default loadout, and records the event', async () => {
    const result = await svc.equipment.equip(player, { slot: 'attack', equipmentId: ring }, { actorDiscordId: 'u-x' });
    expect(result).toMatchObject({ changed: true, previousEquipmentId: null });
    expect(result.loadout.name).toBe('Default');
    expect(result.loadout.slots.attack).toMatchObject({ id: ring, equipped: true });
    expect(await loadoutCount(player)).toBe(1);
    const [event] = await t.db
      .select()
      .from(equipmentEvents)
      .where(and(eq(equipmentEvents.playerId, player), eq(equipmentEvents.kind, 'equipped')));
    expect(event).toMatchObject({ equipmentId: ring, slot: 'attack', previousEquipmentId: null, actorDiscordId: 'u-x' });
  });

  it('is a no-op to equip what is already there', async () => {
    const before = await eventCount(player, 'equipped');
    const result = await svc.equipment.equip(player, { slot: 'attack', equipmentId: ring });
    expect(result.changed).toBe(false);
    expect(await eventCount(player, 'equipped')).toBe(before);
  });

  it('replaces the slot and reports what was there', async () => {
    const result = await svc.equipment.equip(player, { slot: 'attack', equipmentId: coil });
    expect(result).toMatchObject({ changed: true, previousEquipmentId: ring });
    expect(result.loadout.slots.attack?.id).toBe(coil);
    const [row] = await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, player));
    expect(row!.equipmentId).toBe(coil);
  });

  it('refuses the wrong slot', async () => {
    await expect(svc.equipment.equip(player, { slot: 'attack', equipmentId: belt })).rejects.toBeInstanceOf(
      EquipmentSlotMismatchError,
    );
    await expect(svc.equipment.equip(player, { slot: 'health', equipmentId: belt })).rejects.toBeInstanceOf(
      EquipmentSlotMismatchError,
    );
  });

  it('refuses an unknown slot', async () => {
    await expect(
      svc.equipment.equip(player, { slot: 'relic' as never, equipmentId: ring }),
    ).rejects.toBeInstanceOf(EquipmentValidationError);
  });

  it('answers foreign, removed and nonexistent ids identically', async () => {
    const other = await createPlayer(t.db);
    const foreign = await grant(t.db, svc, other, 'training_ring');
    const doomed = await grant(t.db, svc, player, 'training_ring');
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId: player, equipmentId: doomed, reason: 'test', actorDiscordId: 'admin' }),
    );
    const errors = await Promise.all(
      [foreign, doomed, 999_999_999, -1].map((id) =>
        thrown(svc.equipment.equip(player, { slot: 'attack', equipmentId: id })),
      ),
    );
    for (const err of errors) {
      expect(err).toBeInstanceOf(EquipmentNotOwnedError);
      expect((err as EquipmentNotOwnedError).userMessage).toBe("That equipment isn't in your gear bag.");
    }
  });

  it('still equips an instance whose definition was disabled', async () => {
    const legacy = await grant(t.db, svc, player, 'padded_belt');
    await svc.definitions.setEnabled('padded_belt', false);
    try {
      const result = await svc.equipment.equip(player, { slot: 'defense', equipmentId: legacy });
      expect(result.loadout.slots.defense?.id).toBe(legacy);
      expect(result.loadout.slots.defense?.definition.enabled).toBe(false);
    } finally {
      await svc.definitions.setEnabled('padded_belt', true);
    }
  });

  it('refuses a stale expectation, and honours a current one', async () => {
    const current = (await svc.equipment.getActiveLoadout(player)).slots.attack!.id;
    await expect(
      svc.equipment.equip(player, { slot: 'attack', equipmentId: ring, expectedCurrentId: 12345 }),
    ).rejects.toBeInstanceOf(LoadoutConflictError);
    await expect(
      svc.equipment.unequip(player, { slot: 'attack', expectedCurrentId: null }),
    ).rejects.toBeInstanceOf(LoadoutConflictError);
    const ok = await svc.equipment.equip(player, { slot: 'attack', equipmentId: ring, expectedCurrentId: current });
    expect(ok.loadout.slots.attack?.id).toBe(ring);
  });

  it('unequips, and unequipping an empty slot is a no-op', async () => {
    const result = await svc.equipment.unequip(player, { slot: 'attack' });
    expect(result).toMatchObject({ changed: true, previousEquipmentId: ring });
    expect(result.loadout.slots.attack).toBeNull();
    const again = await svc.equipment.unequip(player, { slot: 'attack' });
    expect(again.changed).toBe(false);
    expect(await eventCount(player, 'unequipped')).toBe(1);
  });
});

describe('listing', () => {
  let player: number;
  let ids: Record<string, number[]>;

  beforeAll(async () => {
    player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    ids = { ring: [], coil: [], belt: [], harness: [] };
    for (let i = 0; i < 3; i++) ids.ring!.push(await grant(t.db, svc, player, 'training_ring'));
    for (let i = 0; i < 2; i++) ids.coil!.push(await grant(t.db, svc, player, 'plasma_coil_ring'));
    ids.belt!.push(await grant(t.db, svc, player, 'padded_belt'));
    ids.harness!.push(await grant(t.db, svc, player, 'basic_harness'));
    await svc.equipment.equip(player, { slot: 'attack', equipmentId: ids.ring![0]! });
    await svc.equipment.setFlags(player, ids.coil![1]!, { isFavorite: true });
  });

  it('lists newest first, excluding other players and removed gear', async () => {
    const other = await createPlayer(t.db);
    await grant(t.db, svc, other, 'training_ring');
    const page = await svc.equipment.listEquipment(player);
    expect(page.items.map((i) => i.id)).toEqual([...Object.values(ids).flat()].sort((a, b) => b - a));
    expect(page.nextCursor).toBeNull();
  });

  it('filters by slot, equipped, favourite and text', async () => {
    const attack = await svc.equipment.listEquipment(player, { slot: 'attack' });
    expect(attack.items).toHaveLength(5);
    const equipped = await svc.equipment.listEquipment(player, { equipped: true });
    expect(equipped.items.map((i) => i.id)).toEqual([ids.ring![0]]);
    expect(equipped.items[0]!.equipped).toBe(true);
    expect((await svc.equipment.listEquipment(player, { equipped: false })).items).toHaveLength(6);
    expect((await svc.equipment.listEquipment(player, { favorite: true })).items.map((i) => i.id)).toEqual([ids.coil![1]]);
    expect((await svc.equipment.listEquipment(player, { q: 'COIL' })).items).toHaveLength(2);
    expect((await svc.equipment.listEquipment(player, { q: '%' })).items).toHaveLength(0);
    expect((await svc.equipment.listEquipment(player, { definitionKey: 'padded_belt' })).items).toHaveLength(1);
  });

  it.each(['acquired', 'multiplier', 'rarity', 'name'] as const)(
    'pages by %s with a keyset cursor, with no gaps or repeats',
    async (sort) => {
      const all = (await svc.equipment.listEquipment(player, { sort, limit: 100 })).items.map((i) => i.id);
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page = await svc.equipment.listEquipment(player, { sort, limit: 2, cursor });
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(7);
    },
  );

  it('orders by multiplier, highest first', async () => {
    const page = await svc.equipment.listEquipment(player, { sort: 'multiplier' });
    const multipliers = page.items.map((i) => i.rolledMultiplierBp);
    expect(multipliers).toEqual([...multipliers].sort((a, b) => b - a));
    expect(multipliers[0]).toBe(20_000);
  });

  it('refuses a malformed cursor, or one from another sort', async () => {
    await expect(svc.equipment.listEquipment(player, { cursor: 'garbage' })).rejects.toBeInstanceOf(EquipmentValidationError);
    const page = await svc.equipment.listEquipment(player, { sort: 'name', limit: 1 });
    await expect(
      svc.equipment.listEquipment(player, { sort: 'acquired', cursor: page.nextCursor }),
    ).rejects.toBeInstanceOf(EquipmentValidationError);
  });

  it('groups identical gear, preferring an unequipped representative', async () => {
    const groups = await svc.equipment.listEquipmentGroups(player);
    const ring = groups.find((g) => g.definition.key === 'training_ring')!;
    expect(ring).toMatchObject({ count: 3, equippedCount: 1, favoriteCount: 0 });
    expect(ring.instanceIds).toEqual(ids.ring);
    expect(ring.representativeId).toBe(ids.ring![1]);
    expect(groups.find((g) => g.definition.key === 'plasma_coil_ring')).toMatchObject({ count: 2, favoriteCount: 1 });
    // Default sort: highest multiplier first.
    expect(groups.map((g) => g.definition.key)).toEqual([
      'basic_harness',
      'plasma_coil_ring',
      'training_ring',
      'padded_belt',
    ]);
    expect((await svc.equipment.listEquipmentGroups(player, { slot: 'defense' })).map((g) => g.definition.key)).toEqual([
      'padded_belt',
    ]);
  });

  it('reads one owned instance, or null for anyone else’s', async () => {
    expect(await svc.equipment.getOwned(player, ids.ring![0]!)).toMatchObject({ id: ids.ring![0], equipped: true });
    const other = await createPlayer(t.db);
    expect(await svc.equipment.getOwned(other, ids.ring![0]!)).toBeNull();
  });
});

describe('setFlags', () => {
  it('updates flags and records only real changes', async () => {
    const player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    const ring = await grant(t.db, svc, player, 'training_ring');
    const view = await svc.equipment.setFlags(player, ring, { isLocked: true });
    expect(view).toMatchObject({ isLocked: true, isFavorite: false });
    await svc.equipment.setFlags(player, ring, { isLocked: true });
    expect(await eventCount(player, 'flag_changed')).toBe(1);
    await expect(svc.equipment.setFlags(player, ring, {})).rejects.toBeInstanceOf(EquipmentValidationError);
    const other = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, other);
    await expect(svc.equipment.setFlags(other, ring, { isFavorite: true })).rejects.toBeInstanceOf(EquipmentNotOwnedError);
  });
});

describe('adminRemove', () => {
  it('clears the instance from every loadout, soft-removes it and audits it', async () => {
    const player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    const ring = await grant(t.db, svc, player, 'training_ring');
    await svc.equipment.equip(player, { slot: 'attack', equipmentId: ring });
    // A preset holding the same instance (presets have no service yet).
    const [preset] = await t.db
      .insert(playerLoadouts)
      .values({ playerId: player, name: 'Boss Killer', isActive: false })
      .returning();
    await t.db.insert(playerLoadoutSlots).values({ loadoutId: preset!.id, playerId: player, slot: 'attack', equipmentId: ring });

    const result = await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId: player, equipmentId: ring, reason: 'duplicate grant', actorDiscordId: 'admin-7' }),
    );
    expect(result.clearedLoadoutIds).toHaveLength(2);
    expect(await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.equipmentId, ring))).toEqual([]);
    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, ring));
    expect(row!.removedAt).not.toBeNull();
    expect(row!.removedReason).toBe('duplicate grant');
    expect((await svc.equipment.listEquipment(player)).items).toEqual([]);
    expect(await eventCount(player, 'removed')).toBe(1);
    const audits = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(and(eq(playerProgressionEvents.playerId, player), eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ action: 'remove_equipment', adminDiscordId: 'admin-7', reason: 'duplicate grant' });

    // Removed means gone for every later action.
    await expect(
      t.db.transaction((tx) =>
        svc.equipment.adminRemove(tx, { playerId: player, equipmentId: ring, reason: 'again', actorDiscordId: 'admin-7' }),
      ),
    ).rejects.toBeInstanceOf(EquipmentNotOwnedError);
  });

  it('respects the lock unless explicitly overridden, and says so in the audit', async () => {
    const player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    const ring = await grant(t.db, svc, player, 'training_ring');
    await svc.equipment.setFlags(player, ring, { isLocked: true });
    const remove = (overrideLock?: boolean) =>
      t.db.transaction((tx) =>
        svc.equipment.adminRemove(tx, {
          playerId: player,
          equipmentId: ring,
          reason: 'r',
          actorDiscordId: 'admin',
          ...(overrideLock === undefined ? {} : { overrideLock }),
        }),
      );
    await expect(remove()).rejects.toBeInstanceOf(EquipmentLockedError);
    await remove(true);
    const [audit] = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(and(eq(playerProgressionEvents.playerId, player), eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT)));
    expect(audit!.metadata).toMatchObject({ wasLocked: true, overrideLock: true });
  });

  it('requires an actor and a reason', async () => {
    const player = await createPlayer(t.db);
    const ring = await grant(t.db, svc, player, 'training_ring');
    await expect(
      t.db.transaction((tx) => svc.equipment.adminRemove(tx, { playerId: player, equipmentId: ring, reason: ' ', actorDiscordId: 'a' })),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      t.db.transaction((tx) => svc.equipment.adminRemove(tx, { playerId: player, equipmentId: ring, reason: 'r', actorDiscordId: '' })),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('featureUnlocks', () => {
  it('unlocks once, reporting only the first call as new', async () => {
    const player = await createPlayer(t.db);
    const unlock = () =>
      t.db.transaction((tx) =>
        svc.featureUnlocks.unlock(tx, { playerId: player, featureKey: 'equipment', source: 'onboarding', sourceRef: 'we:1' }),
      );
    expect((await unlock()).newlyUnlocked).toBe(true);
    const again = await unlock();
    expect(again.newlyUnlocked).toBe(false);
    expect(again.unlock).toMatchObject({ source: 'onboarding', sourceRef: 'we:1' });
    expect(await svc.featureUnlocks.isUnlocked(player, 'equipment')).toBe(true);
    expect(await svc.featureUnlocks.listUnlocked(player)).toHaveLength(1);
  });

  it('audits admin unlocks and revokes, and requires an actor', async () => {
    const player = await createPlayer(t.db);
    await expect(
      t.db.transaction((tx) => svc.featureUnlocks.unlock(tx, { playerId: player, featureKey: 'equipment', source: 'admin' })),
    ).rejects.toBeInstanceOf(RangeError);
    await t.db.transaction((tx) =>
      svc.featureUnlocks.unlock(tx, { playerId: player, featureKey: 'equipment', source: 'admin', actorDiscordId: 'owner' }),
    );
    const [row] = await t.db.select().from(playerFeatureUnlocks).where(eq(playerFeatureUnlocks.playerId, player));
    expect(row).toMatchObject({ source: 'admin', unlockedBy: 'owner' });

    const revoked = await t.db.transaction((tx) =>
      svc.featureUnlocks.revoke(tx, { playerId: player, featureKey: 'equipment', actorDiscordId: 'owner', reason: 'reset tester' }),
    );
    expect(revoked.revoked).toBe(true);
    expect(await svc.featureUnlocks.isUnlocked(player, 'equipment')).toBe(false);
    const audits = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(and(eq(playerProgressionEvents.playerId, player), eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT)));
    expect(audits.map((a) => (a.metadata as { action: string }).action).sort()).toEqual([
      'revoke_feature_equipment',
      'unlock_feature_equipment',
    ]);
    expect(audits.find((a) => (a.metadata as { action: string }).action === 'revoke_feature_equipment')!.metadata).toMatchObject({
      reason: 'reset tester',
      targetDiscordId: expect.any(String),
      guildId: expect.any(String),
    });
  });
});
