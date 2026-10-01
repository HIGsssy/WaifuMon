/**
 * Portal admin — boss and expedition reward tables.
 *
 * The live tables are `reward_tables` rows, seeded from the shipped JSON and
 * authoritative from then on (see `modules/rewardTables`). These routes edit
 * them:
 *
 *   - `rewards.read`  — list, get, reference data, validate (dry run),
 *     equipment previews, export, import plan.
 *   - `rewards.write` — create, update, reset to shipped, delete, import apply.
 *
 * Every write is validated in the writing transaction — schema, item
 * references, and each Equipment selector against the definitions in this
 * database — and is optimistic: it names the `revision` it edited, and a save
 * that lost a race answers `409 REWARD_TABLE_STALE` with the current revision
 * instead of overwriting. A table content pays from cannot be deleted; disable
 * it instead.
 *
 * Nothing here changes a boss already announced or a mission already deployed:
 * both snapshot their table. An edit reaches the next spawn and the next deploy.
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiErrorWithDetails } from '../../../errors';
import { AppError, RewardTableInvalidError, RewardTableStaleError } from '../../../../shared/errors';
import { REWARD_TABLE_KINDS } from '../../../../modules/rewardTables/rewardTableCore';
import type {
  RewardTableDetail,
  RewardTableService,
  RewardTableSummary,
} from '../../../../modules/rewardTables/rewardTableService';

/**
 * Body limit for the two import routes, which carry a whole exported file.
 * `expeditionRewards.json` is ~115 KB today, above the API's 64 KB default;
 * this leaves several times that headroom while staying under nginx's 1 MB
 * default for `/api`, so the API's own JSON 413 is what a caller meets.
 * Every other route keeps the default — a single table is a few KB.
 */
export const REWARD_TABLE_IMPORT_BODY_LIMIT_BYTES = 768 * 1024;

const kindSchema = z.enum(REWARD_TABLE_KINDS);
const tableIdSchema = z.string().min(1).max(128);
const tableBody = z.record(z.string(), z.unknown());
const revisionSchema = z.number().int().positive();

const issueSchema = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});

const referenceSchema = z.object({
  role: z.enum(['boss', 'success', 'bonus', 'failure']),
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
});

const summarySchema = z.object({
  kind: kindSchema,
  id: z.string(),
  enabled: z.boolean(),
  version: z.string().nullable(),
  revision: z.number().int(),
  origin: z.enum(['shipped', 'edited', 'custom']),
  matchesShipped: z.boolean().nullable(),
  groupCount: z.number().int(),
  itemRowCount: z.number().int(),
  equipmentRowCount: z.number().int(),
  references: z.array(referenceSchema),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

const detailSchema = summarySchema.extend({
  table: tableBody,
  issues: z.array(issueSchema),
});

const candidateSchema = z.object({
  key: z.string(),
  name: z.string(),
  slot: z.string(),
  rarity: z.string(),
});

const tableParams = z.object({ kind: kindSchema, id: tableIdSchema });
const kindParams = z.object({ kind: kindSchema });

const conflictResponse = {
  409: errorSchema.describe(
    'REWARD_TABLE_STALE (someone saved first — details.currentRevision), REWARD_TABLE_ID_TAKEN, ' +
      'or REWARD_TABLE_DELETE_REFUSED.',
  ),
} as const;

function toSummary(s: RewardTableSummary): z.infer<typeof summarySchema> {
  return { ...s, updatedAt: s.updatedAt.toISOString() };
}

function toDetail(d: RewardTableDetail): z.infer<typeof detailSchema> {
  return { ...toSummary(d), table: d.table, issues: d.issues };
}

/**
 * Service errors that carry structure the editor needs, re-raised with it as
 * `details`: the per-path issues of a refused save, and the revision a stale
 * save lost to.
 */
function withDetails(err: unknown): unknown {
  if (err instanceof RewardTableInvalidError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
  }
  if (err instanceof RewardTableStaleError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
      expectedRevision: err.expectedRevision,
      currentRevision: err.currentRevision,
      updatedBy: err.updatedBy,
      updatedAt: err.updatedAt.toISOString(),
    });
  }
  return err;
}

