import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config';
import { ConfigError } from '../../src/shared/errors';

const validEnv = {
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '12345',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/waifumon',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.discordToken).toBe('token');
    expect(config.dailyTimezone).toBe('UTC');
    expect(config.logLevel).toBe('info');
    expect(config.assetsDir).toBe(path.resolve('./assets'));
    expect(config.contentDir).toBe(path.resolve('./content'));
    expect(config.discordGuildId).toBeUndefined();
  });

  it('rejects a missing DISCORD_TOKEN', () => {
    const { DISCORD_TOKEN: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://x' })).toThrow(ConfigError);
  });

  it('rejects an invalid DAILY_TIMEZONE', () => {
    expect(() => loadConfig({ ...validEnv, DAILY_TIMEZONE: 'Mars/Olympus_Mons' })).toThrow(
      ConfigError,
    );
  });

  it('accepts a valid non-UTC timezone and custom ASSETS_DIR', () => {
    const config = loadConfig({
      ...validEnv,
      DAILY_TIMEZONE: 'America/New_York',
      ASSETS_DIR: '/srv/assets',
    });
    expect(config.dailyTimezone).toBe('America/New_York');
    expect(config.assetsDir).toBe(path.resolve('/srv/assets'));
  });
});
