/**
 * World Encounter runtime types.
 *
 * The DB stores `requirements_json`, `check_json`, `success_effects_json`,
 * `failure_effects_json` as untyped JSONB. Everything below is the Zod-checked
 * shape those columns are validated into on the way in (admin write) and on
 * the way out (engine load). Nothing else in the module reads the raw JSONB.
 */
import { z } from 'zod';
import { REGIONS } from '../locations/regions';
import { AFFINITIES } from '../../db/schema';
import {
  SpeciesSelectionSchema,
  type RandomSpeciesSelection,
} from '../encounters/speciesSelection';
import { OutcomeTextSchema } from './outcomeText';
import {
  WORLD_ENCOUNTER_CHECK_TYPES,
  WORLD_ENCOUNTER_EFFECT_TYPES,
  WORLD_ENCOUNTER_LIFECYCLES,
  WORLD_ENCOUNTER_RARITIES,
  WORLD_ENCOUNTER_SOURCES,
  WORLD_ENCOUNTER_TYPES,
} from '../../db/schema';

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'slug must be lowercase snake_case');

/* ─────────────────────── Effects ─────────────────────── */

const gainAmount = z.number().int().positive().max(1_000_000);
const lossAmount = z.number().int().positive().max(1_000_000);
const xpAmount = z.number().int().nonnegative().max(100_000);

export const EffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('waifubux_gain'), amount: gainAmount }),
  z.object({ type: z.literal('waifubux_loss'), amount: lossAmount }),
  z.object({
    type: z.literal('waifubux_loss_percent'),
    /** 0.10 = 10 %. */
    percent: z.number().gt(0).max(1),
    /** Hard cap on the deduction, in raw Waifubux. Applied *after* the percent. */
    maxAmount: z.number().int().positive().max(100_000).optional(),
  }),
  z.object({ type: z.literal('essence_gain'), amount: gainAmount }),
  z.object({ type: z.literal('essence_loss'), amount: lossAmount }),
  z.object({ type: z.literal('energy_gain'), amount: gainAmount }),
  z.object({ type: z.literal('energy_loss'), amount: lossAmount }),
  z.object({ type: z.literal('player_xp'), amount: xpAmount }),
  z.object({ type: z.literal('buddy_xp'), amount: xpAmount }),
  /**
   * Flat Affection to the active Buddy. `gainAmount` rather than `xpAmount`
   * because zero is not a meaningful award here — an authored `0` is a mistake
   * worth rejecting at validation rather than a no-op to discover at runtime.
   *
   * The `affection_gain` **Buddy Bonus** scales this on the way out. That
   * happens inside `CollectionService.awardBuddyAffection`; the name collision
   * between the two registries is deliberate — they are the same concept seen
   * from the authoring side and the modifier side.
   */
  z.object({ type: z.literal('affection_gain'), amount: gainAmount }),
  z.object({ type: z.literal('give_item'), slug, quantity: z.number().int().positive().max(99) }),
  z.object({
    type: z.literal('consume_item'),
    slug,
    quantity: z.number().int().positive().max(99),
  }),
  z.object({ type: z.literal('trigger_encounter'), encounterSlug: slug }),
  /**
   * A wild Waifumon sighting. Three authored shapes, all valid:
   *
   *   - `{ type }` — legacy random: the hunt's own region/rarity draw,
   *     fallbacks included. Behaviour unchanged.
   *   - `{ type, speciesSlug }` — legacy specific.
   *   - `{ type, selection }` — `specific` (one slug) or `random` (pool scope
   *     plus optional rarity/race/affinity filters, resolved strictly — see
   *     `encounters/speciesSelection.ts`).
   *
   * `speciesSlug` and `selection` together are refused (see the refinement on
   * {@link EffectSchema}). Strict, so a misspelled `selection` is an error
   * rather than a silent downgrade to legacy random.
   * {@link normalizeWaifumonSelection} is the one reader of these shapes.
   */
  z
    .object({
      type: z.literal('trigger_waifumon_encounter'),
      speciesSlug: slug.optional(),
      selection: SpeciesSelectionSchema.optional(),
    })
    .strict(),
  z.object({
    type: z.literal('temp_buff'),
    /** Free-form identifier for a follow-up buff system to hook into. */
    key: z.string().min(1).max(64),
    durationSeconds: z.number().int().positive().max(24 * 60 * 60),
    payload: z.record(z.unknown()).default({}),
  }),
  z.object({ type: z.literal('open_vendor'), vendorKey: z.string().min(1).max(64) }),
]).superRefine((effect, ctx) => {
  // The one cross-field rule a discriminated-union member cannot carry on its
  // own object: two ways of naming the species at once is ambiguous.
  if (
    effect.type === 'trigger_waifumon_encounter' &&
    effect.speciesSlug != null &&
    effect.selection != null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selection'],
      message: 'Use either the legacy `speciesSlug` or `selection`, not both.',
    });
  }
});
export type Effect = z.infer<typeof EffectSchema>;
export type WaifumonEncounterEffect = Extract<Effect, { type: 'trigger_waifumon_encounter' }>;

