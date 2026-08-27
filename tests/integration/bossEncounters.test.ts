/**
 * Boss encounters end to end — real Postgres, real transactions, real
 * constraints.
 *
 * The four properties this file exists to prove:
 *
 *   1. Committing writes a participation and **nothing else** — no XP, no
 *      items, no damage.
 *   2. Resolution pays exactly once, no matter how many times it is retried or
 *      how many processes race it.
 *   3. The participation snapshot is authoritative: changing buddies, levelling
 *      up, or releasing the copy afterwards cannot rewrite the battle.
 *   4. The database, not the application, enforces one active encounter per
 *      guild and one participation per player.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bossEncounters,
  bossParticipations,
  guildBossState,
  items,
  playerInventory,
  playerWaifus,
  players,
  species,
  type BossEncounterRow,
} from '../../src/db/schema';
import { computeBattleDamage } from '../../src/modules/bosses/bossDamage';
import { bossDrawInt } from '../../src/modules/bosses/bossRandom';
import { currentSeductivePower } from '../../src/modules/power/seductivePower';
import {
  BossAlreadyCommittedError,
  BossEncounterNotFoundError,
  BossEncounterNotOpenError,
  BossNoActiveBuddyError,
} from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import {
  bootstrapApp,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let guildDbId: number;
let playerId: number;
let otherPlayerId: number;

const MINUTE = 60_000;
const IDENTITY = { discordUserId: 'u-1', trainerName: 'Whistler' };
const OTHER_IDENTITY = { discordUserId: 'u-2', trainerName: 'Ian' };

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { bossRng: seededRng(1234) });
  ({ guildDbId, playerId } = await provisionPlayer(app, 'g-boss', 'u-1'));
  ({ playerId: otherPlayerId } = await provisionPlayer(app, 'g-boss', 'u-2'));
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.delete(playerInventory);
  await t.db.update(players).set({ buddyWaifuId: null });
  await t.db.delete(playerWaifus);
});

/** A species with a known affinity, so matchups are chosen rather than found. */
async function speciesWithAffinity(affinity: string): Promise<{ id: number; rarity: string }> {
  const [row] = await t.db
    .select({ id: species.id, rarity: species.rarity })
    .from(species)
    .where(and(eq(species.affinity, affinity), eq(species.enabled, true)))
    .limit(1);
  if (!row) throw new Error(`no enabled species with affinity ${affinity}`);
  return row;
}

/** Give a player an owned copy and make it their active buddy. */
async function giveBuddy(
  target: number,
  opts: { affinity?: string; level?: number; baseSp?: number } = {},
): Promise<{ waifuId: number; currentSp: number; level: number }> {
  const sp = await speciesWithAffinity(opts.affinity ?? 'switch');
  const level = opts.level ?? 24;
  const baseSp = opts.baseSp ?? 150;
  const waifu = await insertOwnedWaifu(t.db, {
    playerId: target,
    speciesId: sp.id,
    level,
    xp: 0,
    baseSp,
  });
  await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, target));
  return {
    waifuId: waifu.id,
    level,
    currentSp: currentSeductivePower(baseSp, level, app.content.tables.waifuProgression.maxLevel),
  };
}

/** Open a scouting window directly, so a test controls its clock. */
async function openEncounter(
  overrides: Partial<typeof bossEncounters.$inferInsert> = {},
  guild = guildDbId,
): Promise<BossEncounterRow> {
  const boss = app.content.bosses[0]!;
  const now = new Date();
  const [row] = await t.db
    .insert(bossEncounters)
    .values({
      guildId: guild,
      region: 'waifu-valley',
      bossId: boss.id,
      bossName: boss.name,
      bossAffinity: boss.affinity,
      bossArtwork: null,
      rewardTable: boss.rewardTable,
      rewardTableVersion: 'standard-scouting-v1',
      calcVersion: 1,
      affinityVersion: 1,
      channelId: 'c-boss',
      messageId: 'm-1',
      status: 'scouting',
      scheduledAt: now,
      scoutingStartedAt: now,
      deadlineAt: new Date(now.getTime() + 60 * MINUTE),
      ...overrides,
    })
    .returning();
  return row!;
}

// ── scheduling ──────────────────────────────────────────────────────────────

