/**
 * Rendered card images (plan §12 Phase 3).
 *
 * Two routes, one shape: resolve *what to draw*, hand it to the cards module,
 * stream WebP back. The handler owns none of the drawing and none of the
 * caching — it is the same thin-adapter contract as every other v1 route, with
 * two wrinkles worth reading before editing:
 *
 * **1. Responses are bytes, not envelopes.** Every other v1 route answers
 * `{ data: … }`. These answer `image/webp`. So no `200` response schema is
 * declared: a Zod serializer would try to JSON-encode the Buffer. Error
 * responses still use the standard envelope, so a failure is indistinguishable
 * from any other route's.
 *
 * **2. Which card to draw is not decided here.** Species lookup, appearance
 * selection, artwork fallback, level and the ownership flag all live in
 * `modules/appearance/cardPresentation.ts`, because Discord renders the same
 * cards in-process and a second copy of that chain is how the two would drift.
 * This route resolves the request, hands it over, and streams the bytes.
 *
 * Cache identity still follows the artwork that *resolved* rather than the one
 * asked for — two appearances that both fall back render byte-identical cards,
 * and keying them apart would mint two masters of one image. The presentation
 * service returns the asset it actually used.
 *
 * Registered only when `CARD_RENDERER_ENABLED`; see `routes/v1/index.ts`.
 */
import { z } from 'zod';
import {
  CardArtworkMissingError,
  CARD_MASTER_WIDTH,
  SUPPORTED_CARD_WIDTHS,
  cardEtag,
  getCardRenderer,
  type CardRenderInput,
  type CardRenderResult,
} from '../../../modules/cards';
import {
  ownedCardRequest,
  speciesCardRequest,
  type CardPresentationDeps,
  type CardRequest,
} from '../../../modules/appearance/cardPresentation';
import type { SpeciesContent } from '../../../modules/content/schemas';
import type { ApiContext } from '../../context';
import { ApiCardLevelError, ApiSpeciesNotFoundError } from '../../errors';
import { requirePlayer } from '../../plugins/playerScope';
import { assertSpeciesVisible } from '../../plugins/speciesVisibility';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import {
  commonErrorResponses,
  notFoundResponse,
  slugParam,
  waifuIdParams,
} from '../../schemas/common';

/**
 * Short and revalidating rather than immutable: the URL carries no version, so
 * a content edit must be able to take effect. The ETag makes revalidation
 * cheap — a 304 costs one hash, not one render.
 *
 * `private`, not `public`: both routes are caller-dependent. The owned card is
 * one player's copy by definition, and the species card now answers bytes or
 * 403 according to the requesting player's dex — a shared cache keyed on the
 * URL alone would serve one player's authorized render to another player.
 */
const CACHE_CONTROL = 'private, max-age=300, must-revalidate';

const widthQuery = z.coerce
  .number()
  .int()
  .refine((w) => SUPPORTED_CARD_WIDTHS.includes(w), {
    message: `width must be one of ${SUPPORTED_CARD_WIDTHS.join(', ')}`,
  })
  .optional()
  .describe(`Display width. One of ${SUPPORTED_CARD_WIDTHS.join(', ')}; default ${CARD_MASTER_WIDTH}.`);

const speciesCardQuery = z.object({
  variant: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Appearance id. Defaults to the species’ default appearance.\n\n' +
        'Only **ungated** appearances (`unlock.type: "owned"`) may be named here — this route ' +
        'is a species preview with no owned copy in scope, so it cannot establish that anyone ' +
        'has earned a level-gated look. A gated id answers `409 APPEARANCE_LOCKED`. To see a ' +
        'look you have unlocked, render your own copy: ' +
        '`GET /v1/players/{playerId}/collection/owned/{waifuId}/card`.',
    ),
  level: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Level printed on the card. Defaults to 1.'),
  width: widthQuery,
});

const ownedCardQuery = z.object({
  width: widthQuery,
  selected: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_]+$/)
    .optional()
    .describe(
      'Client cache discriminator only. The server ignores it and resolves the selected appearance from the owned copy.',
    ),
});

/**
 * `304` is declared, not just returned: a conditional GET is part of this
 * endpoint's contract, so it belongs in the OpenAPI document — and declaring
 * it is also what lets `reply.code(304)` typecheck against the narrowed reply.
 *
 * There is deliberately no `200` schema. These routes answer with a WebP
 * buffer; a Zod response schema would install a serializer that JSON-encodes
 * it. Fastify passes a Buffer through untouched when no serializer is set.
 */
