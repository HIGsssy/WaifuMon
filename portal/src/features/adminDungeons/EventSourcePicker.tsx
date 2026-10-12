/**
 * What an event activity presents: one specific event, or a draw from a random
 * pool. Used for a room's Event setting and inside an event activity's card.
 *
 * The author picks a kind and then an existing event or pool, or makes a new
 * one on the spot. Nothing is attached until there is something real to point
 * at, so a room never holds an event activity that presents nothing.
 */
import { useContext, useState } from 'react';
import type { DungeonDefinition, DungeonEventSource } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { createEvent, createPool, eventsOf, poolsOf } from './dungeonEventModel';
import { EventEditorContext } from './eventEditorContext';

const select = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';
type Kind = 'none' | 'event' | 'pool';

export function EventSourcePicker({
  label,
  value,
  definition,
  disabled,
  allowNone,
  onPick,
  onClear,
}: {
  /** Names the controls, e.g. "Room event". */
  label: string;
  value: DungeonEventSource | undefined;
  definition: DungeonDefinition;
  disabled: boolean;
  /** Offer "No event". */
  allowNone: boolean;
  /** `definition` already holds anything that was created for the pick. */
  onPick: (source: DungeonEventSource, definition: DungeonDefinition) => void;
  onClear?: () => void;
}) {
  const host = useContext(EventEditorContext);
  // The kind being chosen from, while it is not yet what is stored.
  const [pending, setPending] = useState<Kind | null>(null);
  const kind: Kind = pending ?? value?.kind ?? 'none';
  const events = eventsOf(definition);
  const pools = poolsOf(definition);
  const chosen =
    value && kind === value.kind ? (value.kind === 'event' ? value.eventId : value.poolId) : '';
  const known =
    kind === 'event' ? events.some((e) => e.id === chosen) : pools.some((p) => p.id === chosen);
  const pick = (source: DungeonEventSource, next = definition) => {
    setPending(null);
    onPick(source, next);
  };
  const createNew = () => {
    if (kind === 'event') {
      const made = createEvent(definition);
      pick({ kind: 'event', eventId: made.id }, made.definition);
      host?.open({ kind: 'event', id: made.id, field: 'title' });
    } else {
      const made = createPool(definition);
      pick({ kind: 'pool', poolId: made.id }, made.definition);
      host?.open({ kind: 'pool', id: made.id, field: 'name' });
    }
  };
  return (
    <div className="space-y-2" data-testid="event-source-picker">
      <select
        aria-label={label}
        className={select}
        disabled={disabled}
        value={kind}
        onChange={(e) => {
          const next = e.target.value as Kind;
          if (next === 'none') {
            setPending(null);
            if (value) onClear?.();
            return;
          }
          setPending(next === value?.kind ? null : next);
        }}
      >
        {(allowNone || !value) && <option value="none">No event</option>}
        <option value="event">A specific event</option>
        <option value="pool">A random event from a pool</option>
      </select>
      {kind !== 'none' && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`${label}: ${kind === 'event' ? 'which event' : 'which pool'}`}
            className={`${select} min-w-0 flex-1`}
            disabled={disabled}
            value={chosen}
            onChange={(e) => {
              if (!e.target.value) return;
              pick(
                kind === 'event'
                  ? { kind: 'event', eventId: e.target.value }
                  : { kind: 'pool', poolId: e.target.value },
              );
            }}
          >
            {(!chosen || !known) && (
              <option value={known ? '' : chosen}>
                {chosen
                  ? `Missing ${kind === 'event' ? 'event' : 'pool'}: choose another…`
                  : kind === 'event'
                    ? 'Choose an event…'
                    : 'Choose a pool…'}
              </option>
            )}
            {(kind === 'event' ? events : pools).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {('title' in entry ? entry.title : entry.name) || 'Untitled'}
              </option>
            ))}
          </select>
          {!disabled && (
            <Button
              variant="outline"
              size="sm"
              aria-label={`${label}: create a new ${kind === 'event' ? 'event' : 'pool'}`}
              onClick={createNew}
            >
              New…
            </Button>
          )}
          {chosen && known && host && (
            <Button
              variant="outline"
              size="sm"
              aria-label={`${label}: ${disabled ? 'view' : 'edit'} ${kind === 'event' ? 'event' : 'pool'}`}
              onClick={() => host.open({ kind, id: chosen })}
            >
              {disabled ? 'View' : 'Edit'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