/**
 * The one reading of a `trigger_waifumon_encounter` effect, whatever shape was
 * authored. Normalised at use rather than migrated in storage, so legacy
 * content round-trips byte-for-byte.
 *
 *   `{ type }`                              → `legacy_random` (hunt draw + fallbacks)
 *   `{ type, speciesSlug }`                 → `specific`
 *   `{ type, selection: { mode: 'specific' } }` → `specific`
 *   `{ type, selection: { mode: 'random' } }`   → `random` (strict selector)
 */
export type NormalizedWaifumonSelection =
  | { mode: 'specific'; speciesSlug: string }
  | { mode: 'legacy_random' }
  | RandomSpeciesSelection;

export function normalizeWaifumonSelection(
  effect: WaifumonEncounterEffect,
): NormalizedWaifumonSelection {
  if (effect.selection) return effect.selection;
  if (effect.speciesSlug) return { mode: 'specific', speciesSlug: effect.speciesSlug };
  return { mode: 'legacy_random' };
}

/* ─────────────────────── Requirements ─────────────────────── */

/**
 * A choice may be gated by attributes of the active buddy. Requirements
 * evaluate against `EncounterCheckContext`; each entry is an AND on top of the
 * others.
 */
export const RequirementsSchema = z
  .object({
    affinity: z.enum(AFFINITIES).optional(),
    /** Any of these race tags on the buddy species allows this choice. */
    raceAny: z.array(z.string().min(1).max(64)).optional(),
    minPlayerLevel: z.number().int().positive().optional(),
    minBuddyLevel: z.number().int().positive().optional(),
    /** Item slug that must be present in inventory to select this choice. */
    requiresItem: slug.optional(),
  })
  .strict();
export type Requirements = z.infer<typeof RequirementsSchema>;

/* ─────────────────────── Checks ─────────────────────── */

/**
 * SP checks come in two models that live in the same object shape and are told
 * apart by a single field: **presence of `baseChance` selects the new model.**
 *
 * NEW MODEL (author sets an explicit success floor, buddy strength moves it a
 * bounded amount):
 *   { type: 'sp', baseChance: 0.40, maxSpModifier: 0.15,
 *     affinityAdvantage?, raceAdvantage? }
 *
 * LEGACY MODEL (base fixed at 50 %, `difficulty` compared against SP; kept so
 * existing content behaves *identically* — see {@link computeChance}):
 *   { type: 'sp', difficulty: 60, baseBias?, affinityAdvantage?, raceAdvantage? }
 *
 * Every field except `type` is optional at the schema level; the cross-field
 * rule ("exactly enough to pick a model") is enforced by the `superRefine`
 * below so a discriminated union can still carry both models without a third
 * `model` discriminant leaking into authored content.
 */
