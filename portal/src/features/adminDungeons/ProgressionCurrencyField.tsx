import type { DungeonReferenceData } from '@/api/adminDungeons';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

export function ProgressionCurrencyField({
  value,
  currencies,
  disabled,
  onChange,
}: {
  value: string | null;
  currencies: DungeonReferenceData['currencies'] | undefined;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const missing = value !== null && !currencies?.some((currency) => currency.key === value);
  return (
    <div className="space-y-1">
      <label className="block">
        Progression currency
        <select
          aria-label="Progression currency"
          className={selectClass}
          value={value ?? ''}
          disabled={disabled || !currencies}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">None</option>
          {missing && (
            <option value={value!} disabled>
              {value} ({currencies ? 'unavailable' : 'loading…'})
            </option>
          )}
          {currencies?.map((currency) => (
            <option key={currency.key} value={currency.key} disabled={!currency.enabled}>
              {currency.pluralName}
              {!currency.enabled && ' (disabled)'}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-ink-muted">
        Used for Baddie Shard rewards. Choose an available currency before publishing Shard loot.
      </p>
    </div>
  );
}
