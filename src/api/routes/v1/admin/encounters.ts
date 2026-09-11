/**
 * Portal admin — world encounter CRUD, preview, simulation.
 *
 * Every route here calls {@link requirePortalPermission} before doing any
 * work. A Portal-cookie call is gated by the {@link PortalPermission} the
 * route names; a bearer call is *also* gated unless the operator has
 * explicitly made the shared API token administrative with
 * `PLATFORM_API_ADMIN_BEARER=true` (see that module for why the default is
 * closed). The permission set is computed once in
 * {@link PortalAuthorizationService} — routes never look up guild ownership
 * directly.
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
import { computeChance, rollCheck } from '../../../../modules/worldEncounters/checkResolver';
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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveAssetPath } from '../../../../modules/content/loader';
import {
  SETTINGS_BOUNDS,
  WorldEncounterSettingsValidationError,
  type WorldEncounterSettings,
  type WorldEncounterSettingsService,
} from '../../../../modules/worldEncounters/settingsService';
import { seededRng } from '../../../../shared/random';
import { DEFAULT_REGION, REGIONS } from '../../../../modules/locations/regions';
import {
  AFFINITIES,
  RARITIES,
  WORLD_ENCOUNTER_LIFECYCLES,
  WORLD_ENCOUNTER_RARITIES,
  WORLD_ENCOUNTER_TYPES,
  type SpeciesRow,
} from '../../../../db/schema';
import { RACE_CODES } from '../../../../modules/cards/race';
import {
  SpeciesSelectionSchema,
  type SpeciesSelectorService,
} from '../../../../modules/encounters/speciesSelection';
import { normalizeWaifumonSelection } from '../../../../modules/worldEncounters/types';
import { directRegions } from '../../../../modules/worldEncounters/encounterPackage';

/**
 * Image types an encounter may use. A closed list, so the endpoint below can
 * set an accurate Content-Type without sniffing bytes and cannot be pointed at
 * a `.json` or `.env` that happens to sit under `assets/`.
 */
const ARTWORK_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

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
  /** Display names from region content, keyed by region id. */
  regionNames: z.record(z.string()),
  /** Species rarity codes, in canonical order — distinct from encounter `rarities`. */
  speciesRarities: z.array(z.string()),
  affinities: z.array(z.string()),
  races: z.array(z.string()),
  items: z.array(z.object({ slug: z.string(), name: z.string(), category: z.string() })),
  encounters: z.array(z.object({ slug: z.string(), name: z.string() })),
  species: z.array(z.object({ slug: z.string(), name: z.string(), rarity: z.string() })),
  vendors: z.array(z.object({ vendorKey: z.string(), name: z.string() })),
  types: z.array(z.string()),
  rarities: z.array(z.string()),
  lifecycles: z.array(z.string()),
});

const simulateAggregateSchema = z.object({
  rolls: z.number().int(),
  /** Observed successes across the N rolls actually performed. */
  successes: z.number().int(),
  failures: z.number().int(),
  /** `successes / rolls` — what this run produced. */
  successRate: z.number(),
  /** `computeChance(...)` — what the formula says, for comparison. */
  expectedSuccessRate: z.number(),
  /** Observed minus expected. Signed; near zero for a fair large run. */
  successRateDeviation: z.number(),
  /**
   * Standard error of the observed rate, `sqrt(p(1-p)/n)`. A deviation
   * inside roughly two of these is ordinary sampling noise rather than a
   * balance problem, which is the question an author is actually asking.
   */
  successRateStdError: z.number(),
  waifubuxGained: z.number(),
  waifubuxLost: z.number(),
  /** Observed net across the run. */
  netWaifubux: z.number(),
  /** Observed net per roll. */
  netWaifubuxPerRoll: z.number(),
  /** Closed-form expectation per roll, independent of this run's luck. */
  expectedNetWaifubuxPerRoll: z.number(),
  essenceGained: z.number(),
  essenceLost: z.number(),
  netEssence: z.number(),
  /**
   * Total **base** Affection the run would award the active Buddy.
   *
   * Base, not final, and deliberately so: the `affection_gain` Buddy Bonus
   * that scales a real award depends on who the player has equipped, which a
   * simulation has no player for. Reporting the authored figure keeps this an
   * observation of the encounter rather than a guess about an account — and
   * is why the simulator needs no player state to produce it.
   */
  affectionGranted: z.number(),
  itemFrequency: z.record(z.number()),
  followUpFrequency: z.record(z.number()),
  /** The seed this run used, so a reported result can be reproduced exactly. */
  seed: z.number().int(),
});
export type SimulateAggregate = z.infer<typeof simulateAggregateSchema>;

