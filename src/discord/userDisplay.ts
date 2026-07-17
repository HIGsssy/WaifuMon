/**
 * Owner-identity helpers for the public session board.
 *
 * Every Waifumon session board is labelled with its owner so multiple boards
 * in the same channel are distinguishable at a glance. Prefer the
 * per-server display name (nickname) — fall back to the global name and then
 * the raw username so we always have something to show.
 */
import { GuildMember, type User } from 'discord.js';

export interface OwnerDisplayInput {
  member?: unknown;
  user: User | { id: string; username?: string; globalName?: string | null };
}

/** Best-effort readable owner label used on every session board render. */
export function getGuildDisplayName(input: OwnerDisplayInput): string {
  // Real interactions carry a `GuildMember` instance; tests (and any exotic
  // interaction path where instanceof check breaks across module realms)
  // fall through to the duck-typed branch below.
  if (input.member instanceof GuildMember) {
    return input.member.displayName;
  }
  const m = input.member as { displayName?: unknown } | null | undefined;
  if (m && typeof m.displayName === 'string' && m.displayName.length > 0) {
    return m.displayName;
  }
  const user = input.user as { username?: string; globalName?: string | null };
  return user.globalName ?? user.username ?? 'that player';
}

/** Full owner identity used throughout the session UI. */
export interface OwnerIdentity {
  discordUserId: string;
  displayName: string;
  mention: string;
}

/** Resolves an owner identity from a live Discord interaction. */
export function ownerFromInteraction(interaction: {
  user: { id: string; username?: string; globalName?: string | null };
  member?: unknown;
}): OwnerIdentity {
  const displayName = getGuildDisplayName({
    member: interaction.member,
    user: interaction.user as User,
  });
  return {
    discordUserId: interaction.user.id,
    displayName,
    mention: `<@${interaction.user.id}>`,
  };
}
