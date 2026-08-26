/**
 * Custom Essence-batch input — pure validation, no Discord, no DB.
 *
 * The custom modal asks for a number of **applications** of the existing
 * essence action, not a raw Essence amount. That is the unit the economy is
 * already denominated in (`essenceInvestment.essenceCost` per application), so
 * "5" means the same thing whether the player typed it or pressed the 5×
 * button, and a content change to the cost never silently re-prices a saved
 * habit.
 *
 * Every rejection names the ceiling it hit, because "invalid amount" tells a
 * player nothing about whether to top up Essence or pick a different copy.
 */

export interface EssenceBatchLimits {
  /** Hard ceiling on one batch (`MAX_ESSENCE_APPLICATIONS`). */
  cap: number;
  /** Essence per application. */
  costPer: number;
  /** The player's current Essence balance. */
  balance: number;
  /** Applications that still buy levels; 0 once she is capped. */
  maxUseful: number;
}

export type EssenceBatchParse =
  | { ok: true; applications: number }
  | { ok: false; error: string };

/** Largest batch that clears every limit at once; 0 when none is possible. */
export function maxAffordableApplications(limits: EssenceBatchLimits): number {
  const byBalance = limits.costPer > 0 ? Math.floor(limits.balance / limits.costPer) : 0;
  return Math.max(0, Math.min(limits.cap, byBalance, limits.maxUseful));
}

/**
 * Validate a typed application count against balance, level cap and the batch
 * ceiling. Checks run cheapest-first and stop at the first failure, so the
 * message points at the reason the player can act on.
 */
export function parseEssenceApplications(
  raw: string,
  limits: EssenceBatchLimits,
): EssenceBatchParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Enter how many times to invest (e.g. `3`).' };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `**${trimmed}** isn't a whole number — try something like \`3\`.` };
  }
  const applications = Number(trimmed);
  if (!Number.isSafeInteger(applications) || applications < 1) {
    return { ok: false, error: 'Enter a whole number of **1 or more**.' };
  }
  if (applications > limits.cap) {
    return { ok: false, error: `You can invest at most **${limits.cap}×** at once.` };
  }
  if (limits.maxUseful <= 0) {
    return { ok: false, error: "She's already at max level — Essence can't take her further." };
  }
  if (applications > limits.maxUseful) {
    return {
      ok: false,
      error: `**${applications}×** overshoots her max level — **${limits.maxUseful}×** is all she can use.`,
    };
  }
  const cost = applications * limits.costPer;
  if (cost > limits.balance) {
    return {
      ok: false,
      error: `**${applications}×** costs **${cost}** Essence — you have **${limits.balance}**.`,
    };
  }
  return { ok: true, applications };
}
