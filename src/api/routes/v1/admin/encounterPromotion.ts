/**
 * Portal admin — World Encounter content promotion.
 *
 * Three routes, and the permission on each is chosen to match what the action
 * actually does to a live server:
 *
 *   `GET  /admin/encounters/export`        → `encounters.read`
 *       Reading authored content, in bulk. The same information the list and
 *       editor screens already expose to a reader.
 *
 *   `POST /admin/encounters/import/preview` → `encounters.write`
 *       A dry run. It writes nothing, but it is an authoring action — it
 *       answers "what would this package do here?" — so it sits with the
 *       permission that authoring uses. An Encounter Editor can therefore
 *       prepare and check a promotion without being able to perform one.
 *
 *   `POST /admin/encounters/import/apply`   → `encounters.publish`
 *       Changes what every player sees, at once, on this server. That is the
 *       same blast radius as publishing an encounter or editing global
 *       tuning, and it carries the same permission.
 *
 * CSRF is enforced upstream at the `onRequest` hook in `src/api/auth.ts` for
 * every non-GET portal-session request, so the two mutations inherit it.
 * Permission checks run at `preValidation` — before the body is parsed —
 * matching the rest of the admin namespace, which matters more here than
 * anywhere else: an import body is an entire content package, and parsing one
 * for a caller who may not even be an admin is work done on their say-so.
 */
import { z } from 'zod';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { AppError } from '../../../../shared/errors';
import { EncounterImportRejectedError } from '../../../../modules/worldEncounters/encounterImportService';

/**
 * The plan, as JSON. Described loosely on purpose: it is a report for a human
 * to read, and pinning every field into the OpenAPI document would make each
 * new diagnostic a schema change for no client benefit.
 */
const planSchema = z.object({
  ok: z.boolean(),
  format: z.string(),
  version: z.number(),
  exportedAt: z.string().nullable(),
  label: z.string().nullable(),
  encounters: z.array(
    z.object({ slug: z.string(), name: z.string(), status: z.string() }),
  ),
  vendors: z.array(z.object({ vendorKey: z.string(), status: z.string() })),
  issues: z.array(
    z.object({
      severity: z.string(),
      code: z.string(),
      subject: z.string().nullable(),
      message: z.string(),
      /** Region ids the issue is about, so the Portal can label them. */
      regions: z.array(z.string()).optional(),
    }),
  ),
  counts: z.object({
    created: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    vendorsCreated: z.number(),
    vendorsUpdated: z.number(),
    vendorsUnchanged: z.number(),
    errors: z.number(),
    warnings: z.number(),
  }),
});

/**
 * The package arrives as an opaque object.
 *
 * Deliberately not validated by the route: the *planner* is the one
 * interpretation of a package, and it reports a malformed one as a readable
 * list of issues. A Zod rejection here would answer a bad file with a 400 and
 * a schema dump instead of the preview screen the operator needs.
 */
const importBody = z.object({
  package: z.unknown(),
  sourceFilename: z.string().max(255).nullable().default(null),
});

export const adminEncounterPromotionRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const promotion = ctx.services.encounterPromotion;
    const authorization = ctx.portalAuthorization;

    if (!promotion) return; // Feature not wired — routes do not exist.

    const gate =
      (permission: Parameters<typeof requirePortalPermission>[2]) =>
      async (req: import('fastify').FastifyRequest): Promise<void> => {
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

    app.get(
      '/admin/encounters/export',
      {
        preValidation: gate('encounters.read'),
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Export encounter definitions as a promotion package',
          querystring: z.object({
            /** Comma-separated slugs. Omitted exports every encounter. */
            slugs: z.string().max(4000).optional(),
            label: z.string().max(200).optional(),
          }),
          response: {
            200: dataSchema(z.object({}).passthrough()),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const slugs = req.query.slugs
          ? req.query.slugs
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
        const pkg = await promotion.exportPackage({
          ...(slugs ? { slugs } : {}),
          label: req.query.label ?? null,
        });
        // Returned inside the standard envelope like every other endpoint; the
        // Portal unwraps `data` and saves that as the .json file, so the file
        // on disk is a bare package with no envelope around it.
        return ok(req, pkg as unknown as Record<string, unknown>);
      },
    );

    app.post(
      '/admin/encounters/import/preview',
      {
        preValidation: gate('encounters.write'),
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Dry-run an encounter package against this server',
          body: importBody,
          response: {
            200: dataSchema(planSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const plan = await promotion.preview(req.body.package);
        return ok(req, plan);
      },
    );

    app.post(
      '/admin/encounters/import/apply',
      {
        preValidation: gate('encounters.publish'),
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Apply an encounter package in a single transaction',
          body: importBody,
          response: {
            200: dataSchema(
              z.object({ plan: planSchema, importLogId: z.number() }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        try {
          const result = await promotion.apply(req.body.package, {
            // The actor is the authenticated session, never the body. A bearer
            // call has no session and is recorded as null rather than as
            // whatever a caller claimed.
            actorDiscordUserId: req.portalSession?.discordUserId ?? null,
            sourceFilename: req.body.sourceFilename,
          });
          req.log.info(
            {
              tag: 'encounter-promotion/applied',
              actor: req.portalSession?.discordUserId ?? null,
              importLogId: result.importLogId,
              created: result.plan.counts.created,
              updated: result.plan.counts.updated,
              unchanged: result.plan.counts.unchanged,
            },
            'encounter package imported',
          );
          return ok(req, result);
        } catch (err) {
          if (err instanceof EncounterImportRejectedError) {
            // The plan is the useful part of the failure: the operator needs
            // the issue list, not just a status code. Attached as details on
            // the standard error body.
            throw new AppError(
              'ENCOUNTER_IMPORT_REJECTED',
              err.message,
              `${err.plan.counts.errors} problem(s) blocked this import.`,
            );
          }
          throw err;
        }
      },
    );
  };
