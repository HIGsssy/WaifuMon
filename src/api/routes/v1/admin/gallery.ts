/**
 * Portal admin — Waifumon Gallery: a read-only content/QA view of every
 * authored species and every authored appearance.
 *
 * Deliberately *not* the player catalog. It includes species the runtime
 * disabled, species from expansion packs that are switched off, appearances
 * the loader dropped, and the `AssetId` of every appearance — which is exactly
 * why every route here requires `gallery.read`, checked at `preValidation`
 * with the same guard every other Portal admin area uses. No other permission
 * (`admin.access`, `encounters.*`, `presentations.*`) satisfies it.
 *
 * GET only; nothing here writes. Species and appearances are addressed by
 * slug and appearance id and nothing else — there is no parameter that names a
 * file, an `AssetId` or a storage stem, and no response carries `imagePath` or
 * any filesystem location.
 *
 * The artwork route serves the **exact** appearance asked for, or 404. It
 * never substitutes the standard look, another appearance, the legacy image
 * or a placeholder: this is a QA surface, and missing artwork must look
 * missing. The only fallback is the one every artwork route shares — a
 * missing display rendition is served as that same appearance's original.
 *
 * All catalog rules live in `modules/adminGallery/galleryCatalog.ts`.
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import {
  commonErrorResponses,
  errorSchema,
  notFoundResponse,
  slugParam,
} from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiNotFoundError, ApiSpeciesNotFoundError } from '../../../errors';
import { artworkWidthQueryField, sendArtwork } from '../../../artworkResponse';
import { AppError } from '../../../../shared/errors';
import {
  GALLERY_ISSUE_CODES,
  buildGalleryCatalog,
  buildGallerySpeciesDetail,
  findGalleryAppearance,
} from '../../../../modules/adminGallery/galleryCatalog';
import { inspectSpeciesArtwork } from '../../../../modules/assets/speciesArtworkFile';
import {
  APPEARANCE_UNLOCK_TYPES,
  COSMETIC_RARITIES,
  SPECIES_ARTWORK_DIAGNOSTIC_CODES,
} from '../../../../modules/content/schemas';
import { AFFINITIES, CONTENT_RATINGS, RARITIES } from '../../../../db/schema';

/* ─────────────────────── Schemas ─────────────────────── */

const assetIdSchema = z.object({ kind: z.literal('waifumon'), slug: z.string(), variant: z.string() });
const artworkStatusSchema = z.enum(['available', 'missing', 'unsafe']);
const artworkFormatSchema = z.enum(['webp', 'png']).nullable();

const issueSchema = z.object({
  code: z.enum(GALLERY_ISSUE_CODES),
  severity: z.enum(['error', 'warning']),
  appearanceId: z.string().nullable(),
});

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('core') }),
  z.object({
    kind: z.literal('expansion'),
    expansionId: z.string(),
    expansionName: z.string(),
    expansionEnabled: z.boolean(),
  }),
]);

const speciesSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  rarity: z.enum(RARITIES),
  race: z.string(),
  archetype: z.string(),
  affinity: z.enum(AFFINITIES),
  contentRating: z.enum(CONTENT_RATINGS),
  tags: z.array(z.string()).describe('Raw species tags. Zone is derived by the Portal.'),
  source: sourceSchema,
  authoredEnabled: z.boolean().describe('`enabled` as written in the content file.'),
  runtime: z.object({
    loaded: z.boolean().describe('Present in the gameplay snapshot.'),
    enabled: z.boolean().nullable().describe('Enabled in the gameplay snapshot; null when not loaded.'),
    disabledByLoader: z
      .boolean()
      .describe('Authored enabled but loaded disabled, because no default artwork exists.'),
  }),
  appearanceCounts: z.object({
    authored: z.number().int(),
    inRuntime: z.number().int().nullable(),
    artworkAvailable: z.number().int(),
  }),
  primary: z.object({
    appearanceId: z.string(),
    assetId: assetIdSchema,
    status: artworkStatusSchema,
    format: artworkFormatSchema,
  }),
  issues: z.array(issueSchema),
});

const appearanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  flavorText: z.string().nullable(),
  cosmeticRarity: z.enum(COSMETIC_RARITIES),
  introducedVersion: z.string().nullable(),
  contentRating: z.enum(CONTENT_RATINGS),
  contentRatingSource: z.enum(['appearance', 'species']),
  sortOrder: z.number().int(),
  tags: z.array(z.string()),
  unlock: z.object({ type: z.enum(APPEARANCE_UNLOCK_TYPES), atLevel: z.number().int().optional() }),
  unlockLabel: z.string(),
  isDefault: z.boolean(),
  implicit: z.boolean(),
  assetId: assetIdSchema,
  inRuntime: z.boolean(),
  artwork: z.object({
    status: artworkStatusSchema,
    format: artworkFormatSchema,
    storageStem: z.string(),
    renditions: z.record(z.string(), z.boolean()).optional(),
  }),
  loaderDiagnostics: z.array(z.enum(SPECIES_ARTWORK_DIAGNOSTIC_CODES)),
  issues: z.array(issueSchema),
});

const speciesDetailSchema = speciesSummarySchema.extend({
  description: z.string(),
  card: z.record(z.string(), z.unknown()).nullable(),
  buddyBonus: z.record(z.string(), z.unknown()).nullable(),
  baseCaptureRate: z.number().nullable(),
  eventKey: z.string().nullable(),
  perSpeciesWeight: z.number().int(),
  appearances: z.array(appearanceSchema),
  loaderDiagnostics: z.array(
    z.object({
      code: z.enum(SPECIES_ARTWORK_DIAGNOSTIC_CODES),
      slug: z.string(),
      appearanceId: z.string(),
      assetId: assetIdSchema,
    }),
  ),
});

