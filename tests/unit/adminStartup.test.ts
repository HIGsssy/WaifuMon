/**
 * Startup contract for the admin panel: silent when disabled, bound to the
 * documented loopback default when enabled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAdminServer, type AdminServerHandle } from '../../src/admin/server';
import { loadConfig } from '../../src/config/config';
import { createAdminFixture, type AdminFixture } from '../helpers/adminFixtures';

let f: AdminFixture;
let handle: AdminServerHandle | null = null;

beforeEach(() => {
  f = createAdminFixture();
});
afterEach(async () => {
  await handle?.close();
  handle = null;
  f.cleanup();
});

const baseEnv = {
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '12345',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/waifumon',
} as NodeJS.ProcessEnv;

describe('startAdminServer', () => {
  it('starts nothing when the panel is disabled', async () => {
    const config = loadConfig(baseEnv).adminWeb;
    handle = await startAdminServer({ config, content: f.service, logger: f.logger });
    expect(handle).toBeNull();
  });

  it('binds 127.0.0.1:3111 by default when enabled', async () => {
    const config = loadConfig({
      ...baseEnv,
      ADMIN_WEB_ENABLED: 'true',
      ADMIN_WEB_TOKEN: 'a-secret',
      // Port 0 would be easier, but the default is part of the contract.
    }).adminWeb;
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3111);

    handle = await startAdminServer({ config, content: f.service, logger: f.logger });
    expect(handle).not.toBeNull();
    const address = handle!.app.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1', port: 3111 });

    // Reachable over the real socket, and still gated by auth.
    const res = await fetch('http://127.0.0.1:3111/admin/species');
    expect(res.status).toBe(401);

    const authed = await fetch('http://127.0.0.1:3111/admin/species', {
      headers: { authorization: 'Bearer a-secret' },
    });
    expect(authed.status).toBe(200);
  });
});
