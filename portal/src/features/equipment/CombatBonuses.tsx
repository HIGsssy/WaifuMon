/**
 * A copy's secondary combat bonuses — "+4.25% Crit Chance" — one row each.
 *
 * The rows are the server's `text`, verbatim: the Portal never formats a
 * percentage from basis points and never shows the bonus family's identifier.
 * A copy rolls none, one or two; with none, nothing is rendered at all, so
 * gear that predates the system looks exactly as it did.
 *
 * Built from spans so it can sit inside the card, which is a button.
 */
import type { CombatBonus } from '@/api/types';
import { cn } from '@/lib/cn';

export function CombatBonusLines({
  bonuses,
  id,
  className,
}: {
  bonuses: readonly CombatBonus[];
  id?: string;
  className?: string;
}) {
  if (bonuses.length === 0) return null;
  return (
    <span
      id={id}
      className={cn('tabular flex flex-col gap-0.5 text-xs text-ink-muted', className)}
      data-testid="combat-bonuses"
    >
      {bonuses.map((bonus, index) => (
        <span key={`${bonus.stat}-${index}`} data-testid="combat-bonus">
          {bonus.text}
        </span>
      ))}
    </span>
  );
}
