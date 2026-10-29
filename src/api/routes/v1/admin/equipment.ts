/**
 * Portal admin — the Equipment Catalogue (Equipment 3.0, E3-D).
 *
 *   - `equipment.read`  — list, get, validate (a dry run), reward impact,
 *     roll previews (analysis and seeded samples), export, history, and the
 *     artwork picker routes.
 *   - `equipment.write` — create, update, enable/disable, duplicate, import
 *     preview and apply.
 *
 * Everything goes through `EquipmentCatalogueService`, which writes only
 * through the existing definition and package services. Server-side rules
 * the Portal cannot bypass:
 *
 *   - a created, duplicated or imported definition starts **disabled**;
 *   - an edit never changes the enabled state, and an import never enables
 *     (or disables) an existing definition;
 *   - enabling N/R/SR gear that would join an automatic reward source at once
 *     is refused with `409 EQUIPMENT_ENABLE_CONFIRMATION_REQUIRED` (the
 *     sources in `details.impact`) until `acknowledgeRewardImpact` is sent;
 *   - every write names the revision it edited — a stale one is
 *     `409 EQUIPMENT_DEFINITION_STALE` — and an import applies only the plan
 *     it previewed (`409 EQUIPMENT_IMPORT_STALE` otherwise).
 *
 * Validation failures are `400 EQUIPMENT_INVALID` with per-field
 * `details.issues`. Roll previews never grant, store or log anything.
 * Nothing here grants equipment to a player.
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
  EquipmentDefinitionStaleError,
  EquipmentEnableConfirmationRequiredError,
  EquipmentExportKeysNotFoundError,
  EquipmentExportRefusedError,
  EquipmentValidationError,
} from '../../../../shared/errors';
import { EquipmentImportRejectedError } from '../../../../modules/equipment/equipmentImportService';
import { EQUIPMENT_PACKAGE_MAX_BYTES } from '../../../../modules/equipment/equipmentPackage';
import {
  CATALOGUE_MAX_PAGE_SIZE,
  CATALOGUE_SORTS,
  SAMPLE_ROLL_MAX,
  type CatalogueDefinition,
  type CatalogueDetail,
  type EquipmentCatalogueService,
} from '../../../../modules/equipment/equipmentCatalogueService';
import {
  EQUIPMENT_AUTHORING_RARITIES,
  EQUIPMENT_KEY_MAX_LENGTH,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_SLOTS,
} from '../../../../modules/equipment/vocabulary';

/** Where equipment artwork lives, relative to the assets root (`definitionSchema` convention). */
export const EQUIPMENT_ARTWORK_ROOTS = ['equipment'] as const;

/**
 * Request-body ceiling for import preview and apply: the largest package an
 * export may produce ({@link EQUIPMENT_PACKAGE_MAX_BYTES}, compact JSON) plus
 * room for the `{ package, expectedPlanHash, sourceFilename }` wrapper. The
 * API's global 64 KB limit would refuse a few hundred definitions, so a
 * server could not re-import its own export.
 *
 * Route-scoped on purpose, as for encounter import: every other endpoint keeps
 * 64 KB. These two routes gate permission at `onRequest`, before the body is
 * read, so only an `equipment.write` caller can spend the larger limit. The
 * Portal's Nginx allows slightly more on `/api/v1/admin/equipment/import/`,
 * so this limit's JSON 413 is what callers meet.
 */
export const EQUIPMENT_IMPORT_BODY_LIMIT_BYTES = EQUIPMENT_PACKAGE_MAX_BYTES + 64 * 1024;

const keySchema = z.string().min(1).max(EQUIPMENT_KEY_MAX_LENGTH).regex(EQUIPMENT_KEY_PATTERN);
/** The shared definition schema validates the body itself, so a bad field is an issue at that field. */
const definitionBody = z.record(z.string(), z.unknown());
const revisionSchema = z.number().int().positive();
const issueSchema = z.object({ path: z.string(), message: z.string() });

const definitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  slot: z.string(),
  rarity: z.string(),
  multiplierMinBp: z.number().int(),
  multiplierMaxBp: z.number().int(),
  multiplierStepBp: z.number().int(),
  primarySpEligible: z.boolean(),
  maxAdditionalBonuses: z.number().int().nullable(),
  secondaryEffects: z.array(z.unknown()),
  tags: z.array(z.string()),
  regionId: z.string().nullable(),
  artworkPath: z.string().nullable(),
  enabled: z.boolean(),
  shopRegions: z.array(z.string()),
  buyPrice: z.number().int().nullable(),
  priceCurrency: z.string(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  ownedCount: z.number().int(),
  instanceCount: z.number().int(),
});

const familySchema = z.object({
  stat: z.string(),
  label: z.string(),
  unit: z.enum(['percent', 'sp']),
  min: z.number().int(),
  max: z.number().int(),
  step: z.number().int(),
});
const multiplierSchema = z.object({ min: z.number().int(), max: z.number().int(), step: z.number().int(), values: z.number().int() });

const rollAnalysisSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('legacy'),
    rarity: z.string(),
    multiplier: multiplierSchema,
    bonusChanceBp: z.number().int(),
    bonusCount: z.number().int(),
    families: z.array(familySchema),
    affixPool: z.string(),
    enabledAffixes: z.number().int(),
    issues: z.array(issueSchema),
  }),
  z.object({
    mode: z.literal('high'),
    rarity: z.string(),
    rulesRevision: z.number().int().nullable(),
    configured: z.boolean(),
    rollable: z.boolean(),
    issues: z.array(issueSchema),
    multiplier: multiplierSchema,
    primarySpEligible: z.boolean(),
    maxAdditionalBonuses: z.number().int().nullable(),
    counts: z.array(z.object({ count: z.number().int(), probability: z.number() })),
    families: z.array(familySchema),
    primarySp: z.object({ probability: z.number(), min: z.number().int(), max: z.number().int(), step: z.number().int() }).nullable(),
    affix: z.union([
      z.object({ mode: z.literal('none') }),
      z.object({
        mode: z.literal('library'),
        library: z.string(),
        revision: z.number().int().nullable(),
        candidates: z.number().int().nullable(),
      }),
    ]),
    spRange: z.object({ min: z.number().int(), max: z.number().int() }),
  }),
  z.object({ mode: z.literal('unsupported'), rarity: z.string(), issues: z.array(issueSchema) }),
]);

const availabilitySchema = z.object({
  enabled: z.boolean(),
  rollConfiguration: z.enum(['legacy', 'published', 'unconfigured', 'invalid', 'unsupported']),
  rollable: z.boolean(),
  rewardRarity: z.boolean(),
  summary: z.string(),
});

const detailSchema = z.object({
  definition: definitionSchema,
  locks: z.object({ slotLocked: z.boolean(), rarityLocked: z.boolean(), instanceCount: z.number().int() }),
  roll: rollAnalysisSchema,
  availability: availabilitySchema,
});

const impactEntrySchema = z.object({
  source: z.enum(['boss_reward_table', 'expedition_reward_table', 'world_encounter', 'workshop_recipe', 'dungeon_loot_table']),
  key: z.string(),
  name: z.string(),
  location: z.string(),
  selector: z.string(),
  when: z.enum(['immediately', 'next_deploy', 'next_publish']),
});
const impactSchema = z.object({
  rewardRarity: z.boolean(),
  automatic: z.array(impactEntrySchema),
  deferred: z.array(impactEntrySchema),
});

const bonusSchema = z.object({ stat: z.string(), valueBp: z.number().int() });
const previewSchema = z.object({
  analysis: rollAnalysisSchema,
  availability: availabilitySchema,
  samples: z
    .array(
      z.object({
        displayName: z.string(),
        rolledMultiplierBp: z.number().int(),
        affixKey: z.string().nullable(),
        combatBonuses: z.array(bonusSchema),
        primarySp: z.number().int(),
        totalFlatSp: z.number().int(),
      }),
    )
    .nullable(),
  seed: z.number().int().nullable(),
  sampleError: z.string().nullable(),
});

