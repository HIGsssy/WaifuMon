/**
 * The dungeon's own library of events and random pools, in its settings.
 * Each row says where it is used. An event or pool that something still uses
 * cannot be deleted: the row says what to change first.
 *
 * They belong to this dungeon alone. Copying one makes a second, independent
 * one here; nothing is shared with any other dungeon.
 */
import { useContext, useState } from 'react';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import type { DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  EVENT_LIMITS,
  EVENT_PRESETS,
  createEvent,
  createPool,
  deleteEvent,
  deletePool,
  duplicateEvent,
  duplicatePool,
  eventUsage,
  eventsOf,
  poolUsage,
  poolsOf,
  usageText,
  type EventUse,
} from './dungeonEventModel';
import { EventEditorContext } from './eventEditorContext';

const hint = 'text-xs text-ink-muted';

interface Removal {
  kind: 'event' | 'pool';
  id: string;
  name: string;
  uses: EventUse[];
}

export function DungeonEventsPanel({
  definition,
  disabled,
  onChange,
}: {
  definition: DungeonDefinition;
  disabled: boolean;
  onChange: (definition: DungeonDefinition) => void;
}) {
  const host = useContext(EventEditorContext);
  const [choosing, setChoosing] = useState(false);
  const [removing, setRemoving] = useState<Removal | null>(null);
  const events = eventsOf(definition);
  const pools = poolsOf(definition);

  const row = (
    kind: 'event' | 'pool',
    id: string,
    name: string,
    detail: string,
    uses: EventUse[],
    copy: () => void,
  ) => (
    <li
      key={id}
      className="rounded-md border border-border p-2"
      data-testid={`${kind}-row`}
      title={`${kind === 'event' ? 'Event' : 'Pool'} ID: ${id}`}
    >
      <div className="flex items-start gap-1">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium break-words">{name}</span>
          <span className={`block ${hint}`}>{detail}</span>
          <span className={`block ${hint}`} data-testid="usage">
            {usageText(uses)}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${disabled ? 'View' : 'Edit'} ${kind === 'event' ? 'event' : 'pool'} ${name}`}
          disabled={!host}
          onClick={() => host?.open({ kind, id })}
        >
          <Pencil />
        </Button>
        {!disabled && (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Duplicate ${kind === 'event' ? 'event' : 'pool'} ${name}`}
              onClick={copy}
            >
              <Copy />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${kind === 'event' ? 'event' : 'pool'} ${name}`}
              onClick={() => setRemoving({ kind, id, name, uses })}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
    </li>
  );

  return (
    <section className="space-y-3" aria-label="Events" data-testid="dungeon-events">
      <h2 className="text-sm font-semibold">Events</h2>
      <p className={hint}>
        Story moments with choices, and random pools that pick one when a player arrives. Attach
        them to rooms from a room’s Event setting. They belong to this dungeon only.
      </p>
      {events.length === 0 && pools.length === 0 && (
        <p className="text-sm text-ink-muted">No events yet.</p>
      )}
      {events.length > 0 && (
        <ul className="space-y-1.5" aria-label="Events in this dungeon">
          {events.map((event) =>
            row(
              'event',
              event.id,
              event.title || 'Untitled event',
              `${event.choices.length} ${event.choices.length === 1 ? 'choice' : 'choices'}`,
              eventUsage(definition, event.id),
              () => {
                const made = duplicateEvent(definition, event.id);
                onChange(made.definition);
              },
            ),
          )}
        </ul>
      )}
      {pools.length > 0 && (
        <ul className="space-y-1.5" aria-label="Random pools in this dungeon">
          {pools.map((pool) =>
            row(
              'pool',
              pool.id,
              pool.name || 'Unnamed pool',
              `Random pool, ${pool.entries.length} ${pool.entries.length === 1 ? 'entry' : 'entries'}`,
              poolUsage(definition, pool.id),
              () => onChange(duplicatePool(definition, pool.id).definition),
            ),
          )}
        </ul>
      )}
      {!disabled && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              aria-expanded={choosing}
              disabled={events.length >= EVENT_LIMITS.events}
              onClick={() => setChoosing(!choosing)}
            >
              + New event
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pools.length >= EVENT_LIMITS.pools}
              onClick={() => {
                const made = createPool(definition);
                onChange(made.definition);
                host?.open({ kind: 'pool', id: made.id, field: 'name' });
              }}
            >
              + New random pool
            </Button>
          </div>
          {choosing && (
            <ul className="space-y-1" aria-label="Starting points">
              {EVENT_PRESETS.map((preset) => (
                <li key={preset.id}>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Start from ${preset.label}`}
                    onClick={() => {
                      const made = createEvent(definition, preset.id);
                      onChange(made.definition);
                      setChoosing(false);
                      host?.open({ kind: 'event', id: made.id, field: 'title' });
                    }}
                  >
                    {preset.label}
                  </Button>{' '}
                  <span className={hint}>{preset.hint}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Button variant="ghost" size="sm" disabled={!host} onClick={() => host?.play()}>
        Play the dungeon
      </Button>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogTitle>
            {removing?.uses.length ? 'Can’t delete' : 'Delete'} “{removing?.name}”
            {removing?.uses.length ? ' yet' : '?'}
          </DialogTitle>
          <DialogDescription>
            {removing?.uses.length
              ? 'It is still used. Change these first, then delete it:'
              : removing?.kind === 'event'
                ? 'The event, its choices and their results are removed from this dungeon.'
                : 'The pool is removed from this dungeon. The events in it are kept.'}
          </DialogDescription>
          {removing && removing.uses.length > 0 && (
            <ul className="mt-3 list-disc pl-5 text-sm" role="alert" data-testid="delete-blockers">
              {removing.uses.map((use, n) => (
                <li key={n}>
                  {use.kind === 'room'
                    ? `The room ${use.name} shows it: set that room’s Event to something else.`
                    : `The random pool ${use.name} lists it: remove its entry there.`}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2">
            {removing && removing.uses.length === 0 && (
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => {
                  onChange(
                    removing.kind === 'event'
                      ? deleteEvent(definition, removing.id)
                      : deletePool(definition, removing.id),
                  );
                  setRemoving(null);
                }}
              >
                Delete {removing.kind === 'event' ? 'event' : 'pool'}
              </Button>
            )}
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {removing?.uses.length ? 'OK' : 'Keep it'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
