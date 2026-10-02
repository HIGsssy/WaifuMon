/**
 * One reward group: a probability gate (chance, rolls) in front of one
 * weighted pick across its item and gear rows.
 *
 * The group id keys every deterministic draw, so a saved group's id is shown
 * read-only — renaming it would re-roll every boss and mission that draws from
 * it. A group added in this session can still be named until it is saved.
 */
import type {
  EquipmentRewardRowDoc,
  EquipmentSelectorPreview,
  ItemRewardRowDoc,
  RewardGroupDoc,
  RewardTableIssue,
  RewardTableReferenceData,
} from '@/api/adminRewardTables';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { EquipmentRewardRow, IssueList, ItemRewardRow } from './RewardRows';
import {
  basisPointsFromPercent,
  groupChance,
  groupRolls,
  groupSummary,
  issuesFor,
  newEquipmentRow,
  newItemRow,
  rowShares,
} from './rewardTableModel';

interface Props {
  group: RewardGroupDoc;
  index: number;
  groupCount: number;
  /** False for a group that exists on the server: its id is then immutable. */
  idEditable: boolean;
  issues: readonly RewardTableIssue[];
  reference: RewardTableReferenceData | undefined;
  /** Previews for this group's gear rows, by row index. */
  previews: (EquipmentSelectorPreview | undefined)[];
  disabled: boolean;
  onChange: (next: RewardGroupDoc) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}

function move<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item!);
  return next;
}

export function RewardGroupCard({
  group,
  index,
  groupCount,
  idEditable,
  issues,
  reference,
  previews,
  disabled,
  onChange,
  onRemove,
  onMove,
}: Props) {
  const shares = rowShares(group);
  const gear = group.equipment ?? [];
  const enabled = group.enabled !== false;

  // Distinct definitions the group's live gear rows can pay — the summary's candidate count.
  const liveGear = gear.map((row, i) => ({ row, preview: previews[i] })).filter(({ row }) => row.enabled !== false);
  const candidates =
    liveGear.length === 0 || liveGear.some(({ preview }) => !preview)
      ? null
      : new Set(liveGear.flatMap(({ preview }) => preview!.eligible.map((d) => d.key))).size;

  const setItems = (entries: ItemRewardRowDoc[]) => onChange({ ...group, entries });
  const setGear = (equipment: EquipmentRewardRowDoc[]) => onChange({ ...group, equipment });
  const firstItem = reference?.items[0]?.slug ?? '';

  return (
    <Card className={cn('space-y-3 p-4', !enabled && 'opacity-80')} data-testid="reward-group">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Group id
          {idEditable ? (
            <Input
              aria-label="Group id"
              className="w-48"
              value={group.id}
              disabled={disabled}
              onChange={(e) => onChange({ ...group, id: e.target.value })}
            />
          ) : (
            <span className="block h-9 pt-2 font-mono text-sm text-ink" title="Keys deterministic draws — fixed once saved">
              {group.id}
            </span>
          )}
        </label>
        <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            aria-label="Group enabled"
            checked={enabled}
            disabled={disabled}
            onChange={(e) => onChange({ ...group, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <label className="text-xs text-ink-muted">
          Chance %
          <Input
            type="number"
            min={0}
            max={100}
            step="0.01"
            aria-label="Chance percent"
            className="w-28"
            value={groupChance(group) / 100}
            disabled={disabled}
            onChange={(e) => {
              const bp = basisPointsFromPercent(e.target.value);
              if (bp !== null) onChange({ ...group, chanceBasisPoints: bp });
            }}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Rolls
          <Input
            type="number"
            min={1}
            aria-label="Rolls"
            className="w-20"
            value={groupRolls(group)}
            disabled={disabled}
            onChange={(e) => onChange({ ...group, rolls: Math.trunc(Number(e.target.value) || 0) })}
          />
        </label>
        <div className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="ghost" disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label="Move group up">
            ↑
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={disabled || index === groupCount - 1} onClick={() => onMove(1)} aria-label="Move group down">
            ↓
          </Button>
          <Button type="button" size="sm" variant="danger" disabled={disabled} onClick={onRemove}>
            Remove group
          </Button>
        </div>
      </div>
      <p className="text-xs text-ink-muted" data-testid="group-summary">
        {groupSummary(group, candidates)}
      </p>
      <IssueList issues={issuesFor(issues, { kind: 'group', group: index })} />

      <div className="space-y-2">
        {group.entries.map((row, i) => (
          <ItemRewardRow
            key={`item-${i}`}
            row={row}
            reference={reference}
            share={shares.items[i] ?? null}
            issues={issuesFor(issues, { kind: 'item', group: index, row: i })}
            disabled={disabled}
            onChange={(next) => setItems(group.entries.map((r, j) => (j === i ? next : r)))}
            onRemove={() => setItems(group.entries.filter((_, j) => j !== i))}
            onMove={(delta) => setItems(move(group.entries, i, delta))}
            canMoveUp={i > 0}
            canMoveDown={i < group.entries.length - 1}
          />
        ))}
        {gear.map((row, i) => (
          <EquipmentRewardRow
            key={`gear-${i}`}
            row={row}
            reference={reference}
            preview={previews[i]}
            share={shares.equipment[i] ?? null}
            issues={issuesFor(issues, { kind: 'equipment', group: index, row: i })}
            disabled={disabled}
            onChange={(next) => setGear(gear.map((r, j) => (j === i ? next : r)))}
            onRemove={() => setGear(gear.filter((_, j) => j !== i))}
            onMove={(delta) => setGear(move(gear, i, delta))}
            canMoveUp={i > 0}
            canMoveDown={i < gear.length - 1}
          />
        ))}
      </div>
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setItems([...group.entries, newItemRow(firstItem)])}>
            Add item row
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setGear([...gear, newEquipmentRow()])}>
            Add equipment row
          </Button>
        </div>
      )}
    </Card>
  );
}
