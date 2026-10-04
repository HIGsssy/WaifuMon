/**
 * Portal admin — dungeon zones, the progression currency, and the generation
 * preview.
 *
 * Zones are `dungeon_zones` rows, seeded from `content/dungeons/zones.json`
 * and authoritative from then on (see `modules/dungeons`). These routes edit
 * them:
 *
 *   - `dungeons.read`  — list, get, reference data (regions included),
 *     validate (dry run), preview, simulate, export, the currency list, the
 *     Delve settings, and the artwork picker (bytes, browse, search — rooted
 *     at `dungeons/`, never the whole assets tree).
 *   - `dungeons.write` — create, update, enable/disable, the currency's
 *     display metadata, and the Delve settings (the shared daily run limit).
 *
 * Every zone write is validated in the writing transaction and is optimistic:
 * it names the `revision` it edited, and a save that lost a race answers
 * `409 DUNGEON_ZONE_STALE` with the current revision instead of overwriting.
 * There is no delete — disable a zone instead.
 *
 * Preview and simulate run the same generator a real run will and persist
 * nothing. A zone whose rules cannot produce a run answers
 * `422 DUNGEON_GENERATION_FAILED` with the generator's diagnostics.
 *
 * Nothing here changes a run already generated: a run snapshots its zone.
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
  adminArtworkBrowseQuery,
  adminArtworkQuery,
  adminArtworkSearchQuery,
  artworkDirectorySchema,
  artworkSearchSchema,
  browseAdminArtwork,
  searchAdminArtwork,
  sendAdminArtwork,
} from '../../../adminArtwork';
import {
  AppError,
  DungeonGenerationError,
  DungeonZoneInvalidError,
  DungeonZoneStaleError,
  ProgressionCurrencyInvalidError,
  ProgressionCurrencyStaleError,
} from '../../../../shared/errors';
import {
  DUNGEON_DAILY_RUN_LIMIT_BOUNDS,
  type DungeonSettings,
} from '../../../../modules/dungeons/dungeonAllowanceService';
import { MAX_DUNGEON_SEED } from '../../../../modules/dungeons/dungeonGenerator';
import { MAX_SIMULATION_RUNS } from '../../../../modules/dungeons/dungeonSimulation';
import type {
  DungeonZoneDetail,
  DungeonZoneService,
  DungeonZoneSummary,
  DungeonZoneTarget,
} from '../../../../modules/dungeons/dungeonZoneService';
import {
  DUNGEON_ARTWORK_ROOTS,
  DUNGEON_KEY_PATTERN,
  DUNGEON_LAYOUT_MODES,
  DUNGEON_NODE_TYPES,
} from '../../../../modules/dungeons/zoneDefinition';
import type {
  ProgressionCurrency,
  ProgressionCurrencyService,
} from '../../../../modules/progressionCurrency/progressionCurrencyService';

const keySchema = z.string().min(1).max(64).regex(DUNGEON_KEY_PATTERN);
const zoneBody = z.record(z.string(), z.unknown());
const revisionSchema = z.number().int().positive();
const seedSchema = z.number().int().min(0).max(MAX_DUNGEON_SEED);
const nodeTypeSchema = z.enum(DUNGEON_NODE_TYPES);

const issueSchema = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});

const summarySchema = z.object({
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  order: z.number().int(),
  tags: z.array(z.string()),
  layoutMode: z.enum(DUNGEON_LAYOUT_MODES),
  minNodes: z.number().int(),
  maxNodes: z.number().int(),
  roomCount: z.number().int().nullable(),
  artworkAssetId: z.string().nullable(),
  artworkPath: z.string().nullable(),
  poolCount: z.number().int(),
  poolEntryCount: z.number().int(),
  rewardBandCount: z.number().int(),
  availableRegions: z.array(z.string()),
  revision: z.number().int(),
  origin: z.enum(['shipped', 'edited', 'custom']),
  matchesShipped: z.boolean().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  regionBackfill: z.enum(['shipped', 'all_enabled_regions']).nullable(),
});

const detailSchema = summarySchema.extend({ zone: zoneBody, issues: z.array(issueSchema) });

const contentRefSchema = z.object({
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  tags: z.array(z.string()),
});

const currencySchema = z.object({
  key: z.string(),
  singularName: z.string(),
  pluralName: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  enabled: z.boolean(),
  revision: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

/** Delve-wide settings, with the bounds the editor needs to offer them. */
const settingsSchema = z.object({
  dailyRunLimit: z.number().int(),
  dailyRunLimitMin: z.number().int(),
  dailyRunLimitMax: z.number().int(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const toSettings = (s: DungeonSettings): z.infer<typeof settingsSchema> => ({
  dailyRunLimit: s.dailyRunLimit,
  dailyRunLimitMin: DUNGEON_DAILY_RUN_LIMIT_BOUNDS.min,
  dailyRunLimitMax: DUNGEON_DAILY_RUN_LIMIT_BOUNDS.max,
  updatedAt: s.updatedAt?.toISOString() ?? null,
  updatedBy: s.updatedBy,
});

const graphSchema = z.object({
  format: z.string(),
  generatorVersion: z.number().int(),
  zoneKey: z.string(),
  seed: z.number().int(),
  depthCount: z.number().int(),
  startNodeId: z.string(),
  terminalNodeId: z.string(),
  attempts: z.number().int(),
  nodes: z.array(
    z.object({
      id: z.string(),
      depth: z.number().int(),
      lane: z.number().int(),
      type: nodeTypeSchema,
      outgoing: z.array(z.string()),
      content: z.object({ kind: z.enum(['enemy', 'event']), key: z.string() }).nullable(),
      source: z.object({ pool: z.string(), entryId: z.string() }).nullable(),
      rewardBandId: z.string().nullable(),
      extraction: z.boolean(),
      terminal: z.boolean(),
      boss: z.boolean(),
      // Set on nodes compiled from an authored room.
      roomId: z.string().optional(),
      name: z.string().optional(),
      reward: z
        .object({
          rewardTable: z.string().nullable(),
          equipmentRewardTable: z.string().nullable(),
          currency: z.object({ min: z.number().int(), max: z.number().int() }),
        })
        .optional(),
      restHealBasisPoints: z.number().int().optional(),
    }),
  ),
  edges: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })),
});

