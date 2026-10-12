/** Dungeon-only catalogue HTTP adapter; publication and delivery remain separate. */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { requirePortalPermission, PortalPermissionError } from '../../../plugins/portalPermissions';
import { commonErrorResponses, errorSchema } from '../../../schemas/common';
import { ApiErrorWithDetails } from '../../../errors';
import { AppError } from '../../../../shared/errors';
import { DungeonTestRollRequestSchema, dungeonTestRollResultSchema } from '../../../schemas/dungeonRewardPreview';
import { DungeonKeySchema } from '../../../../modules/dungeons/content/dungeonIdentifiers';
import {
  DungeonLootTableCreateSchema,
  DungeonLootTableUpdateSchema,
  DungeonLootTableRevisionSchema,
  DungeonLootTableDuplicateSchema,
  DungeonLootTableInvalidError,
  DungeonLootTableNotFoundError,
  DungeonLootTableStaleError,
  DungeonLootTableDeleteRefusedError,
  DungeonLootTableKeyTakenError,
  type DungeonLootTableRecord,
} from '../../../../modules/dungeons/dungeonLootTableService';
import {
  dungeonLootTableSchema,
  dungeonLootTableUsageSchema,
  dungeonLootTableEventSchema,
  dungeonLootTableValidationSchema,
  dungeonLootTableTierSchema,
} from '../../../schemas/dungeonLootTables';

// Bounded selectors can carry hundreds of KB; match dungeon authoring's ceiling.
export const DUNGEON_LOOT_TABLE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const bodyLimit = DUNGEON_LOOT_TABLE_BODY_LIMIT_BYTES;
const base = '/admin/dungeons/loot-tables';
const params = z.object({ key: DungeonKeySchema });
const listQuery = z
  .object({
    includeArchived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    tier: z
      .union([dungeonLootTableTierSchema, z.literal('null')])
      .optional()
      .transform((v) => (v === 'null' ? null : v)),
    search: z.string().trim().max(200).optional(),
  })
  .strict();
