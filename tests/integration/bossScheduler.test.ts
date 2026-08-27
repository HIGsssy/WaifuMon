/**
 * The boss scheduler against real Postgres, with a fake announcer.
 *
 * The announcer is stubbed rather than the database, because the interesting
 * failures here are all *persistence* failures: what a restart sees, what two
 * processes do to each other, and what happens when the channel disappears
 * mid-window. Discord is only ever the thing that succeeds or throws.
 *
 * "Restart" is modelled as constructing a second scheduler over the same
 * database and ticking it — which is exactly what a restart is, since the
 * scheduler holds no state of its own between passes.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bossEncounters,
  bossParticipations,
  guildBossState,
  guilds,
  playerWaifus,
  players,
  species,
  type BossEncounterRow,
} from '../../src/db/schema';
import {
  createBossScheduler,
  type BossAnnouncer,
  type BossScheduler,
} from '../../src/modules/bosses/bossScheduler';
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

const MINUTE = 60_000;
const CHANNEL = 'c-boss';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { bossRng: seededRng(99) });
  ({ guildDbId, playerId } = await provisionPlayer(app, 'g-sched', 'u-1'));
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.update(players).set({ buddyWaifuId: null });
  await t.db.delete(playerWaifus);
  await t.db.update(guilds).set({ bossChannelId: CHANNEL }).where(eq(guilds.id, guildDbId));
});

/**
 * A recording announcer. Every method is a spy so a test can assert on *how
 * many times* Discord was touched, which is how "no duplicate announcement" is
 * actually observed.
 */
function fakeAnnouncer(overrides: Partial<BossAnnouncer> = {}) {
  let nextMessageId = 1;
  // Typed as the spy shape rather than as `BossAnnouncer`, so `.mock.calls`
  // stays visible to the compiler at the assertion sites. The scheduler takes
  // it structurally, which is what makes the double honest: an announcer method
  // that changed shape would fail to compile here rather than silently pass.
  return {
    verifyChannel: vi.fn(async (_channelId: string) => ({ missing: [] as string[] })),
    postAnnouncement: vi.fn(
      async (_encounter: BossEncounterRow, _channelId: string) => `m-${nextMessageId++}`,
    ),
    refreshAnnouncement: vi.fn(async (_encounter: BossEncounterRow) => {}),
    publishResults: vi.fn(async (_encounterId: number) => {}),
    ...overrides,
  };
}

/** How many times a spied announcer method was called, `0` when overridden. */
function callCount(fn: unknown): number {
  const spy = fn as { mock?: { calls: unknown[] } };
  return spy.mock?.calls.length ?? 0;
}

/** A scheduler whose clock a test drives. Never started — `tick()` is called. */
function scheduler(
  announcer: BossAnnouncer,
  now: () => Date = () => new Date(),
): BossScheduler {
  return createBossScheduler({
    db: t.db,
    encounters: app.bosses,
    announcer,
    logger: t.logger,
    now,
  });
}

async function giveBuddy(target = playerId): Promise<number> {
  const [sp] = await t.db.select({ id: species.id }).from(species).limit(1);
  const waifu = await insertOwnedWaifu(t.db, {
    playerId: target,
    speciesId: sp!.id,
    level: 5,
    xp: 0,
    baseSp: 120,
  });
  await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, target));
  return waifu.id;
}

async function activeEncounter() {
  return app.bosses.getActive(guildDbId);
}

