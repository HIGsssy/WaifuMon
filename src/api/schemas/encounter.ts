/**
 * Ephemeral encounters (plan §4.2): a real short-lived resource with state,
 * not a transient UI concept.
 *
 * The species row is embedded rather than left as a bare `speciesId`. Content
 * endpoints are slug-addressed and carry no ids, so a client holding only
 * `speciesId` would have no way to resolve who it met — see the note on
 * `huntService.getActiveEncounterDetail`.
 */
import { z } from 'zod';
import { isoDateTime, nullableIsoDateTime } from './common';
import { speciesSchema } from './content';

export const ENCOUNTER_STATES = ['active', 'captured', 'escaped', 'released', 'expired'] as const;

export const encounterSchema = z.object({
  id: z.number().int(),
  playerId: z.number().int(),
  speciesId: z.number().int(),
  species: speciesSchema,
  channelId: z
    .string()
    .describe('Discord channel the encounter was raised in — inherently Discord-scoped.'),
  state: z.enum(ENCOUNTER_STATES),
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  selectedItemId: z
    .number()
    .int()
    .nullable()
    .describe(
      'Capture item chosen for this encounter but not yet committed. Nothing is ' +
        'consumed until a capture attempt resolves.',
    ),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  resolvedAt: nullableIsoDateTime,
});
