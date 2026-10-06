/**
 * Portal admin — the Enemy Catalogue.
 *
 * Combat enemies are shared content: dungeons and Combat Trials reference
 * them by key, and they are authored here rather than inside either.
 *
 *   - `enemies.read`  — list, get (with usage and current problems), the
 *     picker reference, references, validate (a dry run), export.
 *   - `enemies.write` — create, update, enable/disable, duplicate, delete.
 *
 * Every write names the revision it edited; a stale one is refused with
 * `409 ENEMY_STALE` rather than overwriting. Validation failures are
 * `400 ENEMY_INVALID` with per-field `details.issues`. Delete is refused with
 * `409 ENEMY_IN_USE` (and `details.references`) while anything names the
 * enemy, or while Git ships it — disable it instead.
 *
 * Nothing here is reachable by a player, and none of the administrative
 * fields (revision, origin, hashes, who edited) appear on any player route.
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiErrorWithDetails } from '../../../errors';
import { AppError, EnemyInUseError, EnemyInvalidError, EnemyStaleError } from '../../../../shared/errors';
import { SPRITE_ANCHORS } from '../../../../modules/artworkAssets/scenePlacement';
import { COMBAT_ENEMY_KEY_MAX_LENGTH, COMBAT_ENEMY_KEY_PATTERN } from '../../../../modules/combat/enemyDefinitions';
import type {
  EnemyCatalogueService,
  EnemyDetail,
  EnemySummary,
} from '../../../../modules/enemies/enemyService';

const keySchema = z.string().min(1).max(COMBAT_ENEMY_KEY_MAX_LENGTH).regex(COMBAT_ENEMY_KEY_PATTERN);
/** The service validates the enemy itself, so a bad field is an issue at that field, not a schema 400. */
const enemyBody = z.record(z.string(), z.unknown());
const revisionSchema = z.number().int().positive();

const placementSchema = z.object({
  anchor: z.enum(SPRITE_ANCHORS),
  scaleBasisPoints: z.number().int(),
  offsetX: z.number().int(),
  offsetY: z.number().int(),
});

const issueSchema = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});

const referenceSchema = z.object({
  kind: z.string(),
  key: z.string(),
  name: z.string().nullable(),
  usage: z.string(),
});

/** One enemy as a picker shows it. Shared with the Dungeon editor's reference data. */
export const enemyRefSchema = z.object({
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  attack: z.number().int(),
  defense: z.number().int(),
  hp: z.number().int(),
  tags: z.array(z.string()),
  visual: z.object({
    artworkAssetId: z.string().nullable(),
    artworkPath: z.string().nullable(),
    spriteAssetId: z.string().nullable(),
    spriteArtworkPath: z.string().nullable(),
    spritePlacement: placementSchema,
  }),
});

const definitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  attack: z.number().int(),
  defense: z.number().int(),
  hp: z.number().int(),
  artworkPath: z.string().nullable(),
  spriteArtworkPath: z.string().nullable(),
  spritePlacement: placementSchema.nullable(),
  enabled: z.boolean(),
  tags: z.array(z.string()),
});

