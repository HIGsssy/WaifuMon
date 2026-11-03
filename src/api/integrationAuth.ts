/**
 * Read-only integration credentials (`Authorization: Integration <keyId>.<secret>`).
 *
 * The third way into the Platform API, beside the shared bearer token and a
 * Portal session cookie, and deliberately the narrowest of the three:
 *
 *  - **Hashed at rest.** Config holds `sha256(secret)` per `keyId`; the secret
 *    itself only ever exists in the integration's own secret store and in the
 *    header of a request. Comparison is constant-time over the digests.
 *  - **Its own scheme.** `Integration`, not `Bearer`, so an integration secret
 *    can never be mistaken for `PLATFORM_API_TOKEN` and the bearer comparison
 *    never runs on it.
 *  - **Allowlisted routes, not denylisted ones.** An integration request is
 *    admitted only when the *matched* route opts in with
 *    `config: { integrationRoute: true }` and the method is GET or HEAD. A
 *    route added tomorrow is closed to integrations until it says otherwise.
 *  - **Rate-limited per key**, in process. One route serves a few requests a
 *    minute; a dependency would be heavier than the bucket.
 *
 * Nothing here knows which application holds a key. `keyId` is an operator
 * label and is the only part of the credential that is ever logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IntegrationApiConfig } from '../config/config';

/** Every integration route lives under this prefix; nginx refuses it publicly. */
export const INTEGRATION_PATH_PREFIX = '/api/v1/integrations/';

export const INTEGRATION_SCHEME = 'Integration ';

declare module 'fastify' {
  interface FastifyRequest {
    /** The accepted integration key's id, when `apiAuth === 'integration'`. */
    integrationKeyId?: string;
  }
  interface FastifyContextConfig {
    /**
     * This route may be called with an integration credential. Opt-in and
     * default-absent, so every other route stays closed to integrations
     * without being touched. Set only under `routes/v1/integrations/`.
     */
    integrationRoute?: boolean;
  }
}

export interface IntegrationCredential {
  keyId: string;
  secret: string;
}

/**
 * Splits `<keyId>.<secret>` at the first dot. Returns null for anything that
 * is not exactly that shape; the caller answers every null with the same 401.
 */
export function parseIntegrationCredential(value: string): IntegrationCredential | null {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const keyId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (/\s/.test(keyId) || /\s/.test(secret)) return null;
  return { keyId, secret };
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/**
 * Builds the verifier once from config. An unknown `keyId` still hashes the
 * presented secret and compares it against a fixed dummy digest, so the time
 * a refusal takes does not say whether the key id exists.
 */
export function createIntegrationVerifier(
  config: IntegrationApiConfig | undefined,
): (credential: IntegrationCredential) => boolean {
  const digests = new Map<string, Buffer>(
    (config?.keys ?? []).map((k) => [k.keyId, Buffer.from(k.secretSha256, 'hex')]),
  );
  const dummy = Buffer.alloc(32);
  return ({ keyId, secret }) => {
    const presented = sha256(secret);
    const expected = digests.get(keyId);
    const match = timingSafeEqual(presented, expected ?? dummy);
    return expected !== undefined && match;
  };
}

export interface IntegrationRateLimitOptions {
  /** Requests a key may make in a burst. Default 10. */
  burst?: number;
  /** Sustained requests per minute per key. Default 30. */
  perMinute?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface IntegrationRateLimiter {
  /** Takes one token. `null` = allowed; a number = seconds until the next token. */
  take(keyId: string): number | null;
}

/**
 * A token bucket per key id. Keys are operator-configured and few, so the map
 * is bounded by config, not by traffic.
 */
export function createIntegrationRateLimiter(
  options: IntegrationRateLimitOptions = {},
): IntegrationRateLimiter {
  const burst = options.burst ?? 10;
  const perMs = (options.perMinute ?? 30) / 60_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; at: number }>();

  return {
    take(keyId) {
      const t = now();
      const bucket = buckets.get(keyId) ?? { tokens: burst, at: t };
      bucket.tokens = Math.min(burst, bucket.tokens + (t - bucket.at) * perMs);
      bucket.at = t;
      buckets.set(keyId, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return null;
      }
      return Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
    },
  };
}
