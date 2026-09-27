/**
 * `LOAD_TESTING_ENABLED` — the environment gate.
 *
 * Pinned: off unless explicitly set; only an explicit true turns it on; it
 * refuses to start without the Platform API and Portal auth it depends on;
 * the operator allowlist accepts only Discord ids.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/config';

const BASE = {
  DISCORD_TOKEN: 't',
  DISCORD_CLIENT_ID: 'c',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
};
const API_AND_PORTAL = {
  PLATFORM_API_ENABLED: 'true',
  PLATFORM_API_TOKEN: 'token',
  PORTAL_PUBLIC_URL: 'https://portal.example',
  DISCORD_CLIENT_SECRET: 'secret',
  PORTAL_SESSION_SECRET: 'x'.repeat(40),
};

describe('LOAD_TESTING_ENABLED', () => {
  it('defaults to off, even with everything else it needs configured', () => {
    expect(loadConfig({ ...BASE }).loadTesting?.enabled).toBe(false);
    expect(loadConfig({ ...BASE, ...API_AND_PORTAL }).loadTesting?.enabled).toBe(false);
  });

  it.each(['false', '0'])('stays off for %s', (v) => {
    expect(loadConfig({ ...BASE, ...API_AND_PORTAL, LOAD_TESTING_ENABLED: v }).loadTesting?.enabled).toBe(false);
  });

  it.each(['yes', 'on', 'TRUE', 'enabled'])('rejects the ambiguous value %s rather than guessing', (v) => {
    expect(() => loadConfig({ ...BASE, ...API_AND_PORTAL, LOAD_TESTING_ENABLED: v })).toThrow();
  });

  it('turns on only when explicitly true', () => {
    const config = loadConfig({
      ...BASE,
      ...API_AND_PORTAL,
      LOAD_TESTING_ENABLED: 'true',
      LOAD_TESTING_HOST_LABEL: '3400GE staging',
    });
    expect(config.loadTesting).toEqual({
      enabled: true,
      operatorDiscordIds: [],
      hostLabel: '3400GE staging',
    });
  });

  it('refuses to start without the Platform API', () => {
    expect(() =>
      loadConfig({ ...BASE, ...API_AND_PORTAL, PLATFORM_API_ENABLED: 'false', LOAD_TESTING_ENABLED: 'true' }),
    ).toThrow(/LOAD_TESTING_ENABLED=true requires/);
  });

  it('refuses to start without Portal auth', () => {
    const { PORTAL_PUBLIC_URL: _omit, ...noPortal } = API_AND_PORTAL;
    expect(() => loadConfig({ ...BASE, ...noPortal, LOAD_TESTING_ENABLED: 'true' })).toThrow(
      /LOAD_TESTING_ENABLED=true requires/,
    );
  });

  it('parses the operator allowlist and rejects non-ids', () => {
    const config = loadConfig({
      ...BASE,
      ...API_AND_PORTAL,
      LOAD_TESTING_ENABLED: 'true',
      LOAD_TESTING_OPERATOR_DISCORD_IDS: ' 111111111111111111, 222222222222222222 ,',
    });
    expect(config.loadTesting?.operatorDiscordIds).toEqual(['111111111111111111', '222222222222222222']);
    expect(() =>
      loadConfig({ ...BASE, ...API_AND_PORTAL, LOAD_TESTING_OPERATOR_DISCORD_IDS: 'alice' }),
    ).toThrow(/LOAD_TESTING_OPERATOR_DISCORD_IDS/);
  });
});