describe('a first pass opens an encounter', () => {
  it('draws, announces, and records the message id and deadline', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();

    const encounter = await activeEncounter();
    expect(encounter).toBeDefined();
    expect(encounter!.status).toBe('scouting');
    expect(encounter!.channelId).toBe(CHANNEL);
    expect(encounter!.messageId).toBe('m-1');
    expect(announcer.postAnnouncement).toHaveBeenCalledTimes(1);

    // Sixty minutes, set once at the scouting start.
    const window = (encounter!.deadlineAt!.getTime() - encounter!.scoutingStartedAt!.getTime()) / MINUTE;
    expect(window).toBe(60);
  });

  it('does nothing for a guild with no boss channel configured', async () => {
    await t.db.update(guilds).set({ bossChannelId: null }).where(eq(guilds.id, guildDbId));
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    expect(announcer.postAnnouncement).not.toHaveBeenCalled();
    expect(await activeEncounter()).toBeUndefined();
  });

  it('does not open a second encounter on the next pass', async () => {
    const announcer = fakeAnnouncer();
    const s = scheduler(announcer);
    await s.tick();
    await s.tick();
    await s.tick();
    expect(announcer.postAnnouncement).toHaveBeenCalledTimes(1);
    expect(await t.db.select().from(bossEncounters)).toHaveLength(1);
  });
});

describe('restart recovery', () => {
  it('does not reroll, re-announce, or move the deadline of a live window', async () => {
    const first = fakeAnnouncer();
    await scheduler(first).tick();
    const before = (await activeEncounter())!;

    // "Restart": a brand-new scheduler over the same database.
    const second = fakeAnnouncer();
    await scheduler(second).tick();
    const after = (await activeEncounter())!;

    expect(after.id).toBe(before.id);
    expect(after.bossId).toBe(before.bossId);
    expect(after.messageId).toBe(before.messageId);
    expect(after.deadlineAt!.getTime()).toBe(before.deadlineAt!.getTime());
    // The new process edits the live message; it never posts another.
    expect(second.postAnnouncement).not.toHaveBeenCalled();
    expect(second.refreshAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('keeps committed participants across a restart', async () => {
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });

    await scheduler(fakeAnnouncer()).tick();
    expect(await app.bosses.countParticipants(encounter.id)).toBe(1);
  });

  it('re-attempts an announcement that never went up, without re-drawing', async () => {
    // A crash between the draw and the post leaves a `scheduled` row behind.
    const failing = fakeAnnouncer({
      postAnnouncement: vi.fn(async () => {
        throw new Error('Discord is down');
      }),
    });
    await scheduler(failing).tick();

    const scheduled = (await activeEncounter())!;
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.messageId).toBeNull();

    const recovered = fakeAnnouncer();
    await scheduler(recovered).tick();
    const opened = (await activeEncounter())!;
    // Same encounter, same boss — recovered rather than replaced.
    expect(opened.id).toBe(scheduled.id);
    expect(opened.bossId).toBe(scheduled.bossId);
    expect(opened.status).toBe('scouting');
    expect(recovered.postAnnouncement).toHaveBeenCalledTimes(1);
    expect(await t.db.select().from(bossEncounters)).toHaveLength(1);
  });

  it('finishes a resolution a previous process died partway through', async () => {
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    const waifuId = await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });

    // The crash: claimed for resolution, then nothing, long enough ago that
    // the claim has gone stale.
    await t.db
      .update(bossEncounters)
      .set({ status: 'resolving', resolvingAt: new Date(Date.now() - 30 * MINUTE) })
      .where(eq(bossEncounters.id, encounter.id));

    const recovered = fakeAnnouncer();
    await scheduler(recovered).tick();

    const [finished] = await t.db
      .select()
      .from(bossEncounters)
      .where(eq(bossEncounters.id, encounter.id));
    expect(finished!.status).toBe('resolved');
    expect(finished!.resolutionReason).toBe('repelled');
    expect(recovered.publishResults).toHaveBeenCalledWith(encounter.id);

    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifuId));
    expect(waifu!.xp).toBe(15);
  });

  it('does not touch a fresh resolving claim another process still holds', async () => {
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    // Claimed one minute ago — well inside the ten-minute takeover timeout.
    await t.db
      .update(bossEncounters)
      .set({ status: 'resolving', resolvingAt: new Date(Date.now() - 1 * MINUTE) })
      .where(eq(bossEncounters.id, encounter.id));

    const other = fakeAnnouncer();
    await scheduler(other).tick();

    const [row] = await t.db
      .select()
      .from(bossEncounters)
      .where(eq(bossEncounters.id, encounter.id));
    expect(row!.status).toBe('resolving');
    expect(other.publishResults).not.toHaveBeenCalled();
  });
});

