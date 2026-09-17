/**
 * Small display helpers for the Result Presentation manager.
 *
 * The selection chance shown here is **presentation** probability only: how
 * likely a variant is to be the one shown *once its result has already
 * happened*. It says nothing about how often the result itself occurs.
 */

export interface WeightedLike {
  id: number;
  enabled: boolean;
  weight: number;
}

/**
 * `weight / sum(enabled weights)` for an enabled variant, else null. The
 * server's weighted pick uses exactly this ratio.
 */
export function selectionShare(variant: WeightedLike, all: readonly WeightedLike[]): number | null {
  if (!variant.enabled || variant.weight <= 0) return null;
  const total = all.filter((v) => v.enabled && v.weight > 0).reduce((sum, v) => sum + v.weight, 0);
  return total > 0 ? variant.weight / total : null;
}

/** `~33%`, `~0.5%`, `100%`. */
export function formatShare(share: number): string {
  if (share >= 1) return '100%';
  const pct = share * 100;
  const rounded = pct < 1 ? Math.round(pct * 10) / 10 : Math.round(pct);
  return `~${rounded}%`;
}

/** First line, trimmed to `max` characters with an ellipsis. */
export function excerpt(text: string, max = 80): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  const more = firstLine !== text.trim();
  if (firstLine.length > max) return `${firstLine.slice(0, max - 1).trimEnd()}…`;
  return more ? `${firstLine} …` : firstLine;
}

/** Author-facing names for artwork modes. The legal set per result comes from the server. */
export const ARTWORK_MODE_LABELS: Record<string, string> = {
  encountered: 'Encountered Waifumon',
  custom: 'Custom Artwork',
  none: 'No Artwork',
};

export function artworkModeLabel(mode: string): string {
  return ARTWORK_MODE_LABELS[mode] ?? mode;
}
