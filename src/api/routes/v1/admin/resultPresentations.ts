/**
 * Portal admin — Result Presentations: authored flavor text and artwork for
 * lightweight gameplay outcomes (hunt finds, "nothing found", Let Her Go).
 *
 * Presentation only. Nothing here reads or writes a reward, an item, a
 * species roll, a capture chance or any player state; the variant model has
 * no field that could.
 *
 * Authorization, checked at `preValidation` so an unauthorized caller never
 * learns the body shape:
 *
 *   - `presentations.read`  — list, get, reference data, artwork bytes, and
 *                             the (non-persisting) preview;
 *   - `presentations.write` — create, update (including enable/disable) and
 *                             delete. Every write route checks it; there is
 *                             no lifecycle route that could skip it.
 *
 * No `encounters.*` permission satisfies any route here, and these
 * permissions reach nothing outside this namespace — the artwork route shares
 * its implementation with the encounter editor's, not its authorization.
 *
 * All rules live in `modules/resultPresentation`; the routes validate the
 * request *envelope* and hand the fields to the same validation the runtime
 * write path uses.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, notFoundResponse, slugParam } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiFieldValidationError } from '../../../errors';
import { adminArtworkQuery, sendAdminArtwork } from '../../../adminArtwork';
import { AppError } from '../../../../shared/errors';
import type { PortalPermission } from '../../../../modules/portalAuth/portalAuthService';
import {
  ARTWORK_MODES,
  RESULT_PRESENTATION_FLAVOR_MAX_LENGTH,
  RESULT_PRESENTATION_KEY_DEFINITIONS,
  RESULT_PRESENTATION_KEYS,
} from '../../../../modules/resultPresentation/keys';
import {
  RESULT_PRESENTATION_MAX_WEIGHT,
  ResultPresentationValidationError,
} from '../../../../modules/resultPresentation/validation';
import type { ResultPresentationVariantRecord } from '../../../../modules/resultPresentation/resultPresentationService';
import {
  buildResultPresentationPreview,
  PREVIEW_SAMPLE_NOTICE,
  type PreviewSpecies,
} from '../../../../modules/resultPresentation/preview';
import { SUPPORTED_ARTWORK_EXTENSIONS } from '../../../../modules/assets/artworkPath';
import { locateArtworkFile } from '../../../../modules/assets/artworkFile';
import { resolveAppearanceAssetOrLegacyPath } from '../../../../modules/appearance/assetResolver';
import type { ArtworkFile } from '../../../../modules/assets/speciesArtworkFile';

/* ─────────────────────── Schemas ─────────────────────── */

const keySchema = z.enum(RESULT_PRESENTATION_KEYS);
const artworkModeSchema = z.enum(ARTWORK_MODES);

