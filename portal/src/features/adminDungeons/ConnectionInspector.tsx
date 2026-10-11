/**
 * A path between two rooms. By default it is simply open; an author who wants
 * more chooses "locked" or "hidden" and says when it opens. Those map onto the
 * existing `requires` and `kind` fields — nothing new is stored.
 */
import { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import type { DungeonCondition, DungeonConnection, DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DungeonConditionEditor } from './DungeonConditionEditor';
import { pathState, roomLabel, roomNameOf, type FriendlyIssue } from './dungeonText';

const field = 'block space-y-1 text-sm';
const STATES = [
  ['open', 'Open path', 'Players can always take it.'],
  ['locked', 'Locked path', 'Players see it, but can only take it once a rule is met.'],
  ['hidden', 'Hidden path', 'Players do not see it at all until a rule is met.'],
] as const;

export function ConnectionInspector({
  connection,
  definition,
  issues,
  disabled,
  onChange,
  onDelete,
}: {
  connection: DungeonConnection;
  definition: DungeonDefinition;
  issues: FriendlyIssue[];
  disabled: boolean;
  onChange: (definition: DungeonDefinition) => void;
  onDelete: () => void;
}) {
  const [advanced, setAdvanced] = useState(connection.kind === 'shortcut');
  const state = pathState(connection);
  const update = (next: DungeonConnection) =>
    onChange({
      ...definition,
      connections: definition.connections.map((c) => (c.id === next.id ? next : c)),
    });
  const patch = (fields: Partial<DungeonConnection>) => update({ ...connection, ...fields });
  const setState = (next: (typeof STATES)[number][0]) => {
    if (next === state) return;
    const changed = { ...connection };
    if (next === 'open') {
      delete changed.requires;
      if (changed.kind === 'secret') changed.kind = 'path';
    } else {
      // A lock needs a rule; start from one that is valid and easy to change.
      changed.requires ??= { type: 'room_completed', roomId: connection.from };
      if (next === 'hidden') changed.kind = 'secret';
      else if (changed.kind === 'secret') changed.kind = 'path';
    }
    update(changed);
  };
  const endsAtExit = definition.rooms.find((r) => r.id === connection.to)?.kind === 'exit';
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Path</legend>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {roomNameOf(definition, connection.from)} <ArrowRight className="size-4" />{' '}
        {roomNameOf(definition, connection.to)}
      </p>
      <p className="text-xs text-ink-muted">
        Players travel in the direction of the arrow. Add a second path if they should be able to
        walk back.
      </p>
      {issues.length > 0 && (
        <ul className="space-y-1 text-sm">
          {issues.map((i, n) => (
            <li key={n} className={i.level === 'review' ? 'text-ink-muted' : 'text-danger'}>
              <strong className="font-medium">{i.title}</strong> {i.help}
            </li>
          ))}
        </ul>
      )}
      <fieldset className="space-y-1.5">
        <legend className="text-sm">Can players take this path?</legend>
        {STATES.map(([value, label, hint]) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              aria-label={label}
              name={`path-state-${connection.id}`}
              className="mt-1"
              checked={state === value}
              onChange={() => setState(value)}
            />
            <span>
              {label}
              <span className="block text-xs text-ink-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {state !== 'open' && (
        <>
          <DungeonConditionEditor
            label="This path opens when"
            value={connection.requires as DungeonCondition | undefined}
            allowEmpty={false}
            definition={definition}
            onChange={(requires) => requires && patch({ requires })}
          />
          {state === 'locked' && (
            <label className={field}>
              Message while it is locked
              <Input
                aria-label="Locked text"
                maxLength={200}
                placeholder="Locked."
                value={connection.lockedText ?? ''}
                onChange={(e) => patch({ lockedText: e.target.value })}
              />
            </label>
          )}
        </>
      )}
      <label className={field}>
        Button text players see
        <Input
          aria-label="Path button text"
          maxLength={80}
          placeholder={`→ ${roomNameOf(definition, connection.to)}`}
          value={connection.label ?? ''}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </label>
      <div className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? <ChevronDown /> : <ChevronRight />} Advanced
        </Button>
        {advanced && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            {(['from', 'to'] as const).map((end) => (
              <label key={end} className={field}>
                {end === 'from' ? 'Starts in' : 'Leads to'}
                <select
                  aria-label={end === 'from' ? 'Source room' : 'Destination room'}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  value={connection[end]}
                  onChange={(e) => patch({ [end]: e.target.value })}
                >
                  {!definition.rooms.some((r) => r.id === connection[end]) && (
                    <option value={connection[end]}>A room that no longer exists</option>
                  )}
                  {definition.rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {roomLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={endsAtExit}
              title={endsAtExit ? 'A path cannot start at an exit.' : undefined}
              onClick={() => patch({ from: connection.to, to: connection.from })}
            >
              Reverse direction
            </Button>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                aria-label="Mark as shortcut"
                checked={connection.kind === 'shortcut'}
                disabled={state === 'hidden'}
                onChange={(e) => patch({ kind: e.target.checked ? 'shortcut' : 'path' })}
              />
              <span>
                Mark as a shortcut
                <span className="block text-xs text-ink-muted">
                  A label for your own planning. It plays exactly like any other path.
                </span>
              </span>
            </label>
            {connection.kind === 'secret' && !connection.requires && (
              <p className="text-xs text-ink-muted">
                This path is stored as hidden but has no rule, so players always see it. Choose
                “Hidden path” above to give it a rule.
              </p>
            )}
            <p className="font-mono text-[0.7rem] break-all text-ink-subtle">
              Path ID: {connection.id}
            </p>
          </div>
        )}
      </div>
      <Button variant="danger" size="sm" onClick={onDelete}>
        Remove path
      </Button>
    </fieldset>
  );
}
