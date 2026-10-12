/**
 * The dungeon's Currency Risk section: what a player keeps of the Baddie
 * Shards and WaifuBux earned in a run when they are defeated or abandon it.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import {
  RISK_PRESETS,
  abandonKeepsMore,
  effectiveAbandon,
  isPreset,
  parseRetention,
  retentionLabel,
  retentionPercent,
  withAbandon,
  withDefeat,
} from './dungeonRiskModel';

type Settings = DungeonDefinition['settings'];

interface Props {
  settings: Settings;
  disabled: boolean;
  onChange: (settings: Settings) => void;
}

const FOLLOW = 'follow';

function Choice({
  label,
  basisPoints,
  follows,
  defeat,
  disabled,
  onPick,
}: {
  label: string;
  basisPoints: number;
  /** Abandon only: no value of its own is stored. */
  follows?: boolean;
  /** Abandon only: the defeat rate it can follow. */
  defeat?: number;
  disabled: boolean;
  onPick: (basisPoints: number | null) => void;
}) {
  return (
    <label className="block text-sm">
      {label}
      <select
        aria-label={label}
        className={selectClass}
        disabled={disabled}
        value={follows ? FOLLOW : String(basisPoints)}
        onChange={(e) => onPick(e.target.value === FOLLOW ? null : Number(e.target.value))}
      >
        {defeat !== undefined && (
          <option value={FOLLOW}>Same as defeat: {retentionLabel(defeat)}</option>
        )}
        {RISK_PRESETS.map((preset) => (
          <option key={preset.basisPoints} value={preset.basisPoints}>
            {retentionLabel(preset.basisPoints)}
          </option>
        ))}
        {!follows && !isPreset(basisPoints) && (
          <option value={basisPoints}>Custom: {retentionLabel(basisPoints)}</option>
        )}
      </select>
    </label>
  );
}

function CustomPercent({
  label,
  basisPoints,
  disabled,
  onChange,
}: {
  label: string;
  basisPoints: number;
  disabled: boolean;
  onChange: (basisPoints: number) => void;
}) {
  /** What the author is typing, while it differs from the stored value. */
  const [typed, setTyped] = useState<string | null>(null);
  const parsed = typed === null ? null : parseRetention(typed);
  return (
    <label className="block text-sm">
      {label}
      <span className="flex items-center gap-1.5">
        <Input
          aria-label={label}
          className="w-24"
          inputMode="decimal"
          disabled={disabled}
          value={typed ?? retentionPercent(basisPoints)}
          aria-invalid={parsed?.ok === false}
          onChange={(e) => {
            setTyped(e.target.value);
            const next = parseRetention(e.target.value);
            if (next.ok) onChange(next.basisPoints);
          }}
          onBlur={() => parsed?.ok !== false && setTyped(null)}
        />
        <span className="text-ink-muted">%</span>
      </span>
      {parsed?.ok === false && (
        <span className="block text-xs text-danger" role="alert">
          {parsed.message} The dungeon still says {retentionPercent(basisPoints)}%.
        </span>
      )}
    </label>
  );
}

export function CurrencyRiskSettings({ settings, disabled, onChange }: Props) {
  const defeat = settings.defeatCurrencyRetentionBasisPoints;
  const abandon = effectiveAbandon(settings);
  const follows = settings.abandonCurrencyRetentionBasisPoints === undefined;
  const [advanced, setAdvanced] = useState(!isPreset(defeat) || !isPreset(abandon));
  return (
    <section className="space-y-3" aria-label="Currency Risk" data-testid="currency-risk">
      <h2 className="text-sm font-semibold">Currency Risk</h2>
      <p className="text-xs text-ink-muted">
        How much of the Baddie Shards and WaifuBux earned during a run the player keeps when the run
        ends badly.
      </p>
      <Choice
        label="If the player is defeated"
        basisPoints={defeat}
        disabled={disabled}
        onPick={(value) => value !== null && onChange(withDefeat(settings, value))}
      />
      <Choice
        label="If the player abandons the run"
        basisPoints={abandon}
        follows={follows}
        defeat={defeat}
        disabled={disabled}
        onPick={(value) => onChange(withAbandon(settings, value))}
      />
      {follows && (
        <p className="text-xs text-ink-muted" data-testid="risk-abandon-fallback">
          This dungeon has no separate setting for abandoning, so abandoning keeps what defeat
          keeps: {retentionPercent(abandon)}%.
        </p>
      )}
      {abandonKeepsMore(settings) && (
        <p
          className="rounded-md border border-border-strong bg-surface-raised p-2 text-xs text-ink"
          role="status"
          data-testid="risk-warning"
        >
          Abandoning keeps more than being defeated, so giving up before a hard fight pays better
          than losing it. You can save and publish this; check it is what you want.
        </p>
      )}
      <ul
        className="list-disc space-y-1 pl-5 text-xs text-ink-muted"
        data-testid="risk-explanation"
      >
        <li>Finishing the dungeon or extracting always keeps 100%.</li>
        <li>Being defeated keeps {retentionPercent(defeat)}%.</li>
        <li>Abandoning the run keeps {retentionPercent(abandon)}%.</li>
        <li>Equipment, items, charms, salvage, Essence and affection are always kept.</li>
        <li>
          Only currency earned during that run is at risk. What the player already had is never
          touched.
        </li>
      </ul>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
      >
        {advanced ? <ChevronDown /> : <ChevronRight />} Advanced: custom percentages
      </Button>
      {advanced && (
        <div className="flex flex-wrap gap-4 rounded-lg border border-border p-3">
          <CustomPercent
            label="Kept on defeat"
            basisPoints={defeat}
            disabled={disabled}
            onChange={(value) => onChange(withDefeat(settings, value))}
          />
          <CustomPercent
            label="Kept on abandoning"
            basisPoints={abandon}
            disabled={disabled}
            onChange={(value) => onChange(withAbandon(settings, value))}
          />
        </div>
      )}
    </section>
  );
}
