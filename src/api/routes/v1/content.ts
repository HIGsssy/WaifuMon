/**
 * Content catalog — read-only in v1 (the admin panel keeps content CRUD).
 *
 * Every route here serves the **in-memory content snapshot**, so none of them
 * touches the database at all. That snapshot is republished atomically by the
 * admin panel's "Save + Reload", which is why `ctx.getContent()` is called per
 * request rather than captured once — a reload is visible immediately, and a
 * request that started before it still sees one coherent snapshot.
 *
 * Because reads are already served from memory, no caching layer is needed or
 * wanted here. If a future client wants HTTP-level caching, the natural move
 * is an ETag derived from the snapshot's identity — noted, not built.
 *
 * Content is addressed by **slug**; these payloads carry no internal ids. When
 * a client holds an id (an owned waifu's `speciesId`, an inventory `itemId`),
 * the id-bearing row is embedded in that gameplay resource instead.
 */
import { z } from 'zod';
import type { ApiContext } from '../../context';
import { ApiSpeciesNotFoundError, ApiTableNotFoundError } from '../../errors';
// The service layer's ItemNotFoundError already carries a client-safe message,
// so unlike PLAYER_NOT_FOUND it needs no API-side variant.
import { ItemNotFoundError } from '../../../shared/errors';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, slugParam } from '../../schemas/common';
import {
  contentItemSchema,
  contentSpeciesSchema,
  itemsQuery,
  questCatalogSchema,
  speciesQuery,
  tableKeyParams,
  tablesSchema,
} from '../../schemas/content';

const slugParams = z.object({ slug: slugParam });

export const contentRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/content/species',
      {
        schema: {
          tags: ['Content'],
          summary: 'List species',
          description:
            'The authored species catalog, straight from the in-memory snapshot. Disabled species ' +
            'are included unless filtered out — an operator tool needs to see them. Not paginated: ' +
            'the catalog is small and static.',
          querystring: speciesQuery,
          response: {
            200: dataSchema(z.array(contentSpeciesSchema)),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { rarity, archetype, enabled } = req.query;
        const species = ctx.getContent().species.filter((s) => {
          if (rarity && s.rarity !== rarity) return false;
          if (archetype && s.archetype !== archetype) return false;
          if (enabled !== undefined && s.enabled !== (enabled === 'true')) return false;
          return true;
        });
        return ok(req, species);
      },
    );

    app.get(
      '/content/species/:slug',
      {
        schema: {
          tags: ['Content'],
          summary: 'Get one species',
          params: slugParams,
          response: {
            200: dataSchema(contentSpeciesSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const found = ctx.getContent().species.find((s) => s.slug === req.params.slug);
        if (!found) throw new ApiSpeciesNotFoundError(req.params.slug);
        return ok(req, found);
      },
    );

    app.get(
      '/content/items',
      {
        schema: {
          tags: ['Content'],
          summary: 'List items',
          description:
            'The authored item catalog. Includes non-purchasable and disabled items; use ' +
            'GET /shop/catalog for what is actually for sale.',
          querystring: itemsQuery,
          response: {
            200: dataSchema(z.array(contentItemSchema)),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { category, enabled } = req.query;
        const items = ctx.getContent().items.filter((i) => {
          if (category && i.category !== category) return false;
          if (enabled !== undefined && i.enabled !== (enabled === 'true')) return false;
          return true;
        });
        return ok(req, items);
      },
    );

    app.get(
      '/content/items/:slug',
      {
        schema: {
          tags: ['Content'],
          summary: 'Get one item',
          params: slugParams,
          response: {
            200: dataSchema(contentItemSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const found = ctx.getContent().items.find((i) => i.slug === req.params.slug);
        if (!found) throw new ItemNotFoundError(req.params.slug);
        return ok(req, found);
      },
    );

    app.get(
      '/content/tables',
      {
        schema: {
          tags: ['Content'],
          summary: 'Get all tuning tables',
          description:
            'The whole `tables.json` blob: hunt weights, capture rates, XP curves, Care Mode ' +
            'rates, daily package, quest config. **Opaque by design** — this is balance tuning ' +
            'that changes routinely, so its nested shape is deliberately not part of the frozen ' +
            'v1 contract.',
          response: {
            200: dataSchema(tablesSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, ctx.getContent().tables as Record<string, unknown>),
    );

    app.get(
      '/content/tables/:key',
      {
        schema: {
          tags: ['Content'],
          summary: 'Get one tuning table',
          description:
            'A single top-level key of `tables.json` — `energy`, `hunt`, `capture`, `progression`, ' +
            '`dailyQuests`, and so on. Same opacity caveat as the full blob.',
          params: tableKeyParams,
          response: {
            200: dataSchema(z.unknown()),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const tables = ctx.getContent().tables as Record<string, unknown>;
        if (!Object.hasOwn(tables, req.params.key)) {
          throw new ApiTableNotFoundError(req.params.key);
        }
        return ok(req, tables[req.params.key]);
      },
    );

    app.get(
      '/content/quests',
      {
        schema: {
          tags: ['Content'],
          summary: 'Get the daily-quest catalog',
          description:
            'The live pool quests are rolled from, plus how many are assigned per day and the ' +
            'all-complete bonus. Assigned quests freeze their own copy of these fields, so a pool ' +
            "edit never rewrites a player's in-progress quest.",
          response: {
            200: dataSchema(questCatalogSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const config = ctx.getContent().tables.dailyQuests;
        return ok(req, {
          enabled: config.enabled,
          questsPerDay: config.questsPerDay,
          allCompleteBonus: config.allCompleteBonus ?? null,
          pool: config.pool.map((q) => ({ ...q, rarityAtLeast: q.rarityAtLeast ?? null })),
        });
      },
    );
  };
