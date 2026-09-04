import path from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../shared/errors';
import { isValidTimezone } from '../shared/time';

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  /** When set, slash commands register guild-scoped (instant updates). */
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgres:// connection string',
    }),
  ASSETS_DIR: z.string().min(1).default('./assets'),
  CONTENT_DIR: z.string().min(1).default('./content'),
  DAILY_TIMEZONE: z
    .string()
    .default('UTC')
    .refine(isValidTimezone, { message: 'DAILY_TIMEZONE must be a valid IANA timezone' }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Internal content-admin web panel (Admin Milestone 1). Disabled by default;
   * binds to loopback so it is only reachable through an SSH tunnel unless an
   * operator deliberately fronts it with a reverse proxy.
   */
  ADMIN_WEB_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  ADMIN_WEB_HOST: z.string().min(1).default('127.0.0.1'),
  ADMIN_WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3111),
  /** Shared admin secret. Required when ADMIN_WEB_ENABLED — never logged. */
  ADMIN_WEB_TOKEN: z.string().optional(),

  /**
   * Internal Platform REST API (`/api/v1/…`). A second Fastify instance in
   * this same process, sharing the service layer in memory. Disabled by
   * default; binds to loopback so it is only reachable through an SSH tunnel
   * or a tailnet address the operator publishes it on.
   */
  PLATFORM_API_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  PLATFORM_API_HOST: z.string().min(1).default('127.0.0.1'),
  PLATFORM_API_PORT: z.coerce.number().int().min(1).max(65535).default(3120),
  /** Shared bearer secret. Required when PLATFORM_API_ENABLED — never logged. */
  PLATFORM_API_TOKEN: z.string().optional(),
  /**
   * Treat `PLATFORM_API_TOKEN` as an **administrative** credential, letting a
   * bearer request satisfy Portal admin permission checks without a Portal
   * session.
   *
   * Off by default, and deliberately so. The token is one process-wide shared
   * secret with no per-user scoping; the Portal admin surface it would unlock
   * can author, publish and delete game content. Enable it only for a
   * loopback-bound deployment that genuinely drives content from scripts, and
   * understand that everyone holding the token is then an administrator.
   * See `src/api/plugins/portalPermissions.ts`.
   */
  PLATFORM_API_ADMIN_BEARER: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * How *clients* reach the API — the base URL advertised in the OpenAPI
   * document, and therefore the one Swagger UI's "Try it out" calls. Distinct
   * from PLATFORM_API_HOST, which is only where the process binds: under
   * Docker that bind is 0.0.0.0, which no browser can route to. Optional; when
   * unset the URL is derived from the bind (see `resolvePublicUrl`).
   */
  /**
   * Rendered card images (`/api/v1/cards/…`). Temporary rollout gating for the
   * SVG card renderer, not permanent architecture — Phase 6 removes it once the
   * renderer is stable in production.
   *
   * Off by default, matching every other optional surface here: a flag that
   * ships on cannot be *rolled out*, and rasterizing is the most expensive
   * thing this process does. Development and test environments turn it on
   * explicitly (`.env`, and the API test fixtures).
   */
  CARD_RENDERER_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * Worker threads that draw card masters.
   *
   * Drawing one blocks its thread for ~750 ms of synchronous resvg, so it
   * happens off the main thread — this is how many threads may do so at once,
   * and therefore the ceiling on concurrent cold renders.
   *
   * Two by default, and deliberately *not* derived from `os.cpus()`: each
   * thread holds a full decoded card, and a container rarely has the core
   * count the host advertises. `0` renders in-process instead, which is the
   * escape hatch for an environment without threads — it produces identical
   * bytes and reinstates the stall.
   */
  CARD_RENDER_WORKERS: z.coerce.number().int().min(0).max(8).default(2),
  /**
   * Owned cards warmed at once by a background warm.
   *
   * Background warming exists so a collection grid is served from cache; the
   * player who triggered it has already had their response, so this is tuned
   * for invisibility rather than throughput. One composes correctly with a
   * single render worker: a cold master someone is actually waiting for queues
   * behind at most one warm card.
   *
   * Capped low on purpose. This is not the knob for making a back-catalogue
   * warm finish sooner — `cards:warm --concurrency` is, and it is an operator
   * running a job, not a live process deciding on its own.
   */
  CARD_WARM_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /**
   * Whether a collection listing triggers a background warm of that player's
   * owned cards.
   *
   * On by default, and the switch is here rather than in the Portal because
   * the cost lands on the backend. It is the self-*healing* path, not the
   * primary one — turning it off leaves warm-on-capture and the ops CLI intact,
   * and every card still renders on demand. An operator watching a small node
   * struggle should be able to take this out of the picture without giving up
   * card rendering entirely.
   */
  CARD_WARM_ON_COLLECTION: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  PLATFORM_API_PUBLIC_URL: z
    .string()
    .trim()
    .optional()
    // Blank is the shipped value in .env.example — treat it as "not set"
    // rather than as an invalid URL.
    .transform((v) => (v !== undefined && v.length > 0 ? v : undefined))
    .refine((v) => v === undefined || isAdvertisableUrl(v), {
      message:
        'PLATFORM_API_PUBLIC_URL must be an absolute http(s) URL a client can reach ' +
        '(e.g. http://127.0.0.1:3120), never a wildcard bind like 0.0.0.0',
    })
    .transform((v) => (v === undefined ? undefined : stripTrailingSlash(v))),
  PORTAL_PUBLIC_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v !== undefined && v.length > 0 ? stripTrailingSlash(v) : undefined))
    .refine((v) => v === undefined || isAdvertisableUrl(v), {
      message: 'PORTAL_PUBLIC_URL must be an absolute http(s) URL',
    }),
  PORTAL_FORWARDED_PROTO: z.enum(['http', 'https']).default('http'),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  PORTAL_SESSION_SECRET: z.string().optional(),
  PORTAL_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(60 * 60 * 24 * 30).default(60 * 60 * 24 * 7),
});

