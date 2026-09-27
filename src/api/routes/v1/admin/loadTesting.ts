/**
 * Portal admin — Load Testing: start, watch and stop synthetic load.
 *
 * ## Three locks, not one
 *
 * 1. **Registration.** These routes exist only when the host built a
 *    `LoadTestController`, which it does only under `LOAD_TESTING_ENABLED=true`.
 *    Everywhere else — production included — every path below 404s through
 *    the normal not-found handler, exactly as if it had never been written.
 * 2. **Permission.** `system.loadtest.run`, owner-only (never grantable to a
 *    role), and issued by the authorization service only when the same flag is
 *    on. `LOAD_TESTING_OPERATOR_DISCORD_IDS`, when set, narrows it further to
 *    named operators.
 * 3. **The controller** refuses to construct with the flag off, and the
 *    generator process refuses to run without it.
 *
 * Hiding the Portal nav entry is a courtesy on top; none of the above depends
 * on it.
 *
 * ## Why the bearer token is treated like System Metrics
 *
 * It satisfies the permission only under `PLATFORM_API_ADMIN_BEARER=true`, the
 * opt-in every admin route honours. That is what lets a run be scripted from
 * a shell for back-to-back comparisons. The operator allowlist cannot apply to
 * it — a bearer request has no Discord identity — which is the same trade the
 * admin-bearer flag already documents.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { PortalPermissionError, requirePortalPermission } from '../../../plugins/portalPermissions';
import { AppError } from '../../../../shared/errors';
import {
  LoadTestConflictError,
  LoadTestUnavailableError,
  type LoadTestController,
  type LoadTestRunView,
} from '../../../../modules/loadTest/controller';
import {
  CARD_MODES,
  CONCURRENCY_PRESETS,
  DURATION_PRESETS_SECONDS,
  LOAD_TEST_PROFILES,
  MAX_CONCURRENCY,
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  loadTestStartSchema,
} from '../../../../modules/loadTest/types';
import type { LoadTestRunRow } from '../../../../db/schema';

const PERMISSION = 'system.loadtest.run' as const;

// Progress and summary are the harness's own report shapes, produced by code
// in this repository and read back only by the Portal page. They are passed
// through whole rather than restated field by field.
const passthrough = z.record(z.string(), z.unknown());

const runViewSchema = z.object({
  runKey: z.string(),
  state: z.enum(['preparing', 'priming', 'running', 'stopping', 'completed', 'stopped', 'failed']),
  profile: z.enum(LOAD_TEST_PROFILES),
  cardMode: z.enum(CARD_MODES).nullable(),
  concurrency: z.number().int(),
  durationSeconds: z.number().int(),
  seed: z.number().int(),
  label: z.string().nullable(),
  resetMetricsWindow: z.boolean(),
  operatorDiscordId: z.string().nullable(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  elapsedMs: z.number(),
  remainingMs: z.number().nullable(),
  progress: passthrough.nullable(),
  error: z.string().nullable(),
  resultId: z.number().int().nullable(),
});

const resultSchema = z.object({
  id: z.number().int(),
  runKey: z.string(),
  status: z.string(),
  profile: z.string(),
  cardMode: z.string().nullable(),
  concurrency: z.number().int(),
  durationSeconds: z.number().int(),
  elapsedSeconds: z.number().int(),
  seed: z.number().int(),
  label: z.string().nullable(),
  hostLabel: z.string().nullable(),
  operatorDiscordId: z.string().nullable(),
  hostInfo: passthrough,
  summary: passthrough,
  metricsStart: passthrough.nullable(),
  metricsEnd: passthrough.nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
});

const statusSchema = z.object({
  enabled: z.literal(true),
  hostLabel: z.string().nullable(),
  cardsAvailable: z.boolean(),
  limits: z.object({
    profiles: z.array(z.enum(LOAD_TEST_PROFILES)),
    concurrencyPresets: z.array(z.number().int()),
    durationPresetsSeconds: z.array(z.number().int()),
    maxConcurrency: z.number().int(),
    minDurationSeconds: z.number().int(),
    maxDurationSeconds: z.number().int(),
  }),
  current: runViewSchema.nullable(),
  last: runViewSchema.nullable(),
});

function toResult(row: LoadTestRunRow): z.infer<typeof resultSchema> {
  return {
    id: row.id,
    runKey: row.runKey,
    status: row.status,
    profile: row.profile,
    cardMode: row.cardMode,
    concurrency: row.concurrency,
    durationSeconds: row.durationSeconds,
    elapsedSeconds: row.elapsedSeconds,
    seed: row.seed,
    label: row.label,
    hostLabel: row.hostLabel,
    operatorDiscordId: row.operatorDiscordId,
    hostInfo: row.hostInfo,
    summary: row.summary,
    metricsStart: row.metricsStart ?? null,
    metricsEnd: row.metricsEnd ?? null,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
  };
}

function view(v: LoadTestRunView | null): z.infer<typeof runViewSchema> | null {
  return v === null
    ? null
    : { ...v, progress: v.progress as unknown as Record<string, unknown> | null };
}

class LoadTestConflict extends AppError {
  constructor(message: string) {
    super('LOAD_TEST_CONFLICT', message, message);
  }
}

class LoadTestUnavailable extends AppError {
  constructor(message: string) {
    super('LOAD_TEST_UNAVAILABLE', message, message);
  }
}

export function adminLoadTestingRoutes(ctx: ApiContext): FastifyPluginAsyncZod {
  return async (app) => {
    const controller: LoadTestController | undefined = ctx.loadTesting;
    if (controller === undefined) return; // LOAD_TESTING_ENABLED is off — no route exists.

    const authorization = ctx.portalAuthorization;
    const operators = ctx.loadTestingOperatorIds ?? [];

    const gate = async (req: FastifyRequest): Promise<void> => {
      if (!authorization) throw new PortalPermissionError(PERMISSION);
      await requirePortalPermission(req, authorization, PERMISSION, {
        allowBearer: ctx.adminBearerAllowed === true,
      });
      if (req.apiAuth === 'portal' && operators.length > 0) {
        const who = req.portalSession?.discordUserId ?? '';
        if (!operators.includes(who)) throw new PortalPermissionError(PERMISSION);
      }
    };

    const operatorOf = (req: FastifyRequest): string | null =>
      req.apiAuth === 'portal' ? (req.portalSession?.discordUserId ?? null) : null;

    const forbidden = { 403: errorSchema.describe('The session may not run load tests.') };

    app.get(
      '/admin/load-testing',
      {
        preValidation: gate,
        schema: {
          tags: ['System'],
          summary: 'Load-testing status: limits, the active run, the last run',
          description:
            'Present only when `LOAD_TESTING_ENABLED=true`. Requires `system.loadtest.run` ' +
            '(guild owner only, and optionally a named operator).',
          response: { 200: dataSchema(statusSchema), ...commonErrorResponses, ...forbidden },
        },
      },
      async (req) =>
        ok(req, {
          enabled: true as const,
          hostLabel: controller.hostLabel,
          cardsAvailable: controller.cardsAvailable,
          limits: {
            profiles: [...LOAD_TEST_PROFILES],
            concurrencyPresets: [...CONCURRENCY_PRESETS],
            durationPresetsSeconds: [...DURATION_PRESETS_SECONDS],
            maxConcurrency: MAX_CONCURRENCY,
            minDurationSeconds: MIN_DURATION_SECONDS,
            maxDurationSeconds: MAX_DURATION_SECONDS,
          },
          current: view(controller.currentRun()),
          last: view(controller.lastRun()),
        }),
    );

    app.post(
      '/admin/load-testing/runs',
      {
        preValidation: gate,
        schema: {
          tags: ['System'],
          summary: 'Start a load test',
          description:
            'Starts a run against synthetic players only. Answers immediately with the run in ' +
            '`preparing`; poll `GET /admin/load-testing` for progress. `409` while another run ' +
            'is active.',
          body: loadTestStartSchema,
          response: {
            202: dataSchema(runViewSchema),
            ...commonErrorResponses,
            ...forbidden,
            409: errorSchema.describe('A run is already active.'),
          },
        },
      },
      async (req, reply) => {
        try {
          const started = controller.start(req.body, operatorOf(req));
          req.log.info(
            { tag: 'load-test/start', runKey: started.runKey, operator: operatorOf(req) },
            'load test started from the Portal',
          );
          return reply.code(202).send(ok(req, view(started)!));
        } catch (err) {
          if (err instanceof LoadTestConflictError) throw new LoadTestConflict(err.message);
          if (err instanceof LoadTestUnavailableError) throw new LoadTestUnavailable(err.message);
          throw err;
        }
      },
    );

    app.post(
      '/admin/load-testing/runs/current/stop',
      {
        preValidation: gate,
        schema: {
          tags: ['System'],
          summary: 'Stop the active load test',
          description:
            'Stops the generator, cleans up (synthetic sessions, cold-render cards) and records ' +
            'the partial result as `stopped`. `409` when nothing is running.',
          response: {
            200: dataSchema(runViewSchema),
            ...commonErrorResponses,
            ...forbidden,
            409: errorSchema.describe('No run is active.'),
          },
        },
      },
      async (req) => {
        const stopped = controller.stop();
        if (stopped === null) throw new LoadTestConflict('No load test is running.');
        return ok(req, view(stopped)!);
      },
    );

    app.get(
      '/admin/load-testing/results',
      {
        preValidation: gate,
        schema: {
          tags: ['System'],
          summary: 'Recorded load-test results, newest first',
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
          response: { 200: dataSchema(z.array(resultSchema)), ...commonErrorResponses, ...forbidden },
        },
      },
      async (req) => ok(req, (await controller.listRuns(req.query.limit)).map(toResult)),
    );

    app.get(
      '/admin/load-testing/results/:id',
      {
        preValidation: gate,
        schema: {
          tags: ['System'],
          summary: 'One recorded load-test result, with per-endpoint latency',
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: {
            200: dataSchema(resultSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
            ...forbidden,
          },
        },
      },
      async (req) => {
        const row = await controller.getRun(req.params.id);
        if (!row) throw new AppError('NOT_FOUND', `load test result ${req.params.id}`, 'Not found.');
        return ok(req, toResult(row));
      },
    );
  };
}
