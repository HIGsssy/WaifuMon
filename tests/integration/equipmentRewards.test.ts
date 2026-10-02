/**
 * The shared Equipment reward path, against a real database and the seeded
 * catalogue: a selector picks the base definition, `grantEquipment` rolls the
 * instance, and a grant key replays the whole reward — definition, multiplier,
 * affix and instance — instead of drawing again.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { equipmentEvents, playerEquipment, players } from '../../src/db/schema';
import { affixPoolOf } from '../../src/modules/equipment/affixCatalogue';
import {
  createEquipmentRewardService,
  type EquipmentRewardService,
} from '../../src/modules/equipment/equipmentRewardService';
import { isMultiplierInRange } from '../../src/modules/equipment/equipmentRoll';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { EquipmentRewardConfigError, FeatureLockedError } from '../../src/shared/errors';
import { seededRng, type Rng } from '../../src/shared/random';
import { CONTENT_DIR } from '../helpers/fixtures';
import {
  TEST_AFFIXES,
  buildEquipmentServices,
  createPlayer,
  grant,
  starterRoll,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let svc: EquipmentServices;
let rewards: EquipmentRewardService;
let playerId: number;

/** Scripted base-definition picks; unscripted calls answer `min`. */
let picks: number[] = [];
const pickRng: Rng = {
  next: () => 0,
  intInclusive(min, max) {
    const v = picks.length > 0 ? picks.shift()! : min;
    if (v < min || v > max) throw new Error(`scripted pick ${v} outside [${min}, ${max}]`);
    return v;
  },
};

beforeAll(async () => {
  t = await createTestDb();
  // The instance roll (multiplier, affix) is seeded, not scripted: these tests
  // assert it is *valid* and *stable*, never which value it landed on.
  svc = buildEquipmentServices(t.db, { rng: seededRng(99) });
  rewards = createEquipmentRewardService({ equipment: svc.equipment, getAffixes: svc.getAffixes, featureUnlocks: svc.featureUnlocks, rng: pickRng });
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  picks = [];
  playerId = await createPlayer(t.db);
  // Random gear needs the Equipment feature; the eligibility rule has its own tests below.
  await unlockEquipment(t.db, svc, playerId);
  for (const key of ['throbbing_mace', 'combat_knife', 'kevlar_carrier']) await svc.definitions.setEnabled(key, true);
});

const grantRandom = (selector: Parameters<EquipmentRewardService['grantRandomEquipmentReward']>[1]['selector'], extra = {}) =>
  t.db.transaction((tx) =>
    rewards.grantRandomEquipmentReward(tx, { playerId, selector, source: { type: 'admin', key: 'test' }, ...extra }),
  );

async function instanceRow(id: number) {
  const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, id));
  return row!;
}

describe('selection', () => {
  it('any selector grants one enabled N/R/SR definition', async () => {
    const reward = await grantRandom({});
    expect(['N', 'R', 'SR']).toContain(reward.rarity);
    expect(reward.alreadyGranted).toBe(false);
  });

  it('filters by slot', async () => {
    for (let i = 0; i < 6; i += 1) {
      picks = [i];
      expect((await grantRandom({ slot: 'defense' })).slot).toBe('defense');
    }
  });

  it('filters by rarity', async () => {
    for (let i = 0; i < 6; i += 1) {
      picks = [i];
      expect((await grantRandom({ rarity: 'R' })).rarity).toBe('R');
    }
  });

  it('combines slot and rarity — N Attack draws only from the N attack catalogue', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      picks = [i];
      const reward = await grantRandom({ slot: 'attack', rarity: 'N' });
      expect(reward.slot).toBe('attack');
      expect(reward.rarity).toBe('N');
      seen.add(reward.definitionKey);
    }
    expect(seen).toEqual(
      new Set(['rusty_pipe', 'starter_pistol', 'stun_baton', 'suction_cup_morningstar', 'throwing_knives', 'weighted_wand']),
    );
  });

  it('honours an explicit whitelist', async () => {
    picks = [1];
    expect((await grantRandom({ definitionKeys: ['semi_auto_sidearm', 'combat_knife'] })).definitionKey).toBe(
      'semi_auto_sidearm',
    );
  });

  it('combines a whitelist with a rarity', async () => {
    picks = [0];
    expect((await grantRandom({ rarity: 'R', definitionKeys: ['combat_knife', 'tower_shield'] })).definitionKey).toBe(
      'combat_knife',
    );
  });

  it('never selects a disabled definition', async () => {
    await svc.definitions.setEnabled('throbbing_mace', false);
    for (let i = 0; i < 2; i += 1) {
      picks = [i];
      expect((await grantRandom({ slot: 'attack', rarity: 'R' })).definitionKey).not.toBe('throbbing_mace');
    }
  });

  it('uses whatever Health definitions exist, without special-casing', async () => {
    expect((await grantRandom({ slot: 'health' })).definitionKey).toBe('dented_lunchbox');
  });

  it('is deterministic for an injected RNG', async () => {
    const run = async () => {
      const out: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const tx = (await t.db.transaction((tx) =>
          rewards.grantRandomEquipmentReward(tx, {
            playerId,
            selector: { rarity: 'R' },
            source: { type: 'admin' },
            rng: seededRng(1000 + i),
          }),
        ));
        out.push(tx.definitionKey);
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });
});

