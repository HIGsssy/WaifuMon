/**
 * Affection stages — pure, no DB, no Discord.
 *
 * Affection accrues on the buddy every hunt and every Care Mode tick. The
 * raw number is not interesting on its own; crossing a *named* threshold is.
 * `AFFECTION_MILESTONE` fires on those crossings and the stage name is what
 * the Activity Feed narrates.
 *
 * The ladder is intentionally a code constant rather than content config:
 * nothing in the balance tables references it, and the names are copy, not
 * tuning. Promoting it to `content/tables.json` later is additive.
 */
export interface AffectionStage {
  /** Inclusive lower bound in affection points. */
  threshold: number;
  name: string;
}

export const AFFECTION_STAGES: readonly AffectionStage[] = [
  { threshold: 10, name: 'Acquainted' },
  { threshold: 25, name: 'Warm' },
  { threshold: 50, name: 'Fond' },
  { threshold: 100, name: 'Devoted' },
  { threshold: 200, name: 'Inseparable' },
  { threshold: 400, name: 'Soulbound' },
];

/** Highest stage reached at `affection`, or null below the first threshold. */
export function affectionStageFor(affection: number): AffectionStage | null {
  let current: AffectionStage | null = null;
  for (const stage of AFFECTION_STAGES) {
    if (affection >= stage.threshold) current = stage;
    else break;
  }
  return current;
}

/**
 * The stage crossed by moving from `before` to `after`, or null when no
 * threshold was passed. When a single grant vaults several thresholds at once
 * only the highest is reported — one milestone line per grant, never a burst.
 */
export function crossedAffectionStage(before: number, after: number): AffectionStage | null {
  if (after <= before) return null;
  const crossed = AFFECTION_STAGES.filter((s) => s.threshold > before && s.threshold <= after);
  return crossed.length > 0 ? crossed[crossed.length - 1]! : null;
}
