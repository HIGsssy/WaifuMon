import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type { ApiContext } from "../../../context";
import type { FastifyPluginAsyncZod } from "../../../plugins/typeProvider";
import { requirePortalPermission } from "../../../plugins/portalPermissions";
import { ok, dataSchema } from "../../../plugins/responseEnvelope";
import { commonErrorResponses } from "../../../schemas/common";
import { ApiErrorWithDetails } from "../../../errors";
import {
  AppError,
  DungeonInvalidError,
  DungeonDraftStaleError,
} from "../../../../shared/errors";
import { DungeonKeySchema } from "../../../../modules/dungeons/content/dungeonIdentifiers";
import {
  SharedPoolDefinitionSchema,
  SharedPoolPackageSchema,
} from "../../../../modules/dungeons/sharedPools/sharedPoolDefinition";

export const adminDungeonSpeciesPoolRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const pools = ctx.services.dungeonSpeciesPools;
    if (!pools) return;
    const root = "/admin/dungeons/waifumon-pools";
    const actor = (req: FastifyRequest) =>
      req.portalSession?.discordUserId ?? null;
    const gate =
      (permission: "dungeons.read" | "dungeons.write") =>
      async (req: FastifyRequest) => {
        if (!ctx.portalAuthorization)
          throw new AppError(
            "PORTAL_PERMISSION_DENIED",
            "Authorization unavailable",
            "Admin features are unavailable.",
          );
        await requirePortalPermission(
          req,
          ctx.portalAuthorization,
          permission,
          { allowBearer: ctx.adminBearerAllowed === true },
        );
      };
    const params = z.object({ key: DungeonKeySchema });
    const revision = z.number().int().positive();
    const schema = {
      tags: ["Admin — Dungeon WaifuMon Pools"],
      response: { 200: dataSchema(z.unknown()), ...commonErrorResponses },
    };
    async function result<T>(req: FastifyRequest, action: () => Promise<T>) {
      try {
        return ok(req, await action());
      } catch (err) {
        if (err instanceof DungeonInvalidError)
          throw new ApiErrorWithDetails(
            err.code,
            err.message,
            err.issues.map((i) => i.message).join(" "),
            { issues: err.issues },
          );
        if (err instanceof DungeonDraftStaleError)
          throw new ApiErrorWithDetails(
            err.code,
            err.message,
            "This pool changed since you opened it. Reload before saving.",
            {
              expectedRevision: err.expectedRevision,
              currentRevision: err.currentRevision,
            },
          );
        throw err;
      }
    }
    app.get(
      root,
      {
        onRequest: gate("dungeons.read"),
        schema: {
          ...schema,
          querystring: z.object({ search: z.string().max(100).optional() }),
        },
      },
      (req) => result(req, () => pools.list(req.query.search)),
    );
    app.get(
      `${root}/export`,
      {
        onRequest: gate("dungeons.read"),
        schema: {
          ...schema,
          querystring: z.object({ key: DungeonKeySchema.optional() }),
        },
      },
      (req) =>
        result(req, () =>
          pools.export(req.query.key ? [req.query.key] : undefined),
        ),
    );
    app.post(
      root,
      {
        onRequest: gate("dungeons.write"),
        bodyLimit: 256 * 1024,
        schema: { ...schema, body: SharedPoolDefinitionSchema },
      },
      (req) => result(req, () => pools.create(req.body, actor(req))),
    );
    app.post(
      `${root}/import`,
      {
        onRequest: gate("dungeons.write"),
        bodyLimit: 2 * 1024 * 1024,
        schema: {
          ...schema,
          body: z
            .object({
              package: SharedPoolPackageSchema,
              expectedRevisions: z.record(
                DungeonKeySchema,
                revision.nullable(),
              ),
            })
            .strict(),
        },
      },
      (req) =>
        result(req, () =>
          pools.import(
            req.body.package,
            req.body.expectedRevisions,
            actor(req),
          ),
        ),
    );
    app.get(
      `${root}/:key`,
      { onRequest: gate("dungeons.read"), schema: { ...schema, params } },
      (req) => result(req, () => pools.get(req.params.key)),
    );
    app.put(
      `${root}/:key`,
      {
        onRequest: gate("dungeons.write"),
        bodyLimit: 256 * 1024,
        schema: {
          ...schema,
          params,
          body: z
            .object({
              definition: SharedPoolDefinitionSchema,
              expectedRevision: revision,
            })
            .strict(),
        },
      },
      (req) =>
        result(req, () =>
          pools.update(
            req.params.key,
            req.body.definition,
            req.body.expectedRevision,
            actor(req),
          ),
        ),
    );
    app.post(
      `${root}/:key/enabled`,
      {
        onRequest: gate("dungeons.write"),
        schema: {
          ...schema,
          params,
          body: z
            .object({ enabled: z.boolean(), expectedRevision: revision })
            .strict(),
        },
      },
      (req) =>
        result(req, () =>
          pools.setEnabled(
            req.params.key,
            req.body.enabled,
            req.body.expectedRevision,
            actor(req),
          ),
        ),
    );
    app.post(
      `${root}/:key/duplicate`,
      {
        onRequest: gate("dungeons.write"),
        schema: {
          ...schema,
          params,
          body: z
            .object({ key: DungeonKeySchema, expectedRevision: revision })
            .strict(),
        },
      },
      (req) =>
        result(req, () =>
          pools.duplicate(
            req.params.key,
            req.body.key,
            req.body.expectedRevision,
            actor(req),
          ),
        ),
    );
    app.get(
      `${root}/:key/references`,
      { onRequest: gate("dungeons.read"), schema: { ...schema, params } },
      (req) => result(req, () => pools.references(req.params.key)),
    );
    app.get(
      `${root}/:key/history`,
      { onRequest: gate("dungeons.read"), schema: { ...schema, params } },
      (req) => result(req, () => pools.history(req.params.key)),
    );
  };
