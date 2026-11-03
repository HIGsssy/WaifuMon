/**
 * The integration network overlay, asserted against the files that ship.
 *
 * Static, like the nginx template tests: Compose is not available in the test
 * environment. The live equivalent is the per-environment `docker compose
 * config` check in docs/peanut-gallery-integration.md. What these guard is the
 * mistakes that fail silently:
 *
 *   - dropping the bot off its default network (it would lose Postgres);
 *   - attaching anything besides the bot (Postgres must stay unreachable);
 *   - staging and production resolving to the same network or alias on the
 *     shared host.
 *
 * Interpolation is resolved here with Compose's own `${VAR:-default}` rule
 * (default when the variable is unset *or empty*), so each environment's
 * values are checked as Compose would see them, not just as text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const strip = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, ''))
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
    .join('\n');
const overlayRaw = strip(fs.readFileSync(path.join(ROOT, 'docker-compose.integrations.yml'), 'utf8'));
const base = strip(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'));

type Env = Record<string, string | undefined>;

/** Compose's `${VAR:-default}` / `${VAR}` interpolation. Unknown forms fail the test. */
function interpolate(text: string, env: Env): string {
  return text.replace(/\$\{([^}]+)\}/g, (_whole, expr: string) => {
    const withDefault = /^([A-Z0-9_]+):-(.*)$/.exec(expr);
    if (withDefault) {
      const value = env[withDefault[1]!];
      return value === undefined || value === '' ? withDefault[2]! : value;
    }
    if (/^[A-Z0-9_]+$/.test(expr)) return env[expr] ?? '';
    throw new Error(`unsupported interpolation in overlay: \${${expr}}`);
  });
}

/** Top-level service names (two-space keys under `services:`). */
function services(text: string): string[] {
  const block = text.split(/^services:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  return [...block.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]!);
}

/** What the resolved overlay attaches the bot to, and as what. */
function resolve(env: Env) {
  const text = interpolate(overlayRaw, env);
  const botNetworks = [...text.matchAll(/^ {6}([a-z0-9_-]+):/gm)].map((m) => m[1]!);
  const alias = /^ {6}integrations:\n {8}aliases:\n {10}- (\S+)$/m.exec(text)?.[1];
  const network = /^networks:\n {2}integrations:\n {4}external: true\n {4}name: (\S+)$/m.exec(text)?.[1];
  return { text, botNetworks, alias, network };
}

const STAGING: Env = {
  WAIFUMON_INTEGRATION_NETWORK: 'waifumon-integrations-staging',
  WAIFUMON_INTEGRATION_ALIAS: 'waifumon-api-staging',
};
const PRODUCTION: Env = {
  WAIFUMON_INTEGRATION_NETWORK: 'waifumon-integrations-prod',
  WAIFUMON_INTEGRATION_ALIAS: 'waifumon-api-prod',
};

describe('docker-compose.integrations.yml', () => {
  it('interpolates only the two documented variables, each with a default', () => {
    const vars = [...overlayRaw.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
    expect(vars.sort()).toEqual([
      'WAIFUMON_INTEGRATION_ALIAS:-waifumon-api',
      'WAIFUMON_INTEGRATION_NETWORK:-waifumon-integrations',
    ]);
  });

  it.each([
    ['unset (default)', {}, 'waifumon-integrations', 'waifumon-api'],
    ['empty (default)', { WAIFUMON_INTEGRATION_NETWORK: '', WAIFUMON_INTEGRATION_ALIAS: '' }, 'waifumon-integrations', 'waifumon-api'],
    ['staging', STAGING, 'waifumon-integrations-staging', 'waifumon-api-staging'],
    ['production', PRODUCTION, 'waifumon-integrations-prod', 'waifumon-api-prod'],
  ])('resolves %s to its own network and alias', (_label, env, network, alias) => {
    const resolved = resolve(env);
    expect(resolved.network).toBe(network);
    expect(resolved.alias).toBe(alias);
  });

  it('keeps staging and production apart on a shared host', () => {
    const staging = resolve(STAGING);
    const production = resolve(PRODUCTION);
    expect(staging.network).not.toBe(production.network);
    expect(staging.alias).not.toBe(production.alias);
    expect(staging.text).not.toContain('-prod');
    expect(production.text).not.toContain('-staging');
  });

  it.each([
    ['default', {}],
    ['staging', STAGING],
    ['production', PRODUCTION],
  ])('keeps the bot on its default network (%s)', (_label, env) => {
    expect(resolve(env).botNetworks).toEqual(['default', 'integrations']);
    expect(resolve(env).text).toMatch(/^ {6}default: \{\}$/m);
  });

  it('attaches only the bot, never postgres or the Portal', () => {
    expect(services(overlayRaw)).toEqual(['waifumon-bot']);
    expect(overlayRaw).not.toMatch(/^ {2}(postgres|waifumon-portal):/m);
  });

  it('declares the network external and publishes no port', () => {
    expect(overlayRaw).toMatch(/^ {4}external: true$/m);
    expect(overlayRaw).not.toMatch(/ports:/);
  });
});

describe('docker-compose.yml is unchanged by the integration', () => {
  it('names no networks, so every service stays on the project default', () => {
    expect(base).not.toMatch(/networks:/);
    expect(base).not.toContain('waifumon-integrations');
    expect(base).not.toContain('WAIFUMON_INTEGRATION_');
  });

  it('still publishes the API on loopback by default', () => {
    expect(base).toContain("'${PLATFORM_API_PUBLISH_HOST:-127.0.0.1}:${PLATFORM_API_PORT:-3120}:${PLATFORM_API_PORT:-3120}'");
  });
});