const toTable = (row: DungeonLootTableRecord) => ({
  ...row,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    let details: Record<string, unknown> | undefined;
    if (err instanceof DungeonLootTableInvalidError) details = { issues: err.issues };
    if (err instanceof DungeonLootTableStaleError)
      details = {
        key: err.key,
        expectedRevision: err.expectedRevision,
        currentRevision: err.currentRevision,
        updatedBy: err.updatedBy,
        updatedAt: err.updatedAt.toISOString(),
      };
    if (err instanceof DungeonLootTableDeleteRefusedError)
      details = { key: err.key, reason: err.reason, usage: err.usage };
    if (
      err instanceof DungeonLootTableKeyTakenError ||
      err instanceof DungeonLootTableNotFoundError
    )
      details = { key: err.key };
    if (details && err instanceof AppError)
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, details);
    throw err;
  }
}
export const adminDungeonLootTableRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const tables = ctx.services.dungeonLootTables;
    if (!tables) return;
    const gate =
      (permission: 'dungeons.read' | 'dungeons.write') => async (req: FastifyRequest) => {
        if (!ctx.portalAuthorization) throw new PortalPermissionError(permission);
        await requirePortalPermission(req, ctx.portalAuthorization, permission, {
          allowBearer: ctx.adminBearerAllowed === true,
        });
      };
    const actor = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const tags = ['Admin — Dungeons'];
    const errors = {
      ...commonErrorResponses,
      413: errorSchema,
      404: errorSchema,
      409: errorSchema.describe(
        'Stale revision (currentRevision, updatedBy, updatedAt), taken key, or deletion refused (reason, usage).',
      ),
    };
    if (ctx.services.dungeonContent) app.post(
      `${base}/test-roll`,
      {
        bodyLimit, onRequest: gate('dungeons.read'),
        schema: {
          tags, summary: 'Preview unsaved dungeon rewards and exact odds without granting or saving anything',
          description: 'Returns null roll/analysis and readable issues when rewards cannot be rolled. Equipment selection only; no stats or Buddy bonuses. Shards configuration is checked when progressionCurrency is supplied. Simulation is observed, bounded to 10,000 runs and 1,000,000 total resolved draws.',
          body: DungeonTestRollRequestSchema,
          response: { 200: dataSchema(dungeonTestRollResultSchema), 413: errorSchema, ...commonErrorResponses },
        },
      },
      async (req) => {
        const result = await ctx.services.dungeonContent!.testRoll(req.body);
        return ok(req, { ...result,
          roll: result.roll && { ...result.roll }, analysis: result.analysis && { ...result.analysis },
        });
      },
    );
    app.post(
      `${base}/validate`,
      {
        bodyLimit,
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Validate loot-table structure, item and equipment dependencies without writing',
          body: z
            .object({
              body: z.unknown().refine((value) => value !== undefined, 'body is required'),
            })
            .strict(),
          response: {
            200: dataSchema(dungeonLootTableValidationSchema),
            413: errorSchema,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, await translate(() => tables.validate(req.body.body))),
    );
    app.get(
      base,
      {
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary:
            'List dungeon loot tables; includeArchived defaults false, tier=null selects untiered',
          querystring: listQuery,
          response: {
            200: dataSchema(z.object({ tables: z.array(dungeonLootTableSchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) =>
        ok(req, {
          tables: (
            await translate(() =>
              tables.list({
                includeArchived: req.query.includeArchived,
                ...(req.query.tier === undefined ? {} : { tier: req.query.tier }),
                ...(req.query.search === undefined ? {} : { search: req.query.search }),
              }),
            )
          ).map(toTable),
        }),
    );
    app.get(
      `${base}/:key`,
      {
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Read a dungeon loot table',
          params,
          response: { 200: dataSchema(dungeonLootTableSchema), ...errors },
        },
      },
      async (req) => {
        const row = await translate(() => tables.get(req.params.key));
        if (!row) throw new DungeonLootTableNotFoundError(req.params.key);
        return ok(req, toTable(row));
      },
    );
    app.get(
      `${base}/:key/where-used`,
      {
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Draft and published dungeon references (no embedded snapshots until T6)',
          params,
          response: { 200: dataSchema(dungeonLootTableUsageSchema), ...errors },
        },
      },
      async (req) =>
        ok(
          req,
          await translate(async () => {
            if (!(await tables.get(req.params.key)))
              throw new DungeonLootTableNotFoundError(req.params.key);
            return tables.whereUsed(req.params.key);
          }),
        ),
    );
    app.get(
      `${base}/:key/history`,
      {
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Catalogue history, retained after deletion; unknown keys have empty history',
          params,
          querystring: z
            .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
            .strict(),
          response: {
            200: dataSchema(z.object({ events: z.array(dungeonLootTableEventSchema) })),
            ...errors,
          },
        },
      },
      async (req) =>
        ok(req, {
          events: (await translate(() => tables.history(req.params.key, req.query.limit))).map(
            (e) => ({ ...e, createdAt: e.createdAt.toISOString() }),
          ),
        }),
    );
    app.post(
      base,
      {
        bodyLimit,
        onRequest: gate('dungeons.write'),
        schema: {
          tags,
          summary: 'Create a dungeon loot table',
          body: DungeonLootTableCreateSchema,
          response: { 201: dataSchema(dungeonLootTableSchema), ...errors },
        },
      },
      async (req, reply) => {
        const row = await translate(() => tables.create(req.body, actor(req)));
        reply.code(201);
        return ok(req, toTable(row));
      },
    );
    app.put(
      `${base}/:key`,
      {
        bodyLimit,
        onRequest: gate('dungeons.write'),
        schema: {
          tags,
          summary: 'Update with expectedRevision; conflicts preserve stored content',
          params,
          body: DungeonLootTableUpdateSchema,
          response: { 200: dataSchema(dungeonLootTableSchema), ...errors },
        },
      },
      async (req) =>
        ok(
          req,
          toTable(await translate(() => tables.update(req.params.key, req.body, actor(req)))),
        ),
    );
    for (const operation of ['archive', 'restore'] as const) {
      app.post(
        `${base}/:key/${operation}`,
        {
          onRequest: gate('dungeons.write'),
          schema: {
            tags,
            summary: `${operation} a dungeon loot table with expectedRevision`,
            params,
            body: DungeonLootTableRevisionSchema,
            response: { 200: dataSchema(dungeonLootTableSchema), ...errors },
          },
        },
        async (req) =>
          ok(
            req,
            toTable(await translate(() => tables[operation](req.params.key, req.body, actor(req)))),
          ),
      );
    }
    app.delete(
      `${base}/:key`,
      {
        onRequest: gate('dungeons.write'),
        schema: {
          tags,
          summary: 'Delete an archived, unreferenced table with expectedRevision',
          params,
          body: DungeonLootTableRevisionSchema,
          response: { 200: dataSchema(z.object({ deleted: z.boolean() })), ...errors },
        },
      },
      async (req) =>
        ok(req, {
          deleted: await translate(() => tables.delete(req.params.key, req.body, actor(req))),
        }),
    );
    app.post(
      `${base}/:key/duplicate`,
      {
        onRequest: gate('dungeons.write'),
        schema: {
          tags,
          summary: 'Duplicate under a new key as an active revision-one table',
          params,
          body: DungeonLootTableDuplicateSchema,
          response: { 201: dataSchema(dungeonLootTableSchema), ...errors },
        },
      },
      async (req, reply) => {
        const row = await translate(() => tables.duplicate(req.params.key, req.body, actor(req)));
        reply.code(201);
        return ok(req, toTable(row));
      },
    );
  };
