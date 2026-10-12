/**
 * Dungeon Events: the dungeon-local library an `event` room action draws on.
 *
 * An **event** is a narrative with up to five choices. A **pool** is a
 * weighted list of events (and explicit Nothing entries) one of which is
 * selected when the player arrives. Both live inside the dungeon definition,
 * so they are hashed, published and pinned with it.
 *
 * Deliberately small and closed: no scripting, no variables beyond the run's
 * boolean flags. A choice has requirements, an optional SP check and one
 * outcome (or a success and a failure); an outcome has a short list of
 * effects, an optional Phase 2 reward bundle and a room-independent `then`.
 *
 * Schemas only. Selection, checks and resolution are `engine/events.ts`.
 */
import { z } from 'zod';
import { DungeonIdSchema as id } from './dungeonIdentifiers';
import { BASIS_POINTS, DungeonArtworkRefSchema, DungeonConditionSchema, referenceKey, shortText } from './dungeonPrimitives';
import { DungeonRewardBundleSchema } from './dungeonRewards';

export const DUNGEON_EVENT_LIMITS = Object.freeze({
  events: 100,
  pools: 50,
  poolEntries: 20,
  choices: 5,
  effects: 6,
  itemRequirements: 2,
  itemQuantity: 99,
  weight: 1_000_000,
  maxSpModifierBasisPoints: 5000,
});
const L = DUNGEON_EVENT_LIMITS;

/** What a check's SP modifier defaults to: ±15 points, as World Encounters use. */
export const DEFAULT_EVENT_SP_MODIFIER_BASIS_POINTS = 1500;

const share = z.number().int().min(1).max(BASIS_POINTS);

export const DungeonEventEffectSchema = z.discriminatedUnion('type', [
  /** Run-scoped flags only; the flag must be declared on the dungeon. */
  z.object({ type: z.literal('set_flag'), flag: id, value: z.boolean() }).strict(),
  /** A share of max HP, never above max. */
  z.object({ type: z.literal('heal'), basisPoints: share }).strict(),
  /** A share of max HP. Never lethal: the Buddy is left with at least 1 HP. */
  z.object({ type: z.literal('damage'), basisPoints: share }).strict(),
]);
export type DungeonEventEffect = z.infer<typeof DungeonEventEffectSchema>;
export const DUNGEON_EVENT_EFFECT_TYPES = ['set_flag', 'heal', 'damage'] as const satisfies readonly DungeonEventEffect['type'][];

/** Effects later work adds. Named so content that uses one is told so, and nothing else takes the name. */
export const RESERVED_EVENT_EFFECT_TYPES = ['lose_currency', 'start_combat', 'move', 'set_player_flag', 'trigger_event'] as const;

/**
 * Where the room's sequence goes after an outcome. A subset of
 * `ActionDestination` with nothing room-specific in it, so one event can sit
 * in any room. `retreat` is the walk-away: the event stays open.
 */
export const DungeonEventThenSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('next') }).strict(),
  z.object({ type: z.literal('room_complete') }).strict(),
  z.object({ type: z.literal('retreat') }).strict(),
  z.object({ type: z.literal('end_run'), outcome: z.enum(['completed', 'defeated']) }).strict(),
]);
export type DungeonEventThen = z.infer<typeof DungeonEventThenSchema>;

export const DungeonEventOutcomeSchema = z
  .object({
    /** What happened, as the player reads it. */
    text: shortText(800).default(''),
    /** Presentation only. */
    tone: z.enum(['good', 'neutral', 'bad']).optional(),
    effects: z.array(DungeonEventEffectSchema).max(L.effects).default([]),
    rewards: DungeonRewardBundleSchema.optional(),
    /** Omitted: the event action's own routing for `resolved`. */
    then: DungeonEventThenSchema.optional(),
  })
  .strict();
export type DungeonEventOutcome = z.infer<typeof DungeonEventOutcomeSchema>;

export const DungeonEventItemRequirementSchema = z
  .object({
    item: referenceKey,
    quantity: z.number().int().min(1).max(L.itemQuantity).default(1),
    /** Spent when the choice is made, whatever a check then does. */
    consume: z.boolean().default(false),
  })
  .strict();
export type DungeonEventItemRequirement = z.infer<typeof DungeonEventItemRequirementSchema>;

/** The only check: the participating Buddy's pinned SP against an author-set base chance. */
export const DungeonEventCheckSchema = z
  .object({
    type: z.literal('sp'),
    /** Success chance for an average Buddy (SP 200). */
    baseChanceBasisPoints: z.number().int().min(0).max(BASIS_POINTS),
    /** The most Buddy strength can move it, either way. */
    maxSpModifierBasisPoints: z.number().int().min(0).max(L.maxSpModifierBasisPoints).default(DEFAULT_EVENT_SP_MODIFIER_BASIS_POINTS),
  })
  .strict();
