/**
 * Seed catalogue — the bootstrap encounters that prove every major path.
 *
 * These are *defaults for missing content*, not an enforced definition. The
 * database is authoritative for any encounter that already exists: startup
 * inserts a slug only when it is absent and never touches one that is
 * present, so Portal edits survive restarts and deploys. Moving changed
 * content onto a live server is the job of export/import
 * (`encounterImportService.ts`), not of this file. Deliberately terse copy —
 * a designer will rewrite the prose later.
 *
 * Coverage guaranteed by this list:
 *
 *   • rewards Waifubux + items       (bandit_ambush success)
 *   • capped percentage Waifubux loss (bandit_ambush failure)
 *   • SP-based check                  (ledge, bandits, dune wraiths)
 *   • affinity modifier               (ledge, bandit intimidate)
 *   • race modifier                   (bandit fight, mirage riddle)
 *   • chains into another encounter   (hot spring → wandering merchant)
 *   • travel-only                     (bandit_ambush, wandering_merchant)
 *   • region-specific                 (all region seeds)
 *   • triggers a waifumon encounter   (lost_cub success)
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { worldEncounters } from '../../db/schema';
import { createWorldEncounterRepository } from './worldEncounterRepository';
import type { EncounterInput } from './types';
import { EncounterInputSchema } from './types';

/**
 * Encounter authoring form — validated by `EncounterInputSchema` and written
 * through the repository. Order in this list determines nothing.
 */
