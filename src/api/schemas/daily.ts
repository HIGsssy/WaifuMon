/** Daily reward status. Claiming is a Phase 3 mutation; this is the read half. */
import { z } from 'zod';
import { isoDateTime } from './common';

export const dailyStatusSchema = z.object({
  claimedToday: z.boolean(),
  nextResetAt: isoDateTime.describe('When the next claim becomes available, in the configured daily timezone.'),
});