const cardResponses = {
  304: z.null().describe('The card is unchanged — the ETag matched `If-None-Match`.'),
  ...notFoundResponse,
  ...commonErrorResponses,
} as const;

/**
 * The species route additionally refuses to render a gated appearance, and —
 * for a player's browser session — a species that player has not discovered.
 */
const speciesCardResponses = {
  ...cardResponses,
  403: commonErrorResponses[400].describe('This player has not discovered this species.'),
  409: commonErrorResponses[400].describe(
    'The named appearance is level-gated and cannot be previewed on the species route.',
  ),
} as const;

/** The slice of the typed reply the shared sender needs. */
interface CardReply {
  code(statusCode: 304): CardReply;
  header(key: string, value: string): CardReply;
  send(payload?: unknown): unknown;
}

export const cardRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const { appearance, collection } = ctx.services;
    const renderer = ctx.cardRenderer ?? getCardRenderer();
    if (ctx.assetsDir === undefined) {
      // Registration-time, not request-time: a context without an assets root
      // cannot resolve artwork, and finding that out per request would mean
      // every card 500s instead of the process refusing to start.
      throw new Error('cardRoutes requires ctx.assetsDir');
    }
    const assetsRoot: string = ctx.assetsDir;

    /**
     * Content lookup by slug. Disabled species still render: `enabled` gates
     * whether she can be *encountered*, not whether her card exists, and an
     * encyclopedia entry for a retired Waifumon is a legitimate read.
     */
    function speciesOr404(slug: string): SpeciesContent {
      const species = appearance.speciesContent(slug);
      if (!species) throw new ApiSpeciesNotFoundError(slug);
      return species;
    }

    const presentation: CardPresentationDeps = { appearance, assetsDir: assetsRoot };

    /**
     * Logs when the artwork that supplied the pixels is not the one asked for.
     * A fallback is a content gap worth seeing, and it is also the reason two
     * appearances can share one render key.
     */
    function logFallback(
      request: CardRequest,
      log: { debug: (obj: object, msg: string) => void },
    ): CardRequest {
      const resolved = request.artwork;
      if (
        resolved.assetId.variant !== request.requestedAppearanceId ||
        resolved.source !== 'appearance'
      ) {
        log.debug(
          {
            tag: 'card-renderer/artwork-fallback',
            slug: request.species.slug,
            requestedAppearanceId: request.requestedAppearanceId,
            resolvedAppearanceId: resolved.assetId.variant,
            source: resolved.source,
          },
          'card artwork resolved to a fallback asset',
        );
      }
      return request;
    }

    /**
     * The shared tail of both routes: conditional-GET short circuit, render,
     * headers, timing log.
     *
     * The 304 check runs *before* rendering. `computeMasterRenderKey` hashes
     * artwork bytes and no more, so a revalidation never rasterizes and never
     * even reads a cached file.
     */
    async function sendCard(
      req: {
        id: string | number;
        headers: Record<string, unknown>;
        log: { debug: (obj: object, msg: string) => void };
      },
      reply: CardReply,
      input: CardRenderInput,
      context: { slug: string; requestedAppearanceId: string; source: string },
    ): Promise<void> {
      const width = input.output?.width ?? CARD_MASTER_WIDTH;
      const renderKey = await renderer.computeMasterRenderKey(input);
      const etag = cardEtag(renderKey, width);

      if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
        reply.header('ETag', etag);
        reply.header('Cache-Control', CACHE_CONTROL);
        reply.code(304);
        req.log.debug(
          { tag: 'card-renderer/serve', slug: context.slug, renderKey, width, notModified: true },
          'card not modified',
        );
        reply.send();
        return;
      }

      const started = Date.now();
      const card: CardRenderResult = await renderer.renderCard(input);
      const durationMs = Date.now() - started;

      req.log.debug(
        {
          tag: 'card-renderer/serve',
          slug: context.slug,
          requestedAppearanceId: context.requestedAppearanceId,
          resolvedAppearanceId: input.variant.appearanceId,
          resolutionSource: context.source,
          level: input.progress?.level ?? 1,
          width: card.width,
          renderKey: card.renderKey,
          fromCache: card.fromCache,
          bytes: card.bytes.length,
          durationMs,
        },
        'card served',
      );

      reply.header('Content-Type', card.contentType);
      reply.header('ETag', card.etag);
      reply.header('Cache-Control', CACHE_CONTROL);
      reply.send(card.bytes);
    }

    app.get(
      '/cards/species/:slug',
      {
        schema: {
          tags: ['Cards'],
          summary: 'Render a species card',
          description:
            'Returns a rendered card image (`image/webp`), not JSON.\n\n' +
            'The card is composed server-side from the SVG kit plus the appearance artwork and ' +
            'cached on disk; repeat requests are served from cache and revalidate cheaply via ' +
            '`ETag` / `If-None-Match`.\n\n' +
            'Artwork falls back (appearance → species default) when a file is missing, and the ' +
            'cache identity follows the artwork that actually resolved.\n\n' +
            'Level-gated appearances are **not** renderable here — see `variant`.\n\n' +
            'A **portal session** may only render a species it has discovered; anything else ' +
            'answers `403 SPECIES_NOT_DISCOVERED`. Bearer-token callers are unrestricted.',
          params: z.object({ slug: slugParam }),
          querystring: speciesCardQuery,
          response: speciesCardResponses,
        },
      },
      async (req, reply) => {
        const species = speciesOr404(req.params.slug);
        // A rendered card is the species' artwork with a frame around it, so
        // the encyclopedia's spoiler rule has to hold here too — otherwise the
        // card route is simply the artwork route with an extra border.
        await assertSpeciesVisible(ctx, req, species.slug);
        assertLevelInRange(req.query.level, ctx);

        const request = logFallback(
          speciesCardRequest(presentation, species, {
            ...(req.query.variant === undefined ? {} : { appearanceId: req.query.variant }),
            ...(req.query.level === undefined ? {} : { level: req.query.level }),
            ...(req.query.width === undefined ? {} : { width: req.query.width }),
          }),
          req.log,
        );

        await sendCard(req, reply, request.input, {
          slug: species.slug,
          requestedAppearanceId: request.requestedAppearanceId,
          source: request.artwork.source,
        });
        return reply;
      },
    );

    app.get(
      '/players/:playerId/collection/owned/:waifuId/card',
      {
        schema: {
          tags: ['Cards'],
          summary: 'Render an owned copy’s card',
          description:
            'Returns a rendered card image (`image/webp`) for one owned Waifumon, using her ' +
            'current level and the appearance she is wearing.\n\n' +
            'Returns 404 (`WAIFU_NOT_OWNED`) when the copy belongs to someone else, does not ' +
            'exist, or has been released — the same ownership check the rest of ' +
            '`/collection` uses.',
          params: waifuIdParams,
          querystring: ownedCardQuery,
          response: cardResponses,
        },
      },
      async (req, reply) => {
        // Ownership is this call: `getOwned` throws WAIFU_NOT_OWNED (→ 404) for
        // a copy that is not this player's. No separate authorization path.
        const entry = await collection.getOwned(requirePlayer(req).id, req.params.waifuId);
        // Presence check only: `ownedCardRequest` does the content lookup
        // itself, but a species missing from the snapshot should still read as
        // a 404 on this route rather than a render failure.
        speciesOr404(entry.species.slug);

        const request = logFallback(
          ownedCardRequest(presentation, entry, {
            ...(req.query.width === undefined ? {} : { width: req.query.width }),
          }),
          req.log,
        );

        await sendCard(req, reply, request.input, {
          slug: request.species.slug,
          requestedAppearanceId: request.requestedAppearanceId,
          source: request.artwork.source,
        });
        return reply;
      },
    );
  };

/**
 * Level ceiling comes from `tables.waifuProgression.maxLevel` — the same
 * constant progression enforces. Duplicating a number here would let the API
 * and the game disagree about what a valid level is.
 */
function assertLevelInRange(level: number | undefined, ctx: ApiContext): void {
  if (level === undefined) return;
  const maxLevel = ctx.getContent().tables?.waifuProgression?.maxLevel;
  if (typeof maxLevel === 'number' && level > maxLevel) {
    throw new ApiCardLevelError(level, maxLevel);
  }
}

/** `If-None-Match` per RFC 9110: `*`, or any tag in the comma-separated list. */
export function matchesIfNoneMatch(header: unknown, etag: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag);
}
