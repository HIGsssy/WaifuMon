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
import type { ApiContext } from '../../src/api/context';
import type { IdentityResolver } from '../../src/api/identity';
import type { ReadinessProbes } from '../../src/api/routes/health';
import type { AppServices } from '../../src/discord/types';
import type { LoadedContent } from '../../src/modules/content/schemas';
import type { Logger } from '../../src/shared/logger';

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

/**
 * A context whose services are test doubles. Handler unit tests substitute
 * only the two or three methods the route under test calls; anything else
 * throws loudly, which is how a route that reaches for a service it should not
 * be using gets caught.
 *
 * `deep` is `Partial` per service so a test can write
 * `createApiContext({ services: { currency: { getBalances: async () => row } } })`.
 */
export type ServiceStubs = {
  [K in keyof AppServices]?: Partial<AppServices[K]>;
};

export interface ApiContextOverrides {
  services?: ServiceStubs;
  content?: Partial<LoadedContent>;
  /**
   * Presentation identity resolver. Omitted by default so the API behaves as a
   * process with no Discord client does — every player reports
   * `identity: null` — which is also the shape most route tests want.
   */
  resolveIdentity?: IdentityResolver;
}

const EMPTY_CONTENT: LoadedContent = {
  items: [],
  species: [],
  tables: {} as LoadedContent['tables'],
};

export function createApiContext(overrides: ApiContextOverrides = {}): ApiContext {
  const services = new Proxy({} as AppServices, {
    get(_target, serviceName: string) {
      const stub = (overrides.services as Record<string, unknown> | undefined)?.[serviceName];
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            const impl = (stub as Record<string, unknown> | undefined)?.[method];
            if (typeof impl === 'function') return impl;
            return () => {
              throw new Error(
                `test double: services.${serviceName}.${method}() was called but not stubbed`,
              );
            };
          },
        },
      );
    },
  });

  const content: LoadedContent = { ...EMPTY_CONTENT, ...overrides.content };
  return {
    services,
    getContent: () => content,
    // `exactOptionalPropertyTypes` — only set the key when a resolver is given,
    // so the default context is genuinely "no Discord client wired".
    ...(overrides.resolveIdentity ? { resolveIdentity: overrides.resolveIdentity } : {}),
  };
}
