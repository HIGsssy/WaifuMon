/**
 * Portal admin — Complete Dungeon Bundles (Content Portability CP-4B): export
 * one dungeon **with its artwork and transferable dependencies** as a ZIP, and
 * preview / apply one here. The Dungeon JSON routes in `dungeons.ts` are
 * unchanged and remain the definition-only format.
 *
 *   - `POST /admin/dungeons/definitions/:key/export/bundle` — `dungeons.read` +
 *     `enemies.read` + `artwork.read`. Body `{}` (the draft), `{ origin:
 *     "published" }` or `{ revision: n }`; answers the ZIP.
 *   - `POST /admin/dungeons/import/bundle/preview` — `dungeons.write`. Body: the
 *     ZIP; optional query `decisions` to review a set of choices. Writes nothing.
 *   - `POST /admin/dungeons/import/bundle/apply` — `dungeons.write` +
 *     `enemies.write` + `artwork.write` (it may create enemies and managed
 *     artwork). Body: the same ZIP; query `expectedPlanHash`, `requestId` (a
 *     UUID the caller keeps for retries) and `decisions`.
 *
 * `decisions` is base64url-encoded JSON (`DungeonBundleDecisionsSchema`), so
 * the ZIP stays the whole body and the line stays well inside proxy limits.
 * The import routes take a binary body up to `DUNGEON_BUNDLE_LIMITS.maxArchiveBytes`
 * (route-scoped; every other route keeps its own limit) and check permission
 * at `onRequest`, before the body is read. The Portal's Nginx allows slightly
 * more on `/api/v1/admin/dungeons/import/bundle/`, so this limit's JSON 413 is
 * what callers meet. CSRF for session callers is enforced upstream.
 */
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiErrorWithDetails, ApiFieldValidationError } from '../../../errors';
import {
  AppError,
  DungeonBundleDecisionsRequiredError,
  DungeonBundleExportRefusedError,
  DungeonBundleInvalidError,
  DungeonBundleRejectedError,
  DungeonBundleRequestConflictError,
} from '../../../../shared/errors';
import { DUNGEON_BUNDLE_LIMITS } from '../../../../modules/dungeons/bundle/dungeonBundle';
import type { DungeonBundleDecisions, DungeonBundleService } from '../../../../modules/dungeons/bundle/dungeonBundleService';
import { DungeonImportPlanSchema } from '../../../../modules/dungeons/package/dungeonImportService';
import type { PortalPermission } from '../../../../modules/portalAuth/portalAuthService';

/** The import routes' request-body ceiling: the largest bundle an export may produce. */
export const DUNGEON_BUNDLE_BODY_LIMIT_BYTES = DUNGEON_BUNDLE_LIMITS.maxArchiveBytes;
/** Encoded decisions; a review with this many choices is far beyond any authored dungeon. */
export const DUNGEON_BUNDLE_DECISIONS_MAX_CHARS = 6000;

