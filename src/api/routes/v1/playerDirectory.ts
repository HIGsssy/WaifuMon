/**
 * The guild player directory, and the public profile it links to.
 *
 * Two routes, one idea: a Portal user may see the other Waifumon players in the
 * guild their session currently has selected, and nothing else.
 *
 * ## Guild scope is server-side and unwidenable
 *
 * Neither route takes a guild in its path. `resolveGuildScope` reads the
 * selection off the authenticated Portal session; the optional
 * `discordGuildId` query exists only so the shared bearer token — which has no
 * session and therefore no selection — can say which guild it means, and a
 * Portal session passing one that is not its selection is refused with 403.
 * A hand-crafted request from a member of guild A cannot enumerate guild B,
 * because the parameter that would let it does not exist for that caller.
 *
 * ## Why display-name search and sort happen here rather than in SQL
 *
 * Display names live on Discord, not in this database — `players` stores a
 * snowflake and nothing else about a person. So the service returns the guild's
 * player rows in **one** query (buddy joined in, capped at
 * `DIRECTORY_MAX_PLAYERS`), identity is resolved for that set through the
 * cached, deduplicated, timeout-capped resolver every other player route
 * already uses, and search/sort/pagination are applied to the result.
 *
 * That is one database query per request regardless of page, sort or search
 * term — the N+1 this endpoint exists to avoid is a *query* per player, and
 * there is none. Identity resolution is a per-snowflake in-process cache hit in
 * the steady state, and on a cold cache the whole page races one 500ms budget
 * concurrently, never sequentially, and answers `Trainer #<id>` for anything it
 * cannot resolve.
 */
import type { ApiContext } from '../../context';
import { ApiPlayerNotFoundError } from '../../errors';
import { noIdentity } from '../../identity';
import { requirePlayer } from '../../plugins/playerScope';
import { resolveGuildScope } from '../../plugins/guildScope';
import { dataSchema, ok, okPage, paginatedSchema } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { toCurrentRegionResource } from '../../resources';
import {
  commonErrorResponses,
  errorSchema,
  notFoundResponse,
  playerIdParams,
} from '../../schemas/common';
import {
  directoryPlayerSchema,
  directoryQuery,
  publicPlayerProfileSchema,
} from '../../schemas/players';
import type { DirectoryPlayer } from '../../../modules/players/playerService';
import type { PlayerIdentity } from '../../identity';

type DirectoryResource = ReturnType<typeof toDirectoryResource>;

/** The fallback name. Never blank, never fabricated from a snowflake. */
function fallbackName(playerId: number): string {
  return `Trainer #${playerId}`;
}

function toDirectoryResource(
  row: DirectoryPlayer,
  identity: PlayerIdentity | null,
  buddyAsset: { kind: 'waifumon'; slug: string; variant: string } | null,
) {
  return {
    id: row.id,
    displayName: identity?.displayName ?? fallbackName(row.id),
    avatarUrl: identity?.avatarUrl ?? null,
    level: row.level,
    lastActiveAt: row.lastActiveAt,
    buddy:
      row.buddy && buddyAsset
        ? {
            speciesSlug: row.buddy.speciesSlug,
            speciesName: row.buddy.speciesName,
            rarity: row.buddy.rarity,
            level: row.buddy.level,
            assetId: buddyAsset,
          }
        : null,
  };
}