describe('spawning', () => {
  it('draws a boss and persists it as scheduled', async () => {
    const spawn = await app.bosses.spawnIfDue(guildDbId);
    expect(spawn).not.toBeNull();
    expect(spawn!.encounter.status).toBe('scheduled');
    expect(spawn!.encounter.bossName).toBe(spawn!.boss.name);
    // Content is snapshotted onto the row, not looked up at read time.
    expect(spawn!.encounter.rewardTableVersion).toBe('standard-scouting-v1');
    expect(spawn!.encounter.calcVersion).toBe(1);
    expect(spawn!.encounter.forced).toBe(false);
  });

  it('refuses a second encounter while one is active', async () => {
    await app.bosses.spawnIfDue(guildDbId);
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
    const rows = await t.db.select().from(bossEncounters);
    expect(rows).toHaveLength(1);
  });

  it('is enforced by the database, not only by the read', async () => {
    await app.bosses.spawnIfDue(guildDbId);
    const boss = app.content.bosses[0]!;
    // Bypass the service entirely — the partial unique index is the guarantee.
    await expect(
      t.db.insert(bossEncounters).values({
        guildId: guildDbId,
        region: 'waifu-valley',
        bossId: boss.id,
        bossName: boss.name,
        bossAffinity: boss.affinity,
        rewardTable: boss.rewardTable,
        rewardTableVersion: 'v1',
        calcVersion: 1,
        affinityVersion: 1,
        status: 'scouting',
        scheduledAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('isolates guilds — two servers each get their own encounter', async () => {
    const other = await provisionPlayer(app, 'g-boss-2', 'u-9');
    const first = await app.bosses.spawnIfDue(guildDbId);
    const second = await app.bosses.spawnIfDue(other.guildDbId);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.encounter.guildId).not.toBe(second!.encounter.guildId);
  });

  it('does not spawn before the persisted next appearance', async () => {
    await app.bosses.ensureState(guildDbId);
    await t.db
      .update(guildBossState)
      .set({ nextSpawnAt: new Date(Date.now() + 3 * 60 * MINUTE) })
      .where(eq(guildBossState.guildId, guildDbId));
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
  });

  it('does not spawn while paused', async () => {
    await app.bosses.setPaused(guildDbId, true);
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
    await app.bosses.setPaused(guildDbId, false);
    expect(await app.bosses.spawnIfDue(guildDbId)).not.toBeNull();
  });

  it('does not spawn while suspended', async () => {
    await app.bosses.suspend(guildDbId, 'channel gone');
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
    await app.bosses.clearSuspension(guildDbId);
    expect(await app.bosses.spawnIfDue(guildDbId)).not.toBeNull();
  });

  it('keeps the suspension clock at the first failure', async () => {
    await app.bosses.suspend(guildDbId, 'first reason');
    const [first] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    await new Promise((r) => setTimeout(r, 10));
    await app.bosses.suspend(guildDbId, 'second reason');
    const [second] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    // The operator wants to know how long it has been broken, not when the
    // scheduler last re-noticed.
    expect(second!.suspendedAt!.getTime()).toBe(first!.suspendedAt!.getTime());
    expect(second!.suspendedReason).toBe('second reason');
  });

  it('consumes the shuffle bag and persists what is still owed', async () => {
    const spawn = await app.bosses.spawnIfDue(guildDbId);
    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    const bag = state!.bagState as { remaining: string[]; lastBossId: string };
    expect(bag.remaining).toHaveLength(app.content.bosses.length - 1);
    expect(bag.remaining).not.toContain(spawn!.boss.id);
    expect(bag.lastBossId).toBe(spawn!.boss.id);
  });
});

describe('force spawn', () => {
  it('marks the encounter as forced and leaves the shuffle bag alone', async () => {
    const before = await app.bosses.spawnIfDue(guildDbId);
    await app.bosses.cancel(before!.encounter.id, 'cancelled_admin');
    const [beforeState] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));

    const forced = await app.bosses.forceSpawn(guildDbId, 'karen_managerbane');
    expect(forced.encounter.forced).toBe(true);
    expect(forced.boss.id).toBe('karen_managerbane');

    const [afterState] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    // A live test must not consume a draw the rotation still owes the players.
    expect(afterState!.bagState).toEqual(beforeState!.bagState);
  });

  it('rejects a boss id that is not an enabled boss in the region', async () => {
    await expect(app.bosses.forceSpawn(guildDbId, 'not_a_boss')).rejects.toThrow(
      /not an enabled boss/,
    );
  });
});

// ── commitment ──────────────────────────────────────────────────────────────

describe('committing a buddy', () => {
  it('refuses when the player has no active buddy', async () => {
    const encounter = await openEncounter();
    await expect(app.bosses.preview(encounter.id, guildDbId, playerId)).rejects.toThrow(
      BossNoActiveBuddyError,
    );
  });

  it('previews without writing anything', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId);
    const preview = await app.bosses.preview(encounter.id, guildDbId, playerId);

    expect(preview.currentSp).toBe(buddy.currentSp);
    expect(preview.level).toBe(buddy.level);
    expect(preview.estimate.min).toBeLessThan(preview.estimate.max);
    // The whole point of the preview: nothing exists yet.
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
  });

  it('quotes exactly the closed interval the real roll can land in', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    const preview = await app.bosses.preview(encounter.id, guildDbId, playerId);
    const inputs = {
      currentSp: preview.currentSp,
      attacks: app.content.tables.bossEncounters.attacksPerParticipation,
      affinityBonus: preview.affinityBonus,
      responseBonus: preview.responseBonus,
    };
    expect(preview.estimate.min).toBe(
      computeBattleDamage({ ...inputs, performancePercent: 85 }),
    );
    expect(preview.estimate.max).toBe(
      computeBattleDamage({ ...inputs, performancePercent: 115 }),
    );
  });

  it('grants the affinity advantage to the superior buddy only', async () => {
    // The boss ships as Dominant, which Switch beats.
    const encounter = await openEncounter({ bossAffinity: 'dominant' });
    await giveBuddy(playerId, { affinity: 'switch' });
    expect((await app.bosses.preview(encounter.id, guildDbId, playerId)).affinityBonus).toBe(0.1);

    await giveBuddy(otherPlayerId, { affinity: 'submissive' });
    expect(
      (await app.bosses.preview(encounter.id, guildDbId, otherPlayerId)).affinityBonus,
    ).toBe(0);
  });

  it('creates the participation only on confirm, and awards nothing', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId);
    const before = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifuId));

    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );

    expect(participation.rewardStatus).toBe('pending');
    expect(participation.totalDamage).toBeNull();
    expect(participation.xpAwarded).toBeNull();
    expect(participation.rewardItems).toBeNull();

    // No XP, no items — the buddy row and the inventory are untouched.
    const [after] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifuId));
    expect(after!.xp).toBe(before[0]!.xp);
    expect(after!.level).toBe(before[0]!.level);
    expect(await t.db.select().from(playerInventory)).toHaveLength(0);
  });

  it('snapshots every stat the formula reads', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId, { affinity: 'switch', level: 24, baseSp: 150 });
    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );

    expect(participation.waifuId).toBe(buddy.waifuId);
    expect(participation.level).toBe(24);
    expect(participation.baseSp).toBe(150);
    expect(participation.currentSp).toBe(buddy.currentSp);
    expect(participation.affinity).toBe('switch');
    expect(participation.rarity).toBeTruthy();
    expect(participation.race).toBeTruthy();
    expect(participation.speciesSlug).toBeTruthy();
    // Discord identity too, so a result renders without resolving a member.
    expect(participation.discordUserId).toBe('u-1');
    expect(participation.trainerName).toBe('Whistler');
    expect(participation.attackCount).toBe(10);
  });

  it('freezes the response bonus at commitment', async () => {
    const now = new Date();
    const encounter = await openEncounter({
      scoutingStartedAt: new Date(now.getTime() - 40 * MINUTE),
      deadlineAt: new Date(now.getTime() + 20 * MINUTE),
    });
    await giveBuddy(playerId);
    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );
    // Committed 40 minutes in — past both brackets.
    expect(participation.responseBonus).toBe(0);
  });

  it('pays the rapid-response bonus to an early commitment', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );
    expect(participation.responseBonus).toBe(0.05);
  });

  it('rejects a second confirmed participation from the same player', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    await expect(
      app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY),
    ).rejects.toThrow(BossAlreadyCommittedError);
    expect(await t.db.select().from(bossParticipations)).toHaveLength(1);
  });

  it('survives concurrent duplicate submissions with exactly one participation', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    // A double-clicked Confirm: both requests reach the service at once.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await t.db.select().from(bossParticipations)).toHaveLength(1);
  });

  it('refuses a preview once the player has already committed', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    await expect(app.bosses.preview(encounter.id, guildDbId, playerId)).rejects.toThrow(
      BossAlreadyCommittedError,
    );
  });

  it('lets a player switch buddies and re-preview before confirming', async () => {
    const encounter = await openEncounter();
    const first = await giveBuddy(playerId, { affinity: 'switch', baseSp: 150 });
    const before = await app.bosses.preview(encounter.id, guildDbId, playerId);
    expect(before.waifuId).toBe(first.waifuId);

    const second = await giveBuddy(playerId, { affinity: 'primal', baseSp: 120, level: 10 });
    const after = await app.bosses.preview(encounter.id, guildDbId, playerId);
    expect(after.waifuId).toBe(second.waifuId);
    expect(after.currentSp).toBe(second.currentSp);
    // Still nothing written across two previews and a swap.
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
  });

  it('locks the snapshot after confirmation — a later swap changes nothing', async () => {
    const encounter = await openEncounter();
    const committed = await giveBuddy(playerId, { level: 24, baseSp: 150 });
    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );
    await giveBuddy(playerId, { level: 50, baseSp: 190 });

    const [stored] = await t.db
      .select()
      .from(bossParticipations)
      .where(eq(bossParticipations.id, participation.id));
    expect(stored!.waifuId).toBe(committed.waifuId);
    expect(stored!.currentSp).toBe(committed.currentSp);
    expect(stored!.level).toBe(24);
  });

  it('rejects a button from another guild', async () => {
    const other = await provisionPlayer(app, 'g-boss-3', 'u-8');
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    await expect(
      app.bosses.preview(encounter.id, other.guildDbId, playerId),
    ).rejects.toThrow(BossEncounterNotFoundError);
  });

  it('rejects a commitment after the deadline, before the scheduler notices', async () => {
    const past = new Date(Date.now() - 5 * MINUTE);
    const encounter = await openEncounter({
      scoutingStartedAt: new Date(past.getTime() - 60 * MINUTE),
      deadlineAt: past,
    });
    await giveBuddy(playerId);
    await expect(app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY)).rejects.toThrow(
      BossEncounterNotOpenError,
    );
  });

  it('rejects a stale button pointing at a resolved encounter', async () => {
    const encounter = await openEncounter({ status: 'resolved', resolvedAt: new Date() });
    await giveBuddy(playerId);
    await expect(app.bosses.preview(encounter.id, guildDbId, playerId)).rejects.toThrow(
      BossEncounterNotOpenError,
    );
  });

  it('rejects a participation for a nonexistent encounter', async () => {
    await giveBuddy(playerId);
    await expect(app.bosses.preview(999_999, guildDbId, playerId)).rejects.toThrow(
      BossEncounterNotFoundError,
    );
  });

  it('enforces one participation per player with a database constraint', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId);
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    // Bypass the service — the unique index is the guarantee.
    await expect(
      t.db.insert(bossParticipations).values({
        encounterId: encounter.id,
        playerId,
        discordUserId: 'u-1',
        trainerName: 'Whistler',
        waifuId: buddy.waifuId,
        speciesId: 1,
        speciesSlug: 'x',
        waifuName: 'x',
        level: 1,
        baseSp: 100,
        currentSp: 100,
        rarity: 'N',
        affinity: 'switch',
        race: 'human',
        affection: 0,
      }),
    ).rejects.toThrow();
  });
});