const packageSchema = z.object({
  format: z.string(),
  version: z.number().int(),
  exportedAt: z.string().nullable(),
  label: z.string().nullable(),
  definitions: z.array(z.record(z.string(), z.unknown())),
});

const planSchema = z.object({
  entries: z.array(z.object({ key: z.string(), action: z.enum(['create', 'update', 'unchanged']), changedFields: z.array(z.string()) })),
  issues: z.array(issueSchema),
  counts: z.object({ create: z.number().int(), update: z.number().int(), unchanged: z.number().int() }),
  ok: z.boolean(),
});
const statusNoteSchema = z.object({
  key: z.string(),
  packageEnabled: z.boolean(),
  enabled: z.boolean(),
  reason: z.enum(['new_definitions_start_disabled', 'existing_status_kept']),
});
const importPreviewSchema = planSchema.extend({
  planHash: z.string(),
  statusNotes: z.array(statusNoteSchema),
  rewardImpact: z.array(z.object({ key: z.string(), impact: impactSchema })),
  artwork: z.object({
    checked: z.boolean(),
    warnings: z.array(z.object({ key: z.string(), artworkPath: z.string(), status: z.enum(['missing', 'unsafe']) })),
  }),
});
const importResultSchema = z.object({
  plan: planSchema,
  logId: z.number().int(),
  planHash: z.string(),
  statusNotes: z.array(statusNoteSchema),
});

