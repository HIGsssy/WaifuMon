/**
 * One Gear Bag copy while dismantling — a checkbox, never a one-click action.
 *
 * Whether a copy can be selected is the server's answer (`item.salvage`):
 * equipped, favourite, locked and unsalvageable copies render disabled with
 * the reason, so the player learns what to change rather than wondering why a
 * card is missing. The dismantle route re-checks all of it.
 */
import type { EquipmentItem } from '@/api/types';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { cn } from '@/lib/cn';
import { EquipmentStateMarks } from './EquipmentItemCard';
import { SLOT_LABEL, SLOT_STAT, STAT_LABEL, formatMultiplier } from './format';
import { BLOCKER_TEXT, COMPONENTS_LABEL } from './workshopText';

export function DismantleSelectCard({
  item,
  selected,
  onToggle,
  className,
}: {
  item: EquipmentItem;
  selected: boolean;
  onToggle: (item: EquipmentItem) => void;
  className?: string;
}) {
  const blocked = item.salvage.blockedBy;
  const inputId = `dismantle-${item.id}`;
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'flex w-full gap-3 rounded-2xl border bg-surface p-4 text-left transition-colors',
        blocked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:border-border-strong',
        selected ? 'border-danger/60 bg-danger-soft' : 'border-border',
        className,
      )}
      data-testid="dismantle-card"
    >
      <input
        id={inputId}
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-danger"
        checked={selected}
        disabled={blocked != null}
        onChange={() => onToggle(item)}
        aria-describedby={`${inputId}-info`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0 font-medium break-words text-ink">{item.name}</span>
          <EquipmentStateMarks item={item} />
        </span>
        <span
          id={`${inputId}-info`}
          className="flex flex-wrap items-center gap-2 text-sm text-ink-muted"
        >
          <RarityBadge rarity={item.rarity} />
          <span>{SLOT_LABEL[item.slot]}</span>
          <span className="tabular">
            {STAT_LABEL[SLOT_STAT[item.slot]]} {formatMultiplier(item.multiplier)}
          </span>
          {blocked ? (
            <span className="text-warning">{BLOCKER_TEXT[blocked]}</span>
          ) : (
            <span className="tabular text-ink">
              +{item.salvage.components} {COMPONENTS_LABEL}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}
