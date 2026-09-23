/**
 * Canonical raw species artwork for the Portal.
 *
 * Unlike rendered cards, these responses do not compose anything: they stream
 * the artwork selected by the same appearance service and resolver used by
 * Discord and cards. The species route exposes only the ungated default
 * appearance, and only to a caller allowed to see that species at all — see
 * `assertSpeciesVisible`, which is what stops a player reading the whole
 * encyclopedia out of the URL bar. A copy-specific route performs the normal
 * ownership and level checks before serving the appearance that copy is
 * wearing.
 *
 * Every route here that can reach a species the caller may not own runs
 * `assertSpeciesVisible` against **the caller's own dex** — including the
 * public one, which is addressed by somebody else's copy. Whose collection a
 * picture is reached through never changes who is allowed to look at it.
 */
import { z } from 'zod';
import type { ArtworkFile } from '../../../modules/assets/speciesArtworkFile';
import {
  ownedAppearanceArtworkRequest,
  ownedCardRequest,
  speciesCardRequest,
  type CardPresentationDeps,
} from '../../../modules/appearance/cardPresentation';
import {
  artworkWidthQueryField,
  sendArtwork as sendArtworkFile,
  type ArtworkReply,
  type ArtworkRequest,
} from '../../artworkResponse';
import type { ApiContext } from '../../context';
import { ApiSpeciesNotFoundError } from '../../errors';
import { requirePlayer } from '../../plugins/playerScope';
import { assertSpeciesVisible } from '../../plugins/speciesVisibility';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import {
  commonErrorResponses,
  errorSchema,
  notFoundResponse,
  slugParam,
  waifuIdParams,
} from '../../schemas/common';

/**
 * Every artwork response is now caller-dependent: the species route answers
 * bytes or 403 depending on the requesting player's dex, and the owned route
 * always has one player in scope. `private` is therefore the only correct
 * policy — a shared cache keyed on the URL alone would happily hand one
 * player's authorized response to another player's 403.
 */
const CACHE_CONTROL = 'private, max-age=300, must-revalidate';

const artworkQuery = z.object({
  width: artworkWidthQueryField,
  selected: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_]+$/)
    .optional()
    .describe(
      'Client cache discriminator only. The server ignores it and resolves the selected appearance from the owned copy.',
    ),
  appearance: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_]+$/)
    .optional()
    .describe(
      'Owned-artwork only: the appearance id to render (a gallery tile’s own look). ' +
        'Validated against this copy’s ownership and level — a locked id answers 409, an ' +
        'unknown id 400. Omitted renders the appearance she is currently wearing.',
    ),
}).strict();

const artworkResponses = {
  304: z.null().describe('The artwork is unchanged — the ETag matched.'),
  ...notFoundResponse,
  ...commonErrorResponses,
} as const;

/**
 * Both the species route and the public owned-copy route add 403 for a species
 * the *requesting* player has not discovered.
 */
const speciesArtworkResponses = {
  ...artworkResponses,
  403: errorSchema.describe('This player has not discovered this species.'),
} as const;

/** The owned route adds 409 for a requested appearance this copy has not earned. */
const ownedArtworkResponses = {
  ...artworkResponses,
  409: errorSchema.describe('The requested appearance is not unlocked for this copy.'),
} as const;