const previewSchema = z.object({
  zoneKey: z.string(),
  layoutMode: z.enum(DUNGEON_LAYOUT_MODES),
  seed: z.number().int(),
  graph: graphSchema,
  names: z.object({ enemies: z.record(z.string(), z.string()), events: z.record(z.string(), z.string()) }),
  /** What this graph did with the zone's structural rules, read off the graph. */
  structure: z.object({
    availableRegions: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
    artworkPath: z.string().nullable(),
    backgroundArtworkPath: z.string().nullable(),
    artworkAssetId: z.string().nullable(),
    backgroundAssetId: z.string().nullable(),
    scenes: z.object({
      version: z.number().int(),
      nodes: z.record(
        z.string(),
        z.object({
          background: z
            .object({ entryId: z.string(), assetId: z.string().nullable(), artworkPath: z.string().nullable() })
            .nullable(),
          enemy: z
            .object({
              spriteAssetId: z.string().nullable(),
              artworkAssetId: z.string().nullable(),
              spritePlacement: z.record(z.string(), z.unknown()).nullable(),
            })
            .optional(),
        }),
      ),
    }),
    restNodes: z.array(z.object({ id: z.string(), depth: z.number().int(), extraction: z.boolean() })),
    extractionNodes: z.array(z.object({ id: z.string(), depth: z.number().int(), type: nodeTypeSchema })),
    bossNodeId: z.string().nullable(),
    restBeforeBoss: z.object({ required: z.boolean(), satisfied: z.boolean() }),
  }),
});

const perType = z.record(nodeTypeSchema, z.number());
const appearanceSchema = z.object({
  key: z.string(),
  nodes: z.number().int(),
  runs: z.number().int(),
  runRate: z.number(),
});

const simulationSchema = z.object({
  zoneKey: z.string(),
  firstSeed: z.number().int(),
  runs: z.number().int(),
  valid: z.number().int(),
  invalid: z.number().int(),
  invalidRate: z.number(),
  failures: z.record(z.string(), z.number().int()),
  averageAttempts: z.number(),
  averageNodeCount: z.number(),
  minNodeCount: z.number().int(),
  maxNodeCount: z.number().int(),
  averageDepth: z.number(),
  nodeTypeCounts: perType,
  nodeTypeShare: perType,
  nodeTypeRunRate: perType,
  branchRate: z.number(),
  averageBranches: z.number(),
  bossRate: z.number(),
  restRate: z.number(),
  extractionRate: z.number(),
  averageExtractionPoints: z.number(),
  restCountDistribution: z.record(z.string(), z.number().int()),
  extractionCountDistribution: z.record(z.string(), z.number().int()),
  restBeforeBossRate: z.number(),
  enemies: z.array(appearanceSchema),
  events: z.array(appearanceSchema),
});