export const SEED_ENCOUNTERS: EncounterInput[] = EncounterInputSchema.array().parse([
  {
    slug: 'wv_lost_cub',
    name: 'A Lost Companion',
    description:
      'A tiny cub-like waifumon is stumbling through the tall grass, whimpering. It looks unhurt but hopelessly lost.',
    artworkPath: 'encounters/wv_lost_cub.webp',
    type: 'discovery',
    rarity: 'common',
    weight: 15,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 900,
    regions: ['waifu-valley'],
    choices: [
      {
        label: 'Guide her home (Caregiver)',
        emoji: '🤝',
        requirements: { affinity: 'caregiver' },
        check: { type: 'none' },
        successEffects: [
          { type: 'buddy_xp', amount: 25 },
          { type: 'trigger_waifumon_encounter' },
        ],
      },
      {
        label: 'Escort her carefully',
        emoji: '🌾',
        check: { type: 'sp', difficulty: 20, baseBias: 0.15 },
        successEffects: [
          { type: 'player_xp', amount: 15 },
          { type: 'essence_gain', amount: 20 },
        ],
        failureEffects: [{ type: 'energy_loss', amount: 1 }],
      },
      {
        label: 'Leave her be',
        emoji: '🚶',
        check: { type: 'none' },
        successEffects: [],
      },
    ],
  },
  {
    slug: 'wv_wildflower_field',
    name: 'A Field of Wildflowers',
    description:
      'You wander into a clearing full of shimmering wildflowers. Their pollen carries a strange, invigorating scent.',
    artworkPath: 'encounters/wv_wildflower_field.webp',
    type: 'discovery',
    rarity: 'common',
    weight: 20,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 600,
    regions: ['waifu-valley'],
    choicesRequired: false,
    choices: [
      {
        label: 'Gather a bouquet',
        emoji: '💐',
        check: { type: 'none' },
        successEffects: [{ type: 'essence_gain', amount: 30 }],
      },
      {
        label: 'Rest here',
        emoji: '😌',
        check: { type: 'none' },
        successEffects: [{ type: 'energy_gain', amount: 1 }],
      },
    ],
  },
  {
    slug: 'tp_narrow_ledge',
    name: 'A Narrow Ledge',
    description:
      'The path narrows to a crumbling ledge over a long drop. Crossing means placing every step carefully.',
    artworkPath: 'encounters/tp_narrow_ledge.webp',
    type: 'skill_check',
    rarity: 'uncommon',
    weight: 10,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 1800,
    regions: ['twin-peeks'],
    choices: [
      {
        label: 'Cross the ledge',
        emoji: '🧗',
        check: {
          type: 'sp',
          difficulty: 60,
          affinityAdvantage: 'primal',
          raceAdvantage: ['valkyrie', 'demon'],
        },
        successEffects: [
          { type: 'waifubux_gain', amount: 300 },
          { type: 'player_xp', amount: 25 },
        ],
        failureEffects: [
          { type: 'energy_loss', amount: 2 },
          { type: 'waifubux_loss', amount: 100 },
        ],
      },
      {
        label: 'Turn back',
        emoji: '↩️',
        check: { type: 'none' },
        successEffects: [],
      },
    ],
  },
  {
    slug: 'tp_mountain_bandit',
    name: 'Mountain Bandit',
    description:
      'A masked bandit blocks the trail, one hand on a sword hilt. "Toll or trouble, pick one."',
    artworkPath: 'encounters/tp_mountain_bandit.webp',
    type: 'combat',
    rarity: 'uncommon',
    weight: 8,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 1800,
    regions: ['twin-peeks'],
    choices: [
      {
        label: 'Fight',
        emoji: '⚔️',
        check: {
          type: 'sp',
          difficulty: 70,
          affinityAdvantage: 'dominant',
          raceAdvantage: ['valkyrie'],
        },
        successEffects: [
          { type: 'waifubux_gain', amount: 400 },
          { type: 'give_item', slug: 'basic_charm', quantity: 1 },
        ],
        failureEffects: [
          { type: 'waifubux_loss_percent', percent: 0.1, maxAmount: 500 },
          { type: 'energy_loss', amount: 2 },
        ],
      },
      {
        label: 'Pay the toll',
        emoji: '💰',
        check: { type: 'none' },
        successEffects: [{ type: 'waifubux_loss', amount: 150 }],
      },
    ],
  },
  {
    slug: 'ff_suspicious_stew',
    name: 'A Cauldron of Suspicious Stew',
    description:
      'A weathered pot bubbles on an unattended fire. The smell is… complicated. A dented ladle rests on a nearby stump.',
    artworkPath: 'encounters/ff_suspicious_stew.webp',
    type: 'decision',
    rarity: 'common',
    weight: 12,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 900,
    regions: ['flaccid-foothills'],
    choices: [
      {
        label: 'Take a bite',
        emoji: '🥣',
        check: { type: 'sp', difficulty: 30, baseBias: -0.1 },
        successEffects: [{ type: 'energy_gain', amount: 3 }, { type: 'player_xp', amount: 10 }],
        failureEffects: [{ type: 'energy_loss', amount: 2 }],
      },
      {
        label: 'Offer a charm as trade',
        emoji: '🎴',
        requirements: { requiresItem: 'basic_charm' },
        check: { type: 'none' },
        successEffects: [
          { type: 'consume_item', slug: 'basic_charm', quantity: 1 },
          { type: 'essence_gain', amount: 40 },
        ],
      },
      {
        label: 'Walk away',
        emoji: '🚶',
        check: { type: 'none' },
        successEffects: [],
      },
    ],
  },
  {
    slug: 'ff_hot_spring',
    name: 'A Steaming Hot Spring',
    description:
      'A hidden hot spring nestled in the rocks. The steam rising off it looks almost lazy — a rare invitation.',
    artworkPath: 'encounters/ff_hot_spring.webp',
    type: 'discovery',
    rarity: 'uncommon',
    weight: 8,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 3600,
    regions: ['flaccid-foothills'],
    chainedEncounterSlug: 'tv_wandering_merchant',
    choices: [
      {
        label: 'Take a long soak',
        emoji: '♨️',
        check: { type: 'none' },
        successEffects: [
          { type: 'energy_gain', amount: 4 },
          { type: 'buddy_xp', amount: 20 },
        ],
      },
    ],
  },
  {
    slug: 'th_mirage_oasis',
    name: 'The Mirage Deity',
    description:
      'The shimmering figure of a goddess rises from a pool that should not be here. "Answer me, traveler. What thirsts eternally, yet drinks nothing?"',
    artworkPath: 'encounters/th_mirage_oasis.webp',
    type: 'deity',
    rarity: 'rare',
    weight: 4,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 6 * 3600,
    regions: ['thirstlands'],
    metadata: { riddleAnswer: 'flame' },
    choices: [
      {
        label: 'A flame',
        emoji: '🔥',
        check: { type: 'none' },
        successEffects: [
          { type: 'waifubux_gain', amount: 500 },
          { type: 'essence_gain', amount: 100 },
          { type: 'temp_buff', key: 'deity_blessing', durationSeconds: 3600, payload: { kind: 'capture_bonus', magnitude: 0.05 } },
        ],
      },
      {
        label: 'The sand',
        emoji: '🏜️',
        check: { type: 'none' },
        successEffects: [],
        failureEffects: [{ type: 'waifubux_loss', amount: 100 }],
      },
      {
        label: 'A god',
        emoji: '✨',
        requirements: { raceAny: ['angel', 'spirit', 'demon'] },
        check: { type: 'none' },
        successEffects: [{ type: 'essence_gain', amount: 60 }],
      },
    ],
  },
  {
    slug: 'th_dune_wraiths',
    name: 'Dune Wraiths',
    description:
      'Sand-shaped forms rise from the dunes, hungering. They circle. Something must be given, or something must be taken.',
    artworkPath: 'encounters/th_dune_wraiths.webp',
    type: 'combat',
    rarity: 'rare',
    weight: 5,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 3600,
    regions: ['thirstlands'],
    choices: [
      {
        label: 'Fight through',
        emoji: '🗡️',
        check: {
          type: 'sp',
          difficulty: 90,
          affinityAdvantage: 'dominant',
          raceAdvantage: ['valkyrie', 'angel'],
        },
        successEffects: [
          { type: 'waifubux_gain', amount: 600 },
          { type: 'player_xp', amount: 50 },
        ],
        failureEffects: [
          { type: 'waifubux_loss_percent', percent: 0.15, maxAmount: 1000 },
          { type: 'energy_loss', amount: 3 },
        ],
      },
      {
        label: 'Offer essence',
        emoji: '💎',
        check: { type: 'none' },
        successEffects: [{ type: 'essence_loss', amount: 50 }],
      },
    ],
  },
  {
    slug: 'tv_bandit_ambush',
    name: 'Bandit Ambush',
    description:
      'Three bandits step out of the roadside brush. "Nice buddy. Bet the coins are nicer."',
    artworkPath: 'encounters/tv_bandit_ambush.webp',
    type: 'combat',
    rarity: 'uncommon',
    weight: 10,
    lifecycle: 'active',
    huntEligible: false,
    travelEligible: true,
    cooldownSeconds: 1800,
    regions: [], // any region
    routes: [], // any travel edge
    choices: [
      {
        label: 'Fight',
        emoji: '⚔️',
        check: {
          type: 'sp',
          difficulty: 75,
          affinityAdvantage: 'dominant',
          raceAdvantage: ['valkyrie'],
        },
        successEffects: [
          { type: 'waifubux_gain', amount: 350 },
          { type: 'give_item', slug: 'basic_charm', quantity: 1 },
          { type: 'trigger_encounter', encounterSlug: 'tv_bandit_aftermath' },
        ],
        failureEffects: [
          { type: 'waifubux_loss_percent', percent: 0.1, maxAmount: 500 },
        ],
      },
      {
        label: 'Intimidate',
        emoji: '😠',
        requirements: { affinity: 'dominant' },
        check: { type: 'sp', difficulty: 50, baseBias: 0.15 },
        successEffects: [{ type: 'waifubux_gain', amount: 200 }],
        failureEffects: [{ type: 'waifubux_loss', amount: 100 }],
      },
      {
        label: 'Run',
        emoji: '🏃',
        check: { type: 'sp', difficulty: 40, baseBias: 0.2 },
        successEffects: [],
        failureEffects: [{ type: 'waifubux_loss', amount: 50 }],
      },
      {
        label: 'Pay',
        emoji: '💰',
        check: { type: 'none' },
        successEffects: [{ type: 'waifubux_loss', amount: 200 }],
      },
    ],
  },
  {
    slug: 'tv_bandit_aftermath',
    name: 'Bandit Camp Aftermath',
    description:
      'You loot the bandits\'s abandoned camp. Hidden in a pack — a small coin purse and a scrap of parchment.',
    artworkPath: 'encounters/tv_bandit_aftermath.webp',
    type: 'discovery',
    rarity: 'uncommon',
    weight: 1,
    lifecycle: 'active',
    huntEligible: false,
    travelEligible: false,
    // The parent already gates hunt/travel eligibility; this one is only
    // reachable via a `trigger_encounter` follow-up from the bandit fight.
    cooldownSeconds: 0,
    regions: [],
    routes: [],
    choicesRequired: true,
    choices: [
      {
        label: 'Pocket the loot',
        emoji: '🪙',
        check: { type: 'none' },
        successEffects: [
          { type: 'waifubux_gain', amount: 150 },
          { type: 'player_xp', amount: 20 },
        ],
      },
      {
        label: 'Leave it — this feels wrong',
        emoji: '🕯️',
        check: { type: 'none' },
        successEffects: [{ type: 'essence_gain', amount: 25 }],
      },
    ],
  },
  {
    slug: 'tv_wandering_merchant',
    name: 'The Wandering Merchant',
    description:
      'A hooded merchant with a cart of curiosities beckons you closer. "Special traveler’s prices, no questions."',
    artworkPath: 'encounters/tv_wandering_merchant.webp',
    type: 'vendor',
    rarity: 'rare',
    weight: 3,
    lifecycle: 'active',
    huntEligible: false,
    travelEligible: true,
    cooldownSeconds: 6 * 3600,
    regions: [],
    routes: [],
    choices: [
      {
        label: 'Buy a lucky charm (150 WB)',
        emoji: '🎴',
        check: { type: 'none' },
        successEffects: [
          { type: 'waifubux_loss', amount: 150 },
          { type: 'give_item', slug: 'basic_charm', quantity: 1 },
        ],
      },
      {
        label: 'Browse (vendor placeholder)',
        emoji: '🛒',
        check: { type: 'none' },
        successEffects: [{ type: 'open_vendor', vendorKey: 'wandering_merchant' }],
      },
      {
        label: 'Walk on',
        emoji: '🚶',
        check: { type: 'none' },
        successEffects: [],
      },
    ],
  },
]);

