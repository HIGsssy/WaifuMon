/**
 * GuildOwnershipService — the one place that answers "who owns this Discord
 * guild right now?".
 *
 * Discord owner ids are not persisted in the WaifuMon database on purpose:
 * ownership can be transferred through Discord's own UI at any moment, and a
 * cached row in Postgres would silently disagree with reality. The runtime
 * source of truth is the bot's `Client.guilds.fetch(id).ownerId`, which
 * Discord keeps live over the gateway.
 *
 * The service takes a `fetchOwnerId` closure rather than a `discord.js`
 * `Client` directly so:
 *
 *   1. The Platform API can wire a fetcher against the bot's client without
 *      importing `discord.js` types (some deployments run the API without
 *      the bot; a fetcher that always resolves `null` is a legal wiring).
 *   2. Tests inject a deterministic fetcher and never touch a real gateway.
 *
 * Caching is per-guild with a soft TTL. A miss reads through; a hit is
 * returned instantly. The bot can call {@link GuildOwnershipService.set}
 * from `guildUpdate` handlers to invalidate immediately on an ownership
 * transfer, so the TTL is a safety net rather than the primary correctness
 * mechanism.
 */
import type { Logger } from '../../shared/logger';

/** The fetcher that reads authoritative ownership from Discord. */
export type FetchGuildOwnerId = (discordGuildId: string) => Promise<string | null>;

export interface GuildOwnershipService {
  /**
   * Returns the current Discord user id that owns `discordGuildId`, or
   * `null` if the guild is unknown to the bot. Cheap on a cache hit.
   */
  getOwnerId(discordGuildId: string): Promise<string | null>;
  /** Prime the cache — the bot's startup sweep calls this for every guild. */
  set(discordGuildId: string, ownerId: string | null): void;
  /** Invalidate one entry so the next read goes back through the fetcher. */
  invalidate(discordGuildId: string): void;
  /** Wipe every entry — used only by tests. */
  clear(): void;
}

export interface GuildOwnershipServiceOptions {
  fetchOwnerId: FetchGuildOwnerId;
  logger?: Logger;
  ttlMs?: number;
}

/** Default TTL — five minutes. Aligned with the Portal session identity policy. */
const DEFAULT_TTL_MS = 5 * 60_000;

interface CacheEntry {
  ownerId: string | null;
  expiresAt: number;
}

export function createGuildOwnershipService(
  opts: GuildOwnershipServiceOptions,
): GuildOwnershipService {
  const cache = new Map<string, CacheEntry>();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  async function getOwnerId(discordGuildId: string): Promise<string | null> {
    const now = Date.now();
    const hit = cache.get(discordGuildId);
    if (hit && hit.expiresAt > now) return hit.ownerId;
    try {
      const ownerId = await opts.fetchOwnerId(discordGuildId);
      cache.set(discordGuildId, { ownerId, expiresAt: now + ttl });
      return ownerId;
    } catch (err) {
      opts.logger?.warn(
        { err, tag: 'guild-ownership/fetch-failed', discordGuildId },
        'failed to fetch guild ownership; treating as unknown',
      );
      // Cache the miss briefly so a broken discord fetch does not hammer the API.
      cache.set(discordGuildId, { ownerId: null, expiresAt: now + Math.min(30_000, ttl) });
      return null;
    }
  }

  function set(discordGuildId: string, ownerId: string | null): void {
    cache.set(discordGuildId, { ownerId, expiresAt: Date.now() + ttl });
  }

  function invalidate(discordGuildId: string): void {
    cache.delete(discordGuildId);
  }

  function clear(): void {
    cache.clear();
  }

  return { getOwnerId, set, invalidate, clear };
}

/**
 * Ownership fetcher that always says "unknown". Used to wire the API in
 * deployments where the bot is not attached, or in tests that must never
 * touch Discord.
 */
export const nullFetchOwnerId: FetchGuildOwnerId = async () => null;
