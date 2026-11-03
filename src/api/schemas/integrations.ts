/**
 * Read-only integration contract (`/api/v1/integrations/…`).
 *
 * Every object here is an **allowlist written out in full**, the same rule as
 * `publicOwnedEntrySchema`: the serializer strips any key not named below, so a
 * field added to a service result does not reach an integration until
 * somebody adds it here on purpose.
 */
import { z } from 'zod';
import { RARITIES } from '../../db/schema';
import { isoDateTime, nullableIsoDateTime, raritySchema, snowflakeParam } from './common';

export const commentaryContextQuery = z.object({
  discordGuildId: snowflakeParam.describe('Must equal the configured integration guild.'),
  messageId: snowflakeParam.describe('The WaifuMon announcement message the caller saw.'),
});

const unavailableFact = z.object({
  status: z.literal('unavailable'),
  reason: z
    .enum(['not_recorded', 'withheld', 'player_unavailable', 'degraded'])
    .describe(
      '`not_recorded`: WaifuMon never stores it. `withheld`: exists but is not guild-public. ' +
        '`player_unavailable`: the player row is gone or left the guild. `degraded`: the query ' +
        'missed its time budget or failed. Never a zero.',
    ),
});

function factSchema<T extends z.ZodTypeAny>(value: T) {
  return z.union([
    z.object({ status: z.literal('verified'), value, asOf: isoDateTime }),
    unavailableFact,
  ]);
}

const count = z.number().int().min(0);

const collectionCounts = z.object({
  owned: count.describe('Active (non-released) copies.'),
  distinctSpecies: count,
  totalSpecies: count,
});

const rarityDistribution = z.object(
  Object.fromEntries(RARITIES.map((r) => [r, count])) as Record<(typeof RARITIES)[number], typeof count>,
);

/** Every key is optional: which ones appear depends on the announcement kind. */
export const commentaryFactsSchema = z.object({
  playerLevel: factSchema(z.number().int().min(1)).optional(),
  activeCopiesOfSpecies: factSchema(count).optional(),
  collection: factSchema(collectionCounts).optional(),
  rarityDistribution: factSchema(rarityDistribution).optional(),
  guildOwnersOfSpecies: factSchema(
    z.object({
      trainers: count.describe('Trainers in this guild with an active copy of the species.'),
      guildTrainers: count.describe('Trainers in this guild.'),
    }),
  ).optional(),
  trainerRank: factSchema(
    z.object({
      rank: z.number().int().min(1).describe('Competition rank on the guild `trainer` leaderboard.'),
      guildTrainers: count,
    }),
  ).optional(),
  copyLevel: factSchema(z.number().int().min(1)).optional(),
  guildBossHistory: factSchema(
    z.object({
      encounters: count,
      repelled: count,
      unchallenged: count,
      cancelled: count,
      channelLost: count,
    }),
  ).optional(),
  firstEverCopy: unavailableFact.optional(),
  captureRegion: unavailableFact.optional(),
  perPlayerRewards: unavailableFact.optional(),
  perPlayerOutcome: unavailableFact.optional(),
});

const announcedRareCapture = z.object({
  species: z.object({ slug: z.string(), name: z.string(), rarity: raritySchema }),
  source: z.enum(['hunt', 'delve_recruit']),
  isDuplicate: z.boolean().describe('An active copy of this species already existed at capture time.'),
  waifuId: z.number().int().nullable(),
});

const announcedAppearanceUnlock = z.object({
  waifuId: z.number().int(),
  waifuName: z.string(),
  speciesSlug: z.string(),
  appearanceId: z.string(),
  appearanceName: z.string(),
  unlockLabel: z.string(),
  cosmeticRarity: z.string(),
});

const announcedBoss = z.object({
  encounterId: z.number().int(),
  boss: z.object({ id: z.string(), name: z.string(), affinity: z.string(), region: z.string() }),
  deadlineAt: nullableIsoDateTime,
  outcome: z
    .enum(['repelled', 'unchallenged', 'cancelled_admin', 'channel_lost'])
    .nullable()
    .optional()
    .describe('Present once the encounter has ended.'),
  participantCount: count.optional(),
  totalDamage: count.optional(),
  totalAttacks: count.optional(),
  resolvedAt: nullableIsoDateTime.optional(),
  firstOnScene: z
    .object({
      playerId: z.number().int(),
      discordUserId: z.string(),
      trainerName: z.string().describe('The name the results embed printed.'),
      waifuName: z.string(),
    })
    .nullable()
    .optional()
    .describe('`boss_results` only.'),
});

const announcedLevelUp = z.object({ level: z.number().int().min(1) });

const announcedCollectionCompleted = z.object({ distinctSpecies: count, totalSpecies: count });

export const commentaryContextSchema = z.object({
  contractVersion: z.literal(1),
  announcement: z.object({
    messageId: z.string(),
    channelId: z.string().nullable(),
    discordGuildId: z.string(),
    kind: z.enum([
      'rare_capture',
      'appearance_unlock',
      'level_up',
      'collection_completed',
      'boss_spawn',
      'boss_completed',
      'boss_results',
    ]),
    eventId: z.string().describe('Stable per event; deduplicate on it.'),
    occurredAt: isoDateTime,
  }),
  player: z
    .object({
      playerId: z.number().int().nullable(),
      discordUserId: z.string().nullable(),
      displayName: z.string().nullable().describe('Presentation only; may be null.'),
      status: z.enum(['active', 'unavailable']),
    })
    .nullable()
    .describe('Null for boss posts.'),
  announced: z
    .union([
      announcedRareCapture,
      announcedAppearanceUnlock,
      announcedBoss,
      announcedLevelUp,
      announcedCollectionCompleted,
    ])
    .describe('What the message said when it was posted. Immutable.'),
  facts: commentaryFactsSchema.describe('Read live; each carries its own status and asOf.'),
});
