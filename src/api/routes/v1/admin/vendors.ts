/**
 * Portal admin — World Encounter vendors.
 *
 * A vendor is what an encounter's `open_vendor` effect opens: a name, some
 * flavour text, and a stock template — each line an item, a per-visit
 * quantity, and this vendor's own price and currency. Until these routes the
 * only ways to author one were the startup seed and a content-package import.
 *
 * Same permission model as the rest of the encounter admin: reads need
 * `encounters.read`, writes `encounters.write`. A vendor has no lifecycle of
 * its own, so an edit reaches the next visit to any encounter that opens it —
 * exactly as an edit to an active encounter does. A shop a player already has
 * open keeps the stock it was instantiated with.
 *
 * The vendor key is immutable. Instances and `open_vendor` effects reference
 * it by value with no foreign key, so a rename would orphan both.
 */
import { z } from 'zod';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { AppError } from '../../../../shared/errors';
import { ApiFieldValidationError } from '../../../errors';
import type { WorldEncounterVendorRow } from '../../../../db/schema';
import type { LoadedEncounter } from '../../../../modules/worldEncounters/types';
import {
  NewVendorDefinitionSchema,
  VendorDefinitionInputSchema,
  VendorInUseError,
  VendorStockTemplateSchema,
  vendorStockIssues,
  type VendorStockTemplate,
  type WorldEncounterVendorService,
} from '../../../../modules/worldEncounters/vendorService';

const stockEntrySchema = z.object({
  itemSlug: z.string(),
  quantity: z.number().int(),
  price: z.number().int(),
  currency: z.enum(['waifubux', 'essence']),
});

const vendorSchema = z.object({
  vendorKey: z.string(),
  name: z.string(),
  description: z.string(),
  stock: z.array(stockEntrySchema),
  updatedAt: z.string(),
  /** Encounters with an `open_vendor` effect naming this vendor, any lifecycle. */
  usedBy: z.array(
    z.object({ id: z.number().int(), slug: z.string(), name: z.string(), lifecycle: z.string() }),
  ),
});

const vendorKeyParams = z.object({ vendorKey: z.string().min(1).max(64) });

/** Encounters that open `vendorKey` from any choice outcome. */
function encountersOpening(
  vendorKey: string,
  encounters: readonly LoadedEncounter[],
): LoadedEncounter[] {
  return encounters.filter((e) =>
    e.choices.some((c) =>
      [...c.successEffects, ...c.failureEffects].some(
        (effect) => effect.type === 'open_vendor' && effect.vendorKey === vendorKey,
      ),
    ),
  );
}

function parseStock(raw: unknown): VendorStockTemplate {
  // A template that no longer parses is shown empty rather than failing the
  // whole list — the runtime makes the same call in `parseTemplate`.
  const parsed = VendorStockTemplateSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

function toResource(
  row: WorldEncounterVendorRow,
  encounters: readonly LoadedEncounter[],
): z.infer<typeof vendorSchema> {
  return {
    vendorKey: row.vendorKey,
    name: row.name,
    description: row.description,
    stock: parseStock(row.stockTemplateJson),
    updatedAt: row.updatedAt.toISOString(),
    usedBy: encountersOpening(row.vendorKey, encounters).map((e) => ({
      id: e.id,
      slug: e.slug,
      name: e.name,
      lifecycle: e.lifecycle,
    })),
  };
}

export const adminVendorRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const vendorService = ctx.services.worldEncounterVendor;
    const admin = ctx.services.worldEncounterAdmin;
    const authorization = ctx.portalAuthorization;

    // Both are needed: the vendor rows, and the encounters that reference them.
    if (!vendorService || !admin) return;
    const vendors: WorldEncounterVendorService = vendorService;

    const gate =
      (permission: Parameters<typeof requirePortalPermission>[2]) =>
      async (req: import('fastify').FastifyRequest): Promise<void> => {
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

    const notFound = (vendorKey: string) =>
      new AppError('NOT_FOUND', `Vendor "${vendorKey}" not found`, 'Not found.');

    const itemSlugs = () => new Set(ctx.getContent().items.map((i) => i.slug));

    const assertStock = (stock: VendorStockTemplate): void => {
      const issues = vendorStockIssues(stock, itemSlugs());
      if (issues.length > 0) throw new ApiFieldValidationError(issues);
    };

    app.get(
      '/admin/vendors',
      {
        preValidation: gate('encounters.read'),
        schema: {
          tags: ['Admin — Vendors'],
          summary: 'List world encounter vendors with their stock and the encounters that open them',
          response: {
            200: dataSchema(z.object({ vendors: z.array(vendorSchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const [rows, encounters] = await Promise.all([vendors.listDefinitions(), admin.list()]);
        return ok(req, { vendors: rows.map((row) => toResource(row, encounters)) });
      },
    );

    app.get(
      '/admin/vendors/:vendorKey',
      {
        preValidation: gate('encounters.read'),
        schema: {
          tags: ['Admin — Vendors'],
          summary: 'Get one world encounter vendor',
          params: vendorKeyParams,
          response: {
            200: dataSchema(vendorSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const row = await vendors.getDefinition(req.params.vendorKey);
        if (!row) throw notFound(req.params.vendorKey);
        return ok(req, toResource(row, await admin.list()));
      },
    );

    app.post(
      '/admin/vendors',
      {
        preValidation: gate('encounters.write'),
        schema: {
          tags: ['Admin — Vendors'],
          summary: 'Create a world encounter vendor (refused when the key is taken)',
          body: NewVendorDefinitionSchema,
          response: {
            200: dataSchema(vendorSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        assertStock(req.body.stock);
        const row = await vendors.createDefinition(req.body);
        return ok(req, toResource(row, await admin.list()));
      },
    );

    app.put(
      '/admin/vendors/:vendorKey',
      {
        preValidation: gate('encounters.write'),
        schema: {
          tags: ['Admin — Vendors'],
          summary: "Replace a vendor's name, description and stock (the key is immutable)",
          params: vendorKeyParams,
          body: VendorDefinitionInputSchema,
          response: {
            200: dataSchema(vendorSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        assertStock(req.body.stock);
        const row = await vendors.updateDefinition(req.params.vendorKey, req.body);
        if (!row) throw notFound(req.params.vendorKey);
        return ok(req, toResource(row, await admin.list()));
      },
    );

    app.delete(
      '/admin/vendors/:vendorKey',
      {
        preValidation: gate('encounters.write'),
        schema: {
          tags: ['Admin — Vendors'],
          summary: 'Delete a vendor (refused while any encounter opens it)',
          params: vendorKeyParams,
          response: {
            200: dataSchema(z.object({ ok: z.boolean() })),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { vendorKey } = req.params;
        // Refused rather than cascaded: an `open_vendor` effect naming a
        // missing vendor resolves to "merchant unavailable" at runtime, which
        // is a silent content break. Unlinking is the author's call.
        const users = encountersOpening(vendorKey, await admin.list());
        if (users.length > 0) throw new VendorInUseError(vendorKey, users.map((e) => e.slug));
        if (!(await vendors.deleteDefinition(vendorKey))) throw notFound(vendorKey);
        return ok(req, { ok: true });
      },
    );
  };