/** A saved zone by `key`, or an unsaved draft as `zone` — exactly one. */
const targetShape = { key: keySchema.optional(), zone: zoneBody.optional() };
const exactlyOneTarget = (body: { key?: string | undefined; zone?: unknown }) =>
  (body.key === undefined) !== (body.zone === undefined);
const targetMessage = { message: 'send exactly one of `key` (a saved zone) or `zone` (a draft)' };

const keyParams = z.object({ key: keySchema });

const conflictResponse = {
  409: errorSchema.describe(
    'DUNGEON_ZONE_STALE (someone saved first — details.currentRevision) or DUNGEON_ZONE_KEY_TAKEN.',
  ),
} as const;
const generationResponse = {
  422: errorSchema.describe('DUNGEON_GENERATION_FAILED — the rules cannot produce a run; details has the diagnostics.'),
} as const;

function toSummary(s: DungeonZoneSummary): z.infer<typeof summarySchema> {
  return { ...s, updatedAt: s.updatedAt.toISOString() };
}

function toDetail(d: DungeonZoneDetail): z.infer<typeof detailSchema> {
  return { ...toSummary(d), zone: d.zone as unknown as Record<string, unknown>, issues: d.issues };
}

function toCurrency(c: ProgressionCurrency): z.infer<typeof currencySchema> {
  return { ...c, updatedAt: c.updatedAt.toISOString() };
}

/**
 * Service errors that carry structure the editor needs, re-raised with it as
 * `details`: per-path issues, the revision a stale save lost to, and the
 * generator's diagnostics.
 */
function withDetails(err: unknown): unknown {
  if (err instanceof DungeonZoneInvalidError || err instanceof ProgressionCurrencyInvalidError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
  }
  if (err instanceof DungeonZoneStaleError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
      expectedRevision: err.expectedRevision,
      currentRevision: err.currentRevision,
      updatedBy: err.updatedBy,
      updatedAt: err.updatedAt.toISOString(),
    });
  }
  if (err instanceof ProgressionCurrencyStaleError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
      expectedRevision: err.expectedRevision,
      currentRevision: err.currentRevision,
    });
  }
  if (err instanceof DungeonGenerationError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, { ...err.diagnostics });
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

const targetOf = (body: { key?: string | undefined; zone?: Record<string, unknown> | undefined }): DungeonZoneTarget =>
  body.key !== undefined ? { key: body.key } : { zone: body.zone };

