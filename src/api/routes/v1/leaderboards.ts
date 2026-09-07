/**
 * Guild-scoped leaderboards (Achievements & Leaderboards, Phase 1, §9–§12).
 *
 * One reusable endpoint, `?metric=`, over the guild the caller's Portal session
 * has selected. There is no path guild and no global board: `resolveGuildScope`
 * reads the selection off the session, and the optional `discordGuildId` exists
 * only so the shared bearer token — which has no session — can name its guild.
 * A Portal session passing a guild it has not selected is refused (403). A
 * hand-crafted request from a member of guild A therefore cannot enumerate
 * guild B (§10, cross-guild enumeration).
 *
 * ## Ranks, not scores
 *
 * The service returns metric *values*; this handler ranks them and serialises
 * only ranks. No raw value — no xp, captures, affection, count — is ever put on
 * the wire (§10). `me.rank` is computed from the full guild ranking, so it is
 * correct even when the player sits outside the returned top N, and it costs no
 * extra query (§12).
 */
import type { ApiContext } from '../../context';
import { noIdentity } from '../../identity';
import { resolveGuildScope } from '../../plugins/guildScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, errorSchema } from '../../schemas/common';
import { leaderboardQuery, leaderboardResponseSchema } from '../../schemas/leaderboards';
import { assignRanks, rankOf } from '../../../modules/leaderboards/leaderboardRanking';

function fallbackName(playerId: number): string {
  return `Trainer #${playerId}`;
}

export const leaderboardRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const resolveIdentity = ctx.resolveIdentity ?? noIdentity;

    app.get(
      '/leaderboards',
      {
        schema: {
          tags: ['Leaderboards'],
          summary: 'A guild-scoped leaderboard for one metric',
          description:
            'Ranks the players in the session\'s selected guild by one metric ' +
            '(`trainer`, `collector`, `hunter`, `devoted`, `legendary`). Returns ranks only — ' +
            'never the underlying value. Ties share a rank (standard competition ranking); ' +
            'order within a tie is deterministic by player id. `me.rank` is the requesting ' +
            "player's rank across the whole guild, even when outside the returned page.",
          querystring: leaderboardQuery,
          response: {
            200: dataSchema(leaderboardResponseSchema),
            ...commonErrorResponses,
            403: errorSchema.describe(
              'The session asked for a guild it has not selected — `PORTAL_GUILD_FORBIDDEN`.',
            ),
          },
        },
      },
      async (req) => {
        const { metric, limit, discordGuildId } = req.query;
        const scope = await resolveGuildScope(req, ctx, discordGuildId);

        const rows = await ctx.services.leaderboards.getGuildMetric(scope.guildDbId, metric);

        // Rank the whole guild once. `me.rank` and the visible page both read
        // from this single assignment — no second query, no per-player work.
        const ranked = assignRanks(rows);
        const meId = req.apiAuth === 'portal' ? (req.portalSession?.playerId ?? null) : null;
        const meRank = meId !== null ? rankOf(ranked, meId) : null;

        // Resolve identity only for the visible page.
        const page = ranked.slice(0, limit);
        const rowById = new Map(rows.map((r) => [r.playerId, r]));
        const identities = await Promise.all(
          page.map((entry) => {
            const row = rowById.get(entry.playerId);
            return row ? resolveIdentity(row.discordUserId) : Promise.resolve(null);
          }),
        );

        const entries = page.map((entry, i) => {
          const identity = identities[i] ?? null;
          return {
            rank: entry.rank,
            playerId: entry.playerId,
            displayName: identity?.displayName ?? fallbackName(entry.playerId),
            avatarUrl: identity?.avatarUrl ?? null,
            isMe: meId !== null && entry.playerId === meId,
          };
        });

        return ok(req, {
          metric,
          entries,
          me: meRank !== null ? { rank: meRank } : null,
        });
      },
    );
  };