const speciesRefSchema = z.object({ slug: z.string(), name: z.string(), rarity: z.string() });

/**
 * One `trigger_waifumon_encounter` effect of the simulated choice, sampled
 * once through the live species selector. `selectedSpecies` is only ever what
 * that selector returned — null whenever it returned nothing.
 */
const sightingSchema = z.object({
  outcome: z.enum(['success', 'failure']),
  effect: z.record(z.unknown()),
  /** Region evaluated; null for a specific species, which ignores pools. */
  regionId: z.string().nullable(),
  candidateCount: z.number().int().nullable(),
  selectedSpecies: speciesRefSchema.nullable(),
  result: z.enum(['selected', 'no_matching_species', 'unknown_species', 'hunt_draw']),
});
type Sighting = z.infer<typeof sightingSchema>;

const simulateResponseSchema = z.object({
  encounter: encounterSchema,
  choiceId: z.number().int(),
  aggregate: simulateAggregateSchema,
  sightings: z.array(sightingSchema),
});

/** Where an encounter can fire, as the editor's draft describes it. */
const selectorEncounterSchema = z.object({
  huntEligible: z.boolean(),
  travelEligible: z.boolean(),
  regions: z.array(z.enum(REGIONS)),
  routes: z.array(z.object({ fromRegion: z.enum(REGIONS), toRegion: z.enum(REGIONS) })),
});

const selectorPreviewBodySchema = z.object({
  /** The effect's `selection`; null previews the legacy hunt draw. */
  selection: SpeciesSelectionSchema.nullable(),
  /** Omitted = the selector may run anywhere, so every enabled region is evaluated. */
  encounter: selectorEncounterSchema.optional(),
  /** Evaluate this one region instead. */
  regionId: z.enum(REGIONS).optional(),
  playerLevel: z.number().int().min(1).max(200).default(20),
});

const selectorPreviewResponseSchema = z.object({
  mode: z.enum(['specific', 'random', 'hunt_draw']),
  specific: speciesRefSchema.extend({ found: z.boolean() }).nullable(),
  regions: z.array(
    z.object({
      regionId: z.string(),
      regionName: z.string(),
      candidateCount: z.number().int(),
      candidates: z.array(speciesRefSchema),
    }),
  ),
  /** Any enabled region has a candidate. False is the import-blocking case. */
  matchesAnywhere: z.boolean(),
});

const speciesRef = (s: SpeciesRow): z.infer<typeof speciesRefSchema> => ({
  slug: s.slug,
  name: s.name,
  rarity: s.rarity,
});

/**
 * Sample every Waifumon sighting on a choice through the real selector — the
 * picker instance the spawner itself uses. Reads only; nothing is spawned.
 */