const historySchema = z.object({
  events: z.array(
    z.object({
      id: z.number().int(),
      key: z.string(),
      action: z.string(),
      actor: z.string().nullable(),
      details: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
  imports: z.array(
    z.object({
      id: z.number().int(),
      actor: z.string().nullable(),
      appliedAt: z.string(),
      packageVersion: z.number().int(),
      packageLabel: z.string().nullable(),
      sourceFilename: z.string().nullable(),
      created: z.number().int(),
      updated: z.number().int(),
      unchanged: z.number().int(),
      definitionKeys: z.array(z.string()),
    }),
  ),
});

const catalogueQuery = z.object({
  q: z.string().max(200).optional(),
  rarity: z.enum(EQUIPMENT_AUTHORING_RARITIES).optional(),
  slot: z.enum(EQUIPMENT_SLOTS).optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
  sort: z.enum(CATALOGUE_SORTS as [string, ...string[]]).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(CATALOGUE_MAX_PAGE_SIZE).optional(),
});

function toDefinition(d: CatalogueDefinition): z.infer<typeof definitionSchema> {
  return { ...d, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString() };
}
function toDetail(d: CatalogueDetail): z.infer<typeof detailSchema> {
  return { ...d, definition: toDefinition(d.definition) };
}

/** Service errors that carry structure the editor needs, re-raised with it as `details`. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof EquipmentValidationError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
    }
    if (err instanceof EquipmentImportRejectedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues, plan: err.plan });
    }
    if (err instanceof EquipmentDefinitionStaleError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        expectedRevision: err.expectedRevision,
        currentRevision: err.currentRevision,
        updatedBy: err.updatedBy,
        updatedAt: err.updatedAt.toISOString(),
      });
    }
    if (err instanceof EquipmentEnableConfirmationRequiredError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { impact: err.impact });
    }
    if (err instanceof EquipmentExportKeysNotFoundError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { missingKeys: err.missingKeys });
    }
    if (err instanceof EquipmentExportRefusedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { reason: err.reason, issues: err.issues });
    }
    throw err;
  }
}

const conflictResponse = {
  409: errorSchema.describe(
    'EQUIPMENT_DEFINITION_STALE — someone saved first (details: expectedRevision, currentRevision). ' +
      'EQUIPMENT_KEY_TAKEN — the key is in use. EQUIPMENT_SLOT_LOCKED / EQUIPMENT_RARITY_LOCKED — players own copies. ' +
      'EQUIPMENT_ENABLE_CONFIRMATION_REQUIRED — enabling joins automatic rewards (details.impact). ' +
      'EQUIPMENT_IMPORT_STALE / EQUIPMENT_IMPORT_CONFLICT — preview the import again.',
  ),
};

export const adminEquipmentRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.equipmentCatalogue;
    const authorization = ctx.portalAuthorization;
    if (!service) return;
    const catalogue: EquipmentCatalogueService = service;

    const gate =
      (permission: 'equipment.read' | 'equipment.write') =>
      async (req: FastifyRequest): Promise<void> => {
        if (!authorization) {
          throw new AppError('PORTAL_PERMISSION_DENIED', 'Portal authorization service is not configured', 'Admin features are unavailable.');
        }
        await requirePortalPermission(req, authorization, permission, { allowBearer: ctx.adminBearerAllowed === true });
      };

    const notFound = (key: string) => new AppError('NOT_FOUND', `Equipment definition "${key}" not found`, 'Not found.');
    /** The actor comes from the authenticated session, never the body. */
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const tags = ['Admin — Equipment'];
    const keyParams = z.object({ key: keySchema });

    app.get(
      '/admin/equipment/definitions',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary: 'Search, filter, sort and page the equipment catalogue (all six rarities), with catalogue counts',
          querystring: catalogueQuery,
          response: {
            200: dataSchema(
              z.object({
                definitions: z.array(definitionSchema),
                total: z.number().int(),
                page: z.number().int(),
                pageSize: z.number().int(),
                counts: z.object({
                  total: z.number().int(),
                  enabled: z.number().int(),
                  disabled: z.number().int(),
                  byRarity: z.record(z.string(), z.number().int()),
                }),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const query = Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== undefined));
        const page = await catalogue.list(query as NonNullable<Parameters<EquipmentCatalogueService['list']>[0]>);
        return ok(req, { ...page, definitions: page.definitions.map(toDefinition) });
      },
    );

    app.post(
      '/admin/equipment/definitions/validate',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary: 'Dry run: every issue creating or saving this definition would raise, without writing',
          body: z.object({ definition: z.unknown(), creating: z.boolean().default(false), key: z.string().max(200).optional() }),
          response: { 200: dataSchema(z.object({ issues: z.array(issueSchema) })), ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, {
          issues: await catalogue.validate(req.body.definition, {
            creating: req.body.creating,
            ...(req.body.key !== undefined ? { key: req.body.key } : {}),
          }),
        }),
    );

    app.post(
      '/admin/equipment/definitions',
      {
        preValidation: gate('equipment.write'),
        schema: {
          tags,
          summary: 'Create a definition. It always starts disabled, whatever `enabled` says; the key is permanent',
          body: z.object({ definition: definitionBody }),
          response: { 200: dataSchema(detailSchema), ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, toDetail(await translate(() => catalogue.create(req.body.definition, actorOf(req))))),
    );

    app.get(
      '/admin/equipment/definitions/:key',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary: 'One definition with its revision, field locks, roll analysis and availability',
          params: keyParams,
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const detail = await catalogue.get(req.params.key);
        if (!detail) throw notFound(req.params.key);
        return ok(req, toDetail(detail));
      },
    );

    app.put(
      '/admin/equipment/definitions/:key',
      {
        preValidation: gate('equipment.write'),
        schema: {
          tags,
          summary:
            'Save a definition. `expectedRevision` must be the revision you loaded (409 EQUIPMENT_DEFINITION_STALE ' +
            'otherwise). The enabled state is kept — use the enabled route. Affects future grants only',
          params: keyParams,
          body: z.object({ definition: definitionBody, expectedRevision: revisionSchema }),
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(
          req,
          toDetail(
            await translate(() =>
              catalogue.update(req.params.key, req.body.definition, { expectedRevision: req.body.expectedRevision, actor: actorOf(req) }),
            ),
          ),
        ),
    );

    app.put(
      '/admin/equipment/definitions/:key/enabled',
      {
        preValidation: gate('equipment.write'),
        schema: {
          tags,
          summary:
            'Enable or disable a definition. Enabling N/R/SR gear that joins automatic rewards at once needs ' +
            '`acknowledgeRewardImpact: true` (409 EQUIPMENT_ENABLE_CONFIRMATION_REQUIRED with details.impact otherwise)',
          params: keyParams,
          body: z.object({ enabled: z.boolean(), expectedRevision: revisionSchema, acknowledgeRewardImpact: z.boolean().optional() }),
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(
          req,
          toDetail(
            await translate(() =>
              catalogue.setEnabled(req.params.key, req.body.enabled, {
                expectedRevision: req.body.expectedRevision,
                ...(req.body.acknowledgeRewardImpact !== undefined ? { acknowledgeRewardImpact: req.body.acknowledgeRewardImpact } : {}),
                actor: actorOf(req),
              }),
            ),
          ),
        ),
    );

    app.post(
      '/admin/equipment/definitions/:key/duplicate',
      {
        preValidation: gate('equipment.write'),
        schema: {
          tags,
          summary: 'Copy a definition’s authoring fields under a new key. The copy starts disabled; no owned copies or rolls travel',
          params: keyParams,
          body: z.object({ key: z.string().max(200), name: z.string().max(200).optional() }),
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(
          req,
          toDetail(
            await translate(() =>
              catalogue.duplicate(req.params.key, {
                key: req.body.key,
                ...(req.body.name !== undefined ? { name: req.body.name } : {}),
                actor: actorOf(req),
              }),
            ),
          ),
        ),
    );

    app.get(
      '/admin/equipment/definitions/:key/impact',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary:
            'The automatic reward sources this definition would join if enabled, resolved with the live selectors. ' +
            'Always empty for SSR/UR/LR',
          params: keyParams,
          response: { 200: dataSchema(impactSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const detail = await catalogue.get(req.params.key);
        if (!detail) throw notFound(req.params.key);
        return ok(req, await catalogue.impact(detail.definition));
      },
    );

    app.post(
      '/admin/equipment/roll-preview',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary:
            'Roll analysis for a stored key or an unsaved definition under the published rules; with `seed`, up to ' +
            `${SAMPLE_ROLL_MAX} deterministic sample rolls. Grants, stores and logs nothing`,
          body: z
            .object({
              key: z.string().max(200).optional(),
              definition: z.unknown().optional(),
              seed: z.number().int().min(0).max(0xffff_ffff).optional(),
              count: z.number().int().min(1).max(SAMPLE_ROLL_MAX).optional(),
            })
            .refine((b) => (b.key === undefined) !== (b.definition === undefined), 'give exactly one of key or definition'),
          response: { 200: dataSchema(previewSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const target = req.body.key !== undefined ? { key: req.body.key } : { input: req.body.definition };
        const opts = {
          ...(req.body.seed !== undefined ? { seed: req.body.seed } : {}),
          ...(req.body.count !== undefined ? { count: req.body.count } : {}),
        };
        return ok(req, await translate(() => catalogue.previewRoll(target, opts)));
      },
    );

    app.get(
      '/admin/equipment/export',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary:
            'A `waifumon-equipment` v3 package: every definition, exactly the named `keys` (comma-separated), or ' +
            'the ones matching the catalogue filters. Definitions only — never owned copies or rolls. Unknown keys ' +
            'are 404 EQUIPMENT_EXPORT_KEYS_NOT_FOUND (details.missingKeys); an empty selection or filter, or a ' +
            'package larger than import accepts, is 422 EQUIPMENT_EXPORT_REFUSED — never a wider export',
          querystring: catalogueQuery.extend({ keys: z.string().max(10_000).optional(), label: z.string().max(200).optional() }),
          response: {
            200: dataSchema(packageSchema),
            ...notFoundResponse,
            422: errorSchema.describe('EQUIPMENT_EXPORT_REFUSED — details.reason: empty, too_large or unportable (details.issues).'),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { keys, label, ...query } = req.query;
        // A `keys` parameter is a selection even when it lists nothing.
        const list = keys
          ?.split(',')
          .map((k) => k.trim())
          .filter((k) => k !== '');
        const filteredQuery = Object.values(query).some((v) => v !== undefined)
          ? (Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as NonNullable<Parameters<EquipmentCatalogueService['list']>[0]>)
          : null;
        const pkg = await translate(() =>
          catalogue.exportPackage({
            ...(list !== undefined ? { keys: list } : {}),
            ...(filteredQuery ? { query: filteredQuery } : {}),
            label: label ?? null,
          }),
        );
        return ok(req, pkg as unknown as z.infer<typeof packageSchema>);
      },
    );

    app.post(
      '/admin/equipment/import/preview',
      {
        onRequest: gate('equipment.write'),
        bodyLimit: EQUIPMENT_IMPORT_BODY_LIMIT_BYTES,
        schema: {
          tags,
          summary:
            'Validate and plan a package (v2 or v3) without writing: creates, updates, refusals, status overrides ' +
            '(new definitions start disabled), reward impact of new N/R/SR gear, and the `planHash` apply needs',
          body: z.object({ package: z.unknown() }),
          response: { 200: dataSchema(importPreviewSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const { package: _pkg, ...preview } = await translate(() => catalogue.previewImport(req.body.package));
        return ok(req, preview);
      },
    );

    app.post(
      '/admin/equipment/import/apply',
      {
        onRequest: gate('equipment.write'),
        bodyLimit: EQUIPMENT_IMPORT_BODY_LIMIT_BYTES,
        schema: {
          tags,
          summary:
            'Apply a previewed package atomically. `expectedPlanHash` must be the preview’s; if the catalogue moved ' +
            'since, nothing is applied (409 EQUIPMENT_IMPORT_STALE)',
          body: z.object({ package: z.unknown(), expectedPlanHash: z.string().min(1).max(200), sourceFilename: z.string().max(255).optional() }),
          response: { 200: dataSchema(importResultSchema), ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(
          req,
          await translate(() =>
            catalogue.applyImport(req.body.package, {
              expectedPlanHash: req.body.expectedPlanHash,
              actor: actorOf(req),
              sourceFilename: req.body.sourceFilename ?? null,
            }),
          ),
        ),
    );

    app.get(
      '/admin/equipment/history',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary: 'Definition audit events (create, update, enable, disable, duplicate, import) and package imports, newest first',
          querystring: z.object({ key: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
          response: { 200: dataSchema(historySchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const history = await catalogue.history({
          ...(req.query.key !== undefined ? { key: req.query.key } : {}),
          ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
        });
        return ok(req, {
          events: history.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
          imports: history.imports.map((i) => ({ ...i, appliedAt: i.appliedAt.toISOString() })),
        });
      },
    );

    // ── artwork: the shared picker, rooted at the equipment folder ─────────
    const assetsDir = ctx.assetsDir ?? './assets';
    app.get(
      '/admin/equipment/artwork',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary: 'Stream an equipment artwork file for the editor preview',
          querystring: adminArtworkQuery,
          response: { ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req, reply) => {
        // Only equipment's own folder: never another area's artwork.
        if (!EQUIPMENT_ARTWORK_ROOTS.some((root) => req.query.path.startsWith(`${root}/`))) {
          throw new AppError('VALIDATION_ERROR', 'Equipment artwork must be under equipment/', 'Equipment artwork lives under equipment/.');
        }
        return sendAdminArtwork(reply, assetsDir, req.query.path);
      },
    );
    app.get(
      '/admin/equipment/artwork/browse',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary: 'List one folder of equipment artwork (under assets/equipment) for the picker',
          querystring: adminArtworkBrowseQuery,
          response: { 200: dataSchema(artworkDirectorySchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await browseAdminArtwork(assetsDir, EQUIPMENT_ARTWORK_ROOTS, req.query.path)),
    );
    app.get(
      '/admin/equipment/artwork/search',
      {
        preValidation: gate('equipment.read'),
        schema: {
          tags,
          summary: 'Search equipment artwork by file name or folder',
          querystring: adminArtworkSearchQuery,
          response: { 200: dataSchema(artworkSearchSchema), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await searchAdminArtwork(assetsDir, EQUIPMENT_ARTWORK_ROOTS, req.query.q, req.query.limit)),
    );
  };
