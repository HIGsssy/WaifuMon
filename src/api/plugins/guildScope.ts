/**
 * Which guild a guild-scoped read is allowed to see.
 *
 * The Players directory is the first surface that answers with *other people's*
 * rows, so the guild it is scoped to cannot come from the request. It comes
 * from the authenticated Portal session's current selection, which is the same
 * value `/auth/session` reports and the same one the admin namespace already
 * trusts (`routes/v1/admin/access.ts`).
 *
 * Three rules, all fail-closed:
 *
 *   - **A Portal session may only see its selected guild.** A caller that
 *     supplies `discordGuildId` naming a different server is refused with 403
 *     rather than silently served their own guild — a hand-crafted request
 *     should learn that the scope was rejected, not appear to succeed.
 *   - **A Portal session with no selection sees nothing.** Guild selection is
 *     in progress (or the account has no profile anywhere); 400 rather than a
 *     guess, so the directory cannot briefly answer for the wrong server.
 *   - **A bearer caller must name the guild.** The shared platform token is not
 *     a person and has no selection, so it says which guild it means or gets a
 *     400. It never inherits a "default" guild.
 *
 * Note what does *not* exist here: no path or body parameter anywhere in the
 * directory surface can widen the scope. Cross-guild enumeration is not
 * defended against downstream — it is unreachable.
 */
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors';
import type { ApiContext } from '../context';

/** The session holds no selected guild yet — nothing is in scope. */
export class ApiGuildScopeRequiredError extends AppError {
  constructor(detail: string) {
    super('PORTAL_GUILD_REQUIRED', detail, 'Select a server first.');
  }
}

/** The caller asked for a guild their session is not permitted to select. */
export class ApiGuildScopeForbiddenError extends AppError {
  constructor(detail: string) {
    super('PORTAL_GUILD_FORBIDDEN', detail, 'Not available for that server.');
  }
}

/**
 * The internal guild id this request may read, plus the Discord snowflake it
 * corresponds to (for the response's server label — never for scoping).
 */
export interface GuildScope {
  guildDbId: number;
  discordGuildId: string | null;
}

export async function resolveGuildScope(
  req: FastifyRequest,
  ctx: ApiContext,
  requested?: string | undefined,
): Promise<GuildScope> {
  if (req.apiAuth === 'portal') {
    const session = req.portalSession;
    if (!session || session.selectedGuildDbId === null) {
      throw new ApiGuildScopeRequiredError('Portal session has no selected guild');
    }
    if (requested !== undefined && requested !== session.selectedDiscordGuildId) {
      throw new ApiGuildScopeForbiddenError(
        `Portal session selected ${session.selectedDiscordGuildId ?? 'nothing'}, asked for ${requested}`,
      );
    }
    return {
      guildDbId: session.selectedGuildDbId,
      discordGuildId: session.selectedDiscordGuildId,
    };
  }

  // Bearer: no selection exists, so the guild must be named explicitly.
  if (requested === undefined) {
    throw new ApiGuildScopeRequiredError('Bearer requests must supply discordGuildId');
  }
  const guild = await ctx.services.guilds.getByDiscordId(requested);
  if (!guild) throw new ApiGuildScopeRequiredError(`Guild ${requested} not found`);
  return { guildDbId: guild.id, discordGuildId: guild.discordGuildId };
}