export const artworkRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    if (ctx.assetsDir === undefined) throw new Error('artworkRoutes requires ctx.assetsDir');

    const assetsDir = ctx.assetsDir;
    const { appearance, collection } = ctx.services;
    const presentation: CardPresentationDeps = { appearance, assetsDir };

    // Rendition choice, ETag/304 and headers are shared with the Admin
    // Gallery; which file a caller may see is decided by each route below.
    const sendArtwork = (
      req: ArtworkRequest,
      reply: ArtworkReply,
      artwork: ArtworkFile,
      cacheControl: string,
    ): Promise<void> => sendArtworkFile(assetsDir, req, reply, artwork, cacheControl);

    app.get(
      '/assets/waifumon/:slug',
      {
        schema: {
          tags: ['Content'],
          summary: 'Get a species’ base artwork',
          description:
            'Returns the species’ ungated default artwork. Level-gated variants are never ' +
            'addressable through this route.\n\n' +
            'A **portal session** may only fetch a species it has discovered — owns at least one ' +
            'active copy of — and anything else answers `403 SPECIES_NOT_DISCOVERED`. ' +
            'Bearer-token callers (the bot, tools, the admin panel) are unrestricted.',
          params: z.object({ slug: slugParam }),
          querystring: artworkQuery,
          response: speciesArtworkResponses,
        },
      },
      async (req, reply) => {
        const species = appearance.speciesContent(req.params.slug);
        if (!species) throw new ApiSpeciesNotFoundError(req.params.slug);
        // Before a byte is read: the dex rule is an authorization check, not a
        // presentation one, so it runs ahead of any artwork resolution.
        await assertSpeciesVisible(ctx, req, species.slug);
        const request = speciesCardRequest(presentation, species);
        await sendArtwork(req, reply, request.artwork, CACHE_CONTROL);
        return reply;
      },
    );

    /**
     * The same bytes, for a **guild-mate's** copy.
     *
     * Two ownerships have to line up before a pixel is served here, and
     * conflating them is the bug this route once had:
     *
     *   - **The owner's.** Addressed by owner + copy, never by slug: the only
     *     artwork reachable is the appearance a real, active copy of *that*
     *     player is wearing, resolved by `getOwned` scoped to them. There is no
     *     parameter that names a species, and `publicGuildProfile` has already
     *     established that the owner is inside the requesting session's
     *     selected guild before the handler runs.
     *   - **The viewer's.** `assertSpeciesVisible` — the same check, against
     *     the same dex, that `/assets/waifumon/:slug` has always run. A
     *     guild-mate owning a species is a reason to list her copy; it is not a
     *     reason to hand the viewer artwork they have not earned. Without this
     *     the route was a species oracle with extra steps: any viewer could
     *     read the full-resolution art of anything anybody in their guild owned
     *     by walking copy ids, which is precisely what the slug route refuses.
     *
     * So the public collection shows an undiscovered species exactly as the
     * encyclopedia does — a silhouette — and the two surfaces now answer to one
     * rule instead of two.
     *
     * Level-gated appearances stay unreachable here: there is no `appearance`
     * selector, so this only ever serves the look she is actually wearing —
     * which the copy has, by definition, already earned.
     */
    app.get(
      '/players/:playerId/public/collection/:waifuId/artwork',
      {
        config: { publicGuildProfile: true },
        schema: {
          tags: ['Collection'],
          summary: "Get a guild-mate's owned copy artwork",
          description:
            "The artwork one copy in another player's public collection is wearing." +
            "\n\n" +
            'Two checks, both required: the copy must be an active one belonging to a player in ' +
            "the requesting session's selected guild (404 otherwise), **and** the requesting " +
            'player must have discovered that species themselves (`403 ' +
            "SPECIES_NOT_DISCOVERED` otherwise). Viewing a guild-mate's collection is not a way " +
            'to unlock artwork — the Portal draws the silhouette instead.',
          params: waifuIdParams,
          querystring: artworkQuery,
          response: speciesArtworkResponses,
        },
      },
      async (req, reply) => {
        const owner = requirePlayer(req);
        const entry = await collection.getOwned(owner.id, req.params.waifuId);
        // The owner's copy got us this far; the viewer's dex decides whether
        // the bytes may be read. Ahead of any artwork resolution, as on the
        // slug route — this is authorization, not presentation.
        await assertSpeciesVisible(ctx, req, entry.species.slug);
        const request = ownedCardRequest(presentation, entry);
        await sendArtwork(req, reply, request.artwork, CACHE_CONTROL);
        return reply;
      },
    );

    app.get(
      '/players/:playerId/collection/owned/:waifuId/artwork',
      {
        schema: {
          tags: ['Collection'],
          summary: 'Get an owned copy’s selected artwork',
          description:
            'Returns the appearance this copy is currently allowed to wear, after ownership and ' +
            'level checks. A stale or locked selection falls back to the ungated default. Pass ' +
            '`appearance=<id>` to request a specific unlocked look — a gallery tile’s own art — ' +
            'which is re-validated against this copy before it is served.',
          params: waifuIdParams,
          querystring: artworkQuery,
          response: ownedArtworkResponses,
        },
      },
      async (req, reply) => {
        const entry = await collection.getOwned(requirePlayer(req).id, req.params.waifuId);
        // With no `appearance` selector this is the look she is wearing (the
        // hero image). A gallery tile names its own appearance instead, and the
        // request re-validates ownership and level before serving that variant.
        const request =
          req.query.appearance === undefined
            ? ownedCardRequest(presentation, entry)
            : ownedAppearanceArtworkRequest(presentation, entry, req.query.appearance);
        await sendArtwork(req, reply, request.artwork, CACHE_CONTROL);
        return reply;
      },
    );
  };
