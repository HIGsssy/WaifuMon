/** Currency balances. */
import { z } from 'zod';
import { isoDateTime } from './common';

export const currencySchema = z.object({
  playerId: z.number().int(),
  huntEnergy: z.number().int(),
  waifubux: z.number().int(),
  essence: z.number().int(),
  updatedAt: isoDateTime,
});