/** Binds that mean "every interface" — valid to listen on, useless to publish. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0.0.0.0:0']);

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * A URL is advertisable when a client can actually dial it: absolute, http(s),
 * and pointed at a real host rather than a wildcard bind.
 */
function isAdvertisableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.hostname.length === 0) return false;
  return !WILDCARD_HOSTS.has(url.hostname);
}

export interface AdminWebConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Empty string only when disabled — a startup check enforces this. */
  token: string;
}

export interface PlatformApiConfig {
  enabled: boolean;
  /** Where the process listens. An internal networking concern only. */
  host: string;
  port: number;
  /** Empty string only when disabled — a startup check enforces this. */
  token: string;
  /**
   * Whether a bearer request may satisfy Portal admin permission checks.
   *
   * Optional, and absent means **no** — every consumer treats anything but an
   * explicit `true` as closed, so a config literal that has not thought about
   * this question (a test fixture, an older deployment) cannot accidentally
   * hand out admin. See `PLATFORM_API_ADMIN_BEARER`.
   */
  adminBearer?: boolean | undefined;
  /**
   * The base URL clients use, when the operator set one. Absent means "derive
   * it from the bind" — see `resolvePublicUrl`, which is what callers should
   * use rather than reading this field directly.
   */
  publicUrl?: string | undefined;
  /**
   * Whether `/api/v1/cards/…` is registered at all. Gating registration rather
   * than branching inside handlers means "disabled" is indistinguishable from
   * "never existed" — the routes 404 through the normal not-found handler and
   * no card code is reachable.
   *
   * Optional so that absent reads as off. `resolveAppConfig` always sets it, so
   * the running process is never ambiguous; the looseness is for callers that
   * assemble a config by hand (tests, tools) and should not have to opt out of
   * a feature they are not exercising.
   */
  cardRendererEnabled?: boolean | undefined;
  /** Threads for cold master rendering; see `CARD_RENDER_WORKERS`. */
  cardRenderWorkers?: number | undefined;
  /** Owned cards warmed at once in the background; see `CARD_WARM_CONCURRENCY`. */
  cardWarmConcurrency?: number | undefined;
  /**
   * Whether listing a collection triggers a background warm of that player's
   * owned cards; see `CARD_WARM_ON_COLLECTION`. Absent reads as off, for the
   * same reason `cardRendererEnabled` does.
   */
  cardWarmOnCollection?: boolean | undefined;
}

export interface PortalAuthConfig {
  enabled: boolean;
  publicUrl: string;
  forwardedProto: 'http' | 'https';
  discordClientId: string;
  discordClientSecret: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
}

