/**
 * Player-facing rendering of an item's *mechanics*, derived entirely from the
 * structured columns (`capture_modifier`, `capture_bonus`, `capture_rarities`,
 * `is_guaranteed_capture`, `effect_type`, `effect_config`). Nothing here keys
 * off a slug, so a content-only item lands with correct copy for free.
 *
 * The item's `description` stays flavour text and is never touched: callers
 * render flavour and these lines side by side. Deliberately UI-agnostic (no
 * Discord types) so the shop, inventory, capture selector, rewards and gift
 * screens can all share one source of truth for "what does this actually do".
 */

/**
 * The structural slice of an item this module needs. `ItemRow` satisfies it,
 * as does any content-loader shape, which keeps the formatter usable before a
 * row exists (seed previews, admin, the Platform API).
 */
export interface ItemEffectSource {
  category?: string | null;
  captureModifier?: number | null;
  captureBonus?: number | null;
  captureRarities?: string[] | null;
  isGuaranteedCapture?: boolean | null;
  effectType?: string | null;
  effectConfig?: Record<string, unknown> | null;
}

/** One labelled mechanical fact, e.g. `Effect` → `+15% Capture Chance`. */
export interface ItemEffectLine {
  label: string;
  value: string;
}

/** 0.03 → "+3%" — the player-facing form of a flat capture bonus. */
export function formatCaptureBonus(modifier: number): string {
  const pct = Math.round(modifier * 1000) / 10;
  return `+${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * 1.5 → "1.5×". Capture modifiers are *multiplicative* capture power (the
 * formula multiplies the base rate by them), so they are never rendered as
 * "+50%" — that would read as an additive bonus, which is a different term.
 */
export function formatCaptureMultiplier(modifier: number): string {
  const rounded = Math.round(modifier * 100) / 100;
  return `${rounded}×`;
}

/** ["SSR","UR"] → "SSR • UR". */
function formatRarities(rarities: readonly string[]): string {
  return rarities.join(' • ');
}

function num(config: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = config?.[key];
  return typeof value === 'number' ? value : null;
}

function flag(config: Record<string, unknown> | null | undefined, key: string): boolean {
  return config?.[key] === true;
}

/** Short human description of an item's active effect, for list rows. */
export function effectSummary(
  effectType: string | null,
  effectConfig: Record<string, unknown> | null,
): string {
  if (effectType === 'restore_energy_full') return 'restores Hunt Energy to full';
  if (effectType === 'restore_energy_amount') {
    return `restores ${num(effectConfig, 'amount') ?? 0} Hunt Energy`;
  }
  if (effectType === 'capture_bonus_charges') {
    const bonus = num(effectConfig, 'captureBonus') ?? 0;
    const charges = num(effectConfig, 'charges') ?? 0;
    return `${formatCaptureBonus(bonus)} capture for ${charges} attempts`;
  }
  return '';
}

/**
 * Every mechanical line for an item, in display order. Empty for items with no
 * mechanics at all (materials, cosmetics), so callers can simply skip the block.
 *
 * Understood fields:
 *  - `isGuaranteedCapture` → "Guaranteed Capture" (outranks everything else,
 *    since the chance formula is bypassed entirely).
 *  - `captureBonus` → additive "+30% Capture Chance".
 *  - `captureModifier` → multiplicative "Capture Power: 1.5×".
 *  - `captureRarities` → "Effective against: N • R • SR" (null/empty = all).
 *  - `effectType` + `effectConfig` → the consumable effect, its duration in
 *    charges, and any secondary flags such as `exitCareMode`.
 */
export function formatItemEffects(item: ItemEffectSource): ItemEffectLine[] {
  const lines: ItemEffectLine[] = [];
  const cfg = item.effectConfig ?? null;

  if (item.isGuaranteedCapture) {
    lines.push({ label: 'Effect', value: 'Guaranteed Capture' });
  } else {
    const bonus = item.captureBonus ?? null;
    const modifier = item.captureModifier ?? null;
    if (bonus != null && bonus !== 0) {
      lines.push({ label: 'Effect', value: `${formatCaptureBonus(bonus)} Capture Chance` });
      // A neutral ×1 alongside a flat bonus says nothing — only surface a
      // multiplier that actually moves the number.
      if (modifier != null && modifier !== 1) {
        lines.push({ label: 'Capture Power', value: formatCaptureMultiplier(modifier) });
      }
    } else if (modifier != null) {
      lines.push({ label: 'Capture Power', value: formatCaptureMultiplier(modifier) });
    }

    if (item.captureRarities != null && item.captureRarities.length > 0) {
      lines.push({ label: 'Effective against', value: formatRarities(item.captureRarities) });
    }
  }

  switch (item.effectType) {
    case 'restore_energy_full':
      lines.push({ label: 'Effect', value: 'Fully restores Hunt Energy' });
      break;
    case 'restore_energy_amount': {
      const amount = num(cfg, 'amount') ?? 0;
      lines.push({ label: 'Effect', value: `Restores ${amount} Hunt Energy` });
      break;
    }
    case 'capture_bonus_charges': {
      const bonus = num(cfg, 'captureBonus') ?? 0;
      const charges = num(cfg, 'charges') ?? 0;
      lines.push({ label: 'Effect', value: `${formatCaptureBonus(bonus)} Capture Chance` });
      if (charges > 0) {
        lines.push({
          label: 'Duration',
          value: `Next ${charges} capture attempt${charges === 1 ? '' : 's'}`,
        });
      }
      break;
    }
    default:
      break;
  }

  if (flag(cfg, 'exitCareMode')) {
    lines.push({ label: 'Additional effect', value: 'Exits Care Mode' });
  }

  return lines;
}

/** The same lines as `Label: value` text, one per line — for embed bodies. */
export function formatItemEffectLines(item: ItemEffectSource): string[] {
  return formatItemEffects(item).map((line) => `${line.label}: ${line.value}`);
}

/** The same lines collapsed onto one row — for tight spots (button rows, lists). */
export function formatItemEffectsInline(item: ItemEffectSource): string {
  return formatItemEffectLines(item).join(' · ');
}