describe('the deadline closes the window', () => {
  it('resolves once the deadline passes and publishes the results', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const encounter = (await activeEncounter())!;
    await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });

    // Sixty-one minutes later.
    const later = new Date(Date.now() + 61 * MINUTE);
    await scheduler(announcer, () => later).tick();

    const [row] = await t.db
      .select()
      .from(bossEncounters)
      .where(eq(bossEncounters.id, encounter.id));
    expect(row!.status).toBe('resolved');
    expect(row!.participantCount).toBe(1);
    expect(announcer.publishResults).toHaveBeenCalledWith(encounter.id);
    // The results are an *edit* of the original message, never a new post.
    expect(announcer.postAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('persists a 2–5 hour downtime and does not spawn again inside it', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const later = new Date(Date.now() + 61 * MINUTE);
    await scheduler(announcer, () => later).tick();

    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    const downtimeMinutes = (state!.nextSpawnAt!.getTime() - later.getTime()) / MINUTE;
    expect(downtimeMinutes).toBeGreaterThanOrEqual(120);
    expect(downtimeMinutes).toBeLessThanOrEqual(300);

    // A pass one hour into the downtime must not open anything.
    const inside = new Date(later.getTime() + 60 * MINUTE);
    await scheduler(announcer, () => inside).tick();
    expect(await activeEncounter()).toBeUndefined();
  });

  it('does not reroll the next appearance across a restart', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const later = new Date(Date.now() + 61 * MINUTE);
    await scheduler(announcer, () => later).tick();
    const [before] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));

    await scheduler(fakeAnnouncer(), () => later).tick();
    const [after] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    expect(after!.nextSpawnAt!.getTime()).toBe(before!.nextSpawnAt!.getTime());
  });

  it('opens the next encounter once the downtime has elapsed', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const firstBossId = (await activeEncounter())!.bossId;

    const closed = new Date(Date.now() + 61 * MINUTE);
    await scheduler(announcer, () => closed).tick();
    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));

    const due = new Date(state!.nextSpawnAt!.getTime() + MINUTE);
    await scheduler(announcer, () => due).tick();
    const next = (await activeEncounter())!;
    expect(next.status).toBe('scouting');
    // The shuffle bag guarantees a different boss than the one just seen.
    expect(next.bossId).not.toBe(firstBossId);
  });
});

describe('multi-process ownership', () => {
  it('opens exactly one encounter when two schedulers tick simultaneously', async () => {
    const a = fakeAnnouncer();
    const b = fakeAnnouncer();
    await Promise.all([scheduler(a).tick(), scheduler(b).tick()]);

    expect(await t.db.select().from(bossEncounters)).toHaveLength(1);
    // Whichever process drew it posted once; the other posted nothing.
    const posts =
      callCount(a.postAnnouncement) + callCount(b.postAnnouncement);
    expect(posts).toBe(1);
  });

  it('resolves exactly once when two schedulers race the deadline', async () => {
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    const waifuId = await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });

    const later = () => new Date(Date.now() + 61 * MINUTE);
    const a = fakeAnnouncer();
    const b = fakeAnnouncer();
    await Promise.all([scheduler(a, later).tick(), scheduler(b, later).tick()]);

    // The reward landed exactly once, whichever process won the claim.
    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifuId));
    expect(waifu!.xp).toBe(15);
    const publishes =
      callCount(a.publishResults) + callCount(b.publishResults);
    expect(publishes).toBe(1);
  });
});

