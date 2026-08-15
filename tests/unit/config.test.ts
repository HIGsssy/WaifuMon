import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, resolvePublicUrl } from '../../src/config/config';
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

  it('leaves the admin web panel disabled by default', () => {
    const config = loadConfig(validEnv);
    expect(config.adminWeb).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 3111,
      token: '',
    });
  });

  it('rejects ADMIN_WEB_ENABLED=true without a token', () => {
    expect(() => loadConfig({ ...validEnv, ADMIN_WEB_ENABLED: 'true' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...validEnv, ADMIN_WEB_ENABLED: 'true', ADMIN_WEB_TOKEN: '   ' }),
    ).toThrow(/ADMIN_WEB_TOKEN is required/);
  });

  it('defaults the admin panel to 127.0.0.1:3111 when enabled with a token', () => {
    const config = loadConfig({
      ...validEnv,
      ADMIN_WEB_ENABLED: 'true',
      ADMIN_WEB_TOKEN: 'a-secret',
    });
    expect(config.adminWeb).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 3111,
      token: 'a-secret',
    });
  });

  it('accepts an explicit admin host and port', () => {
    const config = loadConfig({
      ...validEnv,
      ADMIN_WEB_ENABLED: '1',
      ADMIN_WEB_TOKEN: 'a-secret',
      ADMIN_WEB_HOST: '0.0.0.0',
      ADMIN_WEB_PORT: '4000',
    });
    expect(config.adminWeb.enabled).toBe(true);
    expect(config.adminWeb.host).toBe('0.0.0.0');
    expect(config.adminWeb.port).toBe(4000);
  });

  it('rejects an out-of-range admin port', () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        ADMIN_WEB_ENABLED: 'true',
        ADMIN_WEB_TOKEN: 'a-secret',
        ADMIN_WEB_PORT: '99999',
      }),
    ).toThrow(ConfigError);
  });

  it('leaves the platform API disabled by default', () => {
    const config = loadConfig(validEnv);
    expect(config.platformApi).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 3120,
      token: '',
      cardRendererEnabled: false,
    });
  });

  it('rejects PLATFORM_API_ENABLED=true without a token', () => {
    expect(() => loadConfig({ ...validEnv, PLATFORM_API_ENABLED: 'true' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...validEnv, PLATFORM_API_ENABLED: 'true', PLATFORM_API_TOKEN: '   ' }),
    ).toThrow(/PLATFORM_API_TOKEN is required/);
  });

  it('defaults the platform API to 127.0.0.1:3120 when enabled with a token', () => {
    const config = loadConfig({
      ...validEnv,
      PLATFORM_API_ENABLED: 'true',
      PLATFORM_API_TOKEN: 'a-secret',
    });
    expect(config.platformApi).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 3120,
      token: 'a-secret',
      cardRendererEnabled: false,
    });
  });

  it('leaves the card renderer off unless asked, and takes both truthy spellings', () => {
    // Off by default is the safe direction: rasterizing is the most expensive
    // thing the process does, and a flag that ships on cannot be rolled out.
    expect(loadConfig(validEnv).platformApi.cardRendererEnabled).toBe(false);
    for (const value of ['true', '1']) {
      expect(
        loadConfig({ ...validEnv, CARD_RENDERER_ENABLED: value }).platformApi.cardRendererEnabled,
        value,
      ).toBe(true);
    }
    for (const value of ['false', '0']) {
      expect(
        loadConfig({ ...validEnv, CARD_RENDERER_ENABLED: value }).platformApi.cardRendererEnabled,
        value,
      ).toBe(false);
    }
  });

  it('accepts an explicit platform API host and port', () => {
    const config = loadConfig({
      ...validEnv,
      PLATFORM_API_ENABLED: '1',
      PLATFORM_API_TOKEN: 'a-secret',
      PLATFORM_API_HOST: '0.0.0.0',
      PLATFORM_API_PORT: '4100',
    });
    expect(config.platformApi.enabled).toBe(true);
    expect(config.platformApi.host).toBe('0.0.0.0');
    expect(config.platformApi.port).toBe(4100);
  });

  it('accepts a platform API public URL and strips its trailing slash', () => {
    const config = loadConfig({
      ...validEnv,
      PLATFORM_API_ENABLED: 'true',
      PLATFORM_API_TOKEN: 'a-secret',
      PLATFORM_API_HOST: '0.0.0.0',
      PLATFORM_API_PUBLIC_URL: 'https://api.waifumon.com/',
    });
    expect(config.platformApi.publicUrl).toBe('https://api.waifumon.com');
    // The bind is untouched by it — the two are separate concerns.
    expect(config.platformApi.host).toBe('0.0.0.0');
  });

  it('treats a blank platform API public URL as unset', () => {
    const config = loadConfig({
      ...validEnv,
      PLATFORM_API_ENABLED: 'true',
      PLATFORM_API_TOKEN: 'a-secret',
      PLATFORM_API_PUBLIC_URL: '   ',
    });
    expect(config.platformApi.publicUrl).toBeUndefined();
  });

  it('rejects a platform API public URL clients could not dial', () => {
    for (const url of ['127.0.0.1:3120', 'ftp://host:3120', 'http://0.0.0.0:3120', 'http://[::]:3120']) {
      expect(() =>
        loadConfig({
          ...validEnv,
          PLATFORM_API_ENABLED: 'true',
          PLATFORM_API_TOKEN: 'a-secret',
          PLATFORM_API_PUBLIC_URL: url,
        }),
      ).toThrow(ConfigError);
    }
  });

  it('rejects an out-of-range platform API port', () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        PLATFORM_API_ENABLED: 'true',
        PLATFORM_API_TOKEN: 'a-secret',
        PLATFORM_API_PORT: '99999',
      }),
    ).toThrow(ConfigError);
  });

  it('keeps the two web surfaces independent', () => {
    const config = loadConfig({
      ...validEnv,
      ADMIN_WEB_ENABLED: 'true',
      ADMIN_WEB_TOKEN: 'admin-secret',
    });
    expect(config.adminWeb.enabled).toBe(true);
    expect(config.platformApi.enabled).toBe(false);
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

describe('resolvePublicUrl', () => {
  it('prefers the configured public URL over the bind', () => {
    expect(
      resolvePublicUrl({ host: '0.0.0.0', port: 3120, publicUrl: 'https://api.waifumon.com' }),
    ).toBe('https://api.waifumon.com');
  });

  it('reuses a routable bind when no public URL is set', () => {
    expect(resolvePublicUrl({ host: '127.0.0.1', port: 3120, publicUrl: undefined })).toBe(
      'http://127.0.0.1:3120',
    );
    expect(resolvePublicUrl({ host: '100.101.102.103', port: 4100, publicUrl: undefined })).toBe(
      'http://100.101.102.103:4100',
    );
  });

  it('never advertises a wildcard bind — that is what breaks Swagger "Try it out"', () => {
    for (const host of ['0.0.0.0', '::', '[::]']) {
      expect(resolvePublicUrl({ host, port: 3120, publicUrl: undefined })).toBe(
        'http://127.0.0.1:3120',
      );
    }
  });

  it('brackets a bare IPv6 bind so the port stays parseable', () => {
    expect(resolvePublicUrl({ host: 'fd00::1', port: 3120, publicUrl: undefined })).toBe(
      'http://[fd00::1]:3120',
    );
  });
});
