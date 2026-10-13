import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema } from '../../../schemas/common';
import { ApiErrorWithDetails } from '../../../errors';
import { AppError } from '../../../../shared/errors';
import { SceneSpriteError } from '../../../../modules/dungeons/sceneSprites/sceneSpriteService';
import {
  SceneSpriteInputSchema,
  SceneSpriteKeySchema,
} from '../../../../modules/dungeons/sceneSprites/sceneSpriteDefinition';

const summary = SceneSpriteInputSchema.extend({
  key: z.string(),
  revision: z.number(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
const detail = summary.extend({
  references: z.array(
    z.object({
      dungeonKey: z.string(),
      name: z.string(),
      source: z.string(),
      roomId: z.string(),
      actionId: z.string().optional(),
      instanceId: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      action: z.string(),
      actor: z.string().nullable(),
      createdAt: z.string(),
      details: z.record(z.unknown()),
    }),
  ),
});
const response = {
  200: dataSchema(detail),
  409: errorSchema,
  404: errorSchema,
  ...commonErrorResponses,
};
const params = z.object({ key: SceneSpriteKeySchema });
const revision = z.number().int().positive();

export const adminDungeonSceneSpriteRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.dungeonSceneSprites;
    if (!service) return;
    const gate = (permission: 'dungeons.read' | 'dungeons.write') => async (req: FastifyRequest) => {
      if (!ctx.portalAuthorization)
        throw new AppError(
          'PORTAL_PERMISSION_DENIED',
          'Portal authorization unavailable',
          'Admin features are unavailable.',
        );
      await requirePortalPermission(req, ctx.portalAuthorization, permission, {
        allowBearer: ctx.adminBearerAllowed === true,
      });
    };
    const actor = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const translate = async <T>(work: () => Promise<T>) => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof SceneSpriteError) throw new ApiErrorWithDetails(e.code, e.message, e.userMessage, e.details);
        throw e;
      }
    };
    app.get(
      '/admin/dungeons/scene-sprites',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          response: {
            200: dataSchema(z.object({ sprites: z.array(summary) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { sprites: await service.list() }),
    );
    app.get(
      '/admin/dungeons/scene-sprites/:key',
      { preValidation: gate('dungeons.read'), schema: { params, response } },
      async (req) => {
        const sprite = await service.get(req.params.key);
        if (!sprite) throw new AppError('NOT_FOUND', 'Scene sprite not found', 'This scene sprite no longer exists.');
        return ok(req, sprite);
      },
    );
    app.post(
      '/admin/dungeons/scene-sprites',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          body: z.object({ key: z.string(), sprite: z.unknown() }),
          response,
        },
      },
      async (req) => ok(req, await translate(() => service.create(req.body.key, req.body.sprite, actor(req)))),
    );
    app.put(
      '/admin/dungeons/scene-sprites/:key',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          params,
          body: z.object({ sprite: z.unknown(), expectedRevision: revision }),
          response,
        },
      },
      async (req) =>
        ok(
          req,
          await translate(() => service.update(req.params.key, req.body.sprite, req.body.expectedRevision, actor(req))),
        ),
    );
    app.put(
      '/admin/dungeons/scene-sprites/:key/archived',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          params,
          body: z.object({ archived: z.boolean(), expectedRevision: revision }),
          response,
        },
      },
      async (req) =>
        ok(
          req,
          await translate(() =>
            service.archive(req.params.key, req.body.archived, req.body.expectedRevision, actor(req)),
          ),
        ),
    );
    app.delete(
      '/admin/dungeons/scene-sprites/:key',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          params,
          querystring: z.object({
            expectedRevision: z.coerce.number().int().positive(),
          }),
          response: {
            ...response,
            200: dataSchema(z.object({ deleted: z.boolean() })),
          },
        },
      },
      async (req) => {
        await translate(() => service.delete(req.params.key, req.query.expectedRevision, actor(req)));
        return ok(req, { deleted: true });
      },
    );
  };