// ── resolution ──────────────────────────────────────────────────────────────

describe('resolution', () => {
  it('pays XP and items, and records immutable damage', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId, { level: 10, baseSp: 150 });
    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );

    const result = await app.bosses.resolve(encounter.id);
    expect(result!.applied).toBe(true);
    expect(result!.reason).toBe('repelled');
    expect(result!.participants).toHaveLength(1);

    const stored = result!.participants[0]!.participation;
    expect(stored.rewardStatus).toBe('applied');
    expect(stored.xpAwarded).toBe(15);
    expect(stored.totalDamage).toBeGreaterThan(0);
    expect(stored.performancePercent).toBeGreaterThanOrEqual(85);
    expect(stored.performancePercent).toBeLessThanOrEqual(115);

    // The damage is exactly what the formula says for the stored inputs.
    expect(stored.totalDamage).toBe(
      computeBattleDamage({
        currentSp: stored.currentSp,
        attacks: stored.attackCount!,
        performancePercent: stored.performancePercent!,
        affinityBonus: stored.affinityBonus,
        responseBonus: stored.responseBonus,
      }),
    );

    // XP landed on the copy, and items landed in the inventory.
    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifuId));
    expect(waifu!.xp).toBe(15);
    const inventory = await t.db
      .select()
      .from(playerInventory)
      .where(eq(playerInventory.playerId, playerId));
    expect(inventory.length).toBeGreaterThan(0);
    expect(result!.participants[0]!.rewards.length).toBeGreaterThan(0);
    void participation;
  });

  it('sums the encounter totals across every participant', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    await giveBuddy(otherPlayerId);
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    await app.bosses.commit(encounter.id, guildDbId, otherPlayerId, OTHER_IDENTITY);

    const result = await app.bosses.resolve(encounter.id);
    const perPerson = result!.participants.map((p) => p.participation.totalDamage ?? 0);
    expect(result!.encounter.participantCount).toBe(2);
    expect(result!.encounter.totalDamage).toBe(perPerson[0]! + perPerson[1]!);
    // Ten attacks per committed buddy, presented as the headline number.
    expect(result!.totalAttacks).toBe(20);
  });

  it('is deterministic — a retry reproduces the same damage and rewards', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId);
    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );
    const first = await app.bosses.resolve(encounter.id);
    const stored = first!.participants[0]!.participation;

    // The derived value is a pure function of the two ids — recomputing it
    // outside the service must land on the same integer.
    expect(stored.performancePercent).toBe(
      bossDrawInt(encounter.id, participation.id, 'performance', 85, 115),
    );

    // And a second resolve finds everything done rather than redoing it.
    const second = await app.bosses.resolve(encounter.id);
    expect(second!.applied).toBe(false);
    expect(second!.participants[0]!.participation.totalDamage).toBe(stored.totalDamage);
    expect(second!.participants[0]!.rewards).toEqual(first!.participants[0]!.rewards);
  });

  it('never pays twice, however many times resolution is retried', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId, { level: 5 });
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);

    for (let i = 0; i < 5; i++) await app.bosses.resolve(encounter.id);

    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifuId));
    expect(waifu!.xp).toBe(15);

    const [{ total } = { total: 0 }] = await t.db
      .select({ total: sql<number>`coalesce(sum(${playerInventory.quantity}), 0)::int` })
      .from(playerInventory)
      .where(eq(playerInventory.playerId, playerId));
    // One participation's worth of items: at most a minor stack plus a
    // (vanishingly unlikely) jackpot.
    expect(total).toBeLessThanOrEqual(4);
    expect(total).toBeGreaterThan(0);
  });

  it('survives a process dying mid-resolution and resumes without duplicating', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId, { level: 5 });
    const participation = await app.bosses.commit(
      encounter.id,
      guildDbId,
      playerId,
      IDENTITY,
    );

    // Simulate the crash: the encounter was claimed, and one participation was
    // already paid, before the worker died.
    await t.db
      .update(bossEncounters)
      .set({ status: 'resolving', resolvingAt: new Date(Date.now() - 30 * MINUTE) })
      .where(eq(bossEncounters.id, encounter.id));
    await app.inventory.addItem(t.db, playerId, (await anyItemId()), 1);
    await t.db
      .update(bossParticipations)
      .set({
        rewardStatus: 'applied',
        totalDamage: 1234,
        xpAwarded: 15,
        performancePercent: 100,
        rewardItems: [],
        resolvedAt: new Date(),
      })
      .where(eq(bossParticipations.id, participation.id));
    await t.db.update(playerWaifus).set({ xp: 15 }).where(eq(playerWaifus.id, buddy.waifuId));

    // A later pass takes over the stale claim and finishes the encounter.
    const result = await app.bosses.resolve(encounter.id);
    expect(result!.applied).toBe(true);
    expect(result!.encounter.status).toBe('resolved');
    // The already-paid participation was not paid again.
    expect(result!.participants[0]!.participation.totalDamage).toBe(1234);
    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifuId));
    expect(waifu!.xp).toBe(15);
  });

  it('lets exactly one of several concurrent resolvers do the work', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId, { level: 5 });
    const buddy2 = await giveBuddy(otherPlayerId, { level: 5 });
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    await app.bosses.commit(encounter.id, guildDbId, otherPlayerId, OTHER_IDENTITY);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => app.bosses.resolve(encounter.id)),
    );
    // Exactly one claimed; the rest either read the finished result or found
    // the claim held. Neither may pay.
    expect(results.filter((r) => r?.applied === true)).toHaveLength(1);

    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy2.waifuId));
    expect(waifu!.xp).toBe(15);
  });

  it('resolves an empty encounter as unchallenged and awards nothing', async () => {
    const encounter = await openEncounter();
    const result = await app.bosses.resolve(encounter.id);
    expect(result!.reason).toBe('unchallenged');
    expect(result!.participants).toHaveLength(0);
    expect(result!.totalDamage).toBe(0);
    expect(result!.encounter.status).toBe('resolved');
    expect(await t.db.select().from(playerInventory)).toHaveLength(0);
  });

  it('chooses and persists the next appearance when it resolves', async () => {
    const encounter = await openEncounter();
    const before = Date.now();
    const result = await app.bosses.resolve(encounter.id);

    const nextSpawnAt = result!.encounter.nextSpawnAt!;
    const gapMinutes = (nextSpawnAt.getTime() - before) / MINUTE;
    expect(gapMinutes).toBeGreaterThanOrEqual(120 - 1);
    expect(gapMinutes).toBeLessThanOrEqual(300 + 1);

    // Persisted on the guild state too — that is the row `spawnIfDue` reads.
    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    expect(state!.nextSpawnAt!.getTime()).toBe(nextSpawnAt.getTime());
  });

  it('does not reroll the next appearance on a retry', async () => {
    const encounter = await openEncounter();
    const first = await app.bosses.resolve(encounter.id);
    const second = await app.bosses.resolve(encounter.id);
    expect(second!.encounter.nextSpawnAt?.getTime()).toBe(
      first!.encounter.nextSpawnAt?.getTime(),
    );
  });

  it('awards no XP to a max-level buddy but still hands over items', async () => {
    const encounter = await openEncounter();
    const maxLevel = app.content.tables.waifuProgression.maxLevel;
    const buddy = await giveBuddy(playerId, { level: maxLevel, baseSp: 150 });
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);

    const result = await app.bosses.resolve(encounter.id);
    const stored = result!.participants[0]!.participation;
    expect(stored.xpAwarded).toBe(0);
    expect(stored.totalDamage).toBeGreaterThan(0);
    expect(result!.participants[0]!.rewards.length).toBeGreaterThan(0);

    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifuId));
    expect(waifu!.level).toBe(maxLevel);
    expect(waifu!.xp).toBe(0);
  });

  it('pays the committed copy even after the player switches buddies', async () => {
    const encounter = await openEncounter();
    const committed = await giveBuddy(playerId, { level: 5 });
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    const replacement = await giveBuddy(playerId, { level: 5 });

    await app.bosses.resolve(encounter.id);

    const [fought] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, committed.waifuId));
    const [current] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, replacement.waifuId));
    expect(fought!.xp).toBe(15);
    expect(current!.xp).toBe(0);
  });

  it('keeps the historical result after the committed copy is released', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId, { level: 5 });
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    // Released before the window closed — the result must survive her.
    await t.db
      .update(players)
      .set({ buddyWaifuId: null })
      .where(eq(players.id, playerId));
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, buddy.waifuId));

    const result = await app.bosses.resolve(encounter.id);
    const stored = result!.participants[0]!.participation;
    // Damage and items still stand; XP is recorded as zero rather than lost
    // into a copy that no longer exists.
    expect(stored.totalDamage).toBeGreaterThan(0);
    expect(stored.xpAwarded).toBe(0);
    expect(stored.waifuName).toBeTruthy();
    expect(result!.participants[0]!.rewards.length).toBeGreaterThan(0);
  });

  it('cancels an empty encounter without resolving it as a battle', async () => {
    const encounter = await openEncounter();
    const result = await app.bosses.cancel(encounter.id, 'cancelled_admin');
    expect(result!.encounter.status).toBe('cancelled');
    expect(result!.encounter.resolutionReason).toBe('cancelled_admin');
    // The slot is free again.
    expect(await app.bosses.getActive(guildDbId)).toBeUndefined();
  });

  it('still pays committed trainers when an admin ends the encounter early', async () => {
    const encounter = await openEncounter();
    const buddy = await giveBuddy(playerId, { level: 5 });
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);

    const result = await app.bosses.cancel(encounter.id, 'cancelled_admin');
    expect(result!.participants).toHaveLength(1);
    expect(result!.participants[0]!.participation.rewardStatus).toBe('applied');
    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifuId));
    expect(waifu!.xp).toBe(15);
  });
});