/**
 * The base URL to advertise to clients (OpenAPI `servers`, startup log lines).
 *
 * `PLATFORM_API_PUBLIC_URL` wins when set. Otherwise the bind is reused —
 * except a wildcard bind, which is not routable from a browser and would make
 * Swagger UI's "Try it out" fail against `http://0.0.0.0:3120`. For that case
 * loopback is the only safe guess: under Docker the port is published on
 * `PLATFORM_API_PUBLISH_HOST`, which defaults to 127.0.0.1, and an operator
 * who publishes anywhere else sets `PLATFORM_API_PUBLIC_URL` to match.
 */
export function resolvePublicUrl(
  config: Pick<PlatformApiConfig, 'host' | 'port' | 'publicUrl'>,
): string {
  if (config.publicUrl !== undefined) return config.publicUrl;
  const host = WILDCARD_HOSTS.has(config.host) ? '127.0.0.1' : config.host;
  // Bare IPv6 literals need brackets before they can carry a port.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${config.port}`;
}

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string | undefined;
  databaseUrl: string;
  /** Absolute path to the assets root. */
  assetsDir: string;
  /** Absolute path to the content JSON root. */
  contentDir: string;
  dailyTimezone: string;
  logLevel: string;
  adminWeb: AdminWebConfig;
  platformApi: PlatformApiConfig;
  portalAuth?: PortalAuthConfig | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration — ${details}`);
  }
  const e = parsed.data;
  const adminToken = (e.ADMIN_WEB_TOKEN ?? '').trim();
  if (e.ADMIN_WEB_ENABLED && adminToken.length === 0) {
    throw new ConfigError(
      'Invalid environment configuration — ADMIN_WEB_TOKEN is required when ADMIN_WEB_ENABLED=true',
    );
  }
  const platformApiToken = (e.PLATFORM_API_TOKEN ?? '').trim();
  if (e.PLATFORM_API_ENABLED && platformApiToken.length === 0) {
    throw new ConfigError(
      'Invalid environment configuration — PLATFORM_API_TOKEN is required when PLATFORM_API_ENABLED=true',
    );
  }
  const portalPublicUrl = e.PORTAL_PUBLIC_URL ?? '';
  const discordClientSecret = (e.DISCORD_CLIENT_SECRET ?? '').trim();
  const portalSessionSecret = (e.PORTAL_SESSION_SECRET ?? '').trim();
  const portalAuthEnabled = portalPublicUrl.length > 0;
  if (portalAuthEnabled && discordClientSecret.length === 0) {
    throw new ConfigError(
      'Invalid environment configuration — DISCORD_CLIENT_SECRET is required when PORTAL_PUBLIC_URL is set',
    );
  }
  if (portalAuthEnabled && portalSessionSecret.length < 32) {
    throw new ConfigError(
      'Invalid environment configuration — PORTAL_SESSION_SECRET must be at least 32 characters when PORTAL_PUBLIC_URL is set',
    );
  }
  return {
    discordToken: e.DISCORD_TOKEN,
    discordClientId: e.DISCORD_CLIENT_ID,
    discordGuildId: e.DISCORD_GUILD_ID,
    databaseUrl: e.DATABASE_URL,
    assetsDir: path.resolve(e.ASSETS_DIR),
    contentDir: path.resolve(e.CONTENT_DIR),
    dailyTimezone: e.DAILY_TIMEZONE,
    logLevel: e.LOG_LEVEL,
    adminWeb: {
      enabled: e.ADMIN_WEB_ENABLED,
      host: e.ADMIN_WEB_HOST,
      port: e.ADMIN_WEB_PORT,
      token: adminToken,
    },
    platformApi: {
      enabled: e.PLATFORM_API_ENABLED,
      host: e.PLATFORM_API_HOST,
      port: e.PLATFORM_API_PORT,
      token: platformApiToken,
      adminBearer: e.PLATFORM_API_ADMIN_BEARER,
      publicUrl: e.PLATFORM_API_PUBLIC_URL,
      cardRendererEnabled: e.CARD_RENDERER_ENABLED,
      cardRenderWorkers: e.CARD_RENDER_WORKERS,
      cardWarmConcurrency: e.CARD_WARM_CONCURRENCY,
      cardWarmOnCollection: e.CARD_WARM_ON_COLLECTION,
    },
    portalAuth: {
      enabled: portalAuthEnabled,
      publicUrl: portalPublicUrl,
      forwardedProto: e.PORTAL_FORWARDED_PROTO,
      discordClientId: e.DISCORD_CLIENT_ID,
      discordClientSecret,
      sessionSecret: portalSessionSecret,
      sessionTtlSeconds: e.PORTAL_SESSION_TTL_SECONDS,
    },
  };
}