export type DungeonEventCheck = z.infer<typeof DungeonEventCheckSchema>;

export const DUNGEON_EVENT_BRANCHES = ['outcome', 'success', 'failure'] as const;
export type DungeonEventBranch = (typeof DUNGEON_EVENT_BRANCHES)[number];

/**
 * One button. Either `outcome` alone (always the same result — the form a
 * guaranteed success or failure takes), or `check` with `success` and `failure`.
 */
export const DungeonEventChoiceSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(60),
    description: shortText(200).optional(),
    /** Run state only. Inventory is `items`, never a condition. */
    requires: DungeonConditionSchema.optional(),
    items: z.array(DungeonEventItemRequirementSchema).max(L.itemRequirements).optional(),
    unavailableText: shortText(120).optional(),
    /** Unavailable choices are shown disabled unless this is set. */
    hideWhenUnavailable: z.boolean().optional(),
    outcome: DungeonEventOutcomeSchema.optional(),
    check: DungeonEventCheckSchema.optional(),
    success: DungeonEventOutcomeSchema.optional(),
    failure: DungeonEventOutcomeSchema.optional(),
  })
  .strict()
  .superRefine((choice, ctx) => {
    if (choice.check) {
      if (choice.outcome) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'a choice with a check has success and failure outcomes, not a single outcome' });
      for (const branch of ['success', 'failure'] as const) {
        if (!choice[branch]) ctx.addIssue({ code: 'custom', path: [branch], message: `a choice with a check needs a ${branch} outcome` });
      }
    } else {
      if (!choice.outcome) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'a choice needs an outcome, or a check with success and failure outcomes' });
      for (const branch of ['success', 'failure'] as const) {
        if (choice[branch]) ctx.addIssue({ code: 'custom', path: [branch], message: `a ${branch} outcome needs a check` });
      }
    }
  });
export type DungeonEventChoice = z.infer<typeof DungeonEventChoiceSchema>;

export const DungeonEventSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(80),
    /** The narrative. */
    text: z.string().trim().min(1).max(1500),
    artwork: DungeonArtworkRefSchema.nullable().optional(),
    choices: z.array(DungeonEventChoiceSchema).min(1).max(L.choices),
  })
  .strict();
export type DungeonEvent = z.infer<typeof DungeonEventSchema>;

const weight = z.number().int().min(1).max(L.weight);

/** Strict alternatives enforce exactly one of an event and an explicit Nothing. */
export const DungeonEventPoolEntrySchema = z.union([
  z
    .object({
      id,
      weight,
      eventId: id,
      /** The entry is only in the draw while this holds. */
      when: DungeonConditionSchema.optional(),
      /** Skipped once this event has been selected anywhere in the run. */
      oncePerRun: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      id,
      weight,
      nothing: z.literal(true),
      when: DungeonConditionSchema.optional(),
      /** One line shown when nothing happens. Omitted: silent. */
      text: shortText(200).optional(),
    })
    .strict(),
]);
export type DungeonEventPoolEntry = z.infer<typeof DungeonEventPoolEntrySchema>;

export const DungeonEventPoolSchema = z
  .object({
    id,
    /** Authoring label only. */
    name: z.string().trim().min(1).max(80),
    entries: z.array(DungeonEventPoolEntrySchema).min(1).max(L.poolEntries),
  })
  .strict();
export type DungeonEventPool = z.infer<typeof DungeonEventPoolSchema>;

/** What an `event` action presents: one named event, or a draw from a pool. */
export const DungeonEventSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), eventId: id }).strict(),
  z.object({ kind: z.literal('pool'), poolId: id }).strict(),
]);
export type DungeonEventSource = z.infer<typeof DungeonEventSourceSchema>;

/** A choice's outcomes with the branch each belongs to, in a fixed order. */
export function choiceOutcomes(choice: DungeonEventChoice): { branch: DungeonEventBranch; outcome: DungeonEventOutcome }[] {
  return DUNGEON_EVENT_BRANCHES.flatMap((branch) => {
    const outcome = choice[branch];
    return outcome ? [{ branch, outcome }] : [];
  });
}

/** Needs nothing of the run or the player: every player can always pick it. */
export function isAlwaysAvailable(choice: Pick<DungeonEventChoice, 'requires' | 'items'>): boolean {
  return !choice.requires && !(choice.items?.length);
}

/** An outcome that leaves the event open and sends the player back where they came from. */
export function isWalkAway(outcome: Pick<DungeonEventOutcome, 'then'>): boolean {
  return outcome.then?.type === 'retreat';
}
