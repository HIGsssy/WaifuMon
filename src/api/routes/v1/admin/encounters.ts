/**
 * Portal admin — world encounter CRUD, preview, simulation.
 *
 * Every route here calls {@link requirePortalPermission} before doing any
 * work. Bearer-authenticated calls (loopback/tailnet) pass every check by
 * design; Portal-cookie calls are gated by the {@link PortalPermission} the
 * route names. The permission set is computed once in
 * {@link PortalAuthorizationService} — routes never look up guild
 * ownership directly.
 *
 * The routes are deliberately thin: request validation happens via Zod
 * schemas registered with {@link registerTypeProvider}, and all business
 * logic lives on {@link WorldEncounterAdminService} (shared with the
 * server-rendered admin panel). Adding a Discord-role-based permission
 * later is a change in the authorization service, not here.
 */
import { z } from 'zod';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { AppError } from '../../../../shared/errors';
import { computeChance } from '../../../../modules/worldEncounters/checkResolver';
import type {
  BuddyProfile,
  EncounterCheckContext,
  LoadedEncounter,
} from '../../../../modules/worldEncounters/types';
import {
  EncounterInputSchema,
  CheckSchema,
  EffectSchema,
} from '../../../../modules/worldEncounters/types';
import { REGIONS } from '../../../../modules/locations/regions';
import {
  AFFINITIES,
  WORLD_ENCOUNTER_LIFECYCLES,
  WORLD_ENCOUNTER_RARITIES,
  WORLD_ENCOUNTER_TYPES,
} from '../../../../db/schema';
import { RACE_CODES } from '../../../../modules/cards/race';

/* ─────────────────────── Response schemas ─────────────────────── */

const effectSchema: z.ZodType = EffectSchema;
const checkSchema: z.ZodType = CheckSchema;

const choiceSchema = z.object({
  id: z.number().int(),
  sortOrder: z.number().int(),
  label: z.string(),
  emoji: z.string().nullable(),
  requirements: z.record(z.unknown()),
  check: checkSchema,
  successEffects: z.array(effectSchema),
  failureEffects: z.array(effectSchema),
});

const encounterSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(WORLD_ENCOUNTER_TYPES),
  rarity: z.enum(WORLD_ENCOUNTER_RARITIES),
  weight: z.number().int(),
  lifecycle: z.enum(WORLD_ENCOUNTER_LIFECYCLES),
  huntEligible: z.boolean(),
  travelEligible: z.boolean(),
  cooldownSeconds: z.number().int(),
  artworkPath: z.string().nullable(),
  chainedEncounterSlug: z.string().nullable(),
  choicesRequired: z.boolean(),
  regions: z.array(z.string()),
  routes: z.array(z.object({ fromRegion: z.string(), toRegion: z.string() })),
  choices: z.array(choiceSchema),
  metadata: z.record(z.unknown()),
});

const encounterListSchema = z.object({ encounters: z.array(encounterSchema) });

const previewChoiceSchema = z.object({
  choiceId: z.number().int(),
  label: z.string(),
  emoji: z.string().nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  chance: z.number(),
  breakdown: z.object({
    base: z.number(),
    spTerm: z.number(),
    levelTerm: z.number(),
    affinityMod: z.number(),
    raceMod: z.number(),
    buddyBonusMod: z.number(),
    baseBias: z.number(),
  }),
});

const previewResponseSchema = z.object({
  encounter: encounterSchema,
  choices: z.array(previewChoiceSchema),
});

const referenceSchema = z.object({
  regions: z.array(z.string()),
  affinities: z.array(z.string()),
  races: z.array(z.string()),
  items: z.array(z.object({ slug: z.string(), name: z.string(), category: z.string() })),
  encounters: z.array(z.object({ slug: z.string(), name: z.string() })),
  vendors: z.array(z.object({ vendorKey: z.string(), name: z.string() })),
  types: z.array(z.string()),
  rarities: z.array(z.string()),
  lifecycles: z.array(z.string()),
});

const simulateAggregateSchema = z.object({
  rolls: z.number().int(),
  successes: z.number().int(),
  failures: z.number().int(),
  successRate: z.number(),
  waifubuxGained: z.number(),
  waifubuxLost: z.number(),
  expectedNetWaifubux: z.number(),
  essenceGained: z.number(),
  essenceLost: z.number(),
  itemFrequency: z.record(z.number()),
  followUpFrequency: z.record(z.number()),
});
const simulateResponseSchema = z.object({
  encounter: encounterSchema,
  choiceId: z.number().int(),
  aggregate: simulateAggregateSchema,
});