export const adminDungeonRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const zoneService = ctx.services.dungeonZones;
    const currencyService = ctx.services.progressionCurrency;
    const authorization = ctx.portalAuthorization;
    if (!zoneService || !currencyService) return;
    const zones: DungeonZoneService = zoneService;
    const currencies: ProgressionCurrencyService = currencyService;

    const gate =
      (permission: 'dungeons.read' | 'dungeons.write') =>
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

    const zoneNotFound = (key: string) =>
      new AppError('NOT_FOUND', `Dungeon zone "${key}" not found`, 'Not found.');

    /** The actor comes from the authenticated session, never the body. */
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const tags = ['Admin — Dungeons'];

    app.get(
      '/admin/dungeons/zones',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'List dungeon zones, with node range, pool counts, revision and origin',
          response: {
            200: dataSchema(z.object({ zones: z.array(summarySchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { zones: (await zones.list()).map(toSummary) }),
    );

    app.get(
      '/admin/dungeons/reference',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Enemies, events, reward tables, currencies and regions the zone editor offers',
          response: {
            200: dataSchema(
              z.object({
                nodeTypes: z.array(nodeTypeSchema),
                enemies: z.array(contentRefSchema),
                events: z.array(contentRefSchema),
                rewardTables: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
                currencies: z.array(
                  z.object({
                    key: z.string(),
                    singularName: z.string(),
                    pluralName: z.string(),
                    enabled: z.boolean(),
                  }),
                ),
                regions: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { nodeTypes: [...DUNGEON_NODE_TYPES], ...(await zones.reference()) }),
    );

    app.get(
      '/admin/dungeons/export',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Every live zone in the shipped file format (dungeons/zones.json), for committing back to Git',
          response: {
            200: dataSchema(
              z.object({
                file: z.string(),
                document: z.object({ format: z.string(), version: z.number().int(), zones: z.array(zoneBody) }),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const exported = await zones.export();
        return ok(req, {
          file: exported.file,
          document: {
            ...exported.document,
            zones: exported.document.zones as unknown as Record<string, unknown>[],
          },
        });
      },
    );

    app.post(
      '/admin/dungeons/validate',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Dry run: every issue saving this zone would raise, without writing',
          body: z.object({ zone: z.unknown(), key: keySchema.optional() }),
          response: {
            200: dataSchema(z.object({ issues: z.array(issueSchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { issues: await zones.validate(req.body.zone, req.body.key) }),
    );

    app.post(
      '/admin/dungeons/preview',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary:
            'One run of a saved zone (`key`) or an unsaved draft (`zone`), without persisting it: generated for ' +
            'a procedural zone, the authored layout itself for an authored one. ' +
            'The same `seed` always produces the same graph; omitted, a seed is drawn and returned',
          body: z.object({ ...targetShape, seed: seedSchema.optional() }).refine(exactlyOneTarget, targetMessage),
          response: {
            200: dataSchema(previewSchema),
            ...notFoundResponse,
            ...generationResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const preview = await translate(() => zones.preview(targetOf(req.body), req.body.seed));
        if (!preview) throw zoneNotFound(req.body.key ?? '');
        return ok(req, preview);
      },
    );

    app.post(
      '/admin/dungeons/simulate',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary:
            'Generate many runs of a procedural zone and summarise node counts, type distribution, branch and ' +
            'extraction rates, enemy appearances and the invalid-generation rate. Persists nothing. An authored ' +
            'zone has a fixed layout and is refused with 400',
          body: z
            .object({
              ...targetShape,
              runs: z.number().int().min(1).max(MAX_SIMULATION_RUNS).default(500),
              firstSeed: seedSchema.max(MAX_DUNGEON_SEED - MAX_SIMULATION_RUNS).default(1),
            })
            .refine(exactlyOneTarget, targetMessage),
          response: { 200: dataSchema(simulationSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const report = await translate(() =>
          zones.simulate(targetOf(req.body), { runs: req.body.runs, firstSeed: req.body.firstSeed }),
        );
        if (!report) throw zoneNotFound(req.body.key ?? '');
        return ok(req, report);
      },
    );

    app.get(
      '/admin/dungeons/zones/:key',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Get one dungeon zone, with its revision and current problems',
          params: keyParams,
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const detail = await zones.get(req.params.key);
        if (!detail) throw zoneNotFound(req.params.key);
        return ok(req, toDetail(detail));
      },
    );

    app.post(
      '/admin/dungeons/zones',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          tags,
          summary: 'Create a dungeon zone (409 when the key is taken). The key cannot be changed afterwards',
          body: z.object({ zone: zoneBody }),
          response: { 200: dataSchema(detailSchema), ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, toDetail(await translate(() => zones.create(req.body.zone, actorOf(req))))),
    );

    app.put(
      '/admin/dungeons/zones/:key',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          tags,
          summary:
            'Replace a dungeon zone. `expectedRevision` must be the revision you loaded; ' +
            'a stale save is refused with 409 DUNGEON_ZONE_STALE rather than overwriting',
          params: keyParams,
          body: z.object({
            zone: zoneBody,
            expectedRevision: revisionSchema,
            /** Required for a save that changes the zone's layout mode. */
            confirmLayoutChange: z.boolean().optional(),
          }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const detail = await translate(() => zones.update(req.params.key, req.body, actorOf(req)));
        if (!detail) throw zoneNotFound(req.params.key);
        return ok(req, toDetail(detail));
      },
    );

    app.put(
      '/admin/dungeons/zones/:key/enabled',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          tags,
          summary:
            'Enable or disable a zone. Disabling always succeeds; enabling is validated like a save. ' +
            'Runs already generated are unaffected',
          params: keyParams,
          body: z.object({ enabled: z.boolean(), expectedRevision: revisionSchema }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const detail = await translate(() => zones.setEnabled(req.params.key, req.body, actorOf(req)));
        if (!detail) throw zoneNotFound(req.params.key);
        return ok(req, toDetail(detail));
      },
    );

    /**
     * Zone artwork for the editor: the bytes of one authored path, and the
     * picker (one folder at a time, and a bounded search). Read-only and
     * rooted at {@link DUNGEON_ARTWORK_ROOTS}, so `dungeons.read` never lists
     * the rest of the assets tree. A path that is unsafe is 400; a well-formed
     * path with no file is 404 — which is what a typo looks like.
     */
    const assetsDir = ctx.assetsDir ?? './assets';
    app.get(
      '/admin/dungeons/artwork',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Stream zone artwork for the editor preview',
          querystring: adminArtworkQuery,
          response: { ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req, reply) => sendAdminArtwork(reply, assetsDir, req.query.path),
    );
    app.get(
      '/admin/dungeons/artwork/browse',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'List one folder of dungeon artwork for the picker',
          querystring: adminArtworkBrowseQuery,
          response: { 200: dataSchema(artworkDirectorySchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await browseAdminArtwork(assetsDir, DUNGEON_ARTWORK_ROOTS, req.query.path)),
    );
    app.get(
      '/admin/dungeons/artwork/search',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Search dungeon artwork by file name or folder',
          querystring: adminArtworkSearchQuery,
          response: { 200: dataSchema(artworkSearchSchema), ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, await searchAdminArtwork(assetsDir, DUNGEON_ARTWORK_ROOTS, req.query.q, req.query.limit)),
    );

    // Delve-wide settings. Registered only where the allowance service is wired.
    const allowance = ctx.services.dungeonAllowance;
    if (allowance) {
      app.get(
        '/admin/dungeons/settings',
        {
          preValidation: gate('dungeons.read'),
          schema: {
            tags,
            summary: 'Delve-wide settings: the daily run limit shared by every zone',
            response: { 200: dataSchema(settingsSchema), ...commonErrorResponses },
          },
        },
        async (req) => ok(req, toSettings(await allowance.getSettings())),
      );

      app.put(
        '/admin/dungeons/settings',
        {
          preValidation: gate('dungeons.write'),
          schema: {
            tags,
            summary:
              'Set the daily Delve run limit (runs a player may start per game day, across all zones). ' +
              '0 closes Delve to new runs; active runs are unaffected',
            // Only the type is enforced here: a fraction or an out-of-bounds value is
            // refused by the service with 400 DUNGEON_SETTINGS_INVALID.
            body: z.object({ dailyRunLimit: z.number() }).strict(),
            response: {
              200: dataSchema(settingsSchema),
              ...commonErrorResponses,
            },
          },
        },
        async (req) => ok(req, toSettings(await allowance.updateSettings(req.body, actorOf(req)))),
      );
    }

    app.get(
      '/admin/dungeons/currencies',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Progression currencies: stable key and editable display metadata',
          response: {
            200: dataSchema(z.object({ currencies: z.array(currencySchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { currencies: (await currencies.list()).map(toCurrency) }),
    );

    app.put(
      '/admin/dungeons/currencies/:key',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          tags,
          summary:
            "Edit a progression currency's display metadata. The key is the path and cannot be changed; " +
            'a stale save is refused with 409 PROGRESSION_CURRENCY_STALE',
          params: keyParams,
          body: z
            .object({
              singularName: z.string(),
              pluralName: z.string(),
              description: z.string().optional(),
              icon: z.string().nullable().optional(),
              enabled: z.boolean(),
              expectedRevision: revisionSchema,
            })
            .strict(),
          response: {
            200: dataSchema(currencySchema),
            ...notFoundResponse,
            409: errorSchema.describe('PROGRESSION_CURRENCY_STALE — someone saved first.'),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { expectedRevision, ...metadata } = req.body;
        const updated = await translate(() =>
          currencies.updateMetadata(req.params.key, { metadata, expectedRevision }, actorOf(req)),
        );
        if (!updated) {
          throw new AppError('NOT_FOUND', `Progression currency "${req.params.key}" not found`, 'Not found.');
        }
        return ok(req, toCurrency(updated));
      },
    );
  };