async function simulateSightings(
  selector: SpeciesSelectorService | undefined,
  choice: LoadedEncounter['choices'][number],
  regionId: string,
  playerLevel: number,
): Promise<Sighting[]> {
  const out: Sighting[] = [];
  const lists = [
    ['success', choice.successEffects],
    ['failure', choice.failureEffects],
  ] as const;
  for (const [outcome, effects] of lists) {
    for (const effect of effects) {
      if (effect.type !== 'trigger_waifumon_encounter') continue;
      const base = { outcome, effect: effect as unknown as Record<string, unknown> };
      const selection = normalizeWaifumonSelection(effect);
      if (selection.mode === 'legacy_random') {
        // The hunt draw re-rolls rarity and falls back across pools at
        // runtime; there is no fixed candidate set to report honestly.
        out.push({ ...base, regionId, candidateCount: null, selectedSpecies: null, result: 'hunt_draw' });
        continue;
      }
      if (!selector) continue;
      if (selection.mode === 'specific') {
        const row = await selector.findEnabledSpecies(selection.speciesSlug);
        out.push({
          ...base,
          regionId: null,
          candidateCount: row ? 1 : 0,
          selectedSpecies: row ? speciesRef(row) : null,
          result: row ? 'selected' : 'unknown_species',
        });
        continue;
      }
      const pick = await selector.pick(selection, { regionId, playerLevel });
      out.push({
        ...base,
        regionId,
        candidateCount: pick.candidateCount,
        selectedSpecies: pick.status === 'selected' ? speciesRef(pick.species) : null,
        result: pick.status === 'selected' ? 'selected' : 'no_matching_species',
      });
    }
  }
  return out;
}

const SELECTOR_PUBLISH_BLOCKED =
  'This selector does not match any enabled Waifumon in any region where this encounter can run.';

/**
 * Refuse to *publish* an encounter carrying a random selector that matches
 * nothing in any enabled region — the `selector_no_candidates` condition,
 * evaluated by the live picker. Zero in only some regions is allowed: a chain
 * can carry the node into a region that does match.
 *
 * Only activation is gated. Drafts may hold such a selector while it is being
 * worked on, which is what lets an author save their progress.
 */
async function assertPublishableSelectors(
  selector: SpeciesSelectorService | undefined,
  enabledRegions: readonly string[],
  choices: ReadonlyArray<{
    successEffects: LoadedEncounter['choices'][number]['successEffects'];
    failureEffects: LoadedEncounter['choices'][number]['failureEffects'];
  }>,
): Promise<void> {
  if (!selector) return;
  const dead: string[] = [];
  for (const [i, choice] of choices.entries()) {
    for (const effect of [...choice.successEffects, ...choice.failureEffects]) {
      if (effect.type !== 'trigger_waifumon_encounter') continue;
      const selection = normalizeWaifumonSelection(effect);
      if (selection.mode !== 'random') continue;
      let matches = false;
      for (const regionId of enabledRegions) {
        const pick = await selector.pick(selection, { regionId, playerLevel: 20 });
        if (pick.status === 'selected') {
          matches = true;
          break;
        }
      }
      if (!matches) dead.push(`choice ${i + 1}`);
    }
  }
  if (dead.length > 0) {
    const message = `${SELECTOR_PUBLISH_BLOCKED} Save it as a draft or change the selector (${dead.join(', ')}).`;
    throw new AppError('VALIDATION_ERROR', message, message);
  }
}

const settingsSchema = z.object({
  huntChance: z.number(),
  travelChance: z.number(),
  defaultExpirySeconds: z.number().int(),
  forceTrigger: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  /** Echoed so the panel can label its inputs without hard-coding limits. */
  bounds: z.object({
    chance: z.object({ min: z.number(), max: z.number() }),
    expirySeconds: z.object({ min: z.number(), max: z.number() }),
  }),
});

/**
 * Every field optional: the panel sends only what changed, so two operators
 * editing different settings do not clobber each other's values.
 *
 * Bounds are enforced here, again in the settings service, and a third time by
 * the table's CHECK constraints. That is deliberate for values that set the
 * game's pacing — a bad one does not throw, it silently makes encounters
 * impossible or instantaneous.
 */
const settingsPatchSchema = z
  .object({
    huntChance: z.number().min(0).max(1).optional(),
    travelChance: z.number().min(0).max(1).optional(),
    defaultExpirySeconds: z.number().int().min(30).max(86_400).optional(),
    forceTrigger: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one setting to change.',
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
  /**
   * RNG seed. Supplying one makes a run exactly reproducible — the same seed
   * and the same encounter always produce the same aggregate, which is what
   * lets a balance discussion cite a number rather than a vibe. Omitted, the
   * server picks one and reports it back.
   */
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  /**
   * Region Waifumon sightings are sampled in. Omitted: the first region the
   * encounter can fire in (or the starting region), reported back on each
   * sighting so the result is never region-ambiguous.
   */
  regionId: z.enum(REGIONS).optional(),
});