/* ─────────────────────── Request schemas ─────────────────────── */

const previewBodySchema = z.object({
  playerLevel: z.number().int().min(1).max(200).default(20),
  buddy: z
    .object({
      level: z.number().int().min(1).max(200),
      currentSp: z.number().int().min(0).max(9999),
      affinity: z.enum(AFFINITIES),
      race: z.string().min(1).max(64),
    })
    .nullable()
    .default(null),
  buddyBonusPercent: z.number().min(-100).max(100).default(0),
});

const simulateBodySchema = previewBodySchema.extend({
  choiceId: z.number().int(),
  rolls: z.number().int().min(1).max(10_000).default(100),
});

/* ─────────────────────── Helpers ─────────────────────── */

function encounterToResource(e: LoadedEncounter): z.infer<typeof encounterSchema> {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    type: e.type,
    rarity: e.rarity,
    weight: e.weight,
    lifecycle: e.lifecycle,
    huntEligible: e.huntEligible,
    travelEligible: e.travelEligible,
    cooldownSeconds: e.cooldownSeconds,
    artworkPath: e.artworkPath,
    chainedEncounterSlug: e.chainedEncounterSlug,
    choicesRequired: e.choicesRequired,
    regions: e.regions,
    routes: e.routes,
    choices: e.choices.map((c) => ({
      id: c.id,
      sortOrder: c.sortOrder,
      label: c.label,
      emoji: c.emoji,
      requirements: c.requirements as Record<string, unknown>,
      check: c.check,
      successEffects: c.successEffects,
      failureEffects: c.failureEffects,
    })),
    metadata: e.metadata,
  };
}

function contextFrom(body: z.infer<typeof previewBodySchema>): EncounterCheckContext {
  const buddy: BuddyProfile | null = body.buddy
    ? {
        waifuId: 0,
        speciesSlug: 'test',
        speciesName: 'Test Buddy',
        level: body.buddy.level,
        affinity: body.buddy.affinity,
        baseSp: body.buddy.currentSp,
        currentSp: body.buddy.currentSp,
        rarity: 'R',
        raceTags: [body.buddy.race],
      }
    : null;
  return {
    playerId: 0,
    playerLevel: body.playerLevel,
    buddy,
    buddyBonusPercent: body.buddyBonusPercent,
  };
}

/**
 * Availability check that mirrors the runtime version in
 * `worldEncounterService.isChoiceAvailable`. Duplicated here so the preview
 * does not need a full service graph, but the rules stay in lockstep — a
 * change to requirements must land in both.
 */
function isChoiceAvailable(
  requirements: Record<string, unknown>,
  ctx: EncounterCheckContext,
): { available: boolean; reason: string | null } {
  const r = requirements as {
    affinity?: string;
    raceAny?: string[];
    minPlayerLevel?: number;
    minBuddyLevel?: number;
    requiresItem?: string;
  };
  if (r.affinity && (!ctx.buddy || ctx.buddy.affinity !== r.affinity)) {
    return { available: false, reason: `Requires ${r.affinity} affinity` };
  }
  if (r.raceAny && r.raceAny.length > 0) {
    const has = ctx.buddy && r.raceAny.some((tag) => ctx.buddy!.raceTags.includes(tag));
    if (!has) return { available: false, reason: `Requires ${r.raceAny.join('/')}` };
  }
  if (r.minPlayerLevel && ctx.playerLevel < r.minPlayerLevel) {
    return { available: false, reason: `Requires trainer level ${r.minPlayerLevel}` };
  }
  if (r.minBuddyLevel && (!ctx.buddy || ctx.buddy.level < r.minBuddyLevel)) {
    return { available: false, reason: `Requires buddy level ${r.minBuddyLevel}` };
  }
  return { available: true, reason: null };
}

/* ─────────────────────── Routes ─────────────────────── */