const variantSchema = z.object({
  id: z.number().int(),
  presentationKey: keySchema,
  enabled: z.boolean(),
  weight: z.number().int(),
  flavorText: z.string().nullable(),
  artworkMode: artworkModeSchema,
  artworkPath: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const groupSchema = z.object({
  key: keySchema,
  label: z.string(),
  variantCount: z.number().int(),
  enabledCount: z.number().int(),
  /** True when no variant is enabled and players see the built-in screen. */
  usingFallback: z.boolean(),
  variants: z.array(variantSchema),
});

const referenceSchema = z.object({
  keys: z.array(
    z.object({
      key: keySchema,
      label: z.string(),
      allowedArtworkModes: z.array(artworkModeSchema),
      defaultArtworkMode: artworkModeSchema,
      fallbackDescription: z.string(),
      emptyFlavorDescription: z.string(),
    }),
  ),
  flavorTextMaxLength: z.number().int(),
  maxWeight: z.number().int(),
  supportedArtworkExtensions: z.array(z.string()),
  previewSpecies: z.array(z.object({ slug: z.string(), name: z.string(), rarity: z.string() })),
  defaultPreviewSpeciesSlug: z.string().nullable(),
  sampleNotice: z.string(),
});

/**
 * Field envelopes. Values are `unknown` on purpose: the domain validator is
 * the single authority on what they may be, and answers per field.
 */
const createBody = z
  .object({
    presentationKey: z.unknown(),
    enabled: z.unknown().optional(),
    weight: z.unknown().optional(),
    flavorText: z.unknown().optional(),
    artworkMode: z.unknown().optional(),
    artworkPath: z.unknown().optional(),
  })
  .strict();

/**
 * An edit. `presentationKey` is accepted into the envelope only so the domain
 * can refuse it with a clear message — a variant never changes result type.
 */
const updateBody = z
  .object({
    presentationKey: z.unknown().optional(),
    enabled: z.unknown().optional(),
    weight: z.unknown().optional(),
    flavorText: z.unknown().optional(),
    artworkMode: z.unknown().optional(),
    artworkPath: z.unknown().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

const previewBody = z
  .object({
    variant: z
      .object({
        presentationKey: z.unknown(),
        flavorText: z.unknown().optional(),
        artworkMode: z.unknown().optional(),
        artworkPath: z.unknown().optional(),
      })
      .strict(),
    previewSpeciesSlug: z.string().max(100).nullable().optional(),
  })
  .strict();

const screenSectionSchema = z.object({
  kind: z.enum(['flavor', 'mechanical', 'level_up', 'buddy']),
  text: z.string(),
  sample: z.boolean(),
});

const previewSpeciesSchema = z.object({ slug: z.string(), name: z.string(), rarity: z.string() });

const previewSchema = z.object({
  key: keySchema,
  label: z.string(),
  screen: z.object({
    key: keySchema,
    title: z.string(),
    sections: z.array(screenSectionSchema),
    description: z.string(),
    color: z.number().int(),
    footer: z.string().nullable(),
  }),
  artwork: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({
      mode: z.literal('custom'),
      path: z.string(),
      status: z.enum(['available', 'missing', 'unsafe']),
    }),
    z.object({
      mode: z.literal('encountered'),
      species: previewSpeciesSchema.nullable(),
      available: z.boolean(),
    }),
  ]),
  artworkMode: artworkModeSchema,
  flavorSource: z.enum(['authored', 'fallback', 'none']),
  flavorNote: z.string().nullable(),
  sampleNotice: z.string(),
  previewSpecies: previewSpeciesSchema.nullable(),
});

const idParams = z.object({ id: z.coerce.number().int().positive() });

/* ─────────────────────── Helpers ─────────────────────── */

function toResource(v: ResultPresentationVariantRecord) {
  return {
    id: v.id,
    presentationKey: v.presentationKey,
    enabled: v.enabled,
    weight: v.weight,
    flavorText: v.flavorText,
    artworkMode: v.artworkMode,
    artworkPath: v.artworkPath,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

function variantNotFound(id: number): AppError {
  return new AppError(
    'NOT_FOUND',
    `Result presentation variant ${id} not found`,
    'That variant no longer exists. It may have been deleted by someone else.',
  );
}

/** Domain validation → 400 with per-field issues. */
async function validated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ResultPresentationValidationError) {
      throw new ApiFieldValidationError(err.fieldIssues);
    }
    throw err;
  }
}

/* ─────────────────────── Routes ─────────────────────── */

export const adminResultPresentationRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const presentations = ctx.services.resultPresentation;
    if (!presentations) return; // Feature not wired — no routes.
    const authorization = ctx.portalAuthorization;
    const assetsDir = ctx.assetsDir ?? './assets';

    const gate =
      (permission: Extract<PortalPermission, `presentations.${string}`>) =>
      async (req: FastifyRequest): Promise<void> => {
        if (!authorization) {
          throw new AppError(
            'PORTAL_PERMISSION_DENIED',
            'Portal authorization service is not configured',
            'Admin features are unavailable.',
          );
        }
        await requirePortalPermission(req, authorization, permission, {
          allowBearer: ctx.adminBearerAllowed === true,
        });
      };

    /** Enabled species, by name — the release preview's Waifumon picker. */
    const previewSpecies = (): PreviewSpecies[] =>
      ctx
        .getContent()
        .species.filter((sp) => sp.enabled !== false)
        .map((sp) => ({ slug: sp.slug, name: sp.name, rarity: sp.rarity }))
        .sort((a, b) => a.name.localeCompare(b.name));

    /**
     * The file the release screen would attach for this species: her default
     * appearance through the same resolver Discord uses, with the same legacy
     * fallback. Null when none resolves.
     */
    const speciesArtworkFile = (slug: string): ArtworkFile | null => {
      const { appearance } = ctx.services;
      const species = appearance.speciesContent(slug);
      if (!species || species.enabled === false) return null;
      const current = appearance.currentAppearance(species, null);
      return resolveAppearanceAssetOrLegacyPath({ assetsDir }, current.assetId, species.imagePath);
    };

    app.get(
      '/admin/result-presentations/reference',
      {
        preValidation: gate('presentations.read'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Canonical keys, artwork modes and limits for the presentation editor',
          response: { 200: dataSchema(referenceSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const species = previewSpecies();
        return ok(req, {
          keys: RESULT_PRESENTATION_KEYS.map((key) => {
            const def = RESULT_PRESENTATION_KEY_DEFINITIONS[key];
            return {
              key,
              label: def.label,
              allowedArtworkModes: [...def.artworkModes],
              defaultArtworkMode: def.defaultArtworkMode,
              fallbackDescription: def.fallbackDescription,
              emptyFlavorDescription: def.emptyFlavorDescription,
            };
          }),
          flavorTextMaxLength: RESULT_PRESENTATION_FLAVOR_MAX_LENGTH,
          maxWeight: RESULT_PRESENTATION_MAX_WEIGHT,
          supportedArtworkExtensions: [...SUPPORTED_ARTWORK_EXTENSIONS],
          previewSpecies: species,
          defaultPreviewSpeciesSlug: species[0]?.slug ?? null,
          sampleNotice: PREVIEW_SAMPLE_NOTICE,
        });
      },
    );

    app.get(
      '/admin/result-presentations',
      {
        preValidation: gate('presentations.read'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Every variant, grouped by result type (all six types, even when empty)',
          response: {
            200: dataSchema(z.object({ groups: z.array(groupSchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const all = await presentations.listVariants();
        return ok(req, {
          groups: RESULT_PRESENTATION_KEYS.map((key) => {
            const variants = all.filter((v) => v.presentationKey === key);
            const enabledCount = variants.filter((v) => v.enabled).length;
            return {
              key,
              label: RESULT_PRESENTATION_KEY_DEFINITIONS[key].label,
              variantCount: variants.length,
              enabledCount,
              usingFallback: enabledCount === 0,
              variants: variants.map(toResource),
            };
          }),
        });
      },
    );

    /** Authored custom artwork bytes for the editor preview. */
    app.get(
      '/admin/result-presentations/artwork',
      {
        preValidation: gate('presentations.read'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Stream custom presentation artwork for the editor preview',
          querystring: adminArtworkQuery,
          response: { ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req, reply) => sendAdminArtwork(reply, assetsDir, req.query.path),
    );

    /**
     * A Waifumon's canonical artwork, for the release preview's
     * "Encountered Waifumon" mode. Addressed by species slug — never by path —
     * and limited to enabled species.
     */
    app.get(
      '/admin/result-presentations/preview/species-artwork',
      {
        preValidation: gate('presentations.read'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Stream a Waifumon’s release-screen artwork for the preview',
          querystring: z.object({ slug: slugParam }),
          response: { ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req, reply) => {
        const file = speciesArtworkFile(req.query.slug);
        if (!file) {
          throw new AppError('NOT_FOUND', 'Species artwork not found', 'No artwork for that Waifumon.');
        }
        const out = reply as unknown as {
          header(k: string, v: string): typeof out;
          send(payload: Buffer): unknown;
        };
        out
          .header('content-type', file.contentType)
          .header('cache-control', 'private, max-age=300, must-revalidate')
          .send(await readFile(file.absolutePath));
        return reply;
      },
    );

    /**
     * Preview the variant currently in the editor. Never persists, never
     * selects between variants, never touches gameplay; sample values are
     * fixed by the server and cannot be supplied.
     */
    app.post(
      '/admin/result-presentations/preview',
      {
        preValidation: gate('presentations.read'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Preview an unsaved variant with sample gameplay values',
          body: previewBody,
          response: { 200: dataSchema(previewSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const content = ctx.getContent();
        const preview = await validated(async () =>
          buildResultPresentationPreview(
            { variant: req.body.variant, previewSpeciesSlug: req.body.previewSpeciesSlug ?? null },
            {
              items: content.items,
              huntFlavorPool: content.tables.hunt.flavor,
              species: previewSpecies(),
              regionNames: content.regions.filter((r) => r.enabled).map((r) => r.name),
              locateArtwork: (path) => locateArtworkFile(assetsDir, path),
              speciesArtworkAvailable: (slug) => speciesArtworkFile(slug) !== null,
            },
          ),
        );
        return ok(req, preview);
      },
    );

    app.get(
      '/admin/result-presentations/:id',
      {
        preValidation: gate('presentations.read'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Get one variant',
          params: idParams,
          response: { 200: dataSchema(variantSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const variant = await presentations.getVariant(req.params.id);
        if (!variant) throw variantNotFound(req.params.id);
        return ok(req, toResource(variant));
      },
    );

    app.post(
      '/admin/result-presentations',
      {
        preValidation: gate('presentations.write'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Create a variant under a result type',
          body: createBody,
          response: { 200: dataSchema(variantSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const created = await validated(() => presentations.createVariant(req.body));
        return ok(req, toResource(created));
      },
    );

    app.patch(
      '/admin/result-presentations/:id',
      {
        preValidation: gate('presentations.write'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Edit a variant (including enable/disable). Never creates one.',
          params: idParams,
          body: updateBody,
          response: { 200: dataSchema(variantSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const updated = await validated(() =>
          presentations.updateVariant(req.params.id, req.body as Record<string, unknown>),
        );
        if (!updated) throw variantNotFound(req.params.id);
        return ok(req, toResource(updated));
      },
    );

    app.delete(
      '/admin/result-presentations/:id',
      {
        preValidation: gate('presentations.write'),
        schema: {
          tags: ['Admin — Result Presentations'],
          summary: 'Delete a variant',
          params: idParams,
          response: {
            200: dataSchema(z.object({ id: z.number().int(), deleted: z.literal(true) })),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const deleted = await presentations.deleteVariant(req.params.id);
        if (!deleted) throw variantNotFound(req.params.id);
        return ok(req, { id: req.params.id, deleted: true as const });
      },
    );
  };
