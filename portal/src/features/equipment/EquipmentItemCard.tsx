/**
 * One owned copy in the Gear Bag — or one filled slot in the loadout.
 *
 * Shows everything a quick decision needs: the full name, rarity, slot, this
 * copy's own multiplier, the definition's range, roll quality, its secondary
 * combat bonuses (when it rolled any), and the three per-copy states. The whole card is the button that opens the detail view.
 */
import { CheckCircle2, Lock, Star } from 'lucide-react';

import type { EquipmentItem } from '@/api/types';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { cn } from '@/lib/cn';
import { CombatBonusLines } from './CombatBonuses';
import {
  SLOT_ICON,
  SLOT_LABEL,
  SLOT_STAT,
  STAT_LABEL,
  formatMultiplier,
  formatRange,
} from './format';

/** Equipped, favourite and locked — each named in words for screen readers. */
export function EquipmentStateMarks({ item }: { item: EquipmentItem }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {item.equipped && (
        <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
          <CheckCircle2 className="size-3.5" aria-hidden="true" />
          Equipped
        </span>
      )}
      {item.favorite && (
        <span title="Favorite" className="text-warning">
          <Star className="size-4 fill-current" aria-hidden="true" />
          <span className="sr-only">Favorite</span>
        </span>
      )}
      {item.locked && (
        <span title="Locked" className="text-ink-muted">
          <Lock className="size-4" aria-hidden="true" />
          <span className="sr-only">Locked</span>
        </span>
      )}
    </span>
  );
}

export function EquipmentItemCard({
  item,
  onOpen,
  className,
}: {
  item: EquipmentItem;
  onOpen: (item: EquipmentItem) => void;
  className?: string;
}) {
  const SlotIcon = SLOT_ICON[item.slot];
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        'lift flex w-full flex-col gap-2 rounded-2xl border bg-surface p-4 text-left transition-colors',
        'hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2',
        item.equipped ? 'border-success/50' : 'border-border',
        className,
      )}
      data-testid="equipment-card"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0 font-medium break-words text-ink">{item.name}</span>
        <EquipmentStateMarks item={item} />
      </span>
      <span className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <RarityBadge rarity={item.rarity} />
        <span className="inline-flex items-center gap-1">
          <SlotIcon className="size-3.5" aria-hidden="true" />
          {SLOT_LABEL[item.slot]}
        </span>
      </span>
      <span className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm">
        <span className="tabular font-semibold text-ink">
          {STAT_LABEL[SLOT_STAT[item.slot]]} {formatMultiplier(item.multiplier)}
        </span>
        <span className="tabular text-right text-ink-muted">Roll {item.rollQuality}%</span>
        <span className="tabular col-span-2 text-xs text-ink-subtle">
          Range {formatRange(item.range)}
        </span>
      </span>
      <CombatBonusLines bonuses={item.combatBonuses} className="text-sm text-ink" />
    </button>
  );
}
