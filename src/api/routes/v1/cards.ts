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
 * **2. Cache identity follows the artwork that resolved, not the one asked
 * for.** Artwork lookup falls back (appearance → species default → legacy
 * `imagePath`), and two appearances that both fall back render byte-identical
 * cards. Keying those by the *requested* appearance would mint two master
 * renders of one image. The shared resolver returns the asset it actually
 * used, and that is what reaches the renderer — see `speciesCardInput.ts`.
 *
 * Registered only when `CARD_RENDERER_ENABLED`; see `routes/v1/index.ts`.
 */
import { z } from 'zod';
import {
  CardArtworkMissingError,
  MASTER_WIDTH,
  SUPPORTED_CARD_WIDTHS,
  cardEtag,
  getCardRenderer,
  type CardRenderInput,
  type CardRenderResult,
} from '../../../modules/cards';
import { resolveAppearanceAssetOrLegacyPath } from '../../../modules/appearance/assetResolver';
import type { ResolvedAppearanceAsset } from '../../../modules/appearance/assetResolver';
import { toCardRenderInput } from '../../../modules/content/speciesCardInput';
import type { SpeciesContent } from '../../../modules/content/schemas';
import { AppearanceNotFoundError } from '../../../shared/errors';
import type { ApiContext } from '../../context';
import { ApiCardLevelError, ApiSpeciesNotFoundError } from '../../errors';
import { requirePlayer } from '../../plugins/playerScope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import {
  commonErrorResponses,
  notFoundResponse,
  slugParam,
  waifuIdParams,
} from '../../schemas/common';

/**
 * Mirrors `/dev-assets`. Short and revalidating rather than immutable: the URL
 * carries no version, so a content edit must be able to take effect. The ETag
 * makes revalidation cheap — a 304 costs one hash, not one render.
 */
const CACHE_CONTROL = 'public, max-age=300, must-revalidate';

const widthQuery = z.coerce
  .number()
  .int()
  .refine((w) => SUPPORTED_CARD_WIDTHS.includes(w), {
    message: `width must be one of ${SUPPORTED_CARD_WIDTHS.join(', ')}`,
  })
  .optional()
  .describe(`Display width. One of ${SUPPORTED_CARD_WIDTHS.join(', ')}; default ${MASTER_WIDTH}.`);

const speciesCardQuery = z.object({
  variant: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Appearance id. Defaults to the species’ default appearance.'),
  level: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Level printed on the card. Defaults to 1.'),
  width: widthQuery,
});

const ownedCardQuery = z.object({ width: widthQuery });

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

    /**
     * Turns a requested appearance id into the artwork that will actually be
     * drawn. Two distinct failures, deliberately different statuses:
     *
     *   - an id the species does not have is a malformed request — 400, via
     *     `APPEARANCE_NOT_FOUND`, matching the convention in `api/errors.ts`;
     *   - an id that exists but whose file (and every fallback) is missing is a
     *     content gap — 404, via `CARD_ARTWORK_MISSING`.
     */
    function artworkOr404(
      species: SpeciesContent,
      requestedAppearanceId: string | undefined,
      log: { debug: (obj: object, msg: string) => void },
    ): ResolvedAppearanceAsset {
      const catalog = appearance.catalogFor(species);
      const chosen =
        requestedAppearanceId === undefined
          ? appearance.currentAppearance(species, null)
          : catalog.find((entry) => entry.id === requestedAppearanceId);

      if (!chosen) throw new AppearanceNotFoundError(requestedAppearanceId ?? '', species.slug);

      const resolved = resolveAppearanceAssetOrLegacyPath(
        { assetsDir: assetsRoot },
        chosen.assetId,
        species.imagePath,
      );
      if (!resolved) {
        throw new CardArtworkMissingError('', species.slug, chosen.id);
      }

      if (resolved.assetId.variant !== chosen.id || resolved.source !== 'appearance') {
        log.debug(
          {
            tag: 'card-renderer/artwork-fallback',
            slug: species.slug,
            requestedAppearanceId: chosen.id,
            resolvedAppearanceId: resolved.assetId.variant,
            source: resolved.source,
          },
          'card artwork resolved to a fallback asset',
        );
      }
      return resolved;
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
      const width = input.output?.width ?? MASTER_WIDTH;
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
            'cache identity follows the artwork that actually resolved.',
          params: z.object({ slug: slugParam }),
          querystring: speciesCardQuery,
          response: cardResponses,
        },
      },
      async (req, reply) => {
        const species = speciesOr404(req.params.slug);
        assertLevelInRange(req.query.level, ctx);

        const artwork = artworkOr404(species, req.query.variant, req.log);
        const input = toCardRenderInput(species, {
          artwork,
          ...(req.query.level === undefined ? {} : { level: req.query.level }),
          ...(req.query.width === undefined ? {} : { width: req.query.width }),
          logger: req.log as never,
        });

        await sendCard(req, reply, input, {
          slug: species.slug,
          requestedAppearanceId: req.query.variant ?? artwork.assetId.variant,
          source: artwork.source,
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
        const species = speciesOr404(entry.species.slug);

        const worn = appearance.currentAppearance(entry.species, entry.waifu.variant);
        const artwork = artworkOr404(species, worn.id, req.log);

        const input = toCardRenderInput(species, {
          artwork,
          level: entry.waifu.level,
          ...(req.query.width === undefined ? {} : { width: req.query.width }),
          logger: req.log as never,
        });

        await sendCard(req, reply, input, {
          slug: species.slug,
          requestedAppearanceId: worn.id,
          source: artwork.source,
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
