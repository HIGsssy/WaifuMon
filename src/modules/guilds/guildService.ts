import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { guilds, type GuildRow } from '../../db/schema';
import { AppError } from '../../shared/errors';

export interface GuildService {
  /** Auto-provisions the guild row on first touch (ON CONFLICT DO NOTHING). */
  ensureGuild(discordGuildId: string): Promise<GuildRow>;
  /** Read-only lookup — used by PlayChannelGuard, must not create rows. */
  getByDiscordId(discordGuildId: string): Promise<GuildRow | undefined>;
  getAllowedChannelIds(discordGuildId: string): Promise<string[] | null>;
  addAllowedChannel(discordGuildId: string, channelId: string): Promise<string[]>;
  removeAllowedChannel(discordGuildId: string, channelId: string): Promise<string[]>;
  setAnnounceChannel(discordGuildId: string, channelId: string): Promise<void>;
  /**
   * Set — or, with `null`, clear — the dedicated Boss Encounter channel.
   *
   * Clearing is a first-class operation rather than an omission: it is how an
   * admin turns boss encounters off for the server, and the scheduler reads a
   * null channel as exactly that. Validation that the channel is usable
   * (NSFW-marked, and the bot can post/embed/attach in it) belongs to the
   * caller, which is the only layer holding a Discord client.
   */
  setBossChannel(discordGuildId: string, channelId: string | null): Promise<void>;
  /** Read-only lookup for the scheduler and the admin status view. */
  getBossChannelId(discordGuildId: string): Promise<string | null>;
}

export function createGuildService(db: Db): GuildService {
  async function ensureGuild(discordGuildId: string): Promise<GuildRow> {
    const inserted = await db
      .insert(guilds)
      .values({ discordGuildId })
      .onConflictDoNothing({ target: guilds.discordGuildId })
      .returning();
    if (inserted[0]) return inserted[0];
    const existing = await db.query.guilds.findFirst({
      where: eq(guilds.discordGuildId, discordGuildId),
    });
    if (!existing) throw new AppError('GUILD_PROVISION_FAILED', `Guild ${discordGuildId} vanished`);
    return existing;
  }

  async function getByDiscordId(discordGuildId: string): Promise<GuildRow | undefined> {
    return db.query.guilds.findFirst({ where: eq(guilds.discordGuildId, discordGuildId) });
  }

  async function mutateAllowlist(
    discordGuildId: string,
    mutate: (current: string[]) => string[],
  ): Promise<string[]> {
    const guild = await ensureGuild(discordGuildId);
    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(guilds)
        .where(eq(guilds.id, guild.id))
        .for('update');
      const next = mutate(locked?.allowedChannelIds ?? []);
      await tx.update(guilds).set({ allowedChannelIds: next }).where(eq(guilds.id, guild.id));
      return next;
    });
  }

  return {
    ensureGuild,
    getByDiscordId,
    async getAllowedChannelIds(discordGuildId) {
      const guild = await getByDiscordId(discordGuildId);
      return guild?.allowedChannelIds ?? null;
    },
    addAllowedChannel(discordGuildId, channelId) {
      return mutateAllowlist(discordGuildId, (current) =>
        current.includes(channelId) ? current : [...current, channelId],
      );
    },
    removeAllowedChannel(discordGuildId, channelId) {
      return mutateAllowlist(discordGuildId, (current) => current.filter((id) => id !== channelId));
    },
    async setAnnounceChannel(discordGuildId, channelId) {
      const guild = await ensureGuild(discordGuildId);
      await db.update(guilds).set({ announceChannelId: channelId }).where(eq(guilds.id, guild.id));
    },
    async setBossChannel(discordGuildId, channelId) {
      const guild = await ensureGuild(discordGuildId);
      await db.update(guilds).set({ bossChannelId: channelId }).where(eq(guilds.id, guild.id));
    },
    async getBossChannelId(discordGuildId) {
      const guild = await getByDiscordId(discordGuildId);
      return guild?.bossChannelId ?? null;
    },
  };
}
