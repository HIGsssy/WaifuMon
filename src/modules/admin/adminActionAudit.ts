/**
 * Shared vocabulary for admin account adjustments.
 *
 * Every admin tool that changes a player's account — `/waifumon-admin player`
 * in Discord and the Portal's Staging Test Controls — records one row in
 * `player_progression_events` with this `event_type`. The row's `metadata`
 * carries the specifics (`action`, the acting admin, before/after), so one
 * query answers "what did admins do to this account?" regardless of which
 * surface they used.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { guilds, playerProgressionEvents, players } from '../../db/schema';

export const ADMIN_ACTION_EVENT = 'admin_player_action';

/**
 * Write one admin-action audit row from the **domain** layer.
 *
 * The Discord and Staging Test Controls tools each write this row themselves,
 * because they already hold the target's Discord identity and the acting
 * guild. A domain service (equipment removal, a feature unlock) knows only the
 * player id, so this resolves the target's Discord id and guild from the
 * player row and writes the same metadata shape — one query still answers
 * "what did admins do to this account?".
 *
 * Runs in the caller's transaction, so the row exists if and only if the
 * action it describes committed.
 */
export async function recordDomainAdminAction(
  tx: DbOrTx,
  input: {
    playerId: number;
    action: string;
    adminDiscordId: string | null;
    before: unknown;
    after: unknown;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const [target] = await tx
    .select({ discordUserId: players.discordUserId, discordGuildId: guilds.discordGuildId })
    .from(players)
    .innerJoin(guilds, eq(players.guildId, guilds.id))
    .where(eq(players.id, input.playerId));
  await tx.insert(playerProgressionEvents).values({
    playerId: input.playerId,
    eventType: ADMIN_ACTION_EVENT,
    xpDelta: 0,
    metadata: {
      action: input.action,
      source: 'domain',
      adminDiscordId: input.adminDiscordId,
      targetDiscordId: target?.discordUserId ?? null,
      guildId: target?.discordGuildId ?? null,
      before: input.before,
      after: input.after,
      ...(input.detail ?? {}),
    },
  });
}
