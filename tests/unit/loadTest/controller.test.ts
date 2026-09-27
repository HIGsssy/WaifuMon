/**
 * The load-test controller's state machine, against a fake generator process.
 *
 * Pinned:
 *   - it cannot be constructed with load testing disabled;
 *   - the generator is spawned with a scrubbed environment — no database URL,
 *     no Discord token, no API token — and the enable flag;
 *   - one run at a time; a second start is a conflict;
 *   - the cards profile is refused where card rendering is off;
 *   - stop works in every phase, and cleanup (sessions, cold evictions) runs on
 *     every path out: completion, stop, generator crash, generator hang;
 *   - failures are recorded as `failed` with the reason, and results are saved.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  generatorEnv,
  LoadTestConflictError,
  LoadTestUnavailableError,
} from '../../../src/modules/loadTest/controller';
import type { LoadTestStartRequest } from '../../../src/modules/loadTest/types';
import { buildController, fakeSummary } from '../../helpers/loadTestFakes';

const REQ: LoadTestStartRequest = { profile: 'mixed', concurrency: 3, durationSeconds: 1 };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(c: { shutdown(): Promise<void> }) {
  cleanups.push(() => c.shutdown());
  return c;
}

describe('construction', () => {
  it('refuses to build when load testing is disabled', () => {
    expect(() => buildController({ enabled: false })).toThrow(/disabled/);
  });
});

describe('generator environment', () => {
  it('passes the enable flag and nothing secret', () => {
    const env = generatorEnv({
      PATH: '/bin',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://secret',
      DISCORD_TOKEN: 'discord-secret',
      DISCORD_CLIENT_SECRET: 'oauth-secret',
      PLATFORM_API_TOKEN: 'api-secret',
      PORTAL_SESSION_SECRET: 'x'.repeat(40),
      ADMIN_WEB_TOKEN: 'admin-secret',
    });
    expect(env).toEqual({ PATH: '/bin', NODE_ENV: 'production', LOAD_TESTING_ENABLED: 'true' });
  });

  it('is what the controller actually spawns with', async () => {
    const { controller, rec } = buildController();
    track(controller);
    process.env.DISCORD_TOKEN_FOR_TEST = 'nope';
    controller.start(REQ, 'op');
    await controller.whenIdle();
    const env = rec.generators[0]!.env;
    expect(env.LOAD_TESTING_ENABLED).toBe('true');
    for (const key of ['DATABASE_URL', 'DISCORD_TOKEN', 'PLATFORM_API_TOKEN', 'DISCORD_TOKEN_FOR_TEST']) {
      expect(env[key]).toBeUndefined();
    }
    delete process.env.DISCORD_TOKEN_FOR_TEST;
  });
});

describe('a complete run', () => {
  it('prepares, primes, goes, records and cleans up', async () => {
    const { controller, rec } = buildController();
    track(controller);
    const view = controller.start({ ...REQ, label: 'baseline' }, '1234');
    expect(view.state).toBe('preparing');
    expect(controller.currentRun()?.runKey).toBe(view.runKey);

    await controller.whenIdle();
    expect(controller.currentRun()).toBeNull();
    const last = controller.lastRun()!;
    expect(last.state).toBe('completed');
    expect(last.resultId).toBe(1);

    const gen = rec.generators[0]!;
    expect(gen.sent.map((m) => m.type)).toEqual(['start', 'go']);
    const start = gen.sent[0] as Extract<(typeof gen.sent)[number], { type: 'start' }>;
    expect(start.plan.players).toHaveLength(3);
    expect(start.plan.baseUrl).toBe('http://127.0.0.1:3120');

    // Released before (stale sessions) and after (this run's sessions).
    expect(rec.releases).toBe(2);
    const row = rec.rows[0]!;
    expect(row).toMatchObject({
      status: 'completed',
      profile: 'mixed',
      concurrency: 3,
      durationSeconds: 1,
      label: 'baseline',
      hostLabel: 'test host',
      operatorDiscordId: '1234',
    });
    expect((row.summary as { latency: { p99Ms: number } }).latency.p99Ms).toBe(20);
    expect((row.summary as { failures: { http5xx: number } }).failures.http5xx).toBe(1);
  });

  it('plans cold cards for a cold run and evicts exactly them afterwards', async () => {
    const { controller, rec } = buildController();
    track(controller);
    controller.start({ profile: 'cards', cardMode: 'cold', concurrency: 2, durationSeconds: 60 }, null);
    await controller.whenIdle();
    expect(rec.planned).toHaveLength(1);
    expect(rec.planned[0]!.slugs).toEqual(['alpha', 'beta']);
    const go = rec.generators[0]!.sent.find((m) => m.type === 'go') as { coldCards: unknown[] };
    expect(go.coldCards).toHaveLength(4);
    expect(rec.evicted).toHaveLength(1);
    expect(rec.evicted[0]!.map((c) => c.renderKey)).toEqual(['abcdef00', 'abcdef01', 'abcdef02', 'abcdef03']);
  });

  it('plans no cold cards for a warm-only workload', async () => {
    const { controller, rec } = buildController();
    track(controller);
    controller.start({ profile: 'portal', concurrency: 2, durationSeconds: 60 }, null);
    await controller.whenIdle();
    expect(rec.planned).toHaveLength(0);
    expect(rec.evicted).toHaveLength(0);
  });
});

describe('one run at a time', () => {
  it('refuses a second start while one is active', async () => {
    const { controller } = buildController({ script: 'manual' });
    track(controller);
    controller.start(REQ, null);
    expect(() => controller.start(REQ, null)).toThrow(LoadTestConflictError);
    controller.stop();
    await controller.whenIdle();
    // …and accepts one once the first has finished.
    expect(() => controller.start(REQ, null)).not.toThrow();
    controller.stop();
    await controller.whenIdle();
  });
});

describe('workload availability', () => {
  it('refuses the cards profile when card rendering is off', () => {
    const { controller } = buildController({ cardsAvailable: false });
    expect(() =>
      controller.start({ profile: 'cards', cardMode: 'warm', concurrency: 1, durationSeconds: 60 }, null),
    ).toThrow(LoadTestUnavailableError);
    expect(controller.currentRun()).toBeNull();
  });

  it('runs other profiles without cards and plans nothing cold', async () => {
    const { controller, rec } = buildController({ cardsAvailable: false });
    track(controller);
    controller.start({ profile: 'mixed', concurrency: 1, durationSeconds: 60 }, null);
    await controller.whenIdle();
    const start = rec.generators[0]!.sent[0] as { plan: { cardsAvailable: boolean } };
    expect(start.plan.cardsAvailable).toBe(false);
    expect(rec.planned).toHaveLength(0);
  });
});

describe('stop', () => {
  it('returns null when nothing is running', () => {
    const { controller } = buildController();
    expect(controller.stop()).toBeNull();
  });

  it('stops during preparation without spawning a generator', async () => {
    const { controller, rec } = buildController({ prepareDelayMs: 50 });
    track(controller);
    controller.start(REQ, null);
    expect(controller.stop()?.state).toBe('stopping');
    await controller.whenIdle();
    expect(rec.generators).toHaveLength(0);
    expect(controller.lastRun()?.state).toBe('stopped');
    expect(rec.rows[0]?.status).toBe('stopped');
    expect(rec.releases).toBe(2);
  });

  it('stops a running generator and records the partial result', async () => {
    const { controller, rec } = buildController({ script: 'manual' });
    track(controller);
    controller.start(REQ, null);
    // Walk it to running by hand.
    await new Promise((r) => setTimeout(r, 10));
    const gen = rec.generators[0]!;
    gen.emitMessage({ type: 'primed' });
    await new Promise((r) => setTimeout(r, 10));
    expect(controller.currentRun()?.state).toBe('running');
    gen.emitMessage({ type: 'progress', snapshot: fakeSummary({ phase: 'running', completed: 3 }) });
    expect(controller.currentRun()?.progress?.completed).toBe(3);

    controller.stop();
    expect(gen.sent.map((m) => m.type)).toContain('stop');
    gen.emitMessage({ type: 'done', summary: fakeSummary({ completed: 5 }), stopped: true });
    gen.exit(0);
    await controller.whenIdle();
    expect(controller.lastRun()?.state).toBe('stopped');
    expect(rec.rows[0]?.status).toBe('stopped');
    expect((rec.rows[0]!.summary as { completed: number }).completed).toBe(5);
  });

  it('stops while waiting for the renderer to settle after priming, without waiting it out', async () => {
    const { controller, rec } = buildController({ idleDelayMs: 10_000 });
    track(controller);
    controller.start(REQ, null);
    // Primed once the generator has been sent `start`; the renderer wait follows.
    while (!rec.generators[0]?.sent.some((m) => m.type === 'start')) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 50));
    const stoppedAt = Date.now();
    controller.stop();
    await controller.whenIdle();
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(controller.lastRun()?.state).toBe('stopped');
    expect(rec.generators[0]!.sent.map((m) => m.type)).not.toContain('go');
  });

  it('kills a generator that ignores stop, and still cleans up', async () => {
    const { controller, rec } = buildController({ script: 'hang' });
    track(controller);
    controller.start(REQ, null);
    await new Promise((r) => setTimeout(r, 10));
    const stoppedAt = Date.now();
    controller.stop();
    await controller.whenIdle();
    expect(Date.now() - stoppedAt).toBeLessThan(1_500);
    expect(rec.generators[0]!.signals).toContain('SIGKILL');
    // Still the operator's stop, not a failure — and bounded by the grace
    // (200 ms here), not by the 2 s prime timeout.
    expect(controller.lastRun()?.state).toBe('stopped');
    expect(rec.releases).toBe(2);
  });
});

describe('failures', () => {
  it('records a generator that crashes while priming as failed, and cleans up', async () => {
    const { controller, rec } = buildController({ script: 'crash-on-start' });
    track(controller);
    controller.start(REQ, null);
    await controller.whenIdle();
    const last = controller.lastRun()!;
    expect(last.state).toBe('failed');
    expect(last.error).toMatch(/exited unexpectedly while priming/);
    expect(rec.rows[0]?.status).toBe('failed');
    expect(rec.releases).toBe(2);
  });

  it('records a generator error during the timed phase, and evicts its cold cards', async () => {
    const { controller, rec } = buildController({ script: 'error-on-go' });
    track(controller);
    controller.start({ profile: 'cards', cardMode: 'cold', concurrency: 1, durationSeconds: 60 }, null);
    await controller.whenIdle();
    expect(controller.lastRun()?.state).toBe('failed');
    expect(controller.lastRun()?.error).toMatch(/boom/);
    expect(rec.evicted).toHaveLength(1);
  });

  it('stops, then kills, a generator that overruns its deadline', async () => {
    const { controller, rec } = buildController({
      script: 'manual',
      overrides: { deadlineGraceMs: 50, stopGraceMs: 50 },
    });
    track(controller);
    controller.start({ ...REQ, durationSeconds: 0 }, null);
    await new Promise((r) => setTimeout(r, 10));
    rec.generators[0]!.emitMessage({ type: 'primed' });
    await controller.whenIdle();
    const gen = rec.generators[0]!;
    expect(gen.sent.map((m) => m.type)).toContain('stop');
    expect(gen.signals).toContain('SIGKILL');
    expect(controller.lastRun()?.state).toBe('failed');
    expect(controller.lastRun()?.error).toMatch(/killed/);
  });
});
