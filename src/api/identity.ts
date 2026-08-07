/**
 * Player identity resolution — display name and avatar (Portal plan §14 feedback).
 *
 * The Platform API models a player by internal id and Discord snowflake, and
 * nothing else: the bot renders names and avatars from the gateway at send
 * time, so it never needed to store them. A web client has no such luxury —
 * without this, the Player Portal's Dashboard and Trainer Profile can only
 * show "Trainer #12".
 *
 * **This is presentation data, not gameplay data.** It is resolved outside the
 * service layer, is always nullable, and no endpoint's behaviour depends on it.
 *
 * ### Why a host-injected resolver
 *
 * The API layer deliberately holds no Discord types (see `context.ts`). The
 * host process owns the `Client`; it injects a plain async function, exactly as
 * it already does for `ReadinessProbes`. The API stays free of `discord.js`,
 * and a test substitutes a one-line stub.
 *
 * ### Why the caching wrapper lives here
 *
 * Identity now rides along on `GET /players/{id}`, which is the hottest read on
 * the surface — the Portal calls it once per session boot and on every window
 * focus. A naive resolver would put a gateway round trip in front of all of
 * them. `withIdentityCache` makes that cost bounded and bounded *here*, where
 * the caching policy is an API concern, rather than in `src/index.ts` where it
 * would be wiring pretending to be logic.
 *
 * Three properties matter, and all three are failure-first:
 *
 *   - **A slow gateway never slows the API.** Resolution races a timeout; on
 *     expiry the request answers `identity: null` and moves on.
 *   - **A failure is cached too**, briefly. A user the gateway cannot see must
 *     not cause a fresh lookup on every poll.
 *   - **Nothing throws.** A rejected resolver is an absent identity, never a
 *     500 on a read that is otherwise perfectly answerable.
 */

export interface PlayerIdentity {
  /** Discord global display name, falling back to the username. */
  displayName: string;
  /** Absolute CDN URL, or null when none can be resolved. */
  avatarUrl: string | null;
}

/**
 * Resolves a Discord snowflake to presentation identity. Returns `null` when
 * the user cannot be resolved — an unknown id, a disconnected gateway, a
 * process running without a Discord client at all.
 */
export type IdentityResolver = (discordUserId: string) => Promise<PlayerIdentity | null>;

export interface IdentityCacheOptions {
  /** How long a resolved identity is reused. Default 5 minutes. */
  ttlMs?: number;
  /** How long a miss or failure is remembered. Default 60 seconds. */
  negativeTtlMs?: number;
  /** How long a single resolution may take before it is abandoned. Default 500ms. */
  timeoutMs?: number;
  /** Entries retained before the oldest are dropped. Default 500. */
  maxEntries?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface CacheEntry {
  value: PlayerIdentity | null;
  expiresAt: number;
}

const DEFAULTS = {
  ttlMs: 5 * 60_000,
  negativeTtlMs: 60_000,
  timeoutMs: 500,
  maxEntries: 500,
} as const;

/** Resolves to `null` rather than rejecting when `promise` outlives `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        // Never hold the event loop open for a lookup nobody is waiting on.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wraps a resolver with TTL caching, a per-call timeout, and in-flight
 * de-duplication. The returned resolver never rejects.
 */
export function withIdentityCache(
  resolve: IdentityResolver,
  options: IdentityCacheOptions = {},
): IdentityResolver {
  const ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULTS.negativeTtlMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
  const now = options.now ?? Date.now;

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<PlayerIdentity | null>>();

  function remember(key: string, value: PlayerIdentity | null): void {
    // Insertion-ordered Map: deleting the first key evicts the oldest write.
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { value, expiresAt: now() + (value ? ttlMs : negativeTtlMs) });
  }

  return async function resolveCached(discordUserId: string): Promise<PlayerIdentity | null> {
    const cached = cache.get(discordUserId);
    if (cached && cached.expiresAt > now()) return cached.value;

    // Two concurrent requests for the same player share one gateway lookup.
    const pending = inFlight.get(discordUserId);
    if (pending) return pending;

    const lookup = withTimeout(resolve(discordUserId), timeoutMs)
      .catch(() => null)
      .then((value) => {
        remember(discordUserId, value);
        return value;
      })
      .finally(() => {
        inFlight.delete(discordUserId);
      });

    inFlight.set(discordUserId, lookup);
    return lookup;
  };
}

/** The resolver used when the host injects none — every identity is absent. */
export const noIdentity: IdentityResolver = async () => null;
