/**
 * One row of a reward group: an item drop, or a gear drop.
 *
 * A gear row edits only the selector the server's Equipment reward path takes
 * (slot, N/R/SR rarity, optional definitions — the shared
 * `EquipmentRewardFields`), plus its switch and weight. Which definition lands,
 * its multiplier and its affix are rolled by the Equipment system, so there
 * are no controls for them; the preview underneath lists what the selector can
 * pay on this server right now.
 */
import type {
  EquipmentRewardRowDoc,
  EquipmentSelectorPreview,
  ItemRewardRowDoc,
  RewardTableIssue,
  RewardTableReferenceData,
} from '@/api/adminRewardTables';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { EquipmentRewardFields } from '@/features/adminEncounters/EquipmentRewardFields';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { previewLine, sharePercentLabel } from './rewardTableModel';

interface RowChrome {
  share: number | null;
  issues: RewardTableIssue[];
  disabled: boolean;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

function toInt(text: string): number {
  const n = Number(text);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function IssueList({ issues }: { issues: RewardTableIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs" data-testid="row-issues">
      {issues.map((i) => (
        <li key={`${i.path}:${i.message}`} className={i.severity === 'error' ? 'text-danger' : 'text-ink-muted'}>
          {i.severity === 'error' ? '' : '⚠ '}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function RowControls({
  enabled,
  weight,
  share,
  disabled,
  onEnabled,
  onWeight,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
  label,
}: Omit<RowChrome, 'issues'> & {
  enabled: boolean;
  weight: number;
  onEnabled: (v: boolean) => void;
  onWeight: (v: number) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex items-center gap-1 text-xs text-ink-muted">
        <input
          type="checkbox"
          aria-label={`${label} enabled`}
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onEnabled(e.target.checked)}
        />
        Enabled
      </label>
      <label className="text-xs text-ink-muted">
        Weight
        <Input
          type="number"
          min={1}
          aria-label={`${label} weight`}
          className="w-24"
          value={weight}
          disabled={disabled}
          onChange={(e) => onWeight(toInt(e.target.value))}
        />
      </label>
      <span className="pb-2 text-xs text-ink-muted" data-testid="row-share" title="Share of this group's pick">
        {sharePercentLabel(share)}
      </span>
      <div className="ml-auto flex gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={disabled || !canMoveUp} onClick={() => onMove(-1)} aria-label={`Move ${label} up`}>
          ↑
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled || !canMoveDown} onClick={() => onMove(1)} aria-label={`Move ${label} down`}>
          ↓
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove} aria-label={`Remove ${label}`}>
          Remove
        </Button>
      </div>
    </div>
  );
}

export function ItemRewardRow({
  row,
  reference,
  onChange,
  ...chrome
}: RowChrome & {
  row: ItemRewardRowDoc;
  reference: RewardTableReferenceData | undefined;
  onChange: (next: ItemRewardRowDoc) => void;
}) {
  const items = reference?.items ?? [];
  const known = items.some((i) => i.slug === row.itemId);
  const enabled = row.enabled !== false;
  return (
    <div
      className={cn('space-y-2 rounded-md border border-border p-3', !enabled && 'opacity-70')}
      data-testid="item-reward-row"
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
        <label className="text-xs text-ink-muted">
          Item
          <select
            aria-label="Item"
            className={selectClass}
            value={row.itemId}
            disabled={chrome.disabled}
            onChange={(e) => onChange({ ...row, itemId: e.target.value })}
          >
            {!known && <option value={row.itemId}>{row.itemId || 'Choose an item'} (unknown)</option>}
            {items.map((i) => (
              <option key={i.slug} value={i.slug}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Quantity
          <Input
            type="number"
            min={1}
            aria-label="Quantity"
            value={row.quantity ?? 1}
            disabled={chrome.disabled}
            onChange={(e) => onChange({ ...row, quantity: toInt(e.target.value) })}
          />
        </label>
      </div>
      <RowControls
        {...chrome}
        label="item row"
        enabled={enabled}
        weight={row.weight}
        onEnabled={(v) => onChange({ ...row, enabled: v })}
        onWeight={(v) => onChange({ ...row, weight: v })}
      />
      <IssueList issues={chrome.issues} />
    </div>
  );
}

export function EquipmentRewardRow({
  row,
  reference,
  preview,
  onChange,
  ...chrome
}: RowChrome & {
  row: EquipmentRewardRowDoc;
  reference: RewardTableReferenceData | undefined;
  preview: EquipmentSelectorPreview | undefined;
  onChange: (next: EquipmentRewardRowDoc) => void;
}) {
  const enabled = row.enabled !== false;
  return (
    <div
      className={cn('space-y-2 rounded-md border border-accent/30 p-3', !enabled && 'opacity-70')}
      data-testid="equipment-reward-row"
    >
      <p className="text-xs font-semibold uppercase text-ink-muted">Equipment</p>
      <fieldset disabled={chrome.disabled} className="contents">
        <EquipmentRewardFields effect={row} reference={reference} onChange={onChange} />
      </fieldset>
      <p
        className={cn('text-xs', preview && preview.eligible.length === 0 ? 'text-danger' : 'text-ink-muted')}
        data-testid="equipment-preview"
      >
        {previewLine(row, preview)}
      </p>
      <RowControls
        {...chrome}
        label="equipment row"
        enabled={enabled}
        weight={row.weight}
        onEnabled={(v) => onChange({ ...row, enabled: v })}
        onWeight={(v) => onChange({ ...row, weight: v })}
      />
      <IssueList issues={chrome.issues} />
    </div>
  );
}

