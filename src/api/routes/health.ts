/**
 * Liveness and readiness (plan §12 Phase 1, §16.7).
 *
 * Both live outside `/api/v1` on purpose: ops tooling needs a target that
 * survives a future v2 bump. Both are unauthenticated, and both return their
 * report at the top level rather than inside the `{ data }` envelope — they
 * describe the process, not a game resource.
 *
 *   GET /health  cheap liveness. 200 whenever the process is up, no probes.
 *   GET /ready   component-level report. 200 when every *required* component
 *                is ok, 503 otherwise, same body shape either way.
 *
 * `database` and `content` are required — without them no endpoint can answer.
 * `discordClient` is advisory in v1: the API serves its own data fine while
 * the gateway reconnects, so a down gateway is reported but does not fail
 * readiness. `platformApi` self-reports the effective bind, which is the
 * fastest way to confirm a misconfigured `PLATFORM_API_HOST` in production.
 */
import { z } from 'zod';
import type { ZodFastify } from '../plugins/typeProvider';

export type ComponentStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ComponentReport {
  status: ComponentStatus;
  detail: string;
  checkedAt: string;
}

export interface ReadinessReport {
  status: ComponentStatus;
  components: {
    database: ComponentReport;
    content: ComponentReport;
    discordClient: ComponentReport;
    platformApi: ComponentReport;
  };
  checkedAt: string;
}

/**
 * What `/ready` needs from the host process, expressed without importing the
 * db, content or Discord types — the API layer stays free of them.
 */
export interface ReadinessProbes {
  /** Resolves when the database answers; rejects with the reason otherwise. */
  pingDatabase: () => Promise<void>;
  /** Null when no content snapshot has been published yet. */
  describeContent: () => { species: number; items: number } | null;
  describeDiscord: () => { status: ComponentStatus; detail: string };
  /** Human-readable effective bind, e.g. "listening on 127.0.0.1:3120". */
  describeBind: () => string;
}

const componentStatusSchema = z.enum(['ok', 'degraded', 'down', 'unknown']);

const componentReportSchema = z.object({
  status: componentStatusSchema,
  detail: z.string(),
  checkedAt: z.string(),
});

const readinessReportSchema = z.object({
  status: componentStatusSchema,
  components: z.object({
    database: componentReportSchema,
    content: componentReportSchema,
    discordClient: componentReportSchema,
    platformApi: componentReportSchema,
  }),
  checkedAt: z.string(),
});

const livenessSchema = z.object({ status: z.literal('ok') });

/** Components whose failure makes the API unable to serve. */
const REQUIRED_COMPONENTS = ['database', 'content'] as const;

export async function buildReadinessReport(probes: ReadinessProbes): Promise<ReadinessReport> {
  const checkedAt = new Date().toISOString();

  let database: ComponentReport;
  try {
    await probes.pingDatabase();
    database = { status: 'ok', detail: 'SELECT 1 succeeded', checkedAt };
  } catch (err) {
    // The reason is operator-facing diagnostics on a loopback endpoint, not a
    // user-facing message — but keep it to the message, never the stack.
    database = { status: 'down', detail: `SELECT 1 failed: ${(err as Error).message}`, checkedAt };
  }

  const snapshot = probes.describeContent();
  const content: ComponentReport = snapshot
    ? {
        status: 'ok',
        detail: `snapshot loaded (${snapshot.species} species, ${snapshot.items} items)`,
        checkedAt,
      }
    : { status: 'down', detail: 'no content snapshot loaded', checkedAt };

  const discord = probes.describeDiscord();
  const discordClient: ComponentReport = { ...discord, checkedAt };
  const platformApi: ComponentReport = { status: 'ok', detail: probes.describeBind(), checkedAt };

  const components = { database, content, discordClient, platformApi };
  const failed = REQUIRED_COMPONENTS.some((key) => components[key].status !== 'ok');

  return { status: failed ? 'down' : 'ok', components, checkedAt };
}

export function registerHealthRoutes(app: ZodFastify, probes: ReadinessProbes): void {
  app.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Liveness probe',
        description:
          'Returns 200 whenever the process is up. Checks no dependencies — use /ready for that. Unauthenticated.',
        response: { 200: livenessSchema },
      },
    },
    async () => ({ status: 'ok' }) as const,
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['System'],
        summary: 'Readiness probe',
        description:
          'Component-level readiness report. 200 when every required component (database, content) is ok, ' +
          '503 otherwise — the body shape is identical either way. discordClient is advisory in v1 and ' +
          'never fails readiness on its own. Unauthenticated.',
        response: { 200: readinessReportSchema, 503: readinessReportSchema },
      },
    },
    async (_req, reply) => {
      const report = await buildReadinessReport(probes);
      return reply.code(report.status === 'ok' ? 200 : 503).send(report);
    },
  );
}