export const CheckSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      type: z.literal('sp'),

      /* ── New model ── */
      /**
       * Author-set success chance (0–1) *before* any buddy advantages. Its
       * presence is what switches a check onto the new formula.
       */
      baseChance: z.number().min(0).max(1).optional(),
      /**
       * Maximum absolute shift buddy SP may contribute, in probability points
       * (0–0.5). A strong buddy adds up to `+maxSpModifier`, a weak one up to
       * `−maxSpModifier`. Named for the cap it enforces rather than the scaling
       * curve, because the cap is the guarantee an author is buying — no amount
       * of SP can move the chance further than this. Defaults to
       * `DEFAULT_MAX_SP_MODIFIER` at resolve time when omitted.
       */
      maxSpModifier: z.number().min(0).max(0.5).optional(),

      /* ── Legacy model ── */
      /** Target SP the buddy is measured against (legacy formula only). */
      difficulty: z.number().int().nonnegative().max(1_000).optional(),
      /** Legacy flat percentage-point shift to the fixed 50 % base. */
      baseBias: z.number().min(-0.5).max(0.5).optional(),

      /* ── Shared advantages (both models) ── */
      /** Advantage modifier when buddy affinity matches. */
      affinityAdvantage: z.enum(AFFINITIES).optional(),
      /** Advantage modifier when any of these race tags is on the buddy species. */
      raceAdvantage: z.array(z.string().min(1).max(64)).optional(),
    }),
  ])
  .superRefine((check, ctx) => {
    if (check.type !== 'sp') return;
    if (check.baseChance === undefined && check.difficulty === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'An SP check needs either `baseChance` (new model) or `difficulty` (legacy model).',
      });
    }
  });
export type CheckSpec = z.infer<typeof CheckSchema>;

/* ─────────────────────── Choice ─────────────────────── */

export const ChoiceInputSchema = z.object({
  label: z.string().min(1).max(80),
  emoji: z.string().max(16).nullable().default(null),
  requirements: RequirementsSchema.default({}),
  check: CheckSchema.default({ type: 'none' }),
  successEffects: z.array(EffectSchema).default([]),
  failureEffects: z.array(EffectSchema).default([]),
  /**
   * Authored flavor text — presentation only, see `outcomeText.ts`. All
   * optional; trimmed, and blank normalises to omitted. `successText` and
   * `failureText` are never required just because a check exists.
   */
  outcomeText: OutcomeTextSchema,
  successText: OutcomeTextSchema,
  failureText: OutcomeTextSchema,
});
export type ChoiceInput = z.infer<typeof ChoiceInputSchema>;

/* ─────────────────────── Encounter definition ─────────────────────── */

