/**
 * Care Mode state — the read half only. `pendingTicks` is a forecast: how many
 * ticks *would* be granted if they were applied right now. Reading it never
 * applies them; `careService.getState` is documented as non-mutating.
 */
import { z } from 'zod';
import { nullableIsoDateTime } from './common';
import { ownedWaifuSchema } from './collection';
import { speciesSchema } from './content';

export const careStateSchema = z.object({
  enabled: z.boolean().describe('False when Care Mode is switched off by server configuration.'),
  active: z.boolean(),
  startedAt: nullableIsoDateTime,
  lastTickAt: nullableIsoDateTime,
  nextTickAt: nullableIsoDateTime,
  target: z
    .object({ waifu: ownedWaifuSchema, species: speciesSchema })
    .nullable()
    .describe('The Waifumon being cared for, or null.'),
  pendingTicks: z.number().int().describe('Forecast only — reading does not apply them.'),
  intervalMinutes: z.number(),
  energyPerTick: z.number().int(),
  waifuXpPerTick: z.number().int(),
  affectionPerTick: z.number().int(),
  recoveryCap: z.number().int(),
  effectiveEnergyCap: z.number().int(),
  currentEnergy: z.number().int(),
  maxEnergy: z.number().int(),
});