const summarySchema = enemyRefSchema.extend({
  description: z.string(),
  artworkPath: z.string().nullable(),
  spriteArtworkPath: z.string().nullable(),
  artworkAssetId: z.string().nullable(),
  spriteAssetId: z.string().nullable(),
  spritePlacement: placementSchema.nullable(),
  revision: z.number().int(),
  origin: z.enum(['shipped', 'edited', 'custom']),
  matchesShipped: z.boolean().nullable(),
  usageCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

const detailSchema = summarySchema.extend({
  references: z.array(referenceSchema),
  issues: z.array(issueSchema),
  shipped: definitionSchema.nullable(),
});

const exportSchema = z.object({
  file: z.string(),
  document: z.object({
    format: z.string(),
    version: z.number().int(),
    enemies: z.array(definitionSchema),
  }),
  environmentLocal: z.object({
    note: z.string(),
    managedArtwork: z.array(
      z.object({ key: z.string(), artworkAssetId: z.string().nullable(), spriteAssetId: z.string().nullable() }),
    ),
  }),
});

function toSummary(s: EnemySummary): z.infer<typeof summarySchema> {
  return { ...s, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() };
}

function toDetail(d: EnemyDetail): z.infer<typeof detailSchema> {
  return { ...toSummary(d), references: d.references, issues: d.issues, shipped: d.shipped };
}

/** Service errors that carry structure the editor needs, re-raised with it as `details`. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof EnemyInvalidError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
    }
    if (err instanceof EnemyStaleError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        expectedRevision: err.expectedRevision,
        currentRevision: err.currentRevision,
        updatedBy: err.updatedBy,
        updatedAt: err.updatedAt.toISOString(),
      });
    }
    if (err instanceof EnemyInUseError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        references: err.references,
        shipped: err.shipped,
      });
    }
    throw err;
  }
}

const conflictResponse = {
  409: errorSchema.describe(
    'ENEMY_STALE — someone saved first (details: expectedRevision, currentRevision). ' +
      'ENEMY_KEY_TAKEN — the key is in use. ENEMY_IN_USE — still referenced or shipped (details.references).',
  ),
};

export const adminEnemyRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.enemies;
    const authorization = ctx.portalAuthorization;
    if (!service) return;
    const enemies: EnemyCatalogueService = service;

    const gate =
      (permission: 'enemies.read' | 'enemies.write') =>
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

    const notFound = (key: string) => new AppError('NOT_FOUND', `Enemy "${key}" not found`, 'Not found.');
    /** The actor comes from the authenticated session, never the body. */
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const tags = ['Admin — Enemies'];
    const keyParams = z.object({ key: keySchema });

    app.get(
      '/admin/enemies',
      {
        preValidation: gate('enemies.read'),
        schema: {
          tags,
          summary: 'List every enemy: stats, tags, artwork in effect, usage count, revision and origin',
          response: { 200: dataSchema(z.object({ enemies: z.array(summarySchema) })), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, { enemies: (await enemies.list()).map(toSummary) }),
    );

    app.get(
      '/admin/enemies/reference',
      {
        preValidation: gate('enemies.read'),
        schema: {
          tags,
          summary:
            'Picker rows for every enemy (key, name, enabled, stats, tags, artwork in effect). ' +
            'The same read model the Dungeon editor is given',
          response: { 200: dataSchema(z.object({ enemies: z.array(enemyRefSchema) })), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, { enemies: await enemies.reference() }),
    );

    app.get(
      '/admin/enemies/export',
      {
        preValidation: gate('enemies.read'),
        schema: {
          tags,
          summary:
            'Every enemy as a `waifumon-combat-enemies` document, ready to commit as content/combat/enemies.json. ' +
            'Managed artwork is environment-local: it is listed beside the document, not in it',
          response: { 200: dataSchema(exportSchema), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await enemies.export()),
    );

    app.post(
      '/admin/enemies/validate',
      {
        preValidation: gate('enemies.read'),
        schema: {
          tags,
          summary: 'Dry run: every issue creating or saving this enemy would raise, without writing',
          body: z.object({ key: z.string().max(200), enemy: z.unknown(), creating: z.boolean().default(false) }),
          response: { 200: dataSchema(z.object({ issues: z.array(issueSchema) })), ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, {
          issues: await enemies.validate({ key: req.body.key, enemy: req.body.enemy, creating: req.body.creating }),
        }),
    );

    app.post(
      '/admin/enemies',
      {
        preValidation: gate('enemies.write'),
        schema: {
          tags,
          summary: 'Create an enemy (409 when the key is taken). The key cannot be changed afterwards',
          body: z.object({ key: z.string().max(200), enemy: enemyBody }),
          response: { 200: dataSchema(detailSchema), ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, toDetail(await translate(() => enemies.create(req.body.key, req.body.enemy, actorOf(req))))),
    );

    app.get(
      '/admin/enemies/:key',
      {
        preValidation: gate('enemies.read'),
        schema: {
          tags,
          summary: 'Get one enemy, with its revision, where it is used and its current problems',
          params: keyParams,
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const enemy = await enemies.get(req.params.key);
        if (!enemy) throw notFound(req.params.key);
        return ok(req, toDetail(enemy));
      },
    );

    app.get(
      '/admin/enemies/:key/references',
      {
        preValidation: gate('enemies.read'),
        schema: {
          tags,
          summary: 'Where an enemy is used: dungeon pools and rooms, Combat Trials',
          params: keyParams,
          response: {
            200: dataSchema(z.object({ references: z.array(referenceSchema) })),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const references = await enemies.references(req.params.key);
        if (!references) throw notFound(req.params.key);
        return ok(req, { references });
      },
    );

    app.put(
      '/admin/enemies/:key',
      {
        preValidation: gate('enemies.write'),
        schema: {
          tags,
          summary:
            'Save an enemy. `expectedRevision` must be the revision you loaded; a stale save is refused with ' +
            '409 ENEMY_STALE rather than overwriting. Artwork fields left out are kept as they are. ' +
            'Runs already started keep the enemy they snapshotted',
          params: keyParams,
          body: z.object({ enemy: enemyBody, expectedRevision: revisionSchema }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const saved = await translate(() => enemies.update(req.params.key, req.body, actorOf(req)));
        if (!saved) throw notFound(req.params.key);
        return ok(req, toDetail(saved));
      },
    );

    app.put(
      '/admin/enemies/:key/enabled',
      {
        preValidation: gate('enemies.write'),
        schema: {
          tags,
          summary:
            'Enable or disable an enemy. A disabled enemy keeps every reference to it; it is only withdrawn ' +
            'from new use',
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
        const saved = await translate(() => enemies.setEnabled(req.params.key, req.body, actorOf(req)));
        if (!saved) throw notFound(req.params.key);
        return ok(req, toDetail(saved));
      },
    );

    app.post(
      '/admin/enemies/:key/duplicate',
      {
        preValidation: gate('enemies.write'),
        schema: {
          tags,
          summary:
            'Copy an enemy under a new key. The copy starts disabled; `copyArtwork` (default true) also copies ' +
            'its artwork references and placement',
          params: keyParams,
          body: z.object({
            key: z.string().max(200),
            name: z.string().max(200).optional(),
            copyArtwork: z.boolean().optional(),
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
        const copy = await translate(() => enemies.duplicate(req.params.key, req.body, actorOf(req)));
        if (!copy) throw notFound(req.params.key);
        return ok(req, toDetail(copy));
      },
    );

    app.delete(
      '/admin/enemies/:key',
      {
        preValidation: gate('enemies.write'),
        schema: {
          tags,
          summary:
            'Delete an enemy nothing references and Git does not ship (409 ENEMY_IN_USE otherwise, with the ' +
            'references — disable it instead)',
          params: keyParams,
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
        const deleted = await translate(() =>
          enemies.delete(req.params.key, { expectedRevision: req.query.expectedRevision }, actorOf(req)),
        );
        if (!deleted) throw notFound(req.params.key);
        return ok(req, { ok: true });
      },
    );
  };
