/**
 * Startup contract for the Platform API: silent when disabled, bound to the
 * documented loopback default when enabled, and loud about a public bind.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startPlatformApi, type PlatformApiHandle } from '../../src/api/server';
import { loadConfig } from '../../src/config/config';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../helpers/platformApiFixtures';

let handle: PlatformApiHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

const baseEnv = {
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '12345',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/waifumon',
} as NodeJS.ProcessEnv;

describe('startPlatformApi', () => {
  it('starts nothing when the API is disabled', async () => {
    const log = createCapturedLogger();
    handle = await startPlatformApi({
      config: loadConfig(baseEnv).platformApi,
      logger: log.logger,
      probes: createProbes(),
    });
    expect(handle).toBeNull();
    expect(log.text()).toBe('');
  });

  it('binds 127.0.0.1:3120 by default when enabled', async () => {
    const log = createCapturedLogger();
    const config = loadConfig({
      ...baseEnv,
      PLATFORM_API_ENABLED: 'true',
      PLATFORM_API_TOKEN: TEST_TOKEN,
      // Port 0 would be easier, but the default is part of the contract.
    }).platformApi;
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3120);

    handle = await startPlatformApi({ config, logger: log.logger, probes: createProbes() });
    expect(handle).not.toBeNull();
    expect(handle!.app.server.address()).toMatchObject({ address: '127.0.0.1', port: 3120 });

    // Reachable over the real socket, unauthenticated for ops…
    const health = await fetch('http://127.0.0.1:3120/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    // …and gated by the bearer token everywhere else.
    const denied = await fetch('http://127.0.0.1:3120/api/v1/openapi.json/../foo');
    expect(denied.status).toBe(401);

    const spec = await fetch('http://127.0.0.1:3120/api/v1/openapi.json');
    expect(spec.status).toBe(200);

    expect(log.text()).toContain('platform API listening');
    expect(log.text()).not.toContain('public interface');
    expect(log.text()).not.toContain(TEST_TOKEN);
  });

  it('warns when bound to a non-loopback, non-Tailscale interface', async () => {
    const log = createCapturedLogger();
    handle = await startPlatformApi({
      config: { enabled: true, host: '0.0.0.0', port: 3121, token: TEST_TOKEN },
      logger: log.logger,
      probes: createProbes(),
    });
    expect(log.text()).toContain('bound to a public interface');
  });
});
