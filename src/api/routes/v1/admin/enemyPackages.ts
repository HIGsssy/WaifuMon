/**
 * Portal admin — Enemy Catalogue packages (Content Portability CP-3): export
 * enemies **with their artwork** as a ZIP, and preview / apply one here.
 *
 *   - `POST /admin/enemies/export/package` — `enemies.read` + `artwork.read`.
 *     Body `{ scope: "all" }` or `{ scope: "selected", keys }`; answers the
 *     ZIP (`application/zip`). A POST so a large selection never rides in a URL.
 *   - `POST /admin/enemies/import/preview` — `enemies.write`. Body: the ZIP.
 *     Writes nothing.
 *   - `POST /admin/enemies/import/apply` — `enemies.write` + `artwork.write`
 *     (it may create managed artwork). Body: the same ZIP; query
 *     `expectedPlanHash`, `requestId` (a UUID the caller keeps for retries) and
 *     `decisions` — one `u` (update) or `s` (skip) per preview `decisionKeys`
 *     entry, in order. The plan hash pins that order.
 *
 * The import routes take a binary body up to `ENEMY_PACKAGE_LIMITS.maxArchiveBytes`
 * (route-scoped; every other route keeps 64 KB) and check permission at
 * `onRequest`, before the body is read. The Portal's Nginx allows slightly
 * more on `/api/v1/admin/enemies/import/`, so this limit's JSON 413 is what
 * callers meet. CSRF for session callers is enforced upstream for every POST.
 */
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiErrorWithDetails } from '../../../errors';
import {
  AppError,
  EnemyExportKeysNotFoundError,
  EnemyExportRefusedError,
  EnemyImportDecisionsRequiredError,
  EnemyImportRejectedError,
  EnemyImportRequestConflictError,
  EnemyPackageInvalidError,
} from '../../../../shared/errors';
import { COMBAT_ENEMY_KEY_MAX_LENGTH, COMBAT_ENEMY_KEY_PATTERN } from '../../../../modules/combat/enemyDefinitions';
import { ENEMY_PACKAGE_LIMITS } from '../../../../modules/enemies/enemyPackage';
import type { EnemyPackageService } from '../../../../modules/enemies/enemyPackageService';
import type { PortalPermission } from '../../../../modules/portalAuth/portalAuthService';

/** The import routes' request-body ceiling: the largest package an export may produce. */
export const ENEMY_PACKAGE_BODY_LIMIT_BYTES = ENEMY_PACKAGE_LIMITS.maxArchiveBytes;

const ZIP_CONTENT_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const keySchema = z.string().min(1).max(COMBAT_ENEMY_KEY_MAX_LENGTH).regex(COMBAT_ENEMY_KEY_PATTERN);
const issueSchema = z.object({ path: z.string(), message: z.string() });
const slotDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('shipped_file'), path: z.string() }),
  z.object({ kind: z.literal('reuse'), asset: z.string(), assetId: z.string() }),
  z.object({ kind: z.literal('create'), asset: z.string() }),
]);
const slotPlanSchema = z.object({
  source: z.enum(['none', 'managed', 'shipped']),
  destination: slotDestinationSchema,
  notes: z.array(z.string()),
});
const warningSchema = z.object({ key: z.string(), slot: z.enum(['artwork', 'sprite']), message: z.string() });
const previewSchema = z.object({
  package: z.object({
    format: z.string(),
    version: z.number().int(),
    exportedAt: z.string(),
    scope: z.enum(['all', 'selected']),
    sourceEnvironment: z.string(),
    packageHash: z.string(),
    warnings: z.array(warningSchema),
  }),
  entries: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      outcome: z.enum(['create', 'update', 'conflict', 'unchanged', 'invalid']),
      changedFields: z.array(z.string()),
      activation: z
        .object({
          packageEnabled: z.boolean(),
          enabled: z.boolean(),
          reason: z.enum(['new_enemies_start_disabled', 'existing_status_kept']),
        })
        .nullable(),
      references: z.array(z.object({ kind: z.string(), key: z.string(), name: z.string().nullable(), usage: z.string() })),
      issues: z.array(issueSchema),
      artwork: slotPlanSchema,
      sprite: slotPlanSchema,
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
      usedBy: z.array(z.object({ key: z.string(), slot: z.enum(['artwork', 'sprite']) })),
    }),
  ),
  counts: z.object({ create: z.number().int(), update: z.number().int(), conflict: z.number().int(), unchanged: z.number().int(), invalid: z.number().int() }),
  decisionKeys: z.array(z.string()),
  ok: z.boolean(),
  planHash: z.string(),
});
const resultSchema = z.object({
  importId: z.number().int(),
  requestId: z.string(),
  replayed: z.boolean(),
  created: z.array(z.string()),
  updated: z.array(z.string()),
  skipped: z.array(z.string()),
  unchanged: z.array(z.string()),
  assets: z.object({
    created: z.array(z.object({ asset: z.string(), assetId: z.string(), category: z.string() })),
    reused: z.array(z.object({ asset: z.string(), assetId: z.string() })),
  }),
});

