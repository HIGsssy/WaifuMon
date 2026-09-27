/**
 * The load generator process.
 *
 * ## Why a separate process
 *
 * The harness exists to read the Waifumon process's event-loop delay, loop
 * utilization and CPU under load. A generator inside that process would add
 * its own work to every one of those readings — building requests, parsing
 * responses, reading card bytes, running fifty timers — and its client-side
 * latencies would include time spent queued behind the very server work it was
 * timing. So the controller forks this file instead, and the load arrives over
 * loopback HTTP like any other client's. The System Metrics `process` and
 * `eventLoop` figures then describe Waifumon alone.
 *
 * What separation cannot remove: this process shares the host and (under
 * Docker) the container's cgroup, so it *is* inside the `host` CPU and cgroup
 * memory figures. It reports its own CPU in every snapshot so that share can be
 * read off and subtracted.
 *
 * ## What this process can reach
 *
 * Only HTTP. It is forked with a scrubbed environment — no `DATABASE_URL`, no
 * `DISCORD_TOKEN`, no `PLATFORM_API_TOKEN` — and imports nothing that talks to
 * Postgres or Discord. Its only credentials are the synthetic players' Portal
 * session cookies, which the server itself limits to those players' data.
 *
 * ## Lifetime
 *
 * It stops, and exits, when told to, when its own deadline passes, or when the
 * parent goes away. A generator that outlived the server that spawned it would
 * be load nobody is watching.
 */
import { LoadEngine } from './engine';
import type { ControllerMessage, RunnerMessage, RunnerPlan } from './types';

/** Slack past the requested duration before the generator gives up on itself. */
const SELF_DEADLINE_SLACK_MS = 10 * 60_000;

function send(message: RunnerMessage): void {
  process.send?.(message);
}

function main(): void {
  // The second lock. The controller never forks this with the flag off, and a
  // copy of this file started by hand, or from a production build, refuses.
  if (process.env.LOAD_TESTING_ENABLED !== 'true' || typeof process.send !== 'function') {
    console.error('load generator refused: LOAD_TESTING_ENABLED is not true, or no controller channel');
    process.exit(2);
  }

  let engine: LoadEngine | undefined;
  let plan: RunnerPlan | undefined;
  let progressTimer: NodeJS.Timeout | undefined;
  let finished = false;
  /** Primed and waiting for the controller's `go` — nothing else will end the run. */
  let awaitingGo = false;

  const finish = (message: RunnerMessage): void => {
    if (finished) return;
    finished = true;
    if (progressTimer) clearInterval(progressTimer);
    process.send!(message, () => {
      process.disconnect?.();
      process.exit(0);
    });
  };

  const fail = (err: unknown): void => {
    finish({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  };

  process.on('disconnect', () => {
    // The parent is gone: stop generating load immediately.
    engine?.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    engine?.stop();
  });

  process.on('message', (raw: ControllerMessage) => {
    switch (raw.type) {
      case 'start': {
        if (engine) return;
        plan = raw.plan;
        engine = new LoadEngine(plan, { cpuUsage: () => process.cpuUsage() });
        const self = setTimeout(() => {
          engine?.stop();
          fail(new Error('load generator exceeded its own deadline'));
        }, plan.durationMs + SELF_DEADLINE_SLACK_MS);
        self.unref();
        progressTimer = setInterval(() => {
          if (engine) send({ type: 'progress', snapshot: engine.snapshot() });
        }, plan.progressIntervalMs);
        engine
          .prime()
          .then(() => {
            if (engine!.stopped) {
              finish({ type: 'done', summary: engine!.summary(), stopped: true });
              return;
            }
            awaitingGo = true;
            send({ type: 'primed' });
          })
          .catch(fail);
        return;
      }
      case 'go': {
        if (!engine || !plan || !awaitingGo) return;
        awaitingGo = false;
        engine
          .run(raw.coldCards)
          .then((summary) => finish({ type: 'done', summary, stopped: engine!.stopped }))
          .catch(fail);
        return;
      }
      case 'stop': {
        if (!engine) {
          process.exit(0);
        }
        engine.stop();
        if (awaitingGo) finish({ type: 'done', summary: engine.summary(), stopped: true });
        return;
      }
    }
  });
}

main();