const ZIP_CONTENT_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const issueSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string() });
const pathIssue = z.object({ path: z.string(), message: z.string() });
const reference = z.object({ dungeonKey: z.string(), name: z.string(), source: z.string() });
const slotPlan = z.object({
  source: z.enum(['none', 'managed', 'shipped']),
  destination: z.object({ kind: z.string() }).passthrough(),
  notes: z.array(z.string()),
});
const disabledSchema = z.object({ kind: z.enum(['enemy', 'shared_pool']), key: z.string(), name: z.string(), requiredForPublication: z.boolean() });
const readinessSchema = z.enum(['ready', 'needs_enabling', 'incomplete', 'blocked']);
const previewSchema = z.object({
  bundle: z.object({
    format: z.string(),
    version: z.number().int(),
    exportedAt: z.string(),
    sourceEnvironment: z.string(),
    origin: z.enum(['draft', 'revision']),
    draftRevision: z.number().int().nullable(),
    publishedRevision: z.number().int().nullable(),
    packageSchemaVersion: z.number().int(),
    sceneSpriteEvidence: z.enum(['catalogue', 'revision_snapshot']).nullable(),
    bundleHash: z.string(),
    warnings: z.array(pathIssue),
  }),
  dungeon: z.object({ key: z.string(), name: z.string(), decision: z.enum(['create', 'replace', 'unchanged']), plan: DungeonImportPlanSchema }),
  artwork: z.object({
    dungeon: z.array(
      z.object({
        usage: z.array(z.string()),
        source: z.enum(['managed', 'shipped']),
        path: z.string().nullable(),
        asset: z.string(),
        destination: z.enum(['shipped_file', 'reuse', 'create']),
        rebound: z.boolean(),
      }),
    ),
    assets: z.array(
      z.object({
        id: z.string(),
        file: z.string(),
        category: z.string(),
        sha256: z.string(),
        bytes: z.number().int(),
        mimeType: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        name: z.string(),
        action: z.enum(['reuse', 'create', 'not_needed']),
        reuse: z.array(z.string()),
        usedBy: z.array(z.string()),
      }),
    ),
  }),
  sceneSprites: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      outcome: z.enum(['create', 'identical', 'conflict']),
      changedFields: z.array(z.string()),
      archivedHere: z.boolean(),
      references: z.array(reference),
      suggestedCopyKey: z.string(),
      decision: z.enum(['update', 'keep', 'copy']).nullable(),
      resultKey: z.string(),
      asset: z.string(),
      assetDestination: z.enum(['reuse', 'create', 'not_needed']),
    }),
  ),
  sharedPools: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      outcome: z.enum(['create', 'identical', 'conflict']),
      changedFields: z.array(z.string()),
      enabledHere: z.boolean().nullable(),
      enabledAfterImport: z.boolean(),
      currentRevision: z.number().int().nullable(),
      otherDungeons: z.array(reference),
      decision: z.enum(['update', 'keep']).nullable(),
      uses: z.enum(['bundled', 'destination']),
      species: z.array(z.object({ slug: z.string(), status: z.enum(['available', 'missing', 'disabled']) })),
    }),
  ),
  enemies: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      outcome: z.enum(['create', 'update', 'conflict', 'unchanged', 'invalid']),
      changedFields: z.array(z.string()),
      activation: z.object({ packageEnabled: z.boolean(), enabled: z.boolean(), reason: z.string() }).nullable(),
      references: z.array(z.object({ kind: z.string(), key: z.string(), name: z.string().nullable(), usage: z.string() })),
      issues: z.array(pathIssue),
      artwork: slotPlan,
      sprite: slotPlan,
      decision: z.enum(['update', 'keep']).nullable(),
    }),
  ),
  prerequisites: z.array(
    z.object({
      kind: z.enum(['species', 'item', 'equipment', 'currency', 'region', 'reward_table']),
      key: z.string(),
      name: z.string(),
      status: z.enum(['available', 'missing', 'disabled']),
      notes: z.array(z.string()),
    }),
  ),
  remainsDisabled: z.array(disabledSchema),
  issues: z.array(issueSchema),
  decisionsRequired: z.array(z.string()),
  readiness: readinessSchema,
  planHash: z.string(),
});
const resultSchema = z.object({
  importId: z.number().int(),
  requestId: z.string(),
  replayed: z.boolean(),
  dungeonKey: z.string(),
  dungeonResult: z.enum(['created', 'replaced', 'unchanged']),
  draftRevision: z.number().int(),
  dungeonImportId: z.number().int(),
  enabled: z.boolean(),
  publishedRevision: z.number().int().nullable(),
  readiness: readinessSchema,
  enemies: z.object({ created: z.array(z.string()), updated: z.array(z.string()), skipped: z.array(z.string()), unchanged: z.array(z.string()) }),
  sceneSprites: z.object({
    created: z.array(z.string()),
    updated: z.array(z.string()),
    copied: z.array(z.object({ from: z.string(), to: z.string() })),
    reused: z.array(z.string()),
    kept: z.array(z.string()),
  }),
  sharedPools: z.object({ created: z.array(z.string()), updated: z.array(z.string()), reused: z.array(z.string()), kept: z.array(z.string()) }),
  assets: z.object({ created: z.number().int(), reused: z.number().int() }),
  createdLootTables: z.array(z.string()),
  remainsDisabled: z.array(disabledSchema),
  issues: z.array(issueSchema),
});

/** base64url JSON → decisions, refusing anything else with a field error. */
function decodeDecisions(encoded: string | undefined): Partial<DungeonBundleDecisions> {
  if (!encoded) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Partial<DungeonBundleDecisions>;
  } catch {
    throw new ApiFieldValidationError([{ path: 'decisions', message: 'must be base64url-encoded JSON decisions' }]);
  }
}

