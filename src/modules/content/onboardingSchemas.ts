/**
 * Schemas for the NPC registry (`content/npcs.json`) and onboarding narratives
 * (`content/onboarding/<flow>.json`).
 *
 * Kept out of `schemas.ts` because artwork paths are validated with
 * `relativeArtworkPath`, whose module imports `schemas.ts` — defining these
 * there would make the two modules import each other.
 *
 * Narrative is git-managed content, not Portal-authored: it ships with the
 * code that reads it. The mechanics (what each step grants, the stat maths)
 * live in code; these files only say what Patch says.
 */
import { z } from 'zod';
import { relativeArtworkPath } from '../assets/artworkPath';
import { EQUIPMENT_ONBOARDING_FLOW } from '../onboarding/vocabulary';

const npcKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'key must be lowercase snake_case');

/** Discord's embed limits, so authored copy can never fail a render. */
const embedTitle = z.string().trim().min(1).max(256);
const prose = z.string().trim().min(1).max(1000);
/** Discord's button-label limit. */
const buttonLabel = z.string().trim().min(1).max(80);

/**
 * A reusable character. Nothing here is specific to one feature: the same
 * Patch can front the onboarding today and a salvage counter later.
 */
export const NpcSchema = z
  .object({
    key: npcKey,
    name: z.string().trim().min(1).max(60),
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    portraitPath: relativeArtworkPath.nullable().default(null),
  })
  .strict();
export type NpcContent = z.infer<typeof NpcSchema>;

export const NpcsFileSchema = z.array(NpcSchema).superRefine((npcs, ctx) => {
  const seen = new Set<string>();
  npcs.forEach((npc, i) => {
    if (seen.has(npc.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `duplicate NPC key "${npc.key}"` });
    }
    seen.add(npc.key);
  });
});

/**
 * One screen. `narration` is scene-setting in italics; `say` is the NPC's
 * line. Every step needs at least one of the two.
 */
const stepShape = {
  title: embedTitle,
  narration: prose.optional(),
  say: prose.optional(),
  button: buttonLabel,
  artworkPath: relativeArtworkPath.nullable().default(null),
};

function requireSpeech(step: { narration?: string | undefined; say?: string | undefined }, ctx: z.RefinementCtx): void {
  if (!step.narration && !step.say) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'needs narration, say, or both' });
  }
}

const OnboardingStepSchema = z.object(stepShape).strict().superRefine(requireSpeech);

/** The stat explanation: a line before the numbers, one after, and the no-Buddy screen. */
const ExplainStepSchema = z
  .object({
    ...stepShape,
    sayAfter: prose.optional(),
    noBuddy: z
      .object({
        title: embedTitle,
        narration: prose.optional(),
        say: prose.optional(),
        artworkPath: relativeArtworkPath.nullable().default(null),
      })
      .strict()
      .superRefine(requireSpeech),
  })
  .strict()
  .superRefine(requireSpeech);

/**
 * The Equipment onboarding narrative. `steps` must name exactly the flow's
 * steps (`EQUIPMENT_ONBOARDING_STEPS`): `.strict()` rejects an extra one and
 * every key is required, so a missing or misspelt step fails the load.
 */
export const EquipmentOnboardingContentSchema = z
  .object({
    format: z.literal('waifumon-onboarding'),
    version: z.literal(1),
    flow: z.literal(EQUIPMENT_ONBOARDING_FLOW),
    /** Key into `content/npcs.json`. */
    npc: npcKey,
    menu: z
      .object({
        fieldName: z.string().trim().min(1).max(256),
        beginText: prose,
        resumeText: prose,
      })
      .strict(),
    /** Appended to the level-up rewards when a player reaches the onboarding level. */
    levelUpLabel: z.string().trim().min(1).max(200),
    /** Shown when a button is pressed while the onboarding is switched off or not ready. */
    unavailableText: prose,
    steps: z
      .object({
        intro: OnboardingStepSchema,
        attack: OnboardingStepSchema,
        defense: OnboardingStepSchema,
        health: OnboardingStepSchema,
        explain: ExplainStepSchema,
        complete: OnboardingStepSchema,
      })
      .strict(),
  })
  .strict();
export type EquipmentOnboardingContent = z.infer<typeof EquipmentOnboardingContentSchema>;
