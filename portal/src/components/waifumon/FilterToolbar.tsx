import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';

export interface FilterOption {
  value: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  style?: React.CSSProperties;
}

export interface FilterGroup {
  label: string;
  options: FilterOption[];
}

export interface ActiveFilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

export interface FilterToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  groups: FilterGroup[];
  activeChips: ActiveFilterChip[];
  onClearAll: () => void;
  trailing?: ReactNode;
  status?: ReactNode;
}

export function FilterToolbar({
  searchValue,
  onSearchChange,
  searchLabel,
  searchPlaceholder,
  groups,
  activeChips,
  onClearAll,
  trailing,
  status,
}: FilterToolbarProps) {
  const hasFilters = activeChips.length > 0;
  const visibleGroups = groups.filter((group) => group.options.length > 0);

  return (
    <div className="sticky top-14 z-30 -mx-4 mb-5 border-b border-border bg-canvas/90 px-4 py-3 backdrop-blur-md sm:top-16 sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden="true"
          />
          <Input
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            className="pl-9"
          />
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {status}
          {trailing}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" aria-label="Open filters">
              <SlidersHorizontal aria-hidden="true" />
              Filters
              {hasFilters && (
                <span className="tabular rounded-full bg-surface-sunken px-1.5 py-0 text-xs text-ink">
                  {activeChips.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-h-[70vh] overflow-y-auto">
            <div className="space-y-4">
              {visibleGroups.map((group) => (
                <fieldset key={group.label}>
                  <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">
                    {group.label}
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {group.options.map((option) => (
                      <FilterChoice key={option.value} option={option} />
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {activeChips.length > 0 && (
          <>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {activeChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onRemove}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
                >
                  <span className="truncate">{chip.label}</span>
                  <X className="size-3" aria-hidden="true" />
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={onClearAll}>
              <X aria-hidden="true" />
              Clear All
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function FilterChoice({ option }: { option: FilterOption }) {
  return (
    <button
      type="button"
      onClick={option.onSelect}
      aria-pressed={option.active}
      className={cn(
        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        option.active
          ? 'border-transparent bg-ink text-ink-inverse'
          : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
      )}
      style={option.active ? undefined : option.style}
    >
      {option.label}
    </button>
  );
}