export const EncounterInputSchema = z.object({
  slug,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  type: z.enum(WORLD_ENCOUNTER_TYPES),
  rarity: z.enum(WORLD_ENCOUNTER_RARITIES),
  weight: z.number().int().positive().max(1_000_000).default(10),
  lifecycle: z.enum(WORLD_ENCOUNTER_LIFECYCLES).default('draft'),
  huntEligible: z.boolean().default(true),
  travelEligible: z.boolean().default(false),
  cooldownSeconds: z.number().int().nonnegative().max(30 * 24 * 60 * 60).default(0),
  /** Relative path under `assets/`, e.g. `encounters/bandit_ambush.png`. */
  artworkPath: z
    .string()
    .max(200)
    .nullable()
    .default(null)
    .refine(
      (v) => v == null || !v.includes('..'),
      'artworkPath must not contain path traversal',
    ),
  chainedEncounterSlug: slug.nullable().default(null),
  choicesRequired: z.boolean().default(true),
  /** Empty = globally eligible for its enabled sources. */
  regions: z.array(z.enum(REGIONS)).default([]),
  /** Empty on a travel-eligible encounter = every travel edge. */
  routes: z
    .array(
      z
        .object({ fromRegion: z.enum(REGIONS), toRegion: z.enum(REGIONS) })
        .refine((r) => r.fromRegion !== r.toRegion, 'route endpoints must differ'),
    )
    .default([]),
  choices: z.array(ChoiceInputSchema).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type EncounterInput = z.infer<typeof EncounterInputSchema>;

/* ─────────────────────── Runtime shape ─────────────────────── */

/** A choice, as the engine and Discord layer see it. */
export interface LoadedChoice {
  id: number;
  sortOrder: number;
  label: string;
  emoji: string | null;
  requirements: Requirements;
  check: CheckSpec;
  successEffects: Effect[];
  failureEffects: Effect[];
  /**
   * Authored flavor text. Hydration always sets these (null when unauthored);
   * optional in the type only so hand-built fixtures need not spell them out.
   * Resolve with `resolveOutcomeText`, never by picking a field directly.
   */
  outcomeText?: string | null;
  successText?: string | null;
  failureText?: string | null;
}

/** An encounter, fully loaded from the DB with its choices. */
export interface LoadedEncounter {
  id: number;
  slug: string;
  name: string;
  description: string;
  type: (typeof WORLD_ENCOUNTER_TYPES)[number];
  rarity: (typeof WORLD_ENCOUNTER_RARITIES)[number];
  weight: number;
  lifecycle: (typeof WORLD_ENCOUNTER_LIFECYCLES)[number];
  huntEligible: boolean;
  travelEligible: boolean;
  cooldownSeconds: number;
  artworkPath: string | null;
  chainedEncounterSlug: string | null;
  choicesRequired: boolean;
  regions: string[]; // empty = global
  routes: Array<{ fromRegion: string; toRegion: string }>;
  choices: LoadedChoice[];
  metadata: Record<string, unknown>;
}

/* ─────────────────────── Check context ─────────────────────── */

/**
 * The player-side facts the check resolver reads. Snapshotted once at the
 * moment the encounter fires; SP is derived (never mutates species state) and
 * `raceTags` comes from species tags (until race becomes a first-class field).
 */
export interface EncounterCheckContext {
  playerId: number;
  playerLevel: number;
  /** Null when the player has no buddy equipped. */
  buddy: BuddyProfile | null;
  /** Percentage-point shift applied by a Buddy Bonus (e.g. `encounter_check_bonus`). */
  buddyBonusPercent: number;
}

/**
 * Combat/skill profile of the active buddy. Deliberately a copy — nothing
 * below reads back into the DB.
 */
export interface BuddyProfile {
  waifuId: number;
  speciesSlug: string;
  speciesName: string;
  level: number;
  affinity: string;
  baseSp: number;
  currentSp: number;
  rarity: string;
  /** Tags copied from species — the racial vocabulary lives here for now. */
  raceTags: string[];
}

/** Result of a choice check. */
export interface CheckResolution {
  chance: number;
  roll: number;
  success: boolean;
  /**
   * Which check produced this resolution. `'none'` is the no-op check: it
   * never draws from the RNG, so a presentation layer must not narrate a roll
   * for it.
   */
  checkType: 'none' | 'sp';
  /**
   * Which SP formula produced `chance` — `'new'` for a `baseChance` check,
   * `'legacy'` for a `difficulty` one, `'none'` for the no-op check. Carried
   * so a UI can read the breakdown with the right vocabulary (the legacy model
   * is the only one with `levelTerm` / `baseBias` terms) without re-deriving
   * the model from the spec.
   */
  model: 'none' | 'new' | 'legacy';
  /**
   * True only when an RNG value was actually drawn and compared against
   * `chance`. False for every preview (`computeChance`) and for `'none'`
   * checks, whose `roll` is a filler zero rather than a real draw.
   */
  rolled: boolean;
  /** Broken-out contributors so preview + tests can assert them. */
  breakdown: {
    base: number;
    spTerm: number;
    levelTerm: number;
    affinityMod: number;
    raceMod: number;
    buddyBonusMod: number;
    baseBias: number;
  };
}

export type { WorldEncounterSource } from '../../db/schema';
export const SOURCES = WORLD_ENCOUNTER_SOURCES;
