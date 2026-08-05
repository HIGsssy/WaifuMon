/**
 * Platform API test scaffolding.
 *
 * The API is a pure HTTP adapter, so its unit tests need no database and no
 * Discord client — only the readiness probes, which are plain functions here
 * and can be made to fail on demand.
 *
 * The logger writes into an in-memory buffer so tests can assert on what did
 * (and, for the bearer token, did not) reach the log.
 */
import pino from 'pino';
import type { Logger } from '../../src/shared/logger';
import type { ReadinessProbes } from '../../src/api/routes/health';

export const TEST_TOKEN = 'super-secret-platform-token';

export interface CapturedLogger {
  logger: Logger;
  /** Every line written so far, raw JSON. */
  lines: () => string[];
  /** All output concatenated — handy for "this string never appears" checks. */
  text: () => string;
}

export function createCapturedLogger(level = 'trace'): CapturedLogger {
  const lines: string[] = [];
  const logger = pino(
    { level, base: { app: 'waifumon-bot' }, timestamp: pino.stdTimeFunctions.isoTime },
    {
      write(chunk: string) {
        lines.push(chunk.trimEnd());
      },
    },
  );
  return { logger, lines: () => [...lines], text: () => lines.join('\n') };
}

export interface ProbeOverrides {
  pingDatabase?: () => Promise<void>;
  describeContent?: () => { species: number; items: number } | null;
  describeDiscord?: () => ReturnType<ReadinessProbes['describeDiscord']>;
  describeBind?: () => string;
}

/** All-healthy probes, with individual components overridable per test. */
export function createProbes(overrides: ProbeOverrides = {}): ReadinessProbes {
  return {
    pingDatabase: overrides.pingDatabase ?? (async () => {}),
    describeContent: overrides.describeContent ?? (() => ({ species: 49, items: 7 })),
    describeDiscord:
      overrides.describeDiscord ?? (() => ({ status: 'ok', detail: 'gateway connected' })),
    describeBind: overrides.describeBind ?? (() => 'listening on 127.0.0.1:3120'),
  };
}
