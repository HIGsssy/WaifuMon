/**
 * What a dungeon pays: the progression currency, what a defeat keeps, the
 * depth bands, and the completion and extraction bonuses. Shared by both
 * layout modes — a room-by-room dungeon uses the bands as the default for any
 * room that sets no reward of its own.
 */
import {
  type DungeonBonusDoc,
  type DungeonReferenceData,
  type DungeonRewardBandDoc,
  type DungeonZoneDoc,
  type DungeonZoneIssue,
} from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import {
  basisPointsToPercent,
  issuesAt,
  newRewardBand,
  percentToBasisPoints,
} from './dungeonModel';
import {
  Issues,
  NumberField,
  OptionalNumberField,
  RangeFields,
  Section,
  TableSelect,
  TypeChecks,
} from './zoneFormParts';

export function RewardsSection({
  form,
  set,
  issues,
  reference,
  readOnly,
  authored,
}: {
  form: DungeonZoneDoc;
  set: (patch: Partial<DungeonZoneDoc>) => void;
  issues: DungeonZoneIssue[];
  reference: DungeonReferenceData | undefined;
  readOnly: boolean;
  /** Room-by-room: the bands are defaults for rooms that set no reward. */
  authored: boolean;
}) {
  const canWrite = !readOnly;
  const tables = reference?.rewardTables ?? [];
  const setRewards = (patch: Partial<DungeonZoneDoc['rewards']>) =>
    set({ rewards: { ...form.rewards, ...patch } });
  return (
    <Section
      title={authored ? 'Rewards & defaults' : 'Rewards'}
      hint={
        authored
          ? 'What the dungeon pays overall. A room pays its own reward when you give it one; otherwise it pays the default band below that matches its type.'
          : 'Depth bands say what a room pays. A room takes the first band that names its type, else the first that names none.'
      }
      testId="zone-rewards"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Progression currency
          <select
            aria-label="Progression currency"
            className={selectClass}
            value={form.rewards.currencyKey}
            disabled={readOnly}
            onChange={(e) => setRewards({ currencyKey: e.target.value })}
          >
            {!(reference?.currencies ?? []).some((c) => c.key === form.rewards.currencyKey) && (
              <option value={form.rewards.currencyKey}>{form.rewards.currencyKey}</option>
            )}
            {(reference?.currencies ?? []).map((c) => (
              <option key={c.key} value={c.key}>
                {c.pluralName} ({c.key}){c.enabled ? '' : ' — disabled'}
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="Kept on defeat (%)"
          step={0.01}
          className="w-36"
          value={basisPointsToPercent(form.rewards.defeatCurrencyRetentionBasisPoints)}
          disabled={readOnly}
          onChange={(percent) =>
            setRewards({ defeatCurrencyRetentionBasisPoints: percentToBasisPoints(percent) })
          }
        />
      </div>
      <p className="text-xs text-ink-subtle">
        The share of unbanked currency a defeated player keeps. Extraction and completion bank all
        of it.
      </p>
      <Issues
        issues={['rewards.currencyKey', 'rewards.defeatCurrencyRetentionBasisPoints'].flatMap((p) =>
          issuesAt(issues, p),
        )}
      />

      {form.rewards.bands.map((band, i) => (
        <BandRow
          key={i}
          band={band}
          index={i}
          tables={tables}
          issues={issuesAt(issues, `rewards.bands[${i}]`)}
          disabled={readOnly}
          onChange={(next) =>
            setRewards({ bands: form.rewards.bands.map((b, j) => (j === i ? next : b)) })
          }
          onRemove={() => setRewards({ bands: form.rewards.bands.filter((_, j) => j !== i) })}
        />
      ))}
      {canWrite && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            setRewards({ bands: [...form.rewards.bands, newRewardBand(form.rewards.bands)] })
          }
        >
          Add depth band
        </Button>
      )}

      <BonusFields
        label="Completion bonus"
        value={form.rewards.completion}
        tables={tables}
        disabled={readOnly}
        onChange={(completion) => setRewards({ completion })}
      />
      <BonusFields
        label="Extraction bonus"
        value={form.rewards.extraction}
        tables={tables}
        disabled={readOnly}
        onChange={(extraction) => setRewards({ extraction })}
      />
      <Issues
        issues={['rewards.completion', 'rewards.extraction'].flatMap((p) => issuesAt(issues, p))}
      />
    </Section>
  );
}

function BandRow({
  band,
  index,
  tables,
  issues,
  disabled,
  onChange,
  onRemove,
}: {
  band: DungeonRewardBandDoc;
  index: number;
  tables: DungeonReferenceData['rewardTables'];
  issues: DungeonZoneIssue[];
  disabled: boolean;
  onChange: (next: DungeonRewardBandDoc) => void;
  onRemove: () => void;
}) {
  const label = `Band ${index + 1}`;
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="reward-band">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Band id
          <Input
            aria-label={`${label} id`}
            className="w-36 font-mono"
            value={band.id}
            disabled={disabled}
            onChange={(e) => onChange({ ...band, id: e.target.value })}
          />
        </label>
        <NumberField
          label={`${label} min depth`}
          min={1}
          value={band.minDepth}
          disabled={disabled}
          onChange={(minDepth) => onChange({ ...band, minDepth })}
        />
        <OptionalNumberField
          label={`${label} max depth`}
          value={band.maxDepth}
          disabled={disabled}
          onChange={(maxDepth) => onChange({ ...band, maxDepth })}
        />
        <RangeFields
          label={`${label} currency`}
          value={band.currency}
          disabled={disabled}
          onChange={(currency) => onChange({ ...band, currency })}
        />
        <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            aria-label={`${label} enabled`}
            checked={band.enabled}
            disabled={disabled}
            onChange={(e) => onChange({ ...band, enabled: e.target.checked })}
          />
          Enabled
        </label>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <TableSelect
          label={`${label} reward table`}
          value={band.rewardTable}
          tables={tables}
          disabled={disabled}
          onChange={(rewardTable) => onChange({ ...band, rewardTable })}
        />
        <TableSelect
          label={`${label} Equipment reward table`}
          value={band.equipmentRewardTable}
          tables={tables}
          disabled={disabled}
          onChange={(equipmentRewardTable) => onChange({ ...band, equipmentRewardTable })}
        />
      </div>
      <TypeChecks
        label={`${label} applies to (none ticked = every type)`}
        value={band.nodeTypes}
        disabled={disabled}
        onChange={(nodeTypes) => onChange({ ...band, nodeTypes })}
      />
      <Issues issues={issues} />
    </div>
  );
}

function BonusFields({
  label,
  value,
  tables,
  disabled,
  onChange,
}: {
  label: string;
  value: DungeonBonusDoc;
  tables: DungeonReferenceData['rewardTables'];
  disabled: boolean;
  onChange: (next: DungeonBonusDoc) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
      <span className="w-36 pb-2 text-sm text-ink">{label}</span>
      <RangeFields
        label={`${label} currency`}
        value={value.currency}
        disabled={disabled}
        onChange={(currency) => onChange({ ...value, currency })}
      />
      <TableSelect
        label={`${label} reward table`}
        value={value.rewardTable}
        tables={tables}
        disabled={disabled}
        onChange={(rewardTable) => onChange({ ...value, rewardTable })}
      />
    </div>
  );
}