export const playerDirectoryRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const resolveIdentity = ctx.resolveIdentity ?? noIdentity;

    /**
     * The buddy's artwork identifier.
     *
     * A pure content lookup (`appearanceService.currentAppearance` reads the
     * in-memory snapshot), so it costs no query — which is what lets the buddy
     * preview ship at all. It resolves the *base* artwork identity, with no
     * `owned` context: the directory must not hand a viewer a handle to another
     * player's owned-artwork endpoint.
     */
    function buddyAssetFor(row: DirectoryPlayer) {
      if (!row.buddy) return null;
      const species = ctx.getContent().species.find((s) => s.slug === row.buddy?.speciesSlug);
      if (!species) return null;
      const current = ctx.services.appearance.currentAppearance(species, row.buddy.variant, {
        level: row.buddy.level,
      });
      return { kind: 'waifumon' as const, slug: current.assetId.slug, variant: current.assetId.variant };
    }

    /** One resolver call per distinct player, all in flight together. */
    async function withIdentities(rows: readonly DirectoryPlayer[]): Promise<DirectoryResource[]> {
      const identities = await Promise.all(rows.map((row) => resolveIdentity(row.discordUserId)));
      return rows.map((row, i) => toDirectoryResource(row, identities[i] ?? null, buddyAssetFor(row)));
    }

    app.get(
      '/players',
      {
        schema: {
          tags: ['Players'],
          summary: 'List the players in the selected guild',
          description:
            'The Portal "Players" directory. Scoped to the guild the authenticated Portal ' +
            'session currently has selected — never to a guild named by the request. A session ' +
            'with no selected guild gets 400; one asking for a guild it has not selected gets ' +
            '403.\n\n' +
            '**Who is listed.** Every `players` row in the guild. A row exists only because ' +
            'somebody played Waifumon in that server, and the application keeps no Discord ' +
            'membership state, so row existence is the strongest participation signal there is. ' +
            '`activity=recent` narrows to 30 days of activity ' +
            '(`last_hunt_at`, falling back to when they joined).\n\n' +
            'A player who plays in several guilds has one row per guild and therefore appears in ' +
            'each of those guilds\' directories, with that guild\'s level and buddy.\n\n' +
            'One database query per request, buddy included — see the module comment.',
          querystring: directoryQuery,
          response: {
            200: paginatedSchema(directoryPlayerSchema),
            ...commonErrorResponses,
            403: errorSchema.describe(
              'The session asked for a guild it has not selected — `PORTAL_GUILD_FORBIDDEN`.',
            ),
          },
        },
      },
      async (req) => {
        const { page, pageSize, search, sort, activity, discordGuildId } = req.query;
        const scope = await resolveGuildScope(req, ctx, discordGuildId);

        const rows = await ctx.services.players.listGuildDirectory({
          guildDbId: scope.guildDbId,
          activity,
        });
        const resolved = await withIdentities(rows);

        const needle = search?.toLowerCase();
        const matched = needle
          ? resolved.filter((p) => p.displayName.toLowerCase().includes(needle))
          : resolved;

        // `id` is the tiebreak in every order, so two players on the same level
        // (or with the same name) never swap places between page requests.
        const sorted = [...matched].sort((a, b) => {
          if (sort === 'level') return b.level - a.level || a.id - b.id;
          if (sort === 'recent') {
            return b.lastActiveAt.getTime() - a.lastActiveAt.getTime() || a.id - b.id;
          }
          return a.displayName.localeCompare(b.displayName) || a.id - b.id;
        });

        const start = (page - 1) * pageSize;
        return okPage(req, sorted.slice(start, start + pageSize), page, pageSize, sorted.length);
      },
    );

    app.get(
      '/players/:playerId/public',
      {
        // Read by the player-scope hook: this is the one player-scoped route a
        // Portal session may point at somebody else, and only inside its own
        // selected guild. See `plugins/playerScope.ts`.
        config: { publicGuildProfile: true },
        schema: {
          tags: ['Players'],
          summary: "Get another player's public profile",
          description:
            'The profile the Players directory links to. Answers only for a player in the ' +
            "session's selected guild — a player from any other guild is 404, the same answer an " +
            'unknown id gets, so a probe learns nothing from the difference.\n\n' +
            'The payload is the directory row plus join date, current region, and dex *counts*. ' +
            'It carries no currencies, no XP, no inventory, and no collection contents.',
          params: playerIdParams,
          response: {
            200: dataSchema(publicPlayerProfileSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const player = requirePlayer(req);
        const scope = await resolveGuildScope(req, ctx, undefined);
        // Belt and braces: the scope hook has already refused a cross-guild id
        // for a Portal session. This re-asserts it for every auth mode, on the
        // route that actually publishes the data.
        if (player.guildId !== scope.guildDbId) throw new ApiPlayerNotFoundError(player.id);

        // The same query the list uses, narrowed to one id — so the profile
        // cannot disagree with the row that linked to it about scope or buddy.
        const [[row], stats] = await Promise.all([
          ctx.services.players.listGuildDirectory({
            guildDbId: scope.guildDbId,
            playerId: player.id,
          }),
          ctx.services.collection.getDexStats(player.id),
        ]);
        if (!row) throw new ApiPlayerNotFoundError(player.id);

        const [resource] = await withIdentities([row]);
        if (!resource) throw new ApiPlayerNotFoundError(player.id);

        return ok(req, {
          ...resource,
          createdAt: player.createdAt,
          currentRegion: toCurrentRegionResource(player.currentRegion, ctx.getContent().regions),
          collection: stats,
        });
      },
    );
  };
