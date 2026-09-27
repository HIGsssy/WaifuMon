/**
 * The real generator process, forked the way the controller forks it.
 *
 * Pinned:
 *   - it refuses to run without `LOAD_TESTING_ENABLED=true` (the lock that
 *     holds even if the file is started by hand from a production build);
 *   - it speaks the protocol end to end over real IPC against a real HTTP
 *     server: start → primed → go → progress → done, then exits;
 *   - stop ends it promptly with a `stopped` summary;
 *   - it exits when its parent disconnects.
 */
import { fork, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerMessage, RunnerPlan } from '../../../src/modules/loadTest/types';
import { fakePlayers } from '../../helpers/loadTestFakes';

const RUNNER = path.resolve(__dirname, '../../../src/modules/loadTest/runner.ts');

let server: http.Server | undefined;
let child: ChildProcess | undefined;
const hits: string[] = [];

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  hits.length = 0;
});

async function startServer(): Promise<string> {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers.cookie ?? ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":{}}');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function spawnRunner(env: NodeJS.ProcessEnv): ChildProcess {
  return fork(RUNNER, [], {
    env: { PATH: process.env.PATH, ...env },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
  });
}

function waitFor(c: ChildProcess, type: RunnerMessage['type'], timeoutMs = 20_000): Promise<RunnerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const onMessage = (m: RunnerMessage) => {
      if (m.type === type || m.type === 'error') {
        clearTimeout(timer);
        c.off('message', onMessage);
        resolve(m);
      }
    };
    c.on('message', onMessage);
  });
}

function exitCode(c: ChildProcess): Promise<number | null> {
  return new Promise((r) => (c.exitCode !== null ? r(c.exitCode) : c.once('exit', (code) => r(code))));
}

function plan(baseUrl: string, durationMs: number): RunnerPlan {
  return {
    runKey: 'proc-test',
    baseUrl,
    sessionCookieName: 'wm_portal_session',
    profile: 'portal',
    cardMode: null,
    cardsAvailable: false,
    concurrency: 2,
    durationMs,
    seed: 1,
    requestTimeoutMs: 2_000,
    progressIntervalMs: 200,
    players: fakePlayers(2),
  };
}

describe('generator process', () => {
  it('refuses to run without LOAD_TESTING_ENABLED=true', async () => {
    child = spawnRunner({});
    expect(await exitCode(child)).toBe(2);
    child = spawnRunner({ LOAD_TESTING_ENABLED: 'false' });
    expect(await exitCode(child)).toBe(2);
  }, 30_000);

  it('runs the protocol end to end over IPC and HTTP', async () => {
    const baseUrl = await startServer();
    child = spawnRunner({ LOAD_TESTING_ENABLED: 'true' });
    const progress: RunnerMessage[] = [];
    child.on('message', (m: RunnerMessage) => m.type === 'progress' && progress.push(m));

    child.send({ type: 'start', plan: plan(baseUrl, 1_500) });
    expect((await waitFor(child, 'primed')).type).toBe('primed');
    const primeHits = hits.length;
    expect(primeHits).toBeGreaterThan(10);

    child.send({ type: 'go', coldCards: [] });
    const done = await waitFor(child, 'done');
    expect(done.type).toBe('done');
    if (done.type !== 'done') return;
    expect(done.stopped).toBe(false);
    expect(done.summary.completed).toBeGreaterThan(0);
    expect(done.summary.failures.total).toBe(0);
    expect(done.summary.attempted).toBe(hits.length - primeHits);
    expect(progress.length).toBeGreaterThan(0);
    expect(await exitCode(child)).toBe(0);

    // Every request was a GET with a synthetic session cookie.
    for (const h of hits) expect(h).toMatch(/^GET \S+ wm_portal_session=token-\d$/);
  }, 30_000);

  it('stops promptly on request', async () => {
    const baseUrl = await startServer();
    child = spawnRunner({ LOAD_TESTING_ENABLED: 'true' });
    child.send({ type: 'start', plan: plan(baseUrl, 60_000) });
    await waitFor(child, 'primed');
    child.send({ type: 'go', coldCards: [] });
    await new Promise((r) => setTimeout(r, 300));
    const stoppedAt = Date.now();
    child.send({ type: 'stop' });
    const done = await waitFor(child, 'done');
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    expect(done.type === 'done' && done.stopped).toBe(true);
    expect(await exitCode(child)).toBe(0);
  }, 30_000);

  it('exits when its parent disconnects', async () => {
    const baseUrl = await startServer();
    child = spawnRunner({ LOAD_TESTING_ENABLED: 'true' });
    child.send({ type: 'start', plan: plan(baseUrl, 60_000) });
    await waitFor(child, 'primed');
    child.disconnect();
    expect(await exitCode(child)).toBe(0);
  }, 30_000);
});