export const adminEncounterRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const admin = ctx.services.worldEncounterAdmin;
    const authorization = ctx.portalAuthorization;

    if (!admin) return; // Feature not wired — skip route registration entirely.

    const requireAuth = async (
      req: import('fastify').FastifyRequest,
      permission: Parameters<typeof requirePortalPermission>[2],
    ): Promise<void> => {
      if (!authorization) {
        throw new AppError(
          'PORTAL_PERMISSION_DENIED',
          'Portal authorization service is not configured',
          'Admin features are unavailable.',
        );
      }
      await requirePortalPermission(req, authorization, permission);
    };

    app.get(
      '/admin/encounters',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'List world encounters',
          response: {
            200: dataSchema(encounterListSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.read');
        const encounters = await admin.list();
        return ok(req, { encounters: encounters.map(encounterToResource) });
      },
    );

    app.get(
      '/admin/encounters/reference',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Canonical selectors for the encounter editor',
          response: {
            200: dataSchema(referenceSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.read');
        const content = ctx.getContent();
        const encounters = await admin.list();
        const vendors = ctx.services.worldEncounterVendor
          ? await Promise.all(
              [...new Set(encounters.map((e) => e.slug))].map(() => null),
            ).then(() => [{ vendorKey: 'wandering_merchant', name: 'The Wandering Merchant' }])
          : [];
        return ok(req, {
          regions: [...REGIONS],
          affinities: [...AFFINITIES],
          races: [...RACE_CODES],
          items: content.items.map((i) => ({ slug: i.slug, name: i.name, category: i.category })),
          encounters: encounters.map((e) => ({ slug: e.slug, name: e.name })),
          vendors,
          types: [...WORLD_ENCOUNTER_TYPES],
          rarities: [...WORLD_ENCOUNTER_RARITIES],
          lifecycles: [...WORLD_ENCOUNTER_LIFECYCLES],
        });
      },
    );

    app.get(
      '/admin/encounters/:id',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Get one encounter',
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: {
            200: dataSchema(encounterSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.read');
        const { id } = req.params;
        const encounter = await admin.get(id);
        if (!encounter) throw new AppError('NOT_FOUND', `Encounter ${id} not found`, 'Not found.');
        return ok(req, encounterToResource(encounter));
      },
    );

    app.post(
      '/admin/encounters',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Create or replace an encounter (idempotent on slug)',
          body: z.object({ input: EncounterInputSchema }),
          response: {
            200: dataSchema(encounterSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.write');
        const result = await admin.upsert(req.body.input);
        return ok(req, encounterToResource(result));
      },
    );

    app.put(
      '/admin/encounters/:id',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Replace an encounter by id',
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: z.object({ input: EncounterInputSchema }),
          response: {
            200: dataSchema(encounterSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.write');
        const existing = await admin.get(req.params.id);
        if (!existing) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        const result = await admin.upsert({ ...req.body.input, slug: existing.slug });
        return ok(req, encounterToResource(result));
      },
    );

    app.post(
      '/admin/encounters/:id/clone',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Clone an encounter under a new slug',
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: z.object({ newSlug: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/) }),
          response: {
            200: dataSchema(encounterSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.write');
        const cloned = await admin.clone(req.params.id, req.body.newSlug);
        return ok(req, encounterToResource(cloned));
      },
    );

    app.patch(
      '/admin/encounters/:id/lifecycle',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Change the lifecycle state of an encounter',
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: z.object({ lifecycle: z.enum(WORLD_ENCOUNTER_LIFECYCLES) }),
          response: {
            200: dataSchema(encounterSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const permission =
          req.body.lifecycle === 'active' ? 'encounters.publish' : 'encounters.write';
        await requireAuth(req, permission);
        const existing = await admin.get(req.params.id);
        if (!existing) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        await admin.setLifecycle(req.params.id, req.body.lifecycle);
        const updated = await admin.get(req.params.id);
        if (!updated) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        return ok(req, encounterToResource(updated));
      },
    );

    app.delete(
      '/admin/encounters/:id',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Delete an encounter (refused when history exists)',
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: {
            200: dataSchema(z.object({ ok: z.boolean(), reason: z.string().optional() })),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.write');
        const result = await admin.remove(req.params.id);
        if (!result.ok) {
          throw new AppError(
            'ENCOUNTER_DELETE_UNSAFE',
            result.reason ?? 'Encounter cannot be deleted',
            result.reason ?? 'This encounter has resolved history — disable it instead.',
          );
        }
        return ok(req, { ok: true });
      },
    );

    app.post(
      '/admin/encounters/:id/preview',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Preview computed choice chances for a test context',
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: previewBodySchema,
          response: {
            200: dataSchema(previewResponseSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.read');
        const encounter = await admin.get(req.params.id);
        if (!encounter) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        const checkCtx = contextFrom(req.body);
        const choices = encounter.choices.map((c) => {
          const { available, reason } = isChoiceAvailable(
            c.requirements as Record<string, unknown>,
            checkCtx,
          );
          const preview = computeChance(c.check, checkCtx);
          return {
            choiceId: c.id,
            label: c.label,
            emoji: c.emoji,
            available,
            unavailableReason: reason,
            chance: preview.chance,
            breakdown: preview.breakdown,
          };
        });
        return ok(req, { encounter: encounterToResource(encounter), choices });
      },
    );

    app.post(
      '/admin/encounters/:id/simulate',
      {
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'N-roll simulation (no live state mutation)',
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: simulateBodySchema,
          response: {
            200: dataSchema(simulateResponseSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        await requireAuth(req, 'encounters.simulate');
        const encounter = await admin.get(req.params.id);
        if (!encounter) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        const choice = encounter.choices.find((c) => c.id === req.body.choiceId);
        if (!choice) {
          throw new AppError('NOT_FOUND', 'Choice not found on this encounter', 'Not found.');
        }
        const aggregate = simulateChoice(choice, req.body, contextFrom(req.body));
        return ok(req, {
          encounter: encounterToResource(encounter),
          choiceId: choice.id,
          aggregate,
        });
      },
    );
  };

/* ─────────────────────── Simulation ─────────────────────── */

/**
 * Pure aggregation: run the check `rolls` times against the deterministic
 * math and accumulate effect-side expected values from each rolled outcome
 * (successEffects on hit, failureEffects on miss). No DB, no side effects.
 * Currency losses that would soft-cap in production simply cap to the
 * declared amount — the simulator has no player balance to consult.
 */
function simulateChoice(
  choice: LoadedEncounter['choices'][number],
  body: z.infer<typeof simulateBodySchema>,
  ctx: EncounterCheckContext,
): z.infer<typeof simulateAggregateSchema> {
  const preview = computeChance(choice.check, ctx);
  const rolls = body.rolls;
  const successes = Math.round(rolls * preview.chance);
  const failures = rolls - successes;

  let waifubuxGained = 0;
  let waifubuxLost = 0;
  let essenceGained = 0;
  let essenceLost = 0;
  const itemFrequency: Record<string, number> = {};
  const followUpFrequency: Record<string, number> = {};

  const accumulate = (
    effects: LoadedEncounter['choices'][number]['successEffects'],
    count: number,
  ) => {
    for (const effect of effects) {
      switch (effect.type) {
        case 'waifubux_gain':
          waifubuxGained += effect.amount * count;
          break;
        case 'waifubux_loss':
          waifubuxLost += effect.amount * count;
          break;
        case 'waifubux_loss_percent': {
          // Approximate: without a live balance to read, treat the cap as the
          // full loss. Real gameplay soft-caps at balance, so this is upper-
          // bound guidance rather than exact expected value.
          const capped = effect.maxAmount ?? Math.round(effect.percent * 500);
          waifubuxLost += capped * count;
          break;
        }
        case 'essence_gain':
          essenceGained += effect.amount * count;
          break;
        case 'essence_loss':
          essenceLost += effect.amount * count;
          break;
        case 'give_item':
        case 'consume_item':
          itemFrequency[effect.slug] = (itemFrequency[effect.slug] ?? 0) + effect.quantity * count;
          break;
        case 'trigger_encounter':
        case 'trigger_waifumon_encounter':
        case 'open_vendor':
        case 'temp_buff':
          followUpFrequency[effect.type] = (followUpFrequency[effect.type] ?? 0) + count;
          break;
        default:
          break;
      }
    }
  };

  accumulate(choice.successEffects, successes);
  accumulate(choice.failureEffects, failures);

  return {
    rolls,
    successes,
    failures,
    successRate: preview.chance,
    waifubuxGained,
    waifubuxLost,
    expectedNetWaifubux: waifubuxGained - waifubuxLost,
    essenceGained,
    essenceLost,
    itemFrequency,
    followUpFrequency,
  };
}
