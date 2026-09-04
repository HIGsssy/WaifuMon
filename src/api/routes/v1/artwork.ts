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
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ownedAppearanceArtworkRequest,
  ownedCardRequest,
  speciesCardRequest,
  type CardPresentationDeps,
} from '../../../modules/appearance/cardPresentation';
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

const SUPPORTED_WIDTHS = [256, 512, 1024] as const;
/**
 * Every artwork response is now caller-dependent: the species route answers
 * bytes or 403 depending on the requesting player's dex, and the owned route
 * always has one player in scope. `private` is therefore the only correct
 * policy — a shared cache keyed on the URL alone would happily hand one
 * player's authorized response to another player's 403.
 */
const CACHE_CONTROL = 'private, max-age=300, must-revalidate';

const artworkQuery = z.object({
  width: z.coerce
    .number()
    .int()
    .refine((width) => SUPPORTED_WIDTHS.includes(width as (typeof SUPPORTED_WIDTHS)[number]), {
      message: `width must be one of ${SUPPORTED_WIDTHS.join(', ')}`,
    })
    .optional(),
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

/** The species route adds 403 for a species this player has not discovered. */
const speciesArtworkResponses = {
  ...artworkResponses,
  403: errorSchema.describe('This player has not discovered this species.'),
} as const;

/** The owned route adds 409 for a requested appearance this copy has not earned. */
const ownedArtworkResponses = {
  ...artworkResponses,
  409: errorSchema.describe('The requested appearance is not unlocked for this copy.'),
} as const;

interface ArtworkReply {
  code(statusCode: 304): ArtworkReply;
  header(key: string, value: string): ArtworkReply;
  send(payload?: unknown): unknown;
}

function matchesEtag(header: unknown, etag: string): boolean {
  if (typeof header !== 'string') return false;
  const normalizedEtag = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === normalizedEtag);
}

async function rendition(
  assetsDir: string,
  source: string,
  width: number | undefined,
): Promise<{ file: string; contentType: string }> {
  if (width !== undefined) {
    const relative = path.relative(path.resolve(assetsDir), source);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      const thumbnail = path.resolve(
        assetsDir,
        '.thumbnails',
        String(width),
        relative.replace(/\.[^./\\]+$/, '.webp'),
      );
      try {
        if ((await stat(thumbnail)).isFile()) return { file: thumbnail, contentType: 'image/webp' };
      } catch {
        // Renditions are an optimization. Fall through to the canonical source.
      }
    }
  }

  const ext = path.extname(source).toLowerCase();
  const contentType =
    ext === '.webp'
      ? 'image/webp'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : 'image/png';
  return { file: source, contentType };
}

export const artworkRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    if (ctx.assetsDir === undefined) throw new Error('artworkRoutes requires ctx.assetsDir');

    const assetsDir = ctx.assetsDir;
    const { appearance, collection } = ctx.services;
    const presentation: CardPresentationDeps = { appearance, assetsDir };

    async function sendArtwork(
      req: { headers: Record<string, unknown>; query: { width?: number | undefined } },
      reply: ArtworkReply,
      source: string,
      cacheControl: string,
    ): Promise<void> {
      const selected = await rendition(assetsDir, source, req.query.width);
      const stats = await stat(selected.file);
      const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

      reply.header('ETag', etag).header('Cache-Control', cacheControl);
      if (matchesEtag(req.headers['if-none-match'], etag)) {
        reply.code(304);
        reply.send();
        return;
      }

      reply.header('Content-Type', selected.contentType);
      reply.send(await readFile(selected.file));
    }

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
        await sendArtwork(req, reply, request.artwork.absolutePath, CACHE_CONTROL);
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
        await sendArtwork(req, reply, request.artwork.absolutePath, CACHE_CONTROL);
        return reply;
      },
    );
  };
