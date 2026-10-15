/**
 * Portal admin — Region Pools: which Waifumon each region's hunt can meet.
 *
 *   - `regions.read`    — list, read a pool, the species picker, the shipped
 *     pool, validate (dry run), history, a revision, rollback preview, audit
 *     events, drift and probability analysis. None of these writes.
 *   - `regions.write`   — save, discard, load the shipped pool into the draft,
 *     merge newly shipped species into it. A draft never reaches hunts.
 *   - `regions.publish` — publish the draft and roll back to an earlier
 *     revision: what the next hunt draws from.
 *
 * Every write names `expectedDraftRevision` (`409 REGION_POOL_STALE`).
 * Publish and rollback also name the `reviewHash` from `validate` /
 * `rollback-preview` (`409 REGION_POOL_REVIEW_STALE` when anything reviewed
 * changed) and acknowledge its warnings by id
 * (`422 REGION_POOL_ACKNOWLEDGEMENT_REQUIRED`). Refusals carry the issues in
 * `details.issues`, each keyed by species or rarity, so the editor can show
 * them in place. Species are addressed by slug; no database id is exposed.
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiErrorWithDetails } from '../../../errors';
import {
  AppError,
  RegionPoolAcknowledgementRequiredError,
  RegionPoolInvalidError,
  RegionPoolPublishBlockedError,
  RegionPoolReviewStaleError,
  RegionPoolStaleError,
} from '../../../../shared/errors';
import { DISTRIBUTION_MODES } from '../../../../modules/regionPools/regionPoolDistribution';
import { REGION_POOL_ISSUE_CODES } from '../../../../modules/regionPools/regionPoolValidation';
import { RandomSpeciesSelectionSchema } from '../../../../modules/encounters/speciesSelection';
import type { RegionPoolService } from '../../../../modules/regionPools/regionPoolService';

type Permission = 'regions.read' | 'regions.write' | 'regions.publish';

const regionParam = z.object({ regionId: z.string().min(1).max(64) });
const revisionParam = regionParam.extend({ revision: z.coerce.number().int().positive() });
const draftRevision = z.number().int().positive();

const issueSchema = z.object({
  id: z.string(),
  code: z.enum(REGION_POOL_ISSUE_CODES),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  acknowledgementRequired: z.boolean(),
  species: z.string().optional(),
  rarity: z.string().optional(),
  index: z.number().int().optional(),
  regions: z.array(z.string()).optional(),
});

const entrySchema = z.object({ species: z.string(), weight: z.number() });
const diffSchema = z.object({
  added: z.array(entrySchema),
  removed: z.array(entrySchema),
  reweighted: z.array(z.object({ species: z.string(), from: z.number(), to: z.number() })),
});

const entryViewSchema = z.object({
  species: z.string(),
  weight: z.number(),
  name: z.string().nullable(),
  rarity: z.string().nullable(),
  enabled: z.boolean(),
  inContent: z.boolean(),
  regionExclusive: z.boolean(),
  dungeonExclusive: z.boolean(),
  race: z.string().nullable(),
  affinity: z.string().nullable(),
  imagePath: z.string().nullable(),
});

const regionSchema = z.object({ id: z.string(), name: z.string(), released: z.boolean(), isDefault: z.boolean() });
const publishedMetaSchema = z.object({
  number: z.number().int(),
  source: z.enum(['bootstrap', 'editor', 'rollback', 'import']),
  rolledBackFrom: z.number().int().nullable(),
  publishedAt: z.string(),
  publishedBy: z.string().nullable(),
  contentHash: z.string(),
  entryCount: z.number().int(),
});

const poolViewSchema = z.object({
  region: regionSchema,
  draft: z.object({
    revision: z.number().int(),
    hash: z.string(),
    entries: z.array(entryViewSchema),
    updatedAt: z.string(),
    updatedBy: z.string().nullable(),
    unpublishedChanges: z.boolean(),
  }),
  published: publishedMetaSchema.extend({ entries: z.array(entryViewSchema) }).nullable(),
  issues: z.array(issueSchema),
});

const listItemSchema = z.object({
  region: regionSchema,
  hasPool: z.boolean(),
  draftRevision: z.number().int().nullable(),
  unpublishedChanges: z.boolean(),
  published: publishedMetaSchema.nullable(),
  rarityCounts: z.record(z.string(), z.number().int()),
  driftStatus: z.enum(['clean', 'drift', 'none']),
});

const reviewSchema = z.object({
  purpose: z.string(),
  draftRevision: z.number().int(),
  issues: z.array(issueSchema),
  requiredAcknowledgements: z.array(z.string()),
  reviewHash: z.string(),
  canPublish: z.boolean(),
  diffFromPublished: diffSchema,
});

const shippedSchema = z.object({
  available: z.boolean(),
  hash: z.string().nullable(),
  entries: z.array(entrySchema),
  skipped: z.array(z.string()),
  diffFromDraft: diffSchema,
  diffFromPublished: diffSchema,
  mergeCandidates: z.array(entrySchema),
  weightConflicts: z.array(z.object({ species: z.string(), draft: z.number(), shipped: z.number() })),
});

const driftSchema = z.object({
  status: z.enum(['clean', 'drift', 'none']),
  publishedRevision: z.number().int().nullable(),
  species: z.array(
    z.object({
      species: z.string(),
      kind: z.enum(['disabled', 'enabled', 'missing_from_content', 'rarity_changed', 'tags_changed']),
      from: z.string().optional(),
      to: z.string().optional(),
      addedTags: z.array(z.string()).optional(),
      removedTags: z.array(z.string()).optional(),
    }),
  ),
  exclusiveConflicts: z.array(z.object({ species: z.string(), regions: z.array(z.string()) })),
  emptyTiers: z.array(z.object({ rarity: z.string(), causedByContent: z.boolean() })),
  shipped: z.object({ available: z.boolean(), differs: z.boolean(), diff: diffSchema.nullable() }),
});

const historyItemSchema = publishedMetaSchema.extend({ current: z.boolean() });
const revisionDetailSchema = historyItemSchema.extend({
  entries: z.array(entryViewSchema),
  speciesManifest: z.array(
    z.object({ species: z.string(), rarity: z.string(), enabled: z.boolean(), tags: z.array(z.string()) }),
  ),
});

const eventSchema = z.object({
  cursor: z.string(),
  action: z.string(),
  actor: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const speciesItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  rarity: z.string(),
  enabled: z.boolean(),
  inContent: z.boolean(),
  huntable: z.boolean(),
  regionExclusive: z.boolean(),
  dungeonExclusive: z.boolean(),
  race: z.string(),
  affinity: z.string(),
  imagePath: z.string(),
  publishedIn: z.array(z.string()),
});

const tierSchema = z.enum(['region', 'default_region', 'global', 'dead', 'filtered']);
const distributionSchema = z.object({
  mode: z.enum(DISTRIBUTION_MODES),
  level: z.number().int(),
  encounterShare: z.number().nullable(),
  rarities: z.array(
    z.object({
      rarity: z.string(),
      baseWeight: z.number(),
      effectiveWeight: z.number(),
      rollProbability: z.number(),
      probability: z.number(),
      tier: tierSchema,
      candidates: z.number().int(),
      unsafe: z.boolean(),
    }),
  ),
  species: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      rarity: z.string(),
      tier: tierSchema,
      inPool: z.boolean(),
      weight: z.number(),
      effectiveWeight: z.number(),
      shareOfRarity: z.number(),
      perEncounter: z.number(),
      perHunt: z.number().nullable(),
    }),
  ),
  excluded: z.array(z.object({ slug: z.string(), reason: z.string() })),
  exhausted: z.object({ probability: z.number(), fallback: z.string() }).nullable(),
  errorProbability: z.number(),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['error', 'warning', 'info']),
      message: z.string(),
      rarity: z.string().optional(),
    }),
  ),
});

const analysisSchema = z.object({
  source: z.enum(['draft', 'published']),
  assumptions: z.array(z.string()),
  result: distributionSchema,
  comparison: z
    .object({
      against: z.enum(['draft', 'published']),
      result: distributionSchema,
      diff: z.object({
        species: z.array(z.object({ slug: z.string(), before: z.number(), after: z.number(), delta: z.number() })),
        rarities: z.array(
          z.object({ rarity: z.string(), tierBefore: tierSchema.nullable(), tierAfter: tierSchema.nullable() }),
        ),
      }),
    })
    .nullable(),
});

const analysisBody = z
  .object({
    source: z.enum(['draft', 'published']).default('published'),
    mode: z.enum(DISTRIBUTION_MODES).default('hunt'),
    level: z.number().int().min(1).max(1000).default(1),
    buddySpecies: z.string().min(1).max(64).nullable().optional(),
    ownedSpecies: z.array(z.string().min(1).max(64)).max(2000).optional(),
    filter: RandomSpeciesSelectionSchema.omit({ mode: true }).optional(),
    compare: z.boolean().default(false),
  })
  .strict();

const reviewBody = {
  expectedDraftRevision: draftRevision,
  reviewHash: z.string().min(1).max(200),
  acknowledgedWarnings: z.array(z.string().max(200)).max(1000).default([]),
};

/** Service refusals, re-raised with the structure the editor needs. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof RegionPoolInvalidError || err instanceof RegionPoolPublishBlockedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
    }
    if (err instanceof RegionPoolReviewStaleError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        issues: err.issues,
        reviewHash: err.reviewHash,
      });
    }
    if (err instanceof RegionPoolAcknowledgementRequiredError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        missing: err.missing,
        issues: err.issues,
      });
    }
    if (err instanceof RegionPoolStaleError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        expectedDraftRevision: err.expectedDraftRevision,
        currentDraftRevision: err.currentDraftRevision,
        updatedBy: err.updatedBy,
        updatedAt: err.updatedAt.toISOString(),
      });
    }
    throw err;
  }
}

const writeResponses = {
  409: errorSchema.describe(
    'REGION_POOL_STALE — the draft moved on (details: expectedDraftRevision, currentDraftRevision). ' +
      'REGION_POOL_REVIEW_STALE — something reviewed changed; validate again (details: issues, reviewHash).',
  ),
  422: errorSchema.describe(
    'REGION_POOL_PUBLISH_BLOCKED (details.issues) · REGION_POOL_ACKNOWLEDGEMENT_REQUIRED (details.missing) · ' +
      'REGION_POOL_SHIPPED_UNAVAILABLE.',
  ),
};

export const adminRegionPoolRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.regionPools;
    const authorization = ctx.portalAuthorization;
    if (!service) return;
    const pools: RegionPoolService = service;

    const gate =
      (permission: Permission) =>
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
    /** The actor comes from the authenticated session, never the body. */
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const tags = ['Admin — Region Pools'];
    const read = { preValidation: gate('regions.read') };
    const write = { preValidation: gate('regions.write') };
    const publish = { preValidation: gate('regions.publish') };

    app.get(
      '/admin/region-pools',
      {
        ...read,
        schema: {
          tags,
          summary: 'Every region: release state, published revision, unpublished draft changes, per-rarity counts, drift',
          response: { 200: dataSchema(z.object({ regions: z.array(listItemSchema) })), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, { regions: await pools.list() }),
    );

    app.get(
      '/admin/region-pools/species',
      {
        ...read,
        schema: {
          tags,
          summary: 'Species picker: every species with rarity, flags, artwork path and the regions whose published pool lists her',
          response: { 200: dataSchema(z.object({ species: z.array(speciesItemSchema) })), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, { species: await pools.speciesCatalogue() }),
    );

    app.get(
      '/admin/region-pools/:regionId',
      {
        ...read,
        schema: {
          tags,
          summary: 'One region: its draft (with draft-level issues) and its published revision',
          params: regionParam,
          response: { 200: dataSchema(poolViewSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await pools.get(req.params.regionId)),
    );

    app.put(
      '/admin/region-pools/:regionId/draft',
      {
        ...write,
        schema: {
          tags,
          summary: 'Save the draft (never live). Refused with details.issues when a species is unknown, duplicated, dungeon-exclusive or badly weighted',
          params: regionParam,
          body: z.object({ entries: z.array(z.unknown()).max(5000), expectedDraftRevision: draftRevision }),
          response: { 200: dataSchema(poolViewSchema), ...notFoundResponse, ...writeResponses, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, await translate(() => pools.saveDraft(req.params.regionId, req.body, actorOf(req)))),
    );

    app.post(
      '/admin/region-pools/:regionId/draft/discard',
      {
        ...write,
        schema: {
          tags,
          summary: 'Reset the draft to the published pool',
          params: regionParam,
          body: z.object({ expectedDraftRevision: draftRevision }),
          response: { 200: dataSchema(poolViewSchema), ...notFoundResponse, ...writeResponses, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, await translate(() => pools.discardDraft(req.params.regionId, req.body, actorOf(req)))),
    );

    app.get(
      '/admin/region-pools/:regionId/shipped',
      {
        ...read,
        schema: {
          tags,
          summary: "The region file's pool as the bootstrap resolves it, and how it differs from the draft and the published pool",
          params: regionParam,
          response: { 200: dataSchema(shippedSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await pools.shipped(req.params.regionId)),
    );

    app.post(
      '/admin/region-pools/:regionId/draft/load-shipped',
      {
        ...write,
        schema: {
          tags,
          summary: "Replace the draft with the region file's pool. Not published; hunts are unaffected until a publish",
          params: regionParam,
          body: z.object({ expectedDraftRevision: draftRevision }),
          response: { 200: dataSchema(poolViewSchema), ...notFoundResponse, ...writeResponses, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, await translate(() => pools.loadShippedIntoDraft(req.params.regionId, req.body, actorOf(req)))),
    );

    app.post(
      '/admin/region-pools/:regionId/draft/merge-shipped',
      {
        ...write,
        schema: {
          tags,
          summary:
            'Append shipped species the draft does not list (all, or the named ones) at their shipped weights. ' +
            'Keeps every existing member and weight; removes nothing',
          params: regionParam,
          body: z.object({ expectedDraftRevision: draftRevision, species: z.array(z.string().max(64)).max(500).optional() }),
          response: { 200: dataSchema(poolViewSchema), ...notFoundResponse, ...writeResponses, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, await translate(() => pools.mergeShippedIntoDraft(req.params.regionId, req.body, actorOf(req)))),
    );

    app.post(
      '/admin/region-pools/:regionId/validate',
      {
        ...read,
        schema: {
          tags,
          summary:
            'Dry run. With `entries`: draft-level issues for an unsaved list. Without: the publish review of the saved ' +
            'draft — issues, the warnings to acknowledge and the reviewHash a publish must name',
          params: regionParam,
          body: z.object({ entries: z.array(z.unknown()).max(5000).optional() }),
          response: {
            200: dataSchema(z.union([reviewSchema, z.object({ issues: z.array(issueSchema) })])),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) =>
        ok(
          req,
          await pools.validate(req.params.regionId, req.body.entries === undefined ? {} : { entries: req.body.entries }),
        ),
    );

    app.post(
      '/admin/region-pools/:regionId/publish',
      {
        ...publish,
        schema: {
          tags,
          summary:
            'Publish the draft as a new immutable revision and re-project the region for hunting, atomically. ' +
            'Names the draft revision and reviewHash it reviewed, and acknowledges every required warning by id',
          params: regionParam,
          body: z.object(reviewBody),
          response: { 200: dataSchema(poolViewSchema), ...notFoundResponse, ...writeResponses, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await translate(() => pools.publish(req.params.regionId, req.body, actorOf(req)))),
    );

    app.get(
      '/admin/region-pools/:regionId/revisions',
      {
        ...read,
        schema: {
          tags,
          summary: 'Published revisions, newest first',
          params: regionParam,
          response: {
            200: dataSchema(z.object({ revisions: z.array(historyItemSchema) })),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { revisions: await pools.history(req.params.regionId) }),
    );

    app.get(
      '/admin/region-pools/:regionId/revisions/:revision',
      {
        ...read,
        schema: {
          tags,
          summary: 'One revision: its entries and the species evidence stored when it was published',
          params: revisionParam,
          response: { 200: dataSchema(revisionDetailSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await pools.revision(req.params.regionId, req.params.revision)),
    );

    app.get(
      '/admin/region-pools/:regionId/revisions/:revision/rollback-preview',
      {
        ...read,
        schema: {
          tags,
          summary: "Review a rollback: that revision's entries against today's species and other regions",
          params: revisionParam,
          response: { 200: dataSchema(reviewSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await pools.rollbackPreview(req.params.regionId, req.params.revision)),
    );

    app.post(
      '/admin/region-pools/:regionId/rollback',
      {
        ...publish,
        schema: {
          tags,
          summary:
            "Publish an earlier revision's entries as a new revision (history is never changed). The draft becomes " +
            'the restored pool. Revalidated against today; refused with details.issues when no longer valid',
          params: regionParam,
          body: z.object({ revision: z.number().int().positive(), ...reviewBody }),
          response: { 200: dataSchema(poolViewSchema), ...notFoundResponse, ...writeResponses, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await translate(() => pools.rollback(req.params.regionId, req.body, actorOf(req)))),
    );

    app.get(
      '/admin/region-pools/:regionId/events',
      {
        ...read,
        schema: {
          tags,
          summary: 'Audit trail, newest first. Page with `before` = the last cursor seen',
          params: regionParam,
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(200).default(50),
            before: z.string().regex(/^\d+$/).optional(),
          }),
          response: { 200: dataSchema(z.object({ events: z.array(eventSchema) })), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, {
          events: await pools.events(req.params.regionId, { limit: req.query.limit, before: req.query.before }),
        }),
    );

    app.get(
      '/admin/region-pools/:regionId/drift',
      {
        ...read,
        schema: {
          tags,
          summary: 'Published pool vs today: species state, exclusive conflicts, emptied tiers and the shipped file',
          params: regionParam,
          response: { 200: dataSchema(driftSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await pools.drift(req.params.regionId)),
    );

    app.post(
      '/admin/region-pools/:regionId/analysis',
      {
        ...read,
        schema: {
          tags,
          summary:
            'Exact encounter odds of the draft or published pool for normal hunting, scripted spawns or a filtered ' +
            'World Encounter selector, under a stated level / Buddy / ownership scenario. Writes nothing',
          params: regionParam,
          body: analysisBody,
          response: { 200: dataSchema(analysisSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const { buddySpecies, ownedSpecies, filter, ...rest } = req.body;
        return ok(
          req,
          await pools.analyse(req.params.regionId, {
            ...rest,
            ...(buddySpecies !== undefined ? { buddySpecies } : {}),
            ...(ownedSpecies !== undefined ? { ownedSpecies } : {}),
            ...(filter !== undefined ? { filter } : {}),
          }),
        );
      },
    );
  };