// ── results reading ─────────────────────────────────────────────────────────

describe('reading results', () => {
  it('paginates deterministically by damage, then by arrival', async () => {
    const encounter = await openEncounter();
    // Six players, so a page size of 4 produces two pages.
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { playerId: id } = await provisionPlayer(app, 'g-boss', `u-page-${i}`);
      ids.push(id);
      await giveBuddy(id, { level: 5, baseSp: 150 + i });
      await app.bosses.commit(encounter.id, guildDbId, id, {
        discordUserId: `u-page-${i}`,
        trainerName: `Trainer ${i}`,
      });
    }
    await app.bosses.resolve(encounter.id);

    const first = await app.bosses.listParticipations(encounter.id, { page: 1, pageSize: 4 });
    const second = await app.bosses.listParticipations(encounter.id, { page: 2, pageSize: 4 });
    expect(first.total).toBe(6);
    expect(first.totalPages).toBe(2);
    expect(first.entries).toHaveLength(4);
    expect(second.entries).toHaveLength(2);

    // Descending damage, and no participant appears on both pages.
    const damages = first.entries.map((e) => e.participation.totalDamage ?? 0);
    expect([...damages].sort((a, b) => b - a)).toEqual(damages);
    const firstIds = new Set(first.entries.map((e) => e.participation.id));
    for (const entry of second.entries) expect(firstIds.has(entry.participation.id)).toBe(false);

    // And the same page is byte-stable across requests — the ordering has no
    // in-memory cursor to lose across a restart.
    const again = await app.bosses.listParticipations(encounter.id, { page: 1, pageSize: 4 });
    expect(again.entries.map((e) => e.participation.id)).toEqual(
      first.entries.map((e) => e.participation.id),
    );
    void ids;
  });

  it('never truncates or discards a stored participant', async () => {
    const encounter = await openEncounter();
    for (let i = 0; i < 12; i++) {
      const { playerId: id } = await provisionPlayer(app, 'g-boss', `u-keep-${i}`);
      await giveBuddy(id, { level: 5 });
      await app.bosses.commit(encounter.id, guildDbId, id, {
        discordUserId: `u-keep-${i}`,
        trainerName: `Keep ${i}`,
      });
    }
    await app.bosses.resolve(encounter.id);
    const listing = await app.bosses.listParticipations(encounter.id, { pageSize: 5 });
    expect(listing.total).toBe(12);
    // Every one is reachable by walking the pages.
    const seen = new Set<number>();
    for (let page = 1; page <= listing.totalPages; page++) {
      const chunk = await app.bosses.listParticipations(encounter.id, { page, pageSize: 5 });
      for (const entry of chunk.entries) seen.add(entry.participation.id);
    }
    expect(seen.size).toBe(12);
  });

  it('identifies the earliest committer regardless of damage order', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId, { level: 5, baseSp: 90 });
    await giveBuddy(otherPlayerId, { level: 50, baseSp: 190 });
    const early = await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    await app.bosses.commit(encounter.id, guildDbId, otherPlayerId, OTHER_IDENTITY);
    await app.bosses.resolve(encounter.id);

    // The weakest buddy arrived first, so the top of a damage-sorted page is
    // not the first on the scene.
    const first = await app.bosses.getFirstOnScene(encounter.id);
    expect(first!.id).toBe(early.id);
    const listing = await app.bosses.listParticipations(encounter.id);
    expect(listing.entries[0]!.participation.id).not.toBe(early.id);
  });

  it('returns one player their own record', async () => {
    const encounter = await openEncounter();
    await giveBuddy(playerId, { level: 5 });
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    await app.bosses.resolve(encounter.id);

    const mine = await app.bosses.getParticipation(encounter.id, playerId);
    expect(mine!.participation.trainerName).toBe('Whistler');
    expect(mine!.rewards.every((r) => r.name.length > 0)).toBe(true);
    expect(await app.bosses.getParticipation(encounter.id, otherPlayerId)).toBeNull();
  });
});

/** Any seeded item id — used to stage a partially-paid crash state. */
async function anyItemId(): Promise<number> {
  const [row] = await t.db.select({ id: items.id }).from(items).limit(1);
  return row!.id;
}
