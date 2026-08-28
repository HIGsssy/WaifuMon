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

    // Thirty minutes, set once at the scouting start.
    const window = (encounter!.deadlineAt!.getTime() - encounter!.scoutingStartedAt!.getTime()) / MINUTE;
    expect(window).toBe(30);
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

    // Thirty-one minutes later.
    const later = new Date(Date.now() + 31 * MINUTE);
    await scheduler(announcer, () => later).tick();

    const [row] = await t.db
      .select()
      .from(bossEncounters)
      .where(eq(bossEncounters.id, encounter.id));
    expect(row!.status).toBe('resolved');
    expect(row!.participantCount).toBe(1);
    expect(announcer.publishResults).toHaveBeenCalledWith(encounter.id);
    // Results are a *second* message, so the announcement is still posted
    // exactly once — never re-posted, never replaced.
    expect(announcer.postAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('does not resolve a hair before the deadline', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const encounter = (await activeEncounter())!;
    const justBefore = new Date(encounter.deadlineAt!.getTime() - 1000);
    await scheduler(announcer, () => justBefore).tick();
    expect((await app.bosses.getEncounter(encounter.id))!.status).toBe('scouting');
    expect(announcer.publishResults).not.toHaveBeenCalled();
  });

  it('refuses a commitment at or after the deadline', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const encounter = (await activeEncounter())!;
    await giveBuddy();
    // Exactly the deadline, and past it. Both are closed.
    await expect(
      app.bosses.commit(
        encounter.id,
        guildDbId,
        playerId,
        { discordUserId: 'u-1', trainerName: 'Whistler' },
        encounter.deadlineAt!,
      ),
    ).rejects.toThrow();
    await expect(
      app.bosses.commit(
        encounter.id,
        guildDbId,
        playerId,
        { discordUserId: 'u-1', trainerName: 'Whistler' },
        new Date(encounter.deadlineAt!.getTime() + 1),
      ),
    ).rejects.toThrow();
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
  });

  it('persists a 10-35 minute downtime and does not spawn again inside it', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const later = new Date(Date.now() + 31 * MINUTE);
    await scheduler(announcer, () => later).tick();

    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    const downtimeMinutes = (state!.nextSpawnAt!.getTime() - later.getTime()) / MINUTE;
    expect(downtimeMinutes).toBeGreaterThanOrEqual(10);
    expect(downtimeMinutes).toBeLessThanOrEqual(35);

    // A pass nine minutes into the downtime — inside even the shortest band —
    // must not open anything.
    const inside = new Date(later.getTime() + 9 * MINUTE);
    await scheduler(announcer, () => inside).tick();
    expect(await activeEncounter()).toBeUndefined();
  });

  it('reaches both endpoints of the downtime band across many draws', async () => {
    // The band's endpoints are what an operator tunes, so they have to be
    // actually reachable rather than approached asymptotically.
    const seen = new Set<number>();
    for (let seed = 0; seed < 300; seed += 1) {
      await t.db.delete(bossParticipations);
      await t.db.delete(bossEncounters);
      await t.db.delete(guildBossState);
      const isolated = await bootstrapApp(t, { bossRng: seededRng(seed) });
      const announcer = fakeAnnouncer();
      const s = createBossScheduler({
        db: t.db,
        encounters: isolated.bosses,
        announcer,
        logger: t.logger,
      });
      await s.tick();
      const later = new Date(Date.now() + 31 * MINUTE);
      const s2 = createBossScheduler({
        db: t.db,
        encounters: isolated.bosses,
        announcer,
        logger: t.logger,
        now: () => later,
      });
      await s2.tick();
      const [state] = await t.db
        .select()
        .from(guildBossState)
        .where(eq(guildBossState.guildId, guildDbId));
      seen.add(Math.round((state!.nextSpawnAt!.getTime() - later.getTime()) / MINUTE));
      if (seen.has(10) && seen.has(35)) break;
    }
    expect(seen.has(10), `saw ${[...seen].sort((a, b) => a - b).join(',')}`).toBe(true);
    expect(seen.has(35), `saw ${[...seen].sort((a, b) => a - b).join(',')}`).toBe(true);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...seen)).toBeLessThanOrEqual(35);
  });

  it('does not reroll the next appearance across a restart', async () => {
    const announcer = fakeAnnouncer();
    await scheduler(announcer).tick();
    const later = new Date(Date.now() + 31 * MINUTE);
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

    const closed = new Date(Date.now() + 31 * MINUTE);
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

describe('the two-message delivery survives a restart', () => {
  /**
   * Run a full encounter to resolution with a *broken* publisher, so the row
   * lands `resolved` with neither Discord step stamped — which is exactly what
   * a crash between resolving and publishing leaves behind.
   */
  async function resolvedButUnpublished(): Promise<BossEncounterRow> {
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });
    const broken = fakeAnnouncer({
      publishResults: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    await scheduler(broken, () => new Date(Date.now() + 31 * MINUTE)).tick();
    return (await app.bosses.getEncounter(encounter.id))!;
  }

  it('leaves both delivery stamps null when publishing never succeeded', async () => {
    const row = await resolvedButUnpublished();
    expect(row.status).toBe('resolved');
    expect(row.completionEditedAt).toBeNull();
    expect(row.resultsPublishedAt).toBeNull();
    expect(row.resultsMessageId).toBeNull();
    // The announcement message id is untouched — the encounter still owns it.
    expect(row.messageId).toBe('m-1');
  });

  it('reports the encounter as owing Discord work', async () => {
    const row = await resolvedButUnpublished();
    const pending = await app.bosses.findUndelivered();
    expect(pending.map((e) => e.id)).toContain(row.id);
  });

  it('a restart re-attempts delivery for it', async () => {
    const row = await resolvedButUnpublished();
    const recovered = fakeAnnouncer();
    await scheduler(recovered, () => new Date(Date.now() + 32 * MINUTE)).tick();
    expect(recovered.publishResults).toHaveBeenCalledWith(row.id);
    // And it does not re-announce or re-pay anything to do it.
    expect(recovered.postAnnouncement).not.toHaveBeenCalled();
  });

  it('stops re-attempting once both stamps land', async () => {
    const row = await resolvedButUnpublished();
    // Stand in for a successful publish.
    await app.bosses.markCompletionEdited(row.id);
    await app.bosses.markResultsPublished(row.id, 'm-results', 10);

    expect((await app.bosses.findUndelivered()).map((e) => e.id)).not.toContain(row.id);
    const later = fakeAnnouncer();
    await scheduler(later, () => new Date(Date.now() + 33 * MINUTE)).tick();
    expect(later.publishResults).not.toHaveBeenCalledWith(row.id);
  });

  it('still owes work when only the completion edit landed', async () => {
    const row = await resolvedButUnpublished();
    await app.bosses.markCompletionEdited(row.id);
    expect((await app.bosses.findUndelivered()).map((e) => e.id)).toContain(row.id);
  });

  it('never overwrites a results message id that is already recorded', async () => {
    const row = await resolvedButUnpublished();
    const first = await app.bosses.markResultsPublished(row.id, 'm-first', 10);
    expect(first!.resultsMessageId).toBe('m-first');
    // A racing second publisher loses, and the original stands.
    const second = await app.bosses.markResultsPublished(row.id, 'm-second', 10);
    expect(second).toBeUndefined();
    expect((await app.bosses.getEncounter(row.id))!.resultsMessageId).toBe('m-first');
  });

  it('never moves the completion stamp once set', async () => {
    const row = await resolvedButUnpublished();
    const at = new Date('2026-01-01T00:00:00.000Z');
    await app.bosses.markCompletionEdited(row.id, at);
    await app.bosses.markCompletionEdited(row.id, new Date('2027-01-01T00:00:00.000Z'));
    expect((await app.bosses.getEncounter(row.id))!.completionEditedAt!.toISOString()).toBe(
      at.toISOString(),
    );
  });

  it('does not treat an encounter that was never announced as undelivered', async () => {
    // Nothing to edit and nowhere to publish — a `scheduled` row that got
    // cancelled has no message of its own.
    const [orphan] = await t.db
      .insert(bossEncounters)
      .values({
        guildId: guildDbId,
        region: 'waifu-valley',
        bossId: 'x',
        bossName: 'X',
        bossAffinity: 'dominant',
        rewardTable: 'standard-scouting-v1',
        rewardTableVersion: 'standard-scouting-v1',
        calcVersion: 1,
        affinityVersion: 1,
        status: 'cancelled',
        scheduledAt: new Date(),
        resolvedAt: new Date(),
      })
      .returning();
    expect((await app.bosses.findUndelivered()).map((e) => e.id)).not.toContain(orphan!.id);
  });

  it('leaves an older encounter untouched while the next one runs', async () => {
    const first = await resolvedButUnpublished();
    await app.bosses.markCompletionEdited(first.id);
    await app.bosses.markResultsPublished(first.id, 'm-results-1', 10);
    const before = (await app.bosses.getEncounter(first.id))!;

    // Open and finish a second encounter on top of it.
    const [state] = await t.db
      .select()
      .from(guildBossState)
      .where(eq(guildBossState.guildId, guildDbId));
    const due = new Date(state!.nextSpawnAt!.getTime() + MINUTE);
    const announcer = fakeAnnouncer();
    await scheduler(announcer, () => due).tick();
    const second = (await activeEncounter())!;
    expect(second.id).not.toBe(first.id);
    // The next encounter posts its *own* announcement rather than reusing the
    // previous one's message. (That the ids differ on real Discord is asserted
    // against a shared channel in `bossAnnouncer.test.ts`; this double numbers
    // messages per announcer instance, so id inequality would prove nothing.)
    expect(announcer.postAnnouncement).toHaveBeenCalledTimes(1);
    const posted = (
      announcer.postAnnouncement as unknown as { mock: { calls: [BossEncounterRow][] } }
    ).mock.calls;
    expect(posted[0]![0].id).toBe(second.id);
    await scheduler(announcer, () => new Date(due.getTime() + 31 * MINUTE)).tick();

    const after = (await app.bosses.getEncounter(first.id))!;
    expect(after.messageId).toBe(before.messageId);
    expect(after.resultsMessageId).toBe('m-results-1');
    expect(after.completionEditedAt!.getTime()).toBe(before.completionEditedAt!.getTime());
    expect(after.resultsPublishedAt!.getTime()).toBe(before.resultsPublishedAt!.getTime());
    expect(after.status).toBe('resolved');
  });

  it('publishes at most once per encounter across repeated passes', async () => {
    await scheduler(fakeAnnouncer()).tick();
    const encounter = (await activeEncounter())!;
    await giveBuddy();
    await app.bosses.commit(encounter.id, guildDbId, playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });

    // A publisher that records its own success the way the real one does.
    const announcer = fakeAnnouncer({
      publishResults: vi.fn(async (encounterId: number) => {
        await app.bosses.markCompletionEdited(encounterId);
        await app.bosses.markResultsPublished(encounterId, `m-results-${encounterId}`, 10);
      }),
    });
    for (let i = 0; i < 4; i += 1) {
      await scheduler(announcer, () => new Date(Date.now() + (31 + i) * MINUTE)).tick();
    }
    const calls = (announcer.publishResults as unknown as { mock: { calls: [number][] } })
      .mock.calls;
    const published = calls.filter(([id]) => id === encounter.id);
    // Resolution calls it once; every later pass finds both stamps set and
    // skips it entirely.
    expect(published).toHaveLength(1);
    expect((await app.bosses.getEncounter(encounter.id))!.resultsMessageId).toBe(
      `m-results-${encounter.id}`,
    );
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
