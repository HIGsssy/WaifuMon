/**
 * Portal admin — System Metrics: the `/metrics` report, for a signed-in owner.
 *
 * ## Why this is a route and not a proxy
 *
 * The obvious design is a server-side proxy: accept the Portal session, call
 * `/metrics` with `PLATFORM_API_TOKEN`, relay the body. It would work, and it
 * would put the bearer token into a request path that a Portal session can
 * trigger — one more place for it to be logged, echoed in an error, or reached
 * by a future refactor.
 *
 * None of that is necessary, because the metrics are not somewhere else. The
 * collectors live in this process, and `/metrics` is simply one reader of them.
 * This route is a second reader of the same `MetricsSources`, calling the same
 * `buildMetricsReport` against the same response schema. No token is used, no
 * HTTP hop happens, and the two surfaces cannot drift apart.
 *
 * The browser authenticates the way every Portal admin page does: the session
 * cookie, checked by the global auth hook and then by `requirePortalPermission`
 * at `preValidation`. It never sees, sends or receives the bearer token.
 *
 * ## Who may read it
 *
 * `system.metrics.read`, which only the live guild owner holds — it is excluded
 * from the grantable set, so no role can confer it (see `SYSTEM_METRICS_READ`).
 * The bearer token satisfies it only under `PLATFORM_API_ADMIN_BEARER=true`,
 * the same opt-in every admin route honours; a token holder already has the
 * bearer-only `/metrics` anyway.
 *
 * ## Deliberately read-only
 *
 * There is no Portal counterpart to `POST /metrics/reset`. A reset zeroes the
 * server's measurement window, which a load harness relies on to isolate a test
 * phase — a dashboard that could reset it would let anyone with the page open
 * silently corrupt the run they were watching.
 *
 * Registered only when metrics are enabled; with `PLATFORM_API_METRICS_ENABLED
 * =false` the route does not exist, exactly as `/metrics` does not.
 */
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { AppError } from '../../../../shared/errors';
import { buildMetricsReport, metricsResponseSchema } from '../../metrics';

export function adminSystemMetricsRoutes(ctx: ApiContext): FastifyPluginAsyncZod {
  return async (app) => {
    const sources = ctx.metrics;
    if (sources === undefined) return; // Metrics disabled — the route does not exist.

    const authorization = ctx.portalAuthorization;
    const gate = async (req: FastifyRequest): Promise<void> => {
      // No oracle means no session can hold any permission. Refused, never
      // waved through — the same fail-closed stance as every admin area.
      if (!authorization) {
        throw new AppError(
          'PORTAL_PERMISSION_DENIED',
          'Portal authorization service is not configured',
          'You do not have permission to do that.',
        );
      }
      await requirePortalPermission(req, authorization, 'system.metrics.read', {
        allowBearer: ctx.adminBearerAllowed === true,
      });
    };

    app.get(
      '/admin/system/metrics',
      {
        preValidation: gate,
        schema: {
          tags: ['System'],
          summary: 'Runtime metrics for the Portal dashboard',
          description:
            'The same report as `GET /metrics`, inside the `{ data }` envelope, for a Portal ' +
            'session holding `system.metrics.read` (guild owner only).\n\n' +
            'Served from the in-process collectors directly — no bearer token is used or ' +
            'exposed. Read-only: there is no Portal equivalent of `POST /metrics/reset`, so a ' +
            'dashboard cannot disturb a load test measurement window.',
          response: {
            200: dataSchema(metricsResponseSchema),
            ...commonErrorResponses,
            403: errorSchema.describe('The session does not hold `system.metrics.read`.'),
          },
        },
      },
      async (req) => ok(req, buildMetricsReport(sources)),
    );
  };
}