describe('eligibility: the Equipment feature unlock', () => {
  const eligible = (id: number) => t.db.transaction((tx) => rewards.canReceiveRandomEquipmentRewards(tx, id));
  const gearOf = (id: number) => t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, id));

  it('a player without the unlock is not eligible; one with it is', async () => {
    const locked = await createPlayer(t.db);
    expect(await eligible(locked)).toBe(false);
    expect(await eligible(playerId)).toBe(true);
  });

  it('level 35 and beyond is not enough — only the unlock counts', async () => {
    const veteran = await createPlayer(t.db);
    await t.db.update(players).set({ level: 80 }).where(eq(players.id, veteran));
    expect(await eligible(veteran)).toBe(false);
    await unlockEquipment(t.db, svc, veteran);
    expect(await eligible(veteran)).toBe(true);
  });

  it('both reward grants refuse a locked player and persist nothing', async () => {
    const locked = await createPlayer(t.db);
    const common = { playerId: locked, source: { type: 'boss' as const, key: 'test' } };
    await expect(
      t.db.transaction((tx) => rewards.grantRandomEquipmentReward(tx, { ...common, selector: {}, grantKey: 'lock:a' })),
    ).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(
      t.db.transaction((tx) =>
        rewards.grantChosenEquipmentReward(tx, { ...common, definitionKey: 'combat_knife', grantKey: 'lock:b' }),
      ),
    ).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await gearOf(locked)).toEqual([]);
  });

  it('a reward the source promised while the player was eligible still pays', async () => {
    const revoked = await createPlayer(t.db);
    const reward = await t.db.transaction((tx) =>
      rewards.grantChosenEquipmentReward(tx, {
        playerId: revoked,
        definitionKey: 'combat_knife',
        source: { type: 'expedition', key: 'test' },
        grantKey: 'promised:1',
        promised: true,
      }),
    );
    expect(reward.definitionKey).toBe('combat_knife');
    expect((await gearOf(revoked)).map((r) => r.id)).toEqual([reward.equipmentId]);
  });

  it('explicit grants — onboarding starters, admin — still use the core path without the unlock', async () => {
    const locked = await createPlayer(t.db);
    await t.db.update(players).set({ level: 35 }).where(eq(players.id, locked));
    const starter = await grant(t.db, svc, locked, 'rusty_pipe', {
      source: { type: 'onboarding', key: 'equipment' },
      ...starterRoll('rusty_pipe'),
    });
    const admin = await grant(t.db, svc, locked, 'combat_knife');
    const rows = await gearOf(locked);
    expect(rows.map((r) => r.id).sort()).toEqual([starter, admin].sort());
    expect(rows.find((r) => r.id === starter)!).toMatchObject({ sourceType: 'onboarding', rolledMultiplierBp: 4_500, affixKey: null });
    expect(await eligible(locked)).toBe(false);
  });
});

