/**
 * A room as its author thinks of it: what it is called, what happens in it,
 * and where the player can go next. Engine-level settings stay available under
 * "Advanced rules" and are flagged there whenever a room already uses them.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type {
  DungeonArtworkRef,
  DungeonDefinition,
  DungeonReferenceData,
  DungeonRoom,
} from '@/api/adminDungeons';
import { useHasPermission } from '@/auth/useSession';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AssetPickerDialog } from '@/features/adminArtwork/AssetPickerDialog';
import { ActivityCard } from './ActivityCard';
import {
  createAction,
  duplicateAction,
  moveEntry,
  routingProblems,
  type ActionType,
} from './dungeonActionModel';
import { connectMapRooms, type MapSelection } from './dungeonMapModel';
import { connectionProblem } from './dungeonRoomTemplates';
import {
  ACTIVITIES,
  PATH_STATE_LABEL,
  activityOf,
  newFlagKey,
  pathState,
  roomLabel,
  roomNameOf,
  type FriendlyIssue,
} from './dungeonText';

const heading = 'text-xs font-semibold tracking-wide text-ink-muted uppercase';
const field = 'block space-y-1 text-sm';
const COMMON: ActionType[] = ['combat', 'boss', 'reward', 'rest'];
const UNCOMMON: ActionType[] = ['set_flag', 'gate', 'leave'];

function BackgroundField({
  value,
  disabled,
  onChange,
}: {
  value: DungeonArtworkRef | null | undefined;
  disabled: boolean;
  onChange: (ref: DungeonArtworkRef | null) => void;
}) {
  const [picker, setPicker] = useState(false);
  const canBrowse = useHasPermission('artwork.read');
  return (
    <div className="space-y-1 text-sm">
      <span>Background picture</span>
      <p className="text-xs text-ink-muted">
        {!value && 'Uses the dungeon’s background.'}
        {value?.kind === 'managed' && `Uploaded: ${value.name ?? 'artwork'}`}
        {value?.kind === 'shipped' && `File: ${value.path}`}
      </p>
      <div className="flex flex-wrap gap-2">
        {canBrowse && (
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setPicker(true)}>
            Choose room background
          </Button>
        )}
        {value && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
            Use the dungeon’s background
          </Button>
        )}
      </div>
      <AssetPickerDialog
        open={picker}
        title="Choose room background"
        category="dungeon_background"
        selectedId={null}
        onClose={() => setPicker(false)}
        onSelect={(asset) =>
          onChange({
            kind: 'managed',
            category: asset.category,
            contentHash: asset.contentHash,
            name: asset.name,
          })
        }
      />
    </div>
  );
}

export function RoomInspector({
  room,
  definition,
  reference,
  issues,
  disabled,
  focusName,
  focusActionId,
  onChange,
  onSelect,
  onAddNext,
  onDelete,
}: {
  room: DungeonRoom;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  /** Friendly issues that belong to this room. */
  issues: FriendlyIssue[];
  disabled: boolean;
  /** Bumped when the room was just created, to put the cursor in its name. */
  focusName?: number | undefined;
  /** An activity to open, e.g. the one a located problem belongs to. */
  focusActionId?: string | null | undefined;
  onChange: (definition: DungeonDefinition) => void;
  onSelect: (selection: MapSelection) => void;
  onAddNext: () => void;
  onDelete: () => void;
}) {
  const isStart = definition.entranceRoomId === room.id;
  const isExit = room.kind === 'exit';
  const unfinished = room.actions.find((a) =>
    a.waves?.some((w) => ('key' in w.enemy ? !w.enemy.key : w.enemy.pool.some((e) => !e.key))),
  );
  const [openId, setOpenId] = useState<string | null>(
    focusActionId ?? unfinished?.id ?? (room.actions.length === 1 ? room.actions[0]!.id : null),
  );
  const [more, setMore] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [startConfirm, setStartConfirm] = useState(false);
  const [connectTo, setConnectTo] = useState('');
  const [notice, setNotice] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusActionId) setOpenId(focusActionId);
  }, [focusActionId]);
  useEffect(() => {
    if (!focusName) return;
    // After the template chooser has closed and handed focus back.
    const timer = window.setTimeout(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [focusName]);

  const patchRoom = (patch: Partial<DungeonRoom>) =>
    onChange({
      ...definition,
      rooms: definition.rooms.map((r) => (r.id === room.id ? { ...r, ...patch } : r)),
    });
  const replace = (actions: DungeonRoom['actions']) => patchRoom({ actions });
  const addActivity = (type: ActionType) => {
    // "Remember something" needs a thing to remember; make one rather than leave it blank.
    const flags =
      type === 'set_flag' && !definition.flags.some((f) => f.scope === 'run')
        ? [
            ...definition.flags,
            { key: newFlagKey(definition), scope: 'run' as const, description: 'Something new' },
          ]
        : definition.flags;
    const action = createAction(type, room.actions, { ...definition, flags });
    onChange({
      ...definition,
      flags,
      rooms: definition.rooms.map((r) =>
        r.id === room.id ? { ...r, actions: [...r.actions, action] } : r,
      ),
    });
    setOpenId(action.id);
    setMore(false);
  };
  const outgoing = definition.connections.filter((c) => c.from === room.id);
  const candidates = definition.rooms.filter(
    (r) => connectionProblem(definition, room.id, r.id) === null,
  );
  // The sections below already say when the room is empty or has no way out.
  const roomIssues = issues.filter(
    (i) =>
      !i.actionId &&
      i.issue.code !== 'room_empty' &&
      !(i.issue.code === 'room_no_route_to_exit' && outgoing.length === 0),
  );
  const customised = [isStart && 'Start room', room.extraction && 'Players can leave here'].filter(
    Boolean,
  ) as string[];
  const removing = room.actions.find((a) => a.id === removingId);

  return (
    <div className="space-y-5">
      <fieldset disabled={disabled} className="space-y-3">
        <legend className={heading}>Room details</legend>
        <label className={field}>
          Room name
          <Input
            ref={nameInput}
            aria-label="Room name"
            maxLength={80}
            value={room.name ?? ''}
            onChange={(e) => patchRoom({ name: e.target.value })}
          />
        </label>
        <label className={field}>
          Description players read
          <textarea
            aria-label="Room description"
            className="w-full rounded-lg border border-border bg-surface p-2 text-sm"
            rows={2}
            maxLength={600}
            value={room.description ?? ''}
            onChange={(e) => patchRoom({ description: e.target.value })}
          />
        </label>
        <BackgroundField
          value={room.background}
          disabled={disabled}
          onChange={(background) => patchRoom({ background })}
        />
      </fieldset>

      {roomIssues.length > 0 && (
        <ul
          aria-label="To do in this room"
          className="space-y-1 rounded-lg border border-border p-2.5 text-sm"
        >
          {roomIssues.map((i, n) => (
            <li key={n} className={i.level === 'review' ? 'text-ink-muted' : 'text-danger'}>
              <strong className="font-medium">{i.title}</strong> {i.help}
            </li>
          ))}
        </ul>
      )}

      <section aria-label="What happens here" className="space-y-2">
        <h3 className={heading}>What happens here?</h3>
        {room.actions.length === 0 && (
          <p className="text-sm text-ink-muted">
            {isExit
              ? 'Nothing: the dungeon is completed as soon as the player arrives. Add an activity if something should happen first.'
              : 'Nothing yet. Players walk straight through this room. Add an activity below.'}
          </p>
        )}
        <ol className="space-y-2">
          {room.actions.map((action, index) => (
            <ActivityCard
              key={action.id}
              action={action}
              index={index}
              room={room}
              definition={definition}
              reference={reference}
              issues={issues.filter((i) => i.actionId === action.id)}
              open={openId === action.id}
              disabled={disabled}
              onToggle={() => setOpenId(openId === action.id ? null : action.id)}
              onChange={(next) => replace(room.actions.map((a) => (a.id === next.id ? next : a)))}
              onDefinitionChange={onChange}
              onMove={(delta) => replace(moveEntry(room.actions, index, delta))}
              onDuplicate={() => {
                const actions = duplicateAction(room.actions, action.id);
                replace(actions);
                setOpenId(actions[index + 1]!.id);
              }}
              onRemove={() => setRemovingId(action.id)}
            />
          ))}
        </ol>
        {routingProblems(room).map((p) => {
          const index = room.actions.findIndex((a) => a.id === p.actionId);
          return (
            <p role="alert" key={`${p.actionId}:${p.via}`} className="text-sm text-danger">
              Activity {index + 1} ({activityOf(room.actions[index]!).title}) has a custom “what
              happens afterward” rule that no longer works, because the activity it skips to was
              removed or now comes earlier.{' '}
              <Button variant="outline" size="sm" onClick={() => setOpenId(p.actionId)}>
                Open activity {index + 1}
              </Button>
            </p>
          );
        })}
        {!disabled && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {COMMON.map((type) => {
                const Icon = ACTIVITIES[type].icon;
                return (
                  <Button
                    key={type}
                    variant="outline"
                    size="sm"
                    aria-label={`Add ${ACTIVITIES[type].title}`}
                    onClick={() => addActivity(type)}
                  >
                    <Icon /> {ACTIVITIES[type].title}
                  </Button>
                );
              })}
              <Button variant="ghost" size="sm" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? <ChevronDown /> : <ChevronRight />} More
              </Button>
            </div>
            {more && (
              <ul className="space-y-1">
                {UNCOMMON.map((type) => (
                  <li key={type}>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Add ${ACTIVITIES[type].title}`}
                      onClick={() => addActivity(type)}
                    >
                      {ACTIVITIES[type].title}
                    </Button>{' '}
                    <span className="text-xs text-ink-muted">{ACTIVITIES[type].hint}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section aria-label="Ways out" className="space-y-2">
        <h3 className={heading}>Ways out</h3>
        {isExit ? (
          <p className="text-sm text-ink-muted">
            This is an exit. The run is completed here, so no path leads onward.
          </p>
        ) : (
          <>
            {outgoing.length === 0 && (
              <p className="text-sm text-ink-muted">
                No way out yet. Add the next room so players can continue.
              </p>
            )}
            <ul className="space-y-1">
              {outgoing.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-label={`Open path to ${roomNameOf(definition, c.to)}`}
                    className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-sm hover:bg-surface-raised"
                    onClick={() => onSelect({ kind: 'connection', id: c.id })}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      → {roomNameOf(definition, c.to)}
                    </span>
                    {c.kind === 'shortcut' && <Badge variant="outline">Shortcut</Badge>}
                    <Badge variant={pathState(c) === 'open' ? 'default' : 'outline'}>
                      {PATH_STATE_LABEL[pathState(c)]}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
            {outgoing.length > 1 && (
              <p className="text-xs text-ink-muted">
                Players choose between these once the room is finished.
              </p>
            )}
            {!disabled && (
              <div className="space-y-2">
                <Button variant="accent" size="sm" onClick={onAddNext}>
                  <Plus /> Add next room
                </Button>
                {candidates.length > 0 && (
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="Connect to existing room"
                      className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                      value={connectTo}
                      onChange={(e) => setConnectTo(e.target.value)}
                    >
                      <option value="">Connect to an existing room…</option>
                      {candidates.map((r) => (
                        <option key={r.id} value={r.id}>
                          {roomLabel(r)}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!connectTo}
                      onClick={() => {
                        const problem = connectionProblem(definition, room.id, connectTo);
                        setNotice(problem ?? '');
                        if (!problem) onChange(connectMapRooms(definition, room.id, connectTo));
                        setConnectTo('');
                      }}
                    >
                      Connect
                    </Button>
                  </div>
                )}
                {notice && (
                  <p role="status" className="text-sm text-danger">
                    {notice}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section aria-label="Advanced rules" className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? <ChevronDown /> : <ChevronRight />} Advanced rules
        </Button>
        {customised.map((text) => (
          <Badge key={text} variant="outline" className="ml-1">
            {text}
          </Badge>
        ))}
        {advanced && (
          <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-1 text-sm">
              {isStart ? (
                <p>Runs start in this room.</p>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setStartConfirm(true)}>
                  Make this the start room
                </Button>
              )}
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                aria-label="Ends the dungeon"
                checked={isExit}
                onChange={(e) => patchRoom({ kind: e.target.checked ? 'exit' : 'room' })}
              />
              <span>
                Completing this room finishes the dungeon
                <span className="block text-xs text-ink-muted">
                  This is what makes a room an exit.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                aria-label="Players can leave here"
                checked={room.extraction ?? false}
                onChange={(e) => patchRoom({ extraction: e.target.checked })}
              />
              <span>
                Players may leave the dungeon here and keep everything
                <span className="block text-xs text-ink-muted">
                  Offered once this room is finished. Leaving early ends the run without reaching an
                  exit.
                </span>
              </span>
            </label>
            <p className="font-mono text-[0.7rem] break-all text-ink-subtle">Room ID: {room.id}</p>
          </fieldset>
        )}
      </section>

      {!disabled && (
        <Button variant="danger" size="sm" onClick={onDelete}>
          Delete room
        </Button>
      )}

      <Dialog open={removingId !== null} onOpenChange={(open) => !open && setRemovingId(null)}>
        <DialogContent>
          <DialogTitle>
            Remove {removing ? activityOf(removing).title.toLowerCase() : 'activity'}?
          </DialogTitle>
          <DialogDescription>
            It is removed from this room. If another activity was set to skip ahead to it, that rule
            is kept and flagged for you to change.
          </DialogDescription>
          <div className="mt-4 flex gap-2">
            <Button
              variant="danger"
              disabled={disabled}
              onClick={() => {
                replace(room.actions.filter((a) => a.id !== removingId));
                if (openId === removingId) setOpenId(null);
                setRemovingId(null);
              }}
            >
              Remove activity
            </Button>
            <Button variant="outline" onClick={() => setRemovingId(null)}>
              Keep it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={startConfirm} onOpenChange={setStartConfirm}>
        <DialogContent>
          <DialogTitle>Start runs in {roomLabel(room)}?</DialogTitle>
          <DialogDescription>
            {roomNameOf(definition, definition.entranceRoomId)} stops being the start room. Every
            new run will begin here instead.
          </DialogDescription>
          <div className="mt-4 flex gap-2">
            <Button
              disabled={disabled}
              onClick={() => {
                onChange({ ...definition, entranceRoomId: room.id });
                setStartConfirm(false);
              }}
            >
              Make it the start room
            </Button>
            <Button variant="outline" onClick={() => setStartConfirm(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