/** Service errors that carry structure the Portal needs, re-raised with it as `details`. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof EnemyPackageInvalidError || err instanceof EnemyImportRejectedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
    }
    if (err instanceof EnemyExportKeysNotFoundError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { missingKeys: err.missingKeys });
    }
    if (err instanceof EnemyExportRefusedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { reason: err.reason, issues: err.issues });
    }
    if (err instanceof EnemyImportDecisionsRequiredError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { keys: err.keys });
    }
    if (err instanceof EnemyImportRequestConflictError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { inProgress: err.inProgress });
    }
    throw err;
  }
}

export const adminEnemyPackageRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.enemyPackages;
    const authorization = ctx.portalAuthorization;
    if (!service) return;
    const packages: EnemyPackageService = service;

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
        throw new AppError('VALIDATION_ERROR', 'Package body missing', 'Send the enemy package (.zip) as the request body, with Content-Type application/zip.');
      }
      return req.body;
    };
    const tags = ['Admin — Enemies'];
    const importErrors = {
      409: errorSchema.describe(
        'ENEMY_IMPORT_STALE — the catalogue or its artwork changed since the preview. ENEMY_IMPORT_DECISIONS_REQUIRED — ' +
          'an update/skip decision is missing (details.keys). ENEMY_IMPORT_REQUEST_CONFLICT — that requestId is running ' +
          'or belongs to a different request.',
      ),
      413: errorSchema.describe('PAYLOAD_TOO_LARGE — the package is over the route limit (details.maxBytes).'),
    };

    app.post(
      '/admin/enemies/export/package',
      {
        preValidation: gate('enemies.read', 'artwork.read'),
        schema: {
          tags,
          summary:
            'An enemy package (.zip): every enemy, or exactly the selected keys, with the artwork bytes each needs. ' +
            'Unknown keys are 404 ENEMY_EXPORT_KEYS_NOT_FOUND (details.missingKeys); an empty selection, an oversize ' +
            'package or artwork that cannot travel is 422 ENEMY_EXPORT_REFUSED (details.reason, details.issues)',
          body: z.discriminatedUnion('scope', [
            z.object({ scope: z.literal('all') }),
            z.object({ scope: z.literal('selected'), keys: z.array(keySchema).max(ENEMY_PACKAGE_LIMITS.maxEnemies) }),
          ]),
          response: {
            ...notFoundResponse,
            422: errorSchema.describe('ENEMY_EXPORT_REFUSED'),
            ...commonErrorResponses,
          },
        },
      },
      async (req, reply) => {
        const exported = await translate(() =>
          packages.exportPackage(req.body.scope === 'all' ? { scope: 'all' } : { scope: 'selected', keys: req.body.keys }),
        );
        // A binary body, outside the JSON response schemas — as the artwork file route sends its bytes.
        (reply as FastifyReply)
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${exported.filename}"`)
          .header('Cache-Control', 'no-store')
          .header('X-Enemy-Package-Enemies', String(exported.enemies))
          .header('X-Enemy-Package-Assets', String(exported.assets))
          .header('X-Enemy-Package-Warnings', String(exported.warnings.length))
          .send(exported.archive);
        return reply;
      },
    );

    app.post(
      '/admin/enemies/import/preview',
      {
        onRequest: gate('enemies.write'),
        bodyLimit: ENEMY_PACKAGE_BODY_LIMIT_BYTES,
        schema: {
          tags,
          summary:
            'Validate an enemy package (.zip body) and plan it against this server without writing: per enemy ' +
            'create/update/conflict/unchanged/invalid, enabled-state overrides, artwork reuse/create, and the ' +
            '`planHash` and `decisionKeys` apply needs. 400 ENEMY_PACKAGE_INVALID (details.issues) for an unsafe or ' +
            'malformed package',
          response: { 200: dataSchema(previewSchema), ...importErrors, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await translate(() => packages.preview(archiveOf(req)))),
    );

    app.post(
      '/admin/enemies/import/apply',
      {
        onRequest: gate('enemies.write', 'artwork.write'),
        bodyLimit: ENEMY_PACKAGE_BODY_LIMIT_BYTES,
        schema: {
          tags,
          summary:
            'Apply a previewed enemy package (.zip body) atomically: new enemies disabled, existing ones keep their ' +
            'enabled state, each changed one updated or skipped per `decisions`. A repeated `requestId` replays its result',
          querystring: z.object({
            expectedPlanHash: z.string().min(1).max(100),
            requestId: z.string().uuid(),
            decisions: z.string().max(ENEMY_PACKAGE_LIMITS.maxEnemies).regex(/^[us]*$/, 'one u or s per decision key').default(''),
          }),
          response: { 200: dataSchema(resultSchema), ...importErrors, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(
          req,
          await translate(() =>
            packages.apply(
              archiveOf(req),
              { expectedPlanHash: req.query.expectedPlanHash, requestId: req.query.requestId, decisions: req.query.decisions },
              actorOf(req),
            ),
          ),
        ),
    );
  };
