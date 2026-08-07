/**
 * Active consumable buffs. Only the capture bonus is modelled in v1 — it is
 * the only effect the service exposes a read for.
 */
import { z } from 'zod';

export const captureBonusSchema = z.object({
  modifier: z.number().describe('Flat additive capture-chance bonus, e.g. 0.03 for +3%.'),
  chargesRemaining: z.number().int(),
  sourceItemSlug: z.string(),
});

/** Null rather than 404: "no buff active" is a normal state, not a missing resource. */
export const nullableCaptureBonusSchema = captureBonusSchema.nullable();