/** Service errors that carry structure the Portal needs, re-raised with it as `details`. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof DungeonBundleInvalidError || err instanceof DungeonBundleRejectedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
    }
    if (err instanceof DungeonBundleExportRefusedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { reason: err.reason, issues: err.issues });
    }
    if (err instanceof DungeonBundleDecisionsRequiredError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { keys: err.keys });
    }
    if (err instanceof DungeonBundleRequestConflictError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { inProgress: err.inProgress });
    }
    throw err;
  }
}

export const adminDungeonBundleRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.dungeonBundles;
    const authorization = ctx.portalAuthorization;
    if (!service) return;
    const bundles: DungeonBundleService = service;

    // The import body is the ZIP itself. Scoped to this plugin.
    app.addContentTypeParser(ZIP_CONTENT_TYPES, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    const gate =
      (...permissions: PortalPermission[]) =>
      async (req: FastifyRequest): Promise<void> => {
        if (!authorization) {
          throw new AppError('PORTAL_PERMISSION_DENIED', 'Portal authorization service is not configured', 'Admin features are unavailable.');
        }
        for (const permission of permissions) {
          await requirePortalPermission(req, authorization, permission, { allowBearer: ctx.adminBearerAllowed === true });
        }
      };
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const archiveOf = (req: FastifyRequest): Buffer => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new AppError('VALIDATION_ERROR', 'Bundle body missing', 'Send the dungeon bundle (.zip) as the request body, with Content-Type application/zip.');
      }
      return req.body;
    };
    const tags = ['Admin — Dungeons'];
    const decisionsQuery = z.string().max(DUNGEON_BUNDLE_DECISIONS_MAX_CHARS).regex(/^[A-Za-z0-9_-]*$/, 'base64url').optional();
    const importErrors = {
      409: errorSchema.describe(
        'DUNGEON_BUNDLE_STALE — something the review relied on changed. DUNGEON_BUNDLE_DECISIONS_REQUIRED — a conflict ' +
          'has no decision (details.keys). DUNGEON_BUNDLE_REQUEST_CONFLICT — that requestId is running or belongs to a different request.',
      ),
      413: errorSchema.describe('PAYLOAD_TOO_LARGE — the bundle is over the route limit (details.maxBytes).'),
    };

    app.post(
      '/admin/dungeons/definitions/:key/export/bundle',
      {
        preValidation: gate('dungeons.read', 'enemies.read', 'artwork.read'),
        schema: {
          tags,
          summary:
            'A Complete Dungeon Bundle (.zip): the Dungeon JSON package plus the artwork bytes, enemies, Scene Sprites ' +
            'and shared WaifuMon pools it needs. `{}` exports the draft, `{origin:"published"}` the live revision, ' +
            '`{revision:n}` a numbered one (with that revision’s frozen sprite visuals). Content that cannot travel is ' +
            '422 DUNGEON_BUNDLE_EXPORT_REFUSED (details.reason, details.issues)',
          params: z.object({ key: z.string().min(1).max(100) }),
          body: z
            .object({ origin: z.enum(['draft', 'published']).optional(), revision: z.number().int().positive().optional() })
            .strict()
            .default({}),
          response: { ...notFoundResponse, 422: errorSchema.describe('DUNGEON_BUNDLE_EXPORT_REFUSED'), ...commonErrorResponses },
        },
      },
      async (req, reply) => {
        const { origin, revision } = req.body;
        if (origin !== undefined && revision !== undefined) {
          throw new ApiFieldValidationError([{ path: 'revision', message: 'send `origin` or `revision`, not both' }]);
        }
        const exported = await translate(() => bundles.exportBundle(req.params.key, revision !== undefined ? { revision } : (origin ?? 'draft')));
        // A binary body, outside the JSON response schemas — as the enemy package export sends its bytes.
        (reply as FastifyReply)
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${exported.filename}"`)
          .header('Cache-Control', 'no-store')
          .header('X-Dungeon-Bundle-Assets', String(exported.counts.assets))
          .header('X-Dungeon-Bundle-Enemies', String(exported.counts.enemies))
          .header('X-Dungeon-Bundle-Scene-Sprites', String(exported.counts.sceneSprites))
          .header('X-Dungeon-Bundle-Shared-Pools', String(exported.counts.sharedPools))
          .header('X-Dungeon-Bundle-Warnings', String(exported.warnings.length))
          .send(exported.archive);
        return reply;
      },
    );

    app.post(
      '/admin/dungeons/import/bundle/preview',
      {
        onRequest: gate('dungeons.write'),
        bodyLimit: DUNGEON_BUNDLE_BODY_LIMIT_BYTES,
        schema: {
          tags,
          summary:
            'Validate a Complete Dungeon Bundle (.zip body) and review it against this server without writing: the ' +
            'draft change, enemies, Scene Sprites, shared pools, artwork reuse/create, external prerequisites, what stays ' +
            'disabled, and the `planHash` apply needs. Optional `decisions` reviews a set of choices. 400 ' +
            'DUNGEON_BUNDLE_INVALID (details.issues) for an unsafe or malformed bundle',
          querystring: z.object({ decisions: decisionsQuery }),
          response: { 200: dataSchema(previewSchema), ...importErrors, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await translate(() => bundles.preview(archiveOf(req), decodeDecisions(req.query.decisions)))),
    );

    app.post(
      '/admin/dungeons/import/bundle/apply',
      {
        onRequest: gate('dungeons.write', 'enemies.write', 'artwork.write'),
        bodyLimit: DUNGEON_BUNDLE_BODY_LIMIT_BYTES,
        schema: {
          tags,
          summary:
            'Apply a reviewed Complete Dungeon Bundle (.zip body) atomically to the dungeon draft only: new dungeons, ' +
            'enemies and shared pools arrive disabled; an existing dungeon keeps its enabled state and published revision. ' +
            'A repeated `requestId` replays its result',
          querystring: z.object({
            expectedPlanHash: z.string().min(1).max(100),
            requestId: z.string().uuid(),
            decisions: decisionsQuery,
          }),
          response: { 200: dataSchema(resultSchema), ...importErrors, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(
          req,
          await translate(() =>
            bundles.apply(
              archiveOf(req),
              {
                expectedPlanHash: req.query.expectedPlanHash,
                requestId: req.query.requestId,
                decisions: decodeDecisions(req.query.decisions) as DungeonBundleDecisions,
              },
              actorOf(req),
            ),
          ),
        ),
    );
  };
