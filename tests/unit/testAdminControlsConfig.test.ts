/**
 * The environment gate for Staging Test Controls.
 *
 * `DEPLOYMENT_ENV` is the one identity the gate trusts, and it is fail-safe:
 * anything that is not explicitly `staging` or `development` is production.
 * `NODE_ENV` and `COMPOSE_PROJECT_NAME` are deliberately ignored — the shipped
 * image sets `NODE_ENV=production` on staging too.
 */
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  resolveDeploymentEnv,
  testAdminControlsAllowed,
} from '../../src/config/config';
import { ConfigError } from '../../src/shared/errors';

const validEnv = {
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '12345',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/waifumon',
} as NodeJS.ProcessEnv;

describe('DEPLOYMENT_ENV', () => {
  it('resolves unset, blank and unrecognised values to production', () => {
    for (const raw of [undefined, '', '   ', 'prod', 'stage', 'test', 'STAGINGX']) {
      expect(resolveDeploymentEnv(raw), String(raw)).toBe('production');
    }
  });

  it('accepts the three known values, case- and whitespace-insensitively', () => {
    expect(resolveDeploymentEnv('staging')).toBe('staging');
    expect(resolveDeploymentEnv(' Staging ')).toBe('staging');
    expect(resolveDeploymentEnv('development')).toBe('development');
    expect(resolveDeploymentEnv('PRODUCTION')).toBe('production');
  });

  it('defaults a config with nothing set to production with the controls off', () => {
    const config = loadConfig(validEnv);
    expect(config.deploymentEnv).toBe('production');
    expect(config.testAdminControls).toEqual({ enabled: false, deploymentEnv: 'production' });
    expect(testAdminControlsAllowed(config.testAdminControls)).toBe(false);
  });

  it('is not derived from NODE_ENV or COMPOSE_PROJECT_NAME', () => {
    const config = loadConfig({
      ...validEnv,
      NODE_ENV: 'development',
      COMPOSE_PROJECT_NAME: 'waifumon-stage',
    });
    expect(config.deploymentEnv).toBe('production');
  });
});

describe('ENABLE_TEST_ADMIN_CONTROLS', () => {
  it('refuses to start when enabled in production, explicit or by default', () => {
    expect(() => loadConfig({ ...validEnv, ENABLE_TEST_ADMIN_CONTROLS: 'true' })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({ ...validEnv, ENABLE_TEST_ADMIN_CONTROLS: 'true', DEPLOYMENT_ENV: 'production' }),
    ).toThrow(/ENABLE_TEST_ADMIN_CONTROLS/);
    expect(() =>
      loadConfig({ ...validEnv, ENABLE_TEST_ADMIN_CONTROLS: '1', DEPLOYMENT_ENV: 'staigng' }),
    ).toThrow(ConfigError);
  });

  it('starts on staging and development with the controls allowed', () => {
    for (const env of ['staging', 'development']) {
      const config = loadConfig({ ...validEnv, ENABLE_TEST_ADMIN_CONTROLS: 'true', DEPLOYMENT_ENV: env });
      expect(testAdminControlsAllowed(config.testAdminControls), env).toBe(true);
    }
  });

  it('stays off on staging unless explicitly enabled', () => {
    const config = loadConfig({ ...validEnv, DEPLOYMENT_ENV: 'staging' });
    expect(testAdminControlsAllowed(config.testAdminControls)).toBe(false);
  });

  it('treats a missing or partial config as disallowed', () => {
    expect(testAdminControlsAllowed(undefined)).toBe(false);
    expect(testAdminControlsAllowed({ enabled: true })).toBe(false);
    expect(testAdminControlsAllowed({ enabled: true, deploymentEnv: 'production' })).toBe(false);
    expect(testAdminControlsAllowed({ enabled: false, deploymentEnv: 'staging' })).toBe(false);
  });
});