describe('refusals', () => {
  const refused = async (selector: Record<string, unknown>, pattern: RegExp) => {
    const before = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    const err = await grantRandom(selector as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EquipmentRewardConfigError);
    expect(String((err as Error).message)).toMatch(pattern);
    const after = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    expect(after).toHaveLength(before.length);
  };

  it('rejects an unknown explicit key', () => refused({ definitionKeys: ['combat_knife', 'imaginary_blade'] }, /imaginary_blade/));
  it('rejects a disabled explicit key', async () => {
    await svc.definitions.setEnabled('combat_knife', false);
    await refused({ definitionKeys: ['combat_knife'] }, /disabled/);
  });
  it('rejects an explicit key of the wrong slot', () => refused({ slot: 'defense', definitionKeys: ['combat_knife'] }, /attack gear/));
  it('rejects an explicit key of the wrong rarity', () => refused({ rarity: 'N', definitionKeys: ['combat_knife'] }, /is R/));
  it('fails clearly when nothing is eligible — no substitute, no starter', () =>
    refused({ slot: 'health', rarity: 'SR' }, /no enabled equipment definition matches "Any SR Health Equipment"/));
  it('rejects a malformed selector', () => refused({ rarity: 'SSR' }, /rarity/));
});

describe('the granted instance', () => {
  it('carries a multiplier from the definition range and an affix from its own pool', async () => {
    for (let i = 0; i < 8; i += 1) {
      picks = [i % 4];
      const reward = await grantRandom({ rarity: 'R' });
      const definition = (await svc.definitions.getByKey(reward.definitionKey))!;
      expect(isMultiplierInRange(definition, reward.rolledMultiplierBp)).toBe(true);
      expect(reward.affixKey).not.toBeNull();
      expect(TEST_AFFIXES.get(reward.affixKey!)!.pool).toBe(affixPoolOf(definition));
      expect(reward.displayName).toBe(`${definition.name} ${TEST_AFFIXES.get(reward.affixKey!)!.suffix}`);
      const row = await instanceRow(reward.equipmentId);
      expect(row.rolledMultiplierBp).toBe(reward.rolledMultiplierBp);
      expect(row.affixKey).toBe(reward.affixKey);
    }
  });

  it('records the real source on the instance and the grant event', async () => {
    const reward = await t.db.transaction((tx) =>
      rewards.grantRandomEquipmentReward(tx, {
        playerId,
        selector: { rarity: 'N' },
        source: { type: 'boss', key: 'big_bad' },
        grantKey: `test-source-${playerId}`,
      }),
    );
    const row = await instanceRow(reward.equipmentId);
    expect(row.sourceType).toBe('boss');
    expect(row.sourceKey).toBe('big_bad');
    const [event] = await t.db
      .select()
      .from(equipmentEvents)
      .where(and(eq(equipmentEvents.equipmentId, reward.equipmentId), eq(equipmentEvents.kind, 'granted')));
    expect(event!.metadata).toMatchObject({ sourceType: 'boss', sourceKey: 'big_bad', rollKind: 'random' });
  });
});

describe('idempotency', () => {
  it('a retry returns the same definition, affix, multiplier and instance — and draws nothing', async () => {
    const grantKey = `retry-${playerId}`;
    picks = [0];
    const first = await grantRandom({ rarity: 'R' }, { grantKey });
    // A different scripted pick would select another definition if the retry drew again.
    picks = [3];
    const second = await grantRandom({ rarity: 'R' }, { grantKey });
    expect(picks).toEqual([3]);
    expect(second).toEqual({ ...first, alreadyGranted: true });
    const rows = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  it('a retry still replays after the definition was disabled, rather than failing or re-selecting', async () => {
    const grantKey = `retry-disabled-${playerId}`;
    const first = await grantRandom({ definitionKeys: ['combat_knife'] }, { grantKey });
    await svc.definitions.setEnabled('combat_knife', false);
    const second = await grantRandom({ definitionKeys: ['combat_knife'] }, { grantKey });
    expect(second.equipmentId).toBe(first.equipmentId);
  });

  it('a chosen-definition grant replays the same way', async () => {
    const grantKey = `chosen-${playerId}`;
    const pay = () =>
      t.db.transaction((tx) =>
        rewards.grantChosenEquipmentReward(tx, {
          playerId,
          definitionKey: 'kevlar_carrier',
          source: { type: 'expedition', key: 'm' },
          grantKey,
        }),
      );
    const first = await pay();
    const second = await pay();
    expect(second).toEqual({ ...first, alreadyGranted: true });
  });

  it('a grant rolled back with its caller leaves nothing behind', async () => {
    const grantKey = `rollback-${playerId}`;
    await expect(
      t.db.transaction(async (tx) => {
        await rewards.grantRandomEquipmentReward(tx, { playerId, selector: {}, source: { type: 'admin' }, grantKey });
        throw new Error('caller failed after the grant');
      }),
    ).rejects.toThrow('caller failed');
    const rows = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    expect(rows).toEqual([]);
  });
});