const catalogSchema = z.object({
  summary: z.object({
    authoredSpecies: z.number().int(),
    runtimeLoadedSpecies: z.number().int(),
    runtimeEnabledSpecies: z.number().int(),
    loaderDisabledSpecies: z.number().int(),
    unloadedSpecies: z.number().int(),
    authoredAppearances: z.number().int(),
    runtimeAppearances: z.number().int(),
    artworkAvailableAppearances: z.number().int(),
    speciesWithIssues: z.number().int(),
    issueCounts: z.record(z.enum(GALLERY_ISSUE_CODES), z.number().int()),
  }),
  species: z.array(speciesSummarySchema),
});

/**
 * Unreleased artwork is caller-dependent (it requires `gallery.read`), so it
 * must never sit in a shared cache. Same policy as the player artwork routes.
 */
const ARTWORK_CACHE_CONTROL = 'private, max-age=300, must-revalidate';

const artworkParams = z.object({ slug: slugParam, appearanceId: slugParam });
const artworkQuery = z.object({ width: artworkWidthQueryField }).strict();

/* ─────────────────────── Routes ─────────────────────── */

export const adminGalleryRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    // Artwork status is part of every answer; without an assets root there is
    // nothing truthful to say, so the routes simply do not exist.
    if (ctx.assetsDir === undefined) return;
    const assetsDir = ctx.assetsDir;
    const authorization = ctx.portalAuthorization;

    const gate = async (req: FastifyRequest): Promise<void> => {
      if (!authorization) {
        throw new AppError(
          'PORTAL_PERMISSION_DENIED',
          'Portal authorization service is not configured',
          'Admin features are unavailable.',
        );
      }
      await requirePortalPermission(req, authorization, 'gallery.read', {
        allowBearer: ctx.adminBearerAllowed === true,
      });
    };

    app.get(
      '/admin/gallery/species',
      {
        preValidation: gate,
        schema: {
          tags: ['Admin — Waifumon Gallery'],
          summary: 'Every authored species, loaded or not, with artwork and loader status',
          description:
            'One entry per species defined in any content file — core, enabled expansion packs, ' +
            'and packs that are switched off (`runtime.loaded: false`). Built from the loaded ' +
            'content snapshot per request; artwork availability is checked on disk. Rendition ' +
            'presence is reported on species detail only.',
          response: { 200: dataSchema(catalogSchema), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, buildGalleryCatalog(ctx.getContent(), assetsDir)),
    );

    app.get(
      '/admin/gallery/species/:slug',
      {
        preValidation: gate,
        schema: {
          tags: ['Admin — Waifumon Gallery'],
          summary: 'One species with every authored appearance',
          description:
            'Every appearance the content file defines — including any the runtime dropped ' +
            '(`inRuntime: false`) — with its metadata, `AssetId`, artwork status, detected ' +
            'format, rendition presence and loader diagnostics.',
          params: z.object({ slug: slugParam }),
          response: { 200: dataSchema(speciesDetailSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const detail = buildGallerySpeciesDetail(ctx.getContent(), assetsDir, req.params.slug);
        if (!detail) throw new ApiSpeciesNotFoundError(req.params.slug);
        return ok(req, detail);
      },
    );

    app.get(
      '/admin/gallery/species/:slug/appearances/:appearanceId/artwork',
      {
        preValidation: gate,
        schema: {
          tags: ['Admin — Waifumon Gallery'],
          summary: 'Stream the artwork of exactly one authored appearance',
          description:
            'Any appearance the gallery catalog lists — runtime, locked, disabled, or from an ' +
            'expansion pack that is switched off. Serves that appearance or answers 404: a ' +
            'missing or unsafe file is never replaced by another appearance. `width` selects a ' +
            'pre-generated rendition of the same file, and falls back to its original.',
          params: artworkParams,
          querystring: artworkQuery,
          response: {
            304: z.null().describe('The artwork is unchanged — the ETag matched.'),
            403: errorSchema.describe('The session does not hold `gallery.read`.'),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req, reply) => {
        const { slug, appearanceId } = req.params;
        const lookup = findGalleryAppearance(ctx.getContent(), slug, appearanceId);
        if (lookup.status === 'species_not_found') throw new ApiSpeciesNotFoundError(slug);
        if (lookup.status === 'appearance_not_found') {
          throw new ApiNotFoundError(`Species "${slug}" has no appearance "${appearanceId}"`);
        }

        // Exactly this appearance's file — no standard, no legacy image, no
        // other variant. `unsafe` (a symlink out of the assets root) is
        // refused exactly like `missing`, and says nothing more to the client.
        const inspected = inspectSpeciesArtwork(assetsDir, lookup.assetId);
        if (inspected.status !== 'available') {
          if (inspected.status === 'unsafe') {
            req.log.warn(
              { slug, appearanceId, assetId: lookup.assetId },
              'admin gallery artwork refused: it resolves outside the assets directory',
            );
          }
          throw new ApiNotFoundError(
            `No artwork is available for appearance "${appearanceId}" of species "${slug}"`,
          );
        }

        await sendArtwork(assetsDir, req, reply, inspected.file, ARTWORK_CACHE_CONTROL);
        return reply;
      },
    );
  };
