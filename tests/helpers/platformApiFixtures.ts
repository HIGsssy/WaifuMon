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
import type { OwnedCardWarmer } from '../../src/modules/appearance/ownedCardWarm';
import type { ReadinessProbes } from '../../src/api/routes/health';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import { createProgressionService } from '../../src/modules/progression/progressionService';
import type { ProgressionConfig } from '../../src/modules/content/schemas';
import type { AppServices } from '../../src/discord/types';
import type { LoadedContent } from '../../src/modules/content/schemas';
import type { Logger } from '../../src/shared/logger';
import type { PortalAuthorizationService } from '../../src/modules/portalAuth/portalAuthService';

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
  /**
   * Background owned-card warmer. Omitted by default, which is what a
   * deployment with card rendering switched off looks like: the collection
   * route optional-chains it and schedules nothing.
   */
  cardWarmer?: Pick<OwnedCardWarmer, 'schedulePlayerWarm'>;
  /**
   * Portal permission oracle. Omitted by default, which is what a deployment
   * with no Discord bot looks like — every admin route then answers 403,
   * which is the intended fail-closed behaviour and worth being the default a
   * test has to opt out of.
   */
  portalAuthorization?: PortalAuthorizationService;
  /**
   * Whether the shared bearer token counts as an administrator. Omitted means
   * no, mirroring `PLATFORM_API_ADMIN_BEARER`'s own default.
   */
  adminBearerAllowed?: boolean;
}

const EMPTY_CONTENT: LoadedContent = {
  items: [],
  species: [],
  tables: {} as LoadedContent['tables'],
  bosses: [],
  bossRewards: [],
  regions: [],
  expansions: [],
  speciesOrigin: {},
};

/**
 * Progression tuning for a context whose content carries none.
 *
 * Mirrors the shipped `tables.json` numbers so a fixture player's level curve
 * and Energy ceiling are the real ones, without every route test having to
 * hand-author a full tuning blob. A test that supplies `content.tables` gets
 * its own values instead.
 */
const FIXTURE_PROGRESSION: ProgressionConfig = {
  levelCurve: { base: 100, growth: 50 },
  maxLevel: 50,
  maxEnergy: { cap: 40, levelBonuses: [{ atLevel: 7, delta: 5 }, { atLevel: 20, delta: 5 }] },
  xp: {
    hunt: 5,
    captureFailed: 2,
    captureSuccessByRarity: { N: 10, R: 15, SR: 25, SSR: 50, UR: 100, LR: 200, EX: 100 },
    newDexEntry: 25,
    dailyClaim: 20,
  },
  rareEncounterShift: { atLevel: 40, fromRarity: 'N', toRarity: 'R', weightUnits: 1 },
  dailyBonusItems: [],
  dailyRareItemChance: { atLevel: 30, chance: 0.15, slug: 'velvet_charm', quantity: 1 },
  prestigeTitles: [],
};

const FIXTURE_BASE_MAX_ENERGY = 25;

export function createApiContext(overrides: ApiContextOverrides = {}): ApiContext {
  const content: LoadedContent = { ...EMPTY_CONTENT, ...overrides.content };

  /**
   * `appearance.catalogFor` / `currentAppearance` are pure content lookups —
   * no database, no I/O — and almost every resource embeds artwork now. A real
   * service built over the context's own content snapshot is therefore both
   * more faithful *and* less friction than making every route test hand-stub a
   * catalog. `db` is never touched by those two methods; a stub can still
   * override the whole service when a test wants the transactional half.
   */
  const defaultAppearance = createAppearanceService({
    db: null as unknown as Parameters<typeof createAppearanceService>[0]['db'],
    getContent: () => content,
  });

  /**
   * Same bargain as `appearance`, and now for the same reason: every player
   * resource carries `progress` and every balance carries its Energy ceiling,
   * both of which are pure arithmetic over the tuning config with no database
   * behind them. A real service is more faithful than a hand-stubbed number and
   * spares every player-scoped route test from inventing a level curve.
   */
  const defaultProgression = createProgressionService({
    config: content.tables?.progression ?? FIXTURE_PROGRESSION,
    baseMaxEnergy: content.tables?.energy?.baseMax ?? FIXTURE_BASE_MAX_ENERGY,
  });

  const services = new Proxy({} as AppServices, {
    get(_target, serviceName: string) {
      const stub = (overrides.services as Record<string, unknown> | undefined)?.[serviceName];
      const fallback =
        serviceName === 'appearance'
          ? (defaultAppearance as unknown as Record<string, unknown>)
          : serviceName === 'progression'
            ? (defaultProgression as unknown as Record<string, unknown>)
            : undefined;
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            const impl = (stub as Record<string, unknown> | undefined)?.[method];
            if (typeof impl === 'function') return impl;
            const inherited = fallback?.[method];
            if (typeof inherited === 'function') return inherited;
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

  return {
    services,
    getContent: () => content,
    // `exactOptionalPropertyTypes` — only set the key when a resolver is given,
    // so the default context is genuinely "no Discord client wired".
    ...(overrides.resolveIdentity ? { resolveIdentity: overrides.resolveIdentity } : {}),
    ...(overrides.cardWarmer
      ? { cardWarmer: overrides.cardWarmer as unknown as OwnedCardWarmer }
      : {}),
    ...(overrides.portalAuthorization
      ? { portalAuthorization: overrides.portalAuthorization }
      : {}),
    ...(overrides.adminBearerAllowed === undefined
      ? {}
      : { adminBearerAllowed: overrides.adminBearerAllowed }),
  };
}
