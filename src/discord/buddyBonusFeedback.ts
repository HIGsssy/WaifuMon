/**
 * Buddy Bonus feedback — the one place gameplay screens turn an applied bonus
 * into a line of text.
 *
 * Two rules hold everywhere below:
 *
 *   - **Presentation never decides whether a bonus applied.** Every function
 *     here takes an {@link AppliedBuddyBonus} that a service already attached
 *     to its result, and a service attaches one only when the bonus really
 *     changed the outcome. Nothing here re-tests a target, re-rolls a proc, or
 *     recomputes a percentage.
 *   - **Gameplay screens get the mechanical summary, not the flavour.** The
 *     authored `flavorText` is prose for the collection panel; repeating it on
 *     every hunt result would be noise. The compact summaries come from
 *     `buddyBonusEffectSummary`, which is derived from `effectId`, `value` and
 *     `target` — so a new species using an existing effect needs no new copy.
 */
import {
  buddyBonusLine,
  buddyBonusShortLine,
  type AppliedBuddyBonus,
} from '../modules/buddyBonus/buddyBonusEffects';

/**
 * The headline for one applied bonus.
 *
 * `energy_save_chance` is phrased as an event rather than a rate, because by
 * the time it is reported the roll has already been won and "25% chance" would
 * describe something that has stopped being a chance.
 */
export function buddyBonusFeedbackLine(applied: AppliedBuddyBonus): string {
  if (applied.effectId === 'energy_save_chance') {
    return `✨ **${applied.name}** activated! Your Buddy saved 1 Energy.`;
  }
  return buddyBonusLine(applied);
}

/** Every applied bonus on a result, in the order the systems reported them. */
export function buddyBonusFeedbackLines(
  bonuses: readonly AppliedBuddyBonus[] | undefined,
): string[] {
  return (bonuses ?? []).map(buddyBonusFeedbackLine);
}

/**
 * The compact form, for a line that has *already* printed the modified number:
 * `✨ Soul Collector: +100%`. Returns null for an absent bonus so a caller can
 * drop it straight into a `.filter(Boolean)` list.
 */
export function buddyBonusValueLine(
  applied: AppliedBuddyBonus | null | undefined,
): string | null {
  return applied ? buddyBonusShortLine(applied) : null;
}

/**
 * The buddy's own per-hunt / per-tick award, when a Buddy Bonus raised it.
 *
 * Structurally typed rather than importing `BuddyAwardResult`, so the hunt
 * result and the Care summary — which carry the same two fields under
 * different names — can both hand their numbers straight in. Returns an empty
 * list when nothing was boosted, which is the common case.
 */
export function buddyAwardFeedbackLines(award: {
  xpGranted?: number | undefined;
  affectionGranted?: number | undefined;
  xpBonus?: AppliedBuddyBonus | null | undefined;
  affectionBonus?: AppliedBuddyBonus | null | undefined;
} | null | undefined): string[] {
  if (!award) return [];
  const lines: string[] = [];
  if (award.xpBonus) {
    lines.push(`✨ Buddy XP: +${award.xpBonus.finalValue ?? award.xpGranted ?? 0}`);
    lines.push(buddyBonusShortLine(award.xpBonus));
  }
  if (award.affectionBonus) {
    lines.push(`❤️ Affection gained: +${award.affectionBonus.finalValue ?? award.affectionGranted ?? 0}`);
    lines.push(buddyBonusShortLine(award.affectionBonus));
  }
  return lines;
}
