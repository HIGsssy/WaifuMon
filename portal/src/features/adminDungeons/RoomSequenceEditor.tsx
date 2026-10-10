import { useState } from 'react';
import type {
  DungeonDefinition,
  DungeonIssue,
  DungeonReferenceData,
  DungeonRoom,
} from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DungeonActionEditor } from './DungeonActionEditor';
import {
  ACTION_TYPES,
  createAction,
  duplicateAction,
  moveEntry,
  routingProblems,
  actionIssues,
  actionSummary,
  type ActionType,
} from './dungeonActionModel';
import { DungeonIssues } from './zoneFormParts';

export function RoomSequenceEditor({
  room,
  definition,
  issues,
  reference,
  disabled,
  onChange,
}: {
  room: DungeonRoom;
  definition: DungeonDefinition;
  issues: DungeonIssue[];
  reference?: DungeonReferenceData | undefined;
  disabled: boolean;
  onChange: (definition: DungeonDefinition) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<ActionType>('combat');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const selected = room.actions.find((a) => a.id === selectedId);
  const replace = (actions: DungeonRoom['actions']) => {
    if (!disabled)
      onChange({
        ...definition,
        rooms: definition.rooms.map((r) => (r.id === room.id ? { ...r, actions } : r)),
      });
  };
  const roomIndex = definition.rooms.findIndex((r) => r.id === room.id);
  const problems = routingProblems(room);
  return (
    <section className="space-y-3" aria-label="Room action sequence">
      <h3>Room action sequence</h3>
      <div className="space-y-3">
        <label>
          New action type{' '}
          <select
            aria-label="New action type"
            disabled={disabled}
            value={addingType}
            onChange={(e) => setAddingType(e.target.value as ActionType)}
          >
            {ACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={disabled}
          onClick={() => {
            const action = createAction(addingType, room.actions, reference);
            replace([...room.actions, action]);
            setSelectedId(action.id);
          }}
        >
          Add action
        </Button>
        {room.actions.length === 0 && (
          <p>
            No actions yet. Add combat, rewards, or another action to build this room's sequence.
          </p>
        )}
        <ol className="space-y-2">
          {room.actions.map((action, index) => (
            <li
              key={action.id}
              className={`rounded border p-2 ${selectedId === action.id ? 'border-accent' : 'border-border'}`}
            >
              <Button
                variant="ghost"
                aria-pressed={selectedId === action.id}
                onClick={() => setSelectedId(action.id)}
              >
                Select action {index + 1}: {action.label || action.type}
              </Button>
              <p className="text-xs text-ink-muted">
                {action.type} · {actionSummary(action)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={disabled || index === 0}
                  onClick={() => replace(moveEntry(room.actions, index, -1))}
                >
                  Move action {index + 1} up
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled || index === room.actions.length - 1}
                  onClick={() => replace(moveEntry(room.actions, index, 1))}
                >
                  Move action {index + 1} down
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    const actions = duplicateAction(room.actions, action.id);
                    replace(actions);
                    setSelectedId(actions[index + 1]!.id);
                  }}
                >
                  Duplicate action {index + 1}
                </Button>
                <Button
                  disabled={disabled}
                  variant="outline"
                  onClick={() => setRemovingId(action.id)}
                >
                  Remove action {index + 1}
                </Button>
              </div>
              <DungeonIssues issues={actionIssues(issues, roomIndex, index)} />
            </li>
          ))}
        </ol>
        {problems.map((p) => (
          <div role="alert" key={`${p.actionId}:${p.via}`}>
            {p.message} Route {p.via} on{' '}
            {room.actions.find((a) => a.id === p.actionId)?.label || p.actionId} still references{' '}
            {p.targetId}.{' '}
            <Button variant="outline" onClick={() => setSelectedId(p.actionId)}>
              Repair {p.via} route
            </Button>
          </div>
        ))}
        {selected && (
          <fieldset disabled={disabled}>
            <DungeonActionEditor
              action={selected}
              room={room}
              definition={definition}
              reference={reference}
              onChange={(next) => replace(room.actions.map((a) => (a.id === next.id ? next : a)))}
            />
          </fieldset>
        )}
      </div>
      <Dialog open={removingId !== null} onOpenChange={(open) => !open && setRemovingId(null)}>
        <DialogContent>
          <DialogTitle>Remove action?</DialogTitle>
          <DialogDescription>
            The action will be removed. Routes that reference it will retain their targets and must
            be repaired explicitly before publication.
          </DialogDescription>
          <Button
            disabled={disabled}
            onClick={() => {
              replace(room.actions.filter((a) => a.id !== removingId));
              if (selectedId === removingId) setSelectedId(null);
              setRemovingId(null);
            }}
          >
            Confirm action removal
          </Button>
          <Button variant="outline" onClick={() => setRemovingId(null)}>
            Cancel action removal
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function RunFlagsEditor({
  definition,
  disabled,
  onChange,
}: {
  definition: DungeonDefinition;
  disabled: boolean;
  onChange: (definition: DungeonDefinition) => void;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-2 rounded border border-border p-3">
      <legend>Dungeon run flags</legend>
      {definition.flags
        .filter((f) => f.scope === 'run')
        .map((flag) => (
          <label key={flag.key} className="block">
            Flag {flag.key}
            <Input
              aria-label={`Flag description ${flag.key}`}
              maxLength={300}
              value={flag.description ?? ''}
              onChange={(e) =>
                onChange({
                  ...definition,
                  flags: definition.flags.map((f) =>
                    f.key === flag.key && f.scope === 'run'
                      ? { ...f, description: e.target.value }
                      : f,
                  ),
                })
              }
            />
          </label>
        ))}
      <Button
        variant="outline"
        onClick={() => {
          let key: string;
          do {
            key = `f_${crypto.randomUUID().replaceAll('-', '')}`;
          } while (definition.flags.some((f) => f.key === key));
          onChange({
            ...definition,
            flags: [...definition.flags, { key, scope: 'run', description: 'New flag' }],
          });
        }}
      >
        Add run flag
      </Button>
      {definition.flags.some((f) => f.scope === 'player') && (
        <p>
          Existing player flag declarations are preserved. Persistent player flags are not supported
          by this editor.
        </p>
      )}
    </fieldset>
  );
}
