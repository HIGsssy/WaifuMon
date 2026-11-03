/**
 * The integration network overlay, asserted against the files that ship.
 *
 * Static, like the nginx template tests: Compose is not available in the test
 * environment. The operator check `docker compose -f docker-compose.yml -f
 * docker-compose.integrations.yml config` (docs/peanut-gallery-integration.md)
 * is the live equivalent. What these guard is the two mistakes that fail
 * silently: dropping the bot off its default network (it would lose Postgres)
 * and attaching anything besides the bot (Postgres must stay unreachable).
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
const overlay = strip(fs.readFileSync(path.join(ROOT, 'docker-compose.integrations.yml'), 'utf8'));
const base = strip(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'));

/** Top-level service names in a compose file (two-space indented keys under `services:`). */
function services(text: string): string[] {
  const block = text.split(/^services:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  return [...block.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]!);
}

describe('docker-compose.integrations.yml', () => {
  it('attaches only the bot', () => {
    expect(services(overlay)).toEqual(['waifumon-bot']);
  });

  it('keeps the bot on its default network and adds the integration network with the api alias', () => {
    expect(overlay).toMatch(/^ {6}default: \{\}$/m);
    expect(overlay).toMatch(/^ {6}waifumon-integrations:\n {8}aliases:\n {10}- waifumon-api$/m);
  });

  it('declares the network as external, created by the operator with --internal', () => {
    expect(overlay).toMatch(/^networks:\n {2}waifumon-integrations:\n {4}external: true$/m);
  });

  it('publishes no port', () => {
    expect(overlay).not.toMatch(/ports:/);
  });
});

describe('docker-compose.yml is unchanged by the integration', () => {
  it('names no networks, so every service stays on the project default', () => {
    expect(base).not.toMatch(/networks:/);
    expect(base).not.toContain('waifumon-integrations');
  });

  it('still publishes the API on loopback by default', () => {
    expect(base).toContain("'${PLATFORM_API_PUBLISH_HOST:-127.0.0.1}:${PLATFORM_API_PORT:-3120}:${PLATFORM_API_PORT:-3120}'");
  });
});