describe('channel failures suspend scheduling', () => {
  it('suspends with an actionable message when the channel disappears', async () => {
    const gone = fakeAnnouncer({ verifyChannel: vi.fn(async () => null) });
    await scheduler(gone).tick();

    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    expect(state!.suspendedReason).toContain('missing or I cannot see it');
    // The message names the command that fixes it.
    expect(state!.suspendedReason).toContain('set-channel');
    expect(state!.suspendedAt).not.toBeNull();
    expect(gone.postAnnouncement).not.toHaveBeenCalled();
    expect(await activeEncounter()).toBeUndefined();
  });

  it('suspends and names the missing permissions', async () => {
    const blocked = fakeAnnouncer({
      verifyChannel: vi.fn(async () => ({ missing: ['Attach Files', 'Embed Links'] })),
    });
    await scheduler(blocked).tick();

    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    expect(state!.suspendedReason).toContain('Attach Files, Embed Links');
    expect(state!.suspendedReason).toContain('resume');
  });

  it('treats a throwing verification as unusable rather than crashing the pass', async () => {
    const throwing = fakeAnnouncer({
      verifyChannel: vi.fn(async () => {
        throw new Error('gateway exploded');
      }),
    });
    await expect(scheduler(throwing).tick()).resolves.toBeUndefined();
    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    expect(state!.suspendedReason).not.toBeNull();
  });

  it('lifts the suspension automatically once the channel works again', async () => {
    await scheduler(fakeAnnouncer({ verifyChannel: vi.fn(async () => null) })).tick();
    const healthy = fakeAnnouncer();
    await scheduler(healthy).tick();

    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    expect(state!.suspendedReason).toBeNull();
    expect(state!.suspendedAt).toBeNull();
    expect(healthy.postAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('still finishes a live encounter whose channel vanished mid-window', async () => {
    // Rewards are owed regardless of whether the announcement can be updated.
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    const waifuId = await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });

    const broken = fakeAnnouncer({
      verifyChannel: vi.fn(async () => null),
      publishResults: vi.fn(async () => {
        throw new Error('Unknown Channel');
      }),
    });
    await scheduler(broken, () => new Date(Date.now() + 61 * MINUTE)).tick();

    const [row] = await t.db
      .select()
      .from(bossEncounters)
      .where(eq(bossEncounters.id, encounter.id));
    expect(row!.status).toBe('resolved');
    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifuId));
    expect(waifu!.xp).toBe(15);
  });
});

describe('a Discord failure never costs a reward', () => {
  it('keeps rewards committed when publishing the results throws', async () => {
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    const waifuId = await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });

    const failing = fakeAnnouncer({
      publishResults: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    await scheduler(failing, () => new Date(Date.now() + 61 * MINUTE)).tick();

    const [waifu] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifuId));
    expect(waifu!.xp).toBe(15);

    const [participation] = await t.db
      .select()
      .from(bossParticipations)
      .where(eq(bossParticipations.encounterId, encounter.id));
    expect(participation!.rewardStatus).toBe('applied');

    // A later pass must not re-pay just because the publish failed.
    await scheduler(fakeAnnouncer(), () => new Date(Date.now() + 62 * MINUTE)).tick();
    const [again] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifuId));
    expect(again!.xp).toBe(15);
  });

  it('does not stop the pass when refreshing an announcement fails', async () => {
    await scheduler(fakeAnnouncer()).tick();
    const flaky = fakeAnnouncer({
      refreshAnnouncement: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });
    await expect(scheduler(flaky).tick()).resolves.toBeUndefined();
  });
});

describe('pause', () => {
  it('stops new encounters but lets a live one resolve', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const encounter = (await activeEncounter())!;
    await app.bosses.setPaused(guildDbId, true);

    await scheduler(announcer, () => new Date(Date.now() + 61 * MINUTE)).tick();
    const [row] = await t.db
      .select()
      .from(bossEncounters)
      .where(eq(bossEncounters.id, encounter.id));
    expect(row!.status).toBe('resolved');

    // And nothing new opens while the pause stands.
    await scheduler(announcer, () => new Date(Date.now() + 10 * 60 * MINUTE)).tick();
    expect(await activeEncounter()).toBeUndefined();
  });
});

describe('lifecycle control', () => {
  it('reports whether it is running and stops cleanly', () => {
    const s = scheduler(fakeAnnouncer());
    expect(s.running).toBe(false);
    s.start();
    expect(s.running).toBe(true);
    s.stop();
    expect(s.running).toBe(false);
  });
});