export interface SeedResult {
  created: string[];
  /** Existing slugs overwritten from the catalogue. Always empty in `insert-missing` mode. */
  updated: string[];
  /** Existing slugs left exactly as they were. Always empty in `reset` mode. */
  skipped: string[];
}

/**
 * How a seed treats a slug that already exists.
 *
 *  - `insert-missing` — the production/bootstrap behaviour. The existing row
 *    and its regions, routes and choices are not read beyond the slug lookup,
 *    and never written: no UPDATE, no DELETE, choice ids unchanged.
 *  - `reset` — destructive. Overwrites the row from the catalogue and replaces
 *    its children (new choice ids). For test fixtures that want the shipped
 *    definitions back regardless of what ran before; never used at startup.
 */
export type SeedMode = 'insert-missing' | 'reset';

export interface SeedOptions {
  mode?: SeedMode;
  /** The definitions to seed. Defaults to {@link SEED_ENCOUNTERS}. */
  catalogue?: readonly EncounterInput[];
}

/**
 * Seed the bootstrap catalogue, per slug. Never touches an encounter whose
 * slug is not in the catalogue, so hand-authored encounters are safe in
 * either mode. Idempotent in either mode.
 */
export async function seedWorldEncounters(
  db: Db,
  { mode = 'insert-missing', catalogue = SEED_ENCOUNTERS }: SeedOptions = {},
): Promise<SeedResult> {
  const repo = createWorldEncounterRepository(db);
  const result: SeedResult = { created: [], updated: [], skipped: [] };

  for (const input of catalogue) {
    const existing = await db
      .select({ id: worldEncounters.id })
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, input.slug));

    if (existing.length === 0) {
      await db.transaction(async (tx) => {
        const id = await repo.insert(tx, mapEncounterValues(input));
        await repo.replaceChildren(
          tx,
          id,
          input.regions,
          input.routes,
          input.choices.map(mapChoiceValues),
        );
      });
      result.created.push(input.slug);
    } else if (mode === 'insert-missing') {
      result.skipped.push(input.slug);
    } else {
      const id = existing[0]!.id;
      await db.transaction(async (tx) => {
        await repo.update(tx, id, mapEncounterValues(input));
        await repo.replaceChildren(
          tx,
          id,
          input.regions,
          input.routes,
          input.choices.map(mapChoiceValues),
        );
      });
      result.updated.push(input.slug);
    }
  }
  return result;
}

function mapEncounterValues(input: EncounterInput) {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    type: input.type,
    rarity: input.rarity,
    weight: input.weight,
    lifecycle: input.lifecycle,
    huntEligible: input.huntEligible,
    travelEligible: input.travelEligible,
    cooldownSeconds: input.cooldownSeconds,
    artworkPath: input.artworkPath,
    chainedEncounterSlug: input.chainedEncounterSlug,
    choicesRequired: input.choicesRequired,
    metadata: input.metadata,
  };
}

function mapChoiceValues(choice: EncounterInput['choices'][number], index?: number) {
  return {
    sortOrder: index ?? 0,
    label: choice.label,
    emoji: choice.emoji,
    requirementsJson: choice.requirements as unknown as Record<string, unknown>,
    checkJson: choice.check as unknown as Record<string, unknown>,
    successEffectsJson: choice.successEffects as unknown as Record<string, unknown>[],
    failureEffectsJson: choice.failureEffects as unknown as Record<string, unknown>[],
    outcomeText: choice.outcomeText ?? null,
    successText: choice.successText ?? null,
    failureText: choice.failureText ?? null,
  };
}
