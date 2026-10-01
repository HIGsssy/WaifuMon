/**
 * The encounter list's search box and filter row.
 */
import type { AdminEncounterReference } from '@/api/adminEncounters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { activeFilterCount, DEFAULT_FILTERS, type EncounterFilterState } from './encounterFilters';
import { regionLabel } from './waifumonSelection';

const SELECT = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';

interface Props {
  value: EncounterFilterState;
  onChange: (next: EncounterFilterState) => void;
  reference: AdminEncounterReference | undefined;
}

export function EncounterFilterBar({ value, onChange, reference }: Props) {
  const set = <K extends keyof EncounterFilterState>(key: K, v: EncounterFilterState[K]) =>
    onChange({ ...value, [key]: v });
  const active = activeFilterCount(value);

  return (
    <div className="space-y-2" data-testid="encounter-filters">
      <Input
        type="search"
        aria-label="Search encounters"
        placeholder="Search name, slug, or a linked encounter"
        value={value.q}
        onChange={(e) => set('q', e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Encounter role"
          className={SELECT}
          value={value.role}
          onChange={(e) => set('role', e.target.value as EncounterFilterState['role'])}
        >
          <option value="all">Role: all</option>
          <option value="standalone">Standalone</option>
          <option value="root">Chain root</option>
          <option value="child">Chain child</option>
          <option value="chain-only">Chain-only</option>
        </select>
        <select
          aria-label="Status"
          className={SELECT}
          value={value.status}
          onChange={(e) => set('status', e.target.value as EncounterFilterState['status'])}
        >
          <option value="">Status: any</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="disabled">Disabled</option>
        </select>
        <select
          aria-label="Source"
          className={SELECT}
          value={value.source}
          onChange={(e) => set('source', e.target.value as EncounterFilterState['source'])}
        >
          <option value="all">Source: any</option>
          <option value="hunt">Hunt</option>
          <option value="travel">Travel</option>
          <option value="both">Hunt + Travel</option>
        </select>
        <select
          aria-label="Region"
          className={SELECT}
          value={value.region}
          onChange={(e) => set('region', e.target.value)}
        >
          <option value="">Region: any</option>
          {(reference?.regions ?? []).map((r) => (
            <option key={r} value={r}>
              {regionLabel(r, reference?.regionNames)}
            </option>
          ))}
        </select>
        <select
          aria-label="Encounter type"
          className={SELECT}
          value={value.type}
          onChange={(e) => set('type', e.target.value)}
        >
          <option value="">Type: any</option>
          {(reference?.types ?? []).map((t) => (
            <option key={t} value={t}>
              {t.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select
          aria-label="Rarity"
          className={SELECT}
          value={value.rarity}
          onChange={(e) => set('rarity', e.target.value)}
        >
          <option value="">Rarity: any</option>
          {(reference?.rarities ?? ['common', 'uncommon', 'rare', 'mythic']).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          aria-label="Artwork"
          className={SELECT}
          value={value.artwork}
          onChange={(e) => set('artwork', e.target.value as EncounterFilterState['artwork'])}
        >
          <option value="any">Artwork: any</option>
          <option value="has">Has artwork</option>
          <option value="missing">Missing artwork</option>
        </select>
        <select
          aria-label="Vendor"
          className={SELECT}
          value={value.vendor}
          onChange={(e) => set('vendor', e.target.value as EncounterFilterState['vendor'])}
        >
          <option value="any">Vendor: any</option>
          <option value="opens">Opens a vendor</option>
          <option value="none">No vendor</option>
        </select>
        {active > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange({ ...DEFAULT_FILTERS, q: value.q })}
          >
            Clear {active} filter{active === 1 ? '' : 's'}
          </Button>
        )}
      </div>
    </div>
  );
}
