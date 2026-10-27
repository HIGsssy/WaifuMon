/** Admin transport for the E3-B services. Import and edits only ever save drafts. */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { commonErrorResponses, errorSchema } from '../../../schemas/common';
import * as s from '../../../schemas/equipmentManaged';
import { ApiErrorWithDetails } from '../../../errors';
import { AppError, EquipmentConfigInvalidError, EquipmentConfigStaleError } from '../../../../shared/errors';
import { readRollRulesExport } from '../../../../modules/equipment/rollRules';
import type { PortalPermission } from '../../../../modules/portalAuth/portalAuthService';

async function translate<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof EquipmentConfigInvalidError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
    }
    if (err instanceof EquipmentConfigStaleError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        expectedRevision: err.expectedRevision,
        currentRevision: err.currentRevision,
      });
    }
    throw err;
  }
}

export const adminEquipmentManagedRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const rules = ctx.services.equipmentRollRules;
    const libraries = ctx.services.equipmentAffixLibraries;
    const gate = (permission: PortalPermission) => async (req: FastifyRequest) => {
      if (!ctx.portalAuthorization)
        throw new AppError(
          'PORTAL_PERMISSION_DENIED',
          'Portal authorization is unavailable',
          'Admin features are unavailable.',
        );
      await requirePortalPermission(req, ctx.portalAuthorization, permission, {
        allowBearer: ctx.adminBearerAllowed === true,
      });
    };
    const opts = (req: FastifyRequest, expectedDraftRevision: number) => ({
      expectedDraftRevision,
      actor: req.portalSession?.discordUserId ?? null,
    });
    const response = <T extends z.ZodTypeAny>(schema: T) => ({
      200: dataSchema(schema),
      ...commonErrorResponses,
      404: errorSchema,
      409: errorSchema,
      503: errorSchema,
    });
    const tags = ['Admin — Equipment Rules and Affixes'];
    const read = gate('equipment.read');
    const write = gate('equipment.write');
    const publish = gate('equipment.publish');
    const root = '/admin/equipment/rarity-rules';
    if (rules) {
      app.get(
        `${root}/published`,
        { preValidation: read, schema: { tags, response: response(s.publishedRules) } },
        async (req) => {
          const value = await rules.published();
          return ok(req, { ...value, publishedAt: value.publishedAt.toISOString() });
        },
      );
      app.get(
        `${root}/draft`,
        { preValidation: read, schema: { tags, response: response(s.draftRules) } },
        async (req) => {
          const value = await rules.draft();
          return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
        },
      );
      app.put(
        `${root}/draft`,
        { preValidation: write, schema: { tags, body: s.saveRulesRequest, response: response(s.draftRules) } },
        async (req) => {
          const value = await translate(() =>
            rules.saveDraft(req.body.rules, opts(req, req.body.expectedDraftRevision)),
          );
          return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
        },
      );
      app.post(
        `${root}/validate`,
        {
          preValidation: write,
          schema: {
            tags,
            body: z.object({ rules: z.unknown().optional() }).strict(),
            response: response(s.rulesValidation),
          },
        },
        async (req) => ok(req, await rules.validate(req.body.rules)),
      );
      app.post(
        `${root}/preview`,
        {
          preValidation: read,
          schema: {
            tags,
            body: z.object({ rules: z.unknown().optional() }).strict(),
            response: response(s.rulesPreview),
          },
        },
        async (req) => ok(req, await rules.preview(req.body.rules)),
      );
      app.post(
        `${root}/publish`,
        { preValidation: publish, schema: { tags, body: s.revisionRequest, response: response(s.publishedRules) } },
        async (req) => {
          const value = await translate(() => rules.publish(opts(req, req.body.expectedDraftRevision)));
          return ok(req, { ...value, publishedAt: value.publishedAt.toISOString() });
        },
      );
      app.post(
        `${root}/rollback`,
        { preValidation: publish, schema: { tags, body: s.rollbackRequest, response: response(s.publishedRules) } },
        async (req) => {
          const value = await translate(() =>
            rules.rollback(req.body.revision, opts(req, req.body.expectedDraftRevision)),
          );
          return ok(req, { ...value, publishedAt: value.publishedAt.toISOString() });
        },
      );
      app.get(
        `${root}/revisions`,
        { preValidation: read, schema: { tags, response: response(z.array(s.revisionSummary)) } },
        async (req) =>
          ok(
            req,
            (await rules.revisions()).map((value) => ({ ...value, publishedAt: value.publishedAt.toISOString() })),
          ),
      );
      app.get(
        `${root}/export`,
        { preValidation: read, schema: { tags, querystring: s.exportQuery, response: response(s.rulesExport) } },
        async (req) => ok(req, await rules.export(req.query.kind)),
      );
      app.post(
        `${root}/import/preview`,
        {
          preValidation: write,
          schema: {
            tags,
            body: s.importRulesRequest,
            response: response(s.rulesPreview.extend({ handEdited: z.boolean() })),
          },
        },
        async (req) => {
          const file = readRollRulesExport(req.body.file);
          if (file.issues.length)
            return translate(async () => {
              throw new EquipmentConfigInvalidError('roll rules import', file.issues);
            });
          const value = await rules.preview(file.config);
          if (value.draftRevision !== req.body.expectedDraftRevision)
            return translate(async () => {
              throw new EquipmentConfigStaleError('roll rules', req.body.expectedDraftRevision, value.draftRevision);
            });
          return ok(req, { ...value, handEdited: file.handEdited });
        },
      );
      app.post(
        `${root}/import`,
        {
          preValidation: write,
          schema: {
            tags,
            body: s.importRulesRequest,
            response: response(s.draftRules.extend({ handEdited: z.boolean() })),
          },
        },
        async (req) => {
          const value = await translate(() =>
            rules.importDraft(req.body.file, opts(req, req.body.expectedDraftRevision)),
          );
          return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
        },
      );
    }
    if (!libraries) return;
    const base = '/admin/equipment/affix-libraries';
    app.get(base, { preValidation: read, schema: { tags, response: response(s.libraryList) } }, async (req) =>
      ok(req, await libraries.list()),
    );
    app.post(
      base,
      { preValidation: write, schema: { tags, body: s.createLibraryRequest, response: response(s.libraryDetail) } },
      async (req) => {
        const value = await translate(() =>
          libraries.create(
            {
              key: req.body.key,
              ...(req.body.name === undefined ? {} : { name: req.body.name }),
              ...(req.body.description === undefined ? {} : { description: req.body.description }),
            },
            { actor: req.portalSession?.discordUserId ?? null },
          ),
        );
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
    app.get(
      `${base}/:key`,
      {
        preValidation: read,
        schema: { tags, params: s.libraryParams, response: response(z.union([s.libraryDetail, s.legacyLibrary])) },
      },
      async (req) => {
        if (req.params.key.startsWith('legacy_')) {
          const value = (await libraries.list()).legacy.find((l) => l.key === req.params.key);
          if (value) return ok(req, value);
        }
        const value = await libraries.get(req.params.key);
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
    app.put(
      `${base}/:key/draft`,
      {
        preValidation: write,
        schema: { tags, params: s.libraryParams, body: s.saveEntriesRequest, response: response(s.libraryDetail) },
      },
      async (req) => {
        const value = await translate(() =>
          libraries.saveDraft(req.params.key, req.body.entries, opts(req, req.body.expectedDraftRevision)),
        );
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
    app.put(
      `${base}/:key/meta`,
      {
        preValidation: write,
        schema: { tags, params: s.libraryParams, body: s.saveMetaRequest, response: response(s.libraryDetail) },
      },
      async (req) => {
        const value = await translate(() =>
          libraries.updateMeta(req.params.key, req.body.meta, opts(req, req.body.expectedDraftRevision)),
        );
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
    app.put(
      `${base}/:key/entries`,
      {
        preValidation: write,
        schema: { tags, params: s.libraryParams, body: s.saveEntryRequest, response: response(s.libraryDetail) },
      },
      async (req) => {
        const value = await translate(() =>
          libraries.upsertEntry(req.params.key, req.body.entry, opts(req, req.body.expectedDraftRevision)),
        );
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
    app.post(
      `${base}/:key/validate`,
      { preValidation: write, schema: { tags, params: s.libraryParams, response: response(s.libraryValidation) } },
      async (req) => ok(req, await libraries.validate(req.params.key)),
    );
    app.post(
      `${base}/:key/preview`,
      { preValidation: read, schema: { tags, params: s.libraryParams, response: response(s.libraryPreview) } },
      async (req) => ok(req, await libraries.preview(req.params.key)),
    );
    app.post(
      `${base}/:key/publish`,
      {
        preValidation: publish,
        schema: { tags, params: s.libraryParams, body: s.revisionRequest, response: response(s.libraryDetail) },
      },
      async (req) => {
        const value = await translate(() =>
          libraries.publish(req.params.key, opts(req, req.body.expectedDraftRevision)),
        );
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
    app.post(
      `${base}/:key/rollback`,
      {
        preValidation: publish,
        schema: { tags, params: s.libraryParams, body: s.rollbackRequest, response: response(s.libraryDetail) },
      },
      async (req) => {
        const value = await translate(() =>
          libraries.rollback(req.params.key, req.body.revision, opts(req, req.body.expectedDraftRevision)),
        );
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
    app.get(
      `${base}/:key/revisions`,
      {
        preValidation: read,
        schema: { tags, params: s.libraryParams, response: response(z.array(s.libraryRevision)) },
      },
      async (req) =>
        ok(
          req,
          (await libraries.revisions(req.params.key)).map((value) => ({
            ...value,
            publishedAt: value.publishedAt.toISOString(),
          })),
        ),
    );
    app.get(
      `${base}/:key/export`,
      {
        preValidation: read,
        schema: { tags, params: s.libraryParams, querystring: s.exportQuery, response: response(s.libraryExport) },
      },
      async (req) => ok(req, await libraries.export(req.params.key, req.query.kind)),
    );
    app.post(
      `${base}/import`,
      { preValidation: write, schema: { tags, body: s.importLibraryRequest, response: response(s.libraryDetail) } },
      async (req) => {
        const value = await translate(() =>
          libraries.importDraft(req.body.file, {
            ...(req.body.expectedDraftRevision === undefined
              ? {}
              : { expectedDraftRevision: req.body.expectedDraftRevision }),
            actor: req.portalSession?.discordUserId ?? null,
          }),
        );
        return ok(req, { ...value, updatedAt: value.updatedAt.toISOString() });
      },
    );
  };
