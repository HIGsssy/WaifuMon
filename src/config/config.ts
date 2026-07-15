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
});

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
  return {
    discordToken: e.DISCORD_TOKEN,
    discordClientId: e.DISCORD_CLIENT_ID,
    discordGuildId: e.DISCORD_GUILD_ID,
    databaseUrl: e.DATABASE_URL,
    assetsDir: path.resolve(e.ASSETS_DIR),
    contentDir: path.resolve(e.CONTENT_DIR),
    dailyTimezone: e.DAILY_TIMEZONE,
    logLevel: e.LOG_LEVEL,
  };
}
