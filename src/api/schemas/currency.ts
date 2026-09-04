/** Currency balances. */
import { z } from 'zod';
import { isoDateTime } from './common';

export const currencySchema = z.object({
  playerId: z.number().int(),
  huntEnergy: z.number().int(),
  /**
   * The trainer's Energy ceiling at their current level.
   *
   * Derived, not stored: `progressionService.computeMaxEnergy(level)`, which is
   * the same call `GET /players/{id}/care` already answers with. It rides here
   * because a balance without its ceiling is a number, not a meter — and the
   * alternative was every client fetching Care Mode state to read one integer,
   * or summing `tables.progression.maxEnergy.levelBonuses` itself.
   */
  maxHuntEnergy: z.number().int(),
  waifubux: z.number().int(),
  essence: z.number().int(),
  updatedAt: isoDateTime,
});
