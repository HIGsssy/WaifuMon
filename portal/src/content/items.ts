import type { ItemFields } from '@/api/types';

function percentagePoints(value: number): string {
  const points = Math.round(value * 1000) / 10;
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

/** Player-facing summary of the capture item committed to one attempt. */
export function captureItemEffect(
  item: Pick<
    ItemFields,
    'captureModifier' | 'captureBonus' | 'captureRarities' | 'isGuaranteedCapture'
  >,
): string | null {
  if (item.isGuaranteedCapture) return 'Guaranteed capture';

  const eligibility = item.captureRarities?.length
    ? ` · ${item.captureRarities.join('/')} only`
    : '';

  if (item.captureBonus !== null && item.captureBonus !== 0) {
    return `+${percentagePoints(item.captureBonus)} percentage points${eligibility}`;
  }

  if (item.captureModifier !== null) {
    return `×${item.captureModifier} base capture chance${eligibility}`;
  }

  return null;
}

/** Player-facing summary for consumables that grant temporary capture charges. */
export function temporaryCaptureEffect(item: ItemFields): string | null {
  if (item.effectType !== 'capture_bonus_charges' || item.effectConfig === null) return null;

  const captureBonus = item.effectConfig.captureBonus;
  const charges = item.effectConfig.charges;
  if (typeof captureBonus !== 'number' || typeof charges !== 'number') return null;

  return `+${percentagePoints(captureBonus)} percentage points for ${charges} attempt${charges === 1 ? '' : 's'}`;
}