/* ─────────────────────── Helpers ─────────────────────── */

/**
 * Settings row → API resource. Bounds travel with the values so the Portal
 * panel labels and validates its inputs from one source rather than repeating
 * the numbers in the frontend.
 */
function toSettingsResource(s: WorldEncounterSettings): z.infer<typeof settingsSchema> {
  return {
    huntChance: s.huntChance,
    travelChance: s.travelChance,
    defaultExpirySeconds: s.defaultExpirySeconds,
    forceTrigger: s.forceTrigger,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
    updatedBy: s.updatedBy,
    bounds: {
      chance: { ...SETTINGS_BOUNDS.chance },
      expirySeconds: { ...SETTINGS_BOUNDS.expirySeconds },
    },
  };
}

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
      await requirePortalPermission(req, authorization, permission, {
        allowBearer: ctx.adminBearerAllowed === true,
      });
    };

    /**
     * Permission check as a `preValidation` hook rather than the first line of
     * each handler.
     *
     * Ordering is the point. Fastify validates the body against the route's
     * Zod schema *before* the handler runs, so a check inside the handler
     * answers an unauthorized caller with a 400 describing the shape the route
     * expects — handing the admin API's schema to someone who may not even be
     * in the guild. Running at `preValidation` means the 403 comes first and
     * the body is never parsed. `src/api/auth.ts` moves the bearer check up to
     * `onRequest` for exactly this reason.
     */
    /**
     * The settings service is optional on `ApiContext` (a deployment without
     * the encounter engine wires none), so the routes that need it say so
     * once rather than each optional-chaining their way to a confusing null.
     */
    const requireSettings = (): WorldEncounterSettingsService => {
      const service = ctx.services.worldEncounterSettings;
      if (!service) {
        throw new AppError(
          'NOT_FOUND',
          'World encounter settings are not wired in this deployment',
          'Encounter settings are unavailable.',
        );
      }
      return service;
    };

    const gate =
      (permission: Parameters<typeof requireAuth>[1]) =>
      async (req: import('fastify').FastifyRequest): Promise<void> => {
        await requireAuth(req, permission);
      };

    app.get(
      '/admin/encounters',
      {
        preValidation: gate('encounters.read'),
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
        const encounters = await admin.list();
        return ok(req, { encounters: encounters.map(encounterToResource) });
      },
    );

    /**
     * Encounter artwork bytes, for the Portal editor's preview.
     *
     * The Portal's image resolver deliberately refuses to turn a stored
     * `imagePath` into a URL — physical paths are an internal detail and must
     * not leak into pages (`portal/src/images/providers/localDevAssets.ts`).
     * The encounter editor is the one place where the path *is* the subject:
     * an author types it and needs to see what they typed. So the API answers
     * with bytes rather than handing the Portal a path to construct a URL
     * from, and the rule survives intact.
     *
     * This is not a general asset server:
     *
     *   - it is inside the admin namespace and gated on `encounters.read`;
     *   - the path is confined by `resolveAssetPath`, the same helper the
     *     Discord presenter and the content loader use, which throws for
     *     anything resolving outside `assetsDir`;
     *   - it serves a fixed, small allowlist of image extensions;
     *   - a missing file is a plain 404, so a typo reads as "not found"
     *     rather than as an error the editor has to interpret.
     */
    app.get(
      '/admin/encounters/artwork',
      {
        preValidation: gate('encounters.read'),
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Stream encounter artwork for the editor preview',
          querystring: z.object({ path: z.string().min(1).max(200) }),
          response: { ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req, reply) => {
        const relative = req.query.path;
        const ext = relative.slice(relative.lastIndexOf('.')).toLowerCase();
        if (!ARTWORK_CONTENT_TYPES[ext]) {
          throw new AppError('NOT_FOUND', `Unsupported artwork type "${ext}"`, 'Not found.');
        }
        let absolute: string;
        try {
          absolute = resolveAssetPath(ctx.assetsDir ?? './assets', relative);
        } catch {
          // Escaping the assets directory is indistinguishable from a typo
          // as far as the editor is concerned, and saying so tells an
          // attacker nothing.
          throw new AppError('NOT_FOUND', 'Artwork not found', 'Not found.');
        }
        if (!existsSync(absolute)) {
          throw new AppError('NOT_FOUND', 'Artwork not found', 'Not found.');
        }
        // Same shape the species artwork route uses: set headers, send the
        // bytes, hand the reply back. The Zod type provider types `send`
        // against the declared JSON responses, and a binary body is the
        // documented exception — see `ArtworkReply` in `routes/v1/artwork.ts`.
        const out = reply as unknown as {
          header(k: string, v: string): typeof out;
          send(payload: Buffer): unknown;
        };
        out
          .header('content-type', ARTWORK_CONTENT_TYPES[ext] as string)
          .header('cache-control', 'private, max-age=60, must-revalidate')
          .send(await readFile(absolute));
        return reply;
      },
    );

    /**
     * Global runtime tuning: the four values the engine reads on every roll.
     *
     * Deliberately inside the encounter admin namespace and gated on the same
     * permissions as everything else here — this is encounter configuration,
     * not a general settings surface, and nothing unrelated belongs in it.
     */
    app.get(
      '/admin/encounters/settings',
      {
        preValidation: gate('encounters.read'),
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Read global world encounter runtime settings',
          response: { 200: dataSchema(settingsSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const settings = requireSettings();
        return ok(req, toSettingsResource(await settings.get()));
      },
    );

    app.put(
      '/admin/encounters/settings',
      {
        // `encounters.publish` rather than `.write`: these values change the
        // live game for every player at once, which is closer to publishing an
        // encounter than to editing a draft.
        preValidation: gate('encounters.publish'),
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Update global world encounter runtime settings',
          body: settingsPatchSchema,
          response: { 200: dataSchema(settingsSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const settings = requireSettings();
        // The actor comes from the authenticated session, never the body.
        const actor = req.portalSession?.discordUserId ?? null;
        try {
          return ok(req, toSettingsResource(await settings.update(req.body, actor)));
        } catch (err) {
          if (err instanceof WorldEncounterSettingsValidationError) {
            throw new AppError(
              'VALIDATION_ERROR',
              err.issues.join(' '),
              err.issues.join(' '),
            );
          }
          throw err;
        }
      },
    );

    app.get(
      '/admin/encounters/reference',
      {
        preValidation: gate('encounters.read'),
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
        const content = ctx.getContent();
        const encounters = await admin.list();
        // Real definitions from the vendor table — the editor's vendor
        // selector must offer what is actually seeded, not a hard-coded name
        // that silently stops matching the moment a second vendor ships.
        const vendorRows = (await ctx.services.worldEncounterVendor?.listDefinitions()) ?? [];
        const vendors = vendorRows.map((v) => ({ vendorKey: v.vendorKey, name: v.name }));
        return ok(req, {
          regions: [...REGIONS],
          regionNames: Object.fromEntries(content.regions.map((r) => [r.id, r.name])),
          speciesRarities: [...RARITIES],
          affinities: [...AFFINITIES],
          races: [...RACE_CODES],
          items: content.items.map((i) => ({ slug: i.slug, name: i.name, category: i.category })),
          encounters: encounters.map((e) => ({ slug: e.slug, name: e.name })),
          // Enabled species, so `trigger_waifumon_encounter` picks from a
          // canonical list rather than a free-text slug an author can typo.
          species: content.species
            .filter((sp) => sp.enabled !== false)
            .map((sp) => ({ slug: sp.slug, name: sp.name, rarity: sp.rarity })),
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
        preValidation: gate('encounters.read'),
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
        const { id } = req.params;
        const encounter = await admin.get(id);
        if (!encounter) throw new AppError('NOT_FOUND', `Encounter ${id} not found`, 'Not found.');
        return ok(req, encounterToResource(encounter));
      },
    );

    app.post(
      '/admin/encounters',
      {
        preValidation: gate('encounters.write'),
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
        if (req.body.input.lifecycle === 'active') {
          await assertPublishableSelectors(
            ctx.services.speciesSelector,
            ctx.getContent().regions.filter((r) => r.enabled).map((r) => r.id),
            req.body.input.choices,
          );
        }
        const result = await admin.upsert(req.body.input);
        return ok(req, encounterToResource(result));
      },
    );

    app.put(
      '/admin/encounters/:id',
      {
        preValidation: gate('encounters.write'),
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
        const existing = await admin.get(req.params.id);
        if (!existing) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        if (req.body.input.lifecycle === 'active') {
          await assertPublishableSelectors(
            ctx.services.speciesSelector,
            ctx.getContent().regions.filter((r) => r.enabled).map((r) => r.id),
            req.body.input.choices,
          );
        }
        const result = await admin.upsert({ ...req.body.input, slug: existing.slug });
        return ok(req, encounterToResource(result));
      },
    );

    app.post(
      '/admin/encounters/:id/clone',
      {
        preValidation: gate('encounters.write'),
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
        const cloned = await admin.clone(req.params.id, req.body.newSlug);
        return ok(req, encounterToResource(cloned));
      },
    );

    app.patch(
      '/admin/encounters/:id/lifecycle',
      {
        // Gated twice: `encounters.write` before the body is parsed, then
        // `encounters.publish` once the body says this is a publish. The
        // pre-validation half keeps the schema away from a caller with no
        // admin rights at all.
        preValidation: gate('encounters.write'),
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
        if (req.body.lifecycle === 'active') await requireAuth(req, 'encounters.publish');
        const existing = await admin.get(req.params.id);
        if (!existing) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        // The list page's Activate goes through here, so the publish rule
        // lives on the server rather than only in the editor.
        if (req.body.lifecycle === 'active') {
          await assertPublishableSelectors(
            ctx.services.speciesSelector,
            ctx.getContent().regions.filter((r) => r.enabled).map((r) => r.id),
            existing.choices,
          );
        }
        await admin.setLifecycle(req.params.id, req.body.lifecycle);
        const updated = await admin.get(req.params.id);
        if (!updated) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        return ok(req, encounterToResource(updated));
      },
    );

    app.delete(
      '/admin/encounters/:id',
      {
        preValidation: gate('encounters.write'),
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
        preValidation: gate('encounters.read'),
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
        preValidation: gate('encounters.simulate'),
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
        const encounter = await admin.get(req.params.id);
        if (!encounter) throw new AppError('NOT_FOUND', 'Encounter not found', 'Not found.');
        const choice = encounter.choices.find((c) => c.id === req.body.choiceId);
        if (!choice) {
          throw new AppError('NOT_FOUND', 'Choice not found on this encounter', 'Not found.');
        }
        // A caller-supplied seed makes the run reproducible; otherwise the
        // server picks one and reports it back, so any result an author
        // quotes can be re-run exactly.
        const seed = req.body.seed ?? Math.floor(Math.random() * 2_147_483_647);
        const aggregate = simulateChoice(choice, req.body, contextFrom(req.body), seed);
        // Sightings are sampled once each through the live selector, in a
        // region that is always reported back — never an ambiguous count.
        const enabled = ctx
          .getContent()
          .regions.filter((r) => r.enabled)
          .map((r) => r.id as string);
        const regionId =
          req.body.regionId ?? directRegions(encounter, enabled)[0] ?? DEFAULT_REGION;
        const sightings = await simulateSightings(
          ctx.services.speciesSelector,
          choice,
          regionId,
          req.body.playerLevel,
        );
        return ok(req, {
          encounter: encounterToResource(encounter),
          choiceId: choice.id,
          aggregate,
          sightings,
        });
      },
    );

    /**
     * What a `trigger_waifumon_encounter` selector can produce, evaluated by
     * the runtime's own picker — the Portal renders this and never re-derives
     * which species match.
     *
     * Random selectors are evaluated per region: the one asked for, or every
     * region the encounter can fire in directly (hunt regions, travel
     * destinations; "anywhere" means every enabled region). `matchesAnywhere`
     * is computed over all enabled regions, which is exactly the
     * `selector_no_candidates` condition import validation blocks on.
     *
     * Reads only. The picker draws a species as a side effect of evaluating;
     * that draw is discarded and nothing is written.
     */
    app.post(
      '/admin/encounters/selector-preview',
      {
        preValidation: gate('encounters.read'),
        schema: {
          tags: ['Admin — Encounters'],
          summary: 'Preview the species a Waifumon sighting selector can produce',
          body: selectorPreviewBodySchema,
          response: {
            200: dataSchema(selectorPreviewResponseSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const selector = ctx.services.speciesSelector;
        if (!selector) {
          throw new AppError(
            'NOT_FOUND',
            'The species selector is not wired in this deployment',
            'Selector preview is unavailable.',
          );
        }
        const { selection, playerLevel } = req.body;
        if (!selection) {
          return ok(req, { mode: 'hunt_draw', specific: null, regions: [], matchesAnywhere: true });
        }
        if (selection.mode === 'specific') {
          const row = await selector.findEnabledSpecies(selection.speciesSlug);
          return ok(req, {
            mode: 'specific',
            specific: row
              ? { ...speciesRef(row), found: true }
              : { slug: selection.speciesSlug, name: selection.speciesSlug, rarity: '', found: false },
            regions: [],
            matchesAnywhere: row != null,
          });
        }

        const content = ctx.getContent();
        const names = new Map<string, string>(content.regions.map((r) => [r.id, r.name]));
        const enabled = content.regions.filter((r) => r.enabled).map((r) => r.id as string);
        const evaluate = async (regionId: string) => {
          const pick = await selector.pick(selection, { regionId, playerLevel });
          const candidates =
            pick.status === 'selected'
              ? pick.candidates.map(speciesRef).sort((a, b) => a.name.localeCompare(b.name))
              : [];
          return {
            regionId,
            regionName: names.get(regionId) ?? regionId,
            candidateCount: candidates.length,
            candidates,
          };
        };
        const everywhere = await Promise.all(enabled.map(evaluate));
        const byId = new Map(everywhere.map((r) => [r.regionId, r]));
        const wanted = req.body.regionId
          ? [req.body.regionId]
          : directRegions(
              req.body.encounter ?? {
                huntEligible: true,
                travelEligible: false,
                regions: [],
                routes: [],
              },
              enabled,
            );
        const regions = await Promise.all(wanted.map((id) => byId.get(id) ?? evaluate(id)));
        return ok(req, {
          mode: 'random',
          specific: null,
          regions,
          matchesAnywhere: everywhere.some((r) => r.candidateCount > 0),
        });
      },
    );
  };

/* ─────────────────────── Simulation ─────────────────────── */

/**
 * Run the choice `rolls` times and report what actually happened.
 *
 * This is a **simulation**, not an expected-value calculator. Each iteration
 * draws from the injected RNG and calls the same {@link rollCheck} the live
 * encounter resolver calls, so the success/failure split carries real
 * variance and the reward totals are the ones those particular rolls earned.
 * (An earlier version multiplied the chance by the roll count, which produced
 * a number that could never disagree with the formula — and therefore could
 * never tell an author anything the formula had not already told them.)
 *
 * The expected values are reported *alongside* the observed ones rather than
 * instead of them: `expectedSuccessRate` and `expectedNetWaifubuxPerRoll` are
 * the closed-form answers, and `successRateStdError` says how far an honest
 * run of this size is likely to stray from them.
 *
 * Completely mutation-free by construction: it reads a hydrated encounter and
 * a context object, and touches no service, no transaction and no table. No
 * currency, inventory, XP, cooldown, active-encounter row or history line can
 * result from calling it.
 */
export function simulateChoice(
  choice: LoadedEncounter['choices'][number],
  body: { rolls: number },
  ctx: EncounterCheckContext,
  seed: number,
): SimulateAggregate {
  const rolls = body.rolls;
  const rng = seededRng(seed);

  let successes = 0;
  let waifubuxGained = 0;
  let waifubuxLost = 0;
  let essenceGained = 0;
  let essenceLost = 0;
  let affectionGranted = 0;
  const itemFrequency: Record<string, number> = {};
  const followUpFrequency: Record<string, number> = {};

  /** Fold one roll's effect list into the running totals. */
  const accumulate = (effects: LoadedEncounter['choices'][number]['successEffects']) => {
    for (const effect of effects) {
      switch (effect.type) {
        case 'waifubux_gain':
          waifubuxGained += effect.amount;
          break;
        case 'waifubux_loss':
          waifubuxLost += effect.amount;
          break;
        case 'waifubux_loss_percent': {
          // No live balance to read against, so the declared cap stands in for
          // the loss. Upper-bound guidance, and the one figure in this report
          // that is an approximation rather than an observation.
          waifubuxLost += effect.maxAmount ?? Math.round(effect.percent * 500);
          break;
        }
        case 'essence_gain':
          essenceGained += effect.amount;
          break;
        case 'essence_loss':
          essenceLost += effect.amount;
          break;
        case 'affection_gain':
          // Pure arithmetic over the authored list — no Buddy is resolved and
          // no row is touched, so a simulation can never move real Affection.
          affectionGranted += effect.amount;
          break;
        case 'give_item':
        case 'consume_item':
          itemFrequency[effect.slug] = (itemFrequency[effect.slug] ?? 0) + effect.quantity;
          break;
        case 'trigger_encounter':
        case 'trigger_waifumon_encounter':
        case 'open_vendor':
        case 'temp_buff':
          followUpFrequency[effect.type] = (followUpFrequency[effect.type] ?? 0) + 1;
          break;
        default:
          break;
      }
    }
  };

  for (let i = 0; i < rolls; i++) {
    const outcome = rollCheck(choice.check, ctx, rng);
    if (outcome.success) successes++;
    accumulate(outcome.success ? choice.successEffects : choice.failureEffects);
  }

  const failures = rolls - successes;
  const observedRate = successes / rolls;
  const expectedRate = computeChance(choice.check, ctx).chance;
  const netWaifubux = waifubuxGained - waifubuxLost;

  return {
    rolls,
    successes,
    failures,
    successRate: observedRate,
    expectedSuccessRate: expectedRate,
    successRateDeviation: observedRate - expectedRate,
    successRateStdError: Math.sqrt((expectedRate * (1 - expectedRate)) / rolls),
    waifubuxGained,
    waifubuxLost,
    netWaifubux,
    netWaifubuxPerRoll: netWaifubux / rolls,
    expectedNetWaifubuxPerRoll: expectedNetWaifubuxPerRoll(choice, expectedRate),
    essenceGained,
    essenceLost,
    netEssence: essenceGained - essenceLost,
    affectionGranted,
    itemFrequency,
    followUpFrequency,
    seed,
  };
}

/**
 * Closed-form Waifubux expectation for one roll: the success branch weighted
 * by `p`, the failure branch by `1 - p`. Reported next to the observed net so
 * an author can see at a glance whether a run was lucky or the numbers are
 * genuinely off.
 */
function expectedNetWaifubuxPerRoll(
  choice: LoadedEncounter['choices'][number],
  chance: number,
): number {
  const branch = (effects: LoadedEncounter['choices'][number]['successEffects']): number => {
    let net = 0;
    for (const effect of effects) {
      switch (effect.type) {
        case 'waifubux_gain':
          net += effect.amount;
          break;
        case 'waifubux_loss':
          net -= effect.amount;
          break;
        case 'waifubux_loss_percent':
          net -= effect.maxAmount ?? Math.round(effect.percent * 500);
          break;
        default:
          break;
      }
    }
    return net;
  };
  return chance * branch(choice.successEffects) + (1 - chance) * branch(choice.failureEffects);
}
