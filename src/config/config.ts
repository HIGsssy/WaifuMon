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
});

export interface AdminWebConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Empty string only when disabled — a startup check enforces this. */
  token: string;
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
  };
}
