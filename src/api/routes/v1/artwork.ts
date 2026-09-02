/**
 * Canonical raw species artwork for the Portal.
 *
 * Unlike rendered cards, these responses do not compose anything: they stream
 * the artwork selected by the same appearance service and resolver used by
 * Discord and cards. The public species route exposes only the ungated default
 * appearance. A copy-specific route performs the normal ownership and level
 * checks before serving the appearance that copy is wearing.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ownedCardRequest,
  speciesCardRequest,
  type CardPresentationDeps,
} from '../../../modules/appearance/cardPresentation';
import type { ApiContext } from '../../context';
import { ApiSpeciesNotFoundError } from '../../errors';
import { requirePlayer } from '../../plugins/playerScope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import {
  commonErrorResponses,
  notFoundResponse,
  slugParam,
  waifuIdParams,
} from '../../schemas/common';

const SUPPORTED_WIDTHS = [256, 512, 1024] as const;
const PUBLIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';
const PRIVATE_CACHE_CONTROL = 'private, max-age=300, must-revalidate';

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
}).strict();

const artworkResponses = {
  304: z.null().describe('The artwork is unchanged — the ETag matched.'),
  ...notFoundResponse,
  ...commonErrorResponses,
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
            'addressable through this route.',
          params: z.object({ slug: slugParam }),
          querystring: artworkQuery,
          response: artworkResponses,
        },
      },
      async (req, reply) => {
        const species = appearance.speciesContent(req.params.slug);
        if (!species) throw new ApiSpeciesNotFoundError(req.params.slug);
        const request = speciesCardRequest(presentation, species);
        await sendArtwork(req, reply, request.artwork.absolutePath, PUBLIC_CACHE_CONTROL);
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
            'level checks. A stale or locked selection falls back to the ungated default.',
          params: waifuIdParams,
          querystring: artworkQuery,
          response: artworkResponses,
        },
      },
      async (req, reply) => {
        const entry = await collection.getOwned(requirePlayer(req).id, req.params.waifuId);
        const request = ownedCardRequest(presentation, entry);
        await sendArtwork(req, reply, request.artwork.absolutePath, PRIVATE_CACHE_CONTROL);
        return reply;
      },
    );
  };