async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw withDetails(err);
  }
}

export const adminRewardTableRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.rewardTables;
    const authorization = ctx.portalAuthorization;
    if (!service) return;
    const tables: RewardTableService = service;

    const gate =
      (permission: 'rewards.read' | 'rewards.write') =>
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

    const notFound = (kind: string, id: string) =>
      new AppError('NOT_FOUND', `Reward table ${kind}/"${id}" not found`, 'Not found.');

    /** The actor comes from the authenticated session, never the body. */
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;

    app.get(
      '/admin/reward-tables',
      {
        preValidation: gate('rewards.read'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary: 'List boss and expedition reward tables, with origin, references and row counts',
          querystring: z.object({ kind: kindSchema.optional() }),
          response: {
            200: dataSchema(z.object({ tables: z.array(summarySchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { tables: (await tables.list(req.query.kind)).map(toSummary) }),
    );

    app.get(
      '/admin/reward-tables/reference',
      {
        preValidation: gate('rewards.read'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary: 'Items and equipment definitions the reward table editor offers',
          response: {
            200: dataSchema(
              z.object({
                items: z.array(z.object({ slug: z.string(), name: z.string(), category: z.string() })),
                equipmentDefinitions: z.array(
                  z.object({
                    key: z.string(),
                    name: z.string(),
                    slot: z.string(),
                    rarity: z.string(),
                    enabled: z.boolean(),
                  }),
                ),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const items = ctx
          .getContent()
          .items.map((i) => ({ slug: i.slug, name: i.name, category: i.category }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return ok(req, { items, equipmentDefinitions: await tables.listEquipmentDefinitions() });
      },
    );

    app.post(
      '/admin/reward-tables/equipment-preview',
      {
        preValidation: gate('rewards.read'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary:
            'The base definitions each Equipment selector may pay right now, from this database — ' +
            'or why it cannot pay anything',
          body: z.object({ selectors: z.array(z.unknown()).max(500) }),
          response: {
            200: dataSchema(
              z.object({
                previews: z.array(
                  z.object({
                    eligible: z.array(candidateSchema),
                    issues: z.array(z.object({ path: z.string(), message: z.string() })),
                  }),
                ),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { previews: await tables.previewEquipment(req.body.selectors) }),
    );

    app.get(
      '/admin/reward-tables/:kind/export',
      {
        preValidation: gate('rewards.read'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary:
            'Every live table of a kind in the shipped file format (bossRewards.json / expeditionRewards.json), ' +
            'for committing back to Git or importing elsewhere',
          params: kindParams,
          response: {
            200: dataSchema(z.object({ kind: kindSchema, file: z.string(), tables: z.array(tableBody) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, await tables.export(req.params.kind)),
    );

    const planSchema = z.object({
      kind: kindSchema,
      entries: z.array(
        z.object({
          id: z.string(),
          action: z.enum(['create', 'update', 'unchanged', 'invalid']),
          currentRevision: z.number().int().nullable(),
          issues: z.array(issueSchema),
        }),
      ),
      issues: z.array(issueSchema),
      canApply: z.boolean(),
    });

    app.post(
      '/admin/reward-tables/:kind/import/plan',
      {
        // Checked before the (large) body is parsed, not after.
        onRequest: gate('rewards.read'),
        bodyLimit: REWARD_TABLE_IMPORT_BODY_LIMIT_BYTES,
        schema: {
          tags: ['Admin — Reward Tables'],
          summary: 'Validate an exported file against this server and say what applying it would do',
          params: kindParams,
          body: z.object({ tables: z.unknown() }),
          response: { 200: dataSchema(planSchema), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await tables.planImport(req.params.kind, req.body.tables)),
    );

    app.post(
      '/admin/reward-tables/:kind/import/apply',
      {
        onRequest: gate('rewards.write'),
        bodyLimit: REWARD_TABLE_IMPORT_BODY_LIMIT_BYTES,
        schema: {
          tags: ['Admin — Reward Tables'],
          summary:
            'Apply an import all-or-nothing. `expectedRevisions` is the plan’s `currentRevision` per table ' +
            '(null for a create); any table that moved since the plan makes the whole import stale (409).',
          params: kindParams,
          body: z.object({
            tables: z.unknown(),
            expectedRevisions: z.record(z.string(), z.number().int().nullable()),
          }),
          response: {
            200: dataSchema(
              z.object({ created: z.array(z.string()), updated: z.array(z.string()), unchanged: z.array(z.string()) }),
            ),
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) =>
        ok(
          req,
          await translate(() =>
            tables.applyImport(req.params.kind, req.body.tables, req.body.expectedRevisions, actorOf(req)),
          ),
        ),
    );

    app.post(
      '/admin/reward-tables/:kind/validate',
      {
        preValidation: gate('rewards.read'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary: 'Dry run: every issue saving this table would raise, without writing',
          params: kindParams,
          body: z.object({ table: z.unknown(), id: tableIdSchema.optional() }),
          response: {
            200: dataSchema(z.object({ issues: z.array(issueSchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { issues: await tables.validate(req.params.kind, req.body.table, req.body.id) }),
    );

    app.get(
      '/admin/reward-tables/:kind/:id',
      {
        preValidation: gate('rewards.read'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary: 'Get one reward table, with its revision and current problems',
          params: tableParams,
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const detail = await tables.get(req.params.kind, req.params.id);
        if (!detail) throw notFound(req.params.kind, req.params.id);
        return ok(req, toDetail(detail));
      },
    );

    app.post(
      '/admin/reward-tables/:kind',
      {
        preValidation: gate('rewards.write'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary: 'Create a reward table (409 when the id is taken)',
          params: kindParams,
          body: z.object({ table: tableBody }),
          response: { 200: dataSchema(detailSchema), ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, toDetail(await translate(() => tables.create(req.params.kind, req.body.table, actorOf(req))))),
    );

    app.put(
      '/admin/reward-tables/:kind/:id',
      {
        preValidation: gate('rewards.write'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary:
            'Replace a reward table. `expectedRevision` must be the revision you loaded; ' +
            'a stale save is refused with 409 REWARD_TABLE_STALE rather than overwriting',
          params: tableParams,
          body: z.object({ table: tableBody, expectedRevision: revisionSchema }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { kind, id } = req.params;
        const detail = await translate(() => tables.update(kind, id, req.body, actorOf(req)));
        if (!detail) throw notFound(kind, id);
        return ok(req, toDetail(detail));
      },
    );

    app.post(
      '/admin/reward-tables/:kind/:id/reset',
      {
        preValidation: gate('rewards.write'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary: "Replace a table with this build's shipped copy, so later deploys update it again",
          params: tableParams,
          body: z.object({ expectedRevision: revisionSchema }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { kind, id } = req.params;
        const detail = await translate(() =>
          tables.resetToShipped(kind, id, req.body.expectedRevision, actorOf(req)),
        );
        if (!detail) throw notFound(kind, id);
        return ok(req, toDetail(detail));
      },
    );

    app.delete(
      '/admin/reward-tables/:kind/:id',
      {
        preValidation: gate('rewards.write'),
        schema: {
          tags: ['Admin — Reward Tables'],
          summary:
            'Delete a table nothing pays from and Git does not ship (409 REWARD_TABLE_DELETE_REFUSED otherwise — disable it instead)',
          params: tableParams,
          querystring: z.object({ expectedRevision: z.coerce.number().int().positive() }),
          response: {
            200: dataSchema(z.object({ ok: z.boolean() })),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { kind, id } = req.params;
        const deleted = await translate(() => tables.delete(kind, id, req.query.expectedRevision));
        if (!deleted) throw notFound(kind, id);
        return ok(req, { ok: true });
      },
    );
  };
