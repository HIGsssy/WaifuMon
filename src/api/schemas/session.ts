/**
 * Per-channel session rows: the daily tally the bot renders, plus the pointer
 * to the player's Care Mode Trainer Profile message.
 *
 * This resource is inherently Discord-scoped — a session only exists in the
 * context of a channel — so `channelId` and `profileMessageId` are snowflakes
 * by nature rather than by leakage (plan §4.8).
 */
import { z } from 'zod';
import { calendarDay, isoDateTime } from './common';

export const sessionSummarySchema = z.object({
  hunts: z.number().int(),
  caught: z.number().int(),
  escaped: z.number().int(),
  srPlus: z.number().int().describe('Captures of SR rarity or better.'),
  levelUps: z.number().int(),
  caughtNames: z.array(z.string()),
  escapedNames: z.array(z.string()),
  notableFinds: z.array(
    z.object({
      kind: z.enum(['item', 'waifubux', 'essence']),
      label: z.string().describe('Pre-rendered, e.g. "Velvet Charm ×1".'),
    }),
  ),
  buddyXp: z.number().int(),
  buddyAffection: z.number().int(),
});

export const sessionSchema = z.object({
  id: z.number().int(),
  guildId: z.number().int(),
  playerId: z.number().int(),
  channelId: z.string(),
  profileMessageId: z
    .string()
    .nullable()
    .describe('Care Mode Trainer Profile message id in this channel, or null.'),
  summary: sessionSummarySchema,
  summaryDate: calendarDay.nullable(),
  summaryFresh: z
    .boolean()
    .describe("True when summaryDate is today — a stale tally reads as last session's."),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  lastActivityAt: isoDateTime,
});
