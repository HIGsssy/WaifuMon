/**
 * The room-by-room editor of an authored dungeon.
 *
 * The layout is drawn as an outline walked from the start room: the trunk at
 * the left, each way of a fork indented under the room that offers it, and a
 * pointer where the ways rejoin. There is no canvas to drag things around on —
 * rooms are added *after* a room or as a *branch* of one, and the links follow.
 *
 * A room's editor shows only what its type uses: a fight has an enemy and a
 * scene, a rest has a heal, a reward has a payout. Everything optional starts
 * on "use the default" — the dungeon's background, the enemy's own artwork,
 * the dungeon's reward for that kind of room — and an override is something
 * the author asks for, not something they must fill in.
 *
 * Nothing here saves. Every change edits the draft; the page's Save writes it.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  DEFAULT_SPRITE_PLACEMENT,
  ENEMY_ARTWORK_QUERY_KEY,
  listEnemyArtwork,
  type ArtworkLayerRef,
  type EnemyArtworkEntry,
} from '@/api/adminArtworkAssets';
import {
  DUNGEON_MAX_ROOMS,
  DUNGEON_MAX_ROOM_EXITS,
  DUNGEON_NODE_TYPES,
  type DungeonAuthoredLayoutDoc,
  type DungeonContentRef,
  type DungeonNodeType,
  type DungeonReferenceData,
  type DungeonRoomDoc,
  type DungeonRoomSceneDoc,
  type DungeonZoneDoc,
  type DungeonZoneIssue,
} from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AssetField } from '@/features/adminArtwork/AssetField';
import { PlacementControls, ScenePreview } from '@/features/adminArtwork/ScenePreview';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { cn } from '@/lib/cn';

import { ArtThumb } from './ArtThumb';
import {
  NODE_TYPE_LABELS,
  NO_ROOMS,
  addBranch,
  addNextRoom,
  basisPointsToPercent,
  canBranch,
  deleteRoom,
  duplicateRoom,
  isFightType,
  issueRoomIndex,
  newRoom,
  percentToBasisPoints,
  roomOutline,
  roomTitle,
  roomsLeadingTo,
  withRoomType,
} from './dungeonModel';
import { Advanced, Issues, NumberField, RangeFields, Section, TableSelect } from './zoneFormParts';

const firstEnabled = (refs: readonly DungeonContentRef[] | undefined) =>
  (refs ?? []).find((r) => r.enabled)?.key ?? refs?.[0]?.key ?? null;

/** The background a room is drawn against: its own, else the dungeon's default. */
function roomBackground(room: DungeonRoomDoc, zone: DungeonZoneDoc): ArtworkLayerRef {
  return room.backgroundAssetId || room.backgroundArtworkPath
    ? { assetId: room.backgroundAssetId, artworkPath: room.backgroundArtworkPath }
    : { assetId: zone.backgroundAssetId ?? null, artworkPath: zone.backgroundArtworkPath };
}

/** What a room card says about its content, in a few words. */
function roomSummary(
  room: DungeonRoomDoc,
  zone: DungeonZoneDoc,
  reference: DungeonReferenceData | undefined,
  final: boolean,
): string {
  const named = (refs: DungeonContentRef[] | undefined, key: string | null, what: string) =>
    key === null ? `No ${what} chosen` : (refs?.find((r) => r.key === key)?.name ?? key);
  if (isFightType(room.type)) return named(reference?.enemies, room.enemyKey, 'enemy');
  if (room.type === 'event') return named(reference?.events, room.eventKey, 'event');
  if (room.type === 'rest') {
    const heal = room.healBasisPoints ?? zone.nodeSettings?.rest.healBasisPoints ?? 0;
    return `Heals ${basisPointsToPercent(heal)}%`;
  }
  if (room.type === 'reward') {
    if (!room.reward) return 'Dungeon default reward';
    const { min, max } = room.reward.currency;
    const tables = [room.reward.rewardTable, room.reward.equipmentRewardTable].filter(Boolean);
    return [min === max ? `${min} currency` : `${min}–${max} currency`, ...tables].join(' · ');
  }
  return final ? 'Completes the dungeon' : 'A way out';
}

export function AuthoredRoomsEditor({
  form,
  set,
  issues,
  reference,
  readOnly,
}: {
  form: DungeonZoneDoc;
  set: (patch: Partial<DungeonZoneDoc>) => void;
  issues: DungeonZoneIssue[];
  reference: DungeonReferenceData | undefined;
  readOnly: boolean;
}) {
  const layout: DungeonAuthoredLayoutDoc = form.authored ?? NO_ROOMS;
  const [editing, setEditing] = useState<string | null>(null);
  const setLayout = (next: DungeonAuthoredLayoutDoc) => set({ authored: next });
  const enemies =
    useQuery({
      queryKey: ENEMY_ARTWORK_QUERY_KEY,
      queryFn: ({ signal }) => listEnemyArtwork(signal),
      staleTime: 30_000,
    }).data?.enemies ?? [];

  const rows = roomOutline(layout);
  const drawn = rows.filter((row) => !row.rejoin);
  const finals = drawn.filter((row) => !row.unreachable && row.room.next.length === 0);
  const finalId = finals.length === 1 ? finals[0]!.room.id : null;
  const full = layout.rooms.length >= DUNGEON_MAX_ROOMS;
  const blank = () => newRoom('', 'combat', firstEnabled(reference?.enemies), null);

  const apply = (result: { layout: DungeonAuthoredLayoutDoc; roomId: string }) => {
    setLayout(result.layout);
    setEditing(result.roomId);
  };
  const updateRoom = (id: string, next: DungeonRoomDoc) =>
    setLayout({ ...layout, rooms: layout.rooms.map((r) => (r.id === id ? next : r)) });
  const issuesOfRoom = (room: DungeonRoomDoc) => {
    const index = layout.rooms.indexOf(room);
    return issues.filter((i) => issueRoomIndex(i.path) === index);
  };

  return (
    <Section
      title="Rooms"
      hint="The dungeon, room by room, in the order a player walks it. Add a room after another to extend the path, or add a branch to offer a choice — the branch rejoins the path by itself."
      testId="zone-rooms"
    >
      <Issues
        issues={issues.filter(
          (i) => i.path === 'authored.rooms' || i.path === 'authored.startRoomId',
        )}
      />
      {layout.rooms.length === 0 && (
        <p className="text-sm text-ink-muted" data-testid="rooms-empty">
          No rooms yet. Add the room a run starts in.
        </p>
      )}
      <ol className="space-y-2" data-testid="room-outline">
        {rows.map((row, i) => {
          const { room } = row;
          const style = { marginLeft: `${row.indent * 1.75}rem` };
          if (row.rejoin) {
            return (
              <li
                key={`rejoin-${i}`}
                style={style}
                className="pl-2 text-xs text-ink-muted"
                data-testid="room-rejoin"
              >
                {row.branch && <span className="mr-1 font-medium">Branch {row.branch}:</span>}↳
                continues to <span className="text-ink">{roomTitle(room)}</span>
              </li>
            );
          }
          const final = room.id === finalId;
          const open = editing === room.id;
          const roomIssues = issuesOfRoom(room);
          return (
            <li key={room.id} style={style} data-testid="room-card" data-room-id={room.id}>
              {i > 0 && !row.unreachable && (
                <span aria-hidden className="block pl-4 text-xs leading-4 text-ink-subtle">
                  {row.branch ? '├──' : '↓'}
                </span>
              )}
              <div
                className={cn(
                  'rounded-lg border border-border bg-surface px-3 py-2',
                  room.type === 'boss' && 'border-danger/50',
                  roomIssues.some((issue) => issue.severity === 'error') && 'border-danger',
                  open && 'ring-1 ring-accent',
                )}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <ArtThumb
                    image={roomBackground(room, form)}
                    label={`${roomTitle(room)} background`}
                    testId={`room-thumb-${room.id}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.branch && <Badge variant="outline">Branch {row.branch}</Badge>}
                      <Badge variant="solid">{NODE_TYPE_LABELS[room.type]}</Badge>
                      <span className="font-medium text-ink" data-testid="room-title">
                        {roomTitle(room)}
                      </span>
                      {room.id === layout.startRoomId && <Badge variant="default">Start</Badge>}
                      {final && <Badge variant="default">Final room</Badge>}
                      {room.extraction && !final && <Badge variant="outline">Extraction</Badge>}
                      {row.unreachable && <Badge variant="danger">Not connected</Badge>}
                    </div>
                    <p className="text-xs text-ink-muted" data-testid="room-summary">
                      {roomSummary(room, form, reference, final)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={open ? 'accent' : 'outline'}
                      aria-label={`${open ? 'Close' : 'Edit'} ${roomTitle(room)}`}
                      aria-expanded={open}
                      onClick={() => setEditing(open ? null : room.id)}
                    >
                      {open ? 'Close' : readOnly ? 'View' : 'Edit'}
                    </Button>
                    {!readOnly && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={full}
                          aria-label={`Duplicate ${roomTitle(room)}`}
                          onClick={() => apply(duplicateRoom(layout, room.id))}
                        >
                          Duplicate
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${roomTitle(room)}`}
                          onClick={() => {
                            setLayout(deleteRoom(layout, room.id));
                            if (open) setEditing(null);
                          }}
                        >
                          Delete
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={full}
                          aria-label={
                            room.type === 'boss'
                              ? `Add room before ${roomTitle(room)}`
                              : `Add next room after ${roomTitle(room)}`
                          }
                          onClick={() => apply(addNextRoom(layout, room.id, blank()))}
                        >
                          {room.type === 'boss' ? 'Add room before' : 'Add next room'}
                        </Button>
                        {room.type !== 'boss' && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={full || !canBranch(layout, room.id)}
                            title={
                              canBranch(layout, room.id)
                                ? 'Offer the player another way on from this room'
                                : `A room can lead to at most ${DUNGEON_MAX_ROOM_EXITS} others`
                            }
                            aria-label={`Add branch from ${roomTitle(room)}`}
                            onClick={() => apply(addBranch(layout, room.id, blank()))}
                          >
                            Add branch
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <Issues issues={roomIssues} />
                {open && (
                  <RoomEditor
                    room={room}
                    zone={form}
                    layout={layout}
                    final={final}
                    reference={reference}
                    enemy={enemies.find((e) => e.key === room.enemyKey) ?? null}
                    readOnly={readOnly}
                    onChange={(next) => updateRoom(room.id, next)}
                    onMakeStart={() => setLayout({ ...layout, startRoomId: room.id })}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={full}
          onClick={() =>
            apply(addNextRoom(layout, finalId ?? drawn.at(-1)?.room.id ?? null, blank()))
          }
        >
          + Add room
        </Button>
      )}
      {full && (
        <p className="text-xs text-ink-subtle">
          A dungeon holds at most {DUNGEON_MAX_ROOMS} rooms.
        </p>
      )}
    </Section>
  );
}

function RoomEditor({
  room,
  zone,
  layout,
  final,
  reference,
  enemy,
  readOnly,
  onChange,
  onMakeStart,
}: {
  room: DungeonRoomDoc;
  zone: DungeonZoneDoc;
  layout: DungeonAuthoredLayoutDoc;
  /** The dungeon ends here. */
  final: boolean;
  reference: DungeonReferenceData | undefined;
  /** The chosen enemy's artwork as it stands, for the defaults and the preview. */
  enemy: EnemyArtworkEntry | null;
  readOnly: boolean;
  onChange: (next: DungeonRoomDoc) => void;
  onMakeStart: () => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  const patch = (change: Partial<DungeonRoomDoc>) => onChange({ ...room, ...change });
  const fight = isFightType(room.type);
  const title = roomTitle(room);
  const tables = reference?.rewardTables ?? [];
  const pays = fight || room.type === 'reward' || room.type === 'event';
  const defaults = {
    enemyKey: firstEnabled(reference?.enemies),
    eventKey: firstEnabled(reference?.events),
  };
  const zoneHeal = zone.nodeSettings?.rest.healBasisPoints ?? 0;

  const scene = room.scene;
  const setScene = (change: Partial<DungeonRoomSceneDoc>) =>
    patch({
      scene: {
        spriteAssetId: null,
        artworkAssetId: null,
        spritePlacement: null,
        ...scene,
        ...change,
      },
    });
  const enemyPlacement = enemy?.visual.spritePlacement ?? DEFAULT_SPRITE_PLACEMENT;
  const sprite: ArtworkLayerRef | null = fight
    ? {
        assetId: scene?.spriteAssetId ?? enemy?.visual.spriteAssetId ?? null,
        artworkPath: enemy?.visual.spriteArtworkPath ?? null,
      }
    : null;

  // A link to a room that already leads here would make a loop, so it is not offered.
  const upstream = roomsLeadingTo(layout, room.id);
  const candidates = layout.rooms.filter((r) => r.id !== room.id && !upstream.has(r.id));
  const dangling = room.next.filter((id) => !layout.rooms.some((r) => r.id === id));

  return (
    <div className="mt-3 space-y-4 border-t border-border pt-3" data-testid="room-editor">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Room type
          <select
            aria-label="Room type"
            className={selectClass}
            value={room.type}
            disabled={readOnly}
            onChange={(e) =>
              onChange(withRoomType(room, e.target.value as DungeonNodeType, defaults))
            }
          >
            {DUNGEON_NODE_TYPES.map((type) => (
              <option key={type} value={type}>
                {NODE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          {fight || room.type === 'event' ? 'Room name' : 'Label shown to players'}
          <Input
            aria-label="Room name"
            className="w-64"
            placeholder={NODE_TYPE_LABELS[room.type]}
            value={room.name}
            disabled={readOnly}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>

        {fight && (
          <label className="text-xs text-ink-muted">
            Enemy
            <select
              aria-label="Enemy"
              className={selectClass}
              value={room.enemyKey ?? ''}
              disabled={readOnly}
              onChange={(e) => patch({ enemyKey: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">Choose an enemy</option>
              {room.enemyKey !== null &&
                !(reference?.enemies ?? []).some((o) => o.key === room.enemyKey) && (
                  <option value={room.enemyKey}>{room.enemyKey} (unknown)</option>
                )}
              {(reference?.enemies ?? []).map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name}
                  {o.enabled ? '' : ' (disabled)'}
                </option>
              ))}
            </select>
          </label>
        )}

        {room.type === 'event' && (
          <label className="text-xs text-ink-muted">
            Event
            <select
              aria-label="Event"
              className={selectClass}
              value={room.eventKey ?? ''}
              disabled={readOnly}
              onChange={(e) => patch({ eventKey: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">Choose an event</option>
              {room.eventKey !== null &&
                !(reference?.events ?? []).some((o) => o.key === room.eventKey) && (
                  <option value={room.eventKey}>{room.eventKey} (unknown)</option>
                )}
              {(reference?.events ?? []).map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name}
                  {o.enabled ? '' : ' (disabled)'}
                </option>
              ))}
            </select>
          </label>
        )}

        {room.type === 'rest' && (
          <div className="flex flex-wrap items-end gap-2" data-testid="room-heal">
            {room.healBasisPoints === null ? (
              <p className="pb-2 text-xs text-ink-muted">
                Heals {basisPointsToPercent(zoneHeal)}% of max HP — the dungeon default.
              </p>
            ) : (
              <NumberField
                label="Heal (% of max HP)"
                step={0.01}
                className="w-36"
                value={basisPointsToPercent(room.healBasisPoints)}
                disabled={readOnly}
                onChange={(percent) => patch({ healBasisPoints: percentToBasisPoints(percent) })}
              />
            )}
            {!readOnly && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  patch({ healBasisPoints: room.healBasisPoints === null ? zoneHeal : null })
                }
              >
                {room.healBasisPoints === null ? 'Set a heal for this room' : 'Use dungeon default'}
              </Button>
            )}
          </div>
        )}
      </div>

      {room.type === 'exit' && (
        <p className="text-xs text-ink-muted" data-testid="room-exit-note">
          {final
            ? 'The final room: reaching it completes the dungeon, and everything carried is banked.'
            : 'A way out: a player may leave from here with everything they carry, or go on.'}
        </p>
      )}

      {!final && room.type !== 'exit' && room.type !== 'boss' && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            aria-label="Extraction available"
            checked={room.extraction}
            disabled={readOnly}
            onChange={(e) => patch({ extraction: e.target.checked })}
          />
          <span>
            {fight ? 'Players may extract after this fight' : 'Players may extract from this room'}
            <span className="block text-xs text-ink-muted">
              Leaving banks everything they carry and ends the run here.
            </span>
          </span>
        </label>
      )}

      {pays && (
        <div className="space-y-2" data-testid="room-reward">
          <p className="text-xs font-medium text-ink-muted">Reward</p>
          {room.reward === null ? (
            <p className="text-xs text-ink-muted">
              Uses the dungeon default for {NODE_TYPE_LABELS[room.type]} rooms
              {room.type === 'event' ? ', when the event pays one' : ''}.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <TableSelect
                label="Reward table"
                value={room.reward.rewardTable}
                tables={tables}
                disabled={readOnly}
                onChange={(rewardTable) => patch({ reward: { ...room.reward!, rewardTable } })}
              />
              <TableSelect
                label="Equipment reward table"
                value={room.reward.equipmentRewardTable}
                tables={tables}
                disabled={readOnly}
                onChange={(equipmentRewardTable) =>
                  patch({ reward: { ...room.reward!, equipmentRewardTable } })
                }
              />
              <RangeFields
                label="Currency"
                value={room.reward.currency}
                disabled={readOnly}
                onChange={(currency) => patch({ reward: { ...room.reward!, currency } })}
              />
            </div>
          )}
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                patch({
                  reward:
                    room.reward === null
                      ? {
                          rewardTable: null,
                          equipmentRewardTable: null,
                          currency: { min: 0, max: 0 },
                        }
                      : null,
                })
              }
            >
              {room.reward === null ? 'Set a reward for this room' : 'Use dungeon default'}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-3" data-testid="room-scene">
        <p className="text-xs font-medium text-ink-muted">Scene</p>
        <AssetField
          label="Room background"
          testId="room-background"
          category="dungeon_background"
          value={room.backgroundAssetId}
          fallback={
            room.backgroundArtworkPath
              ? 'this room’s shipped background'
              : 'the dungeon’s default background'
          }
          disabled={readOnly}
          onChange={(backgroundAssetId) => patch({ backgroundAssetId })}
        />
        {fight &&
          (scene === null ? (
            <div className="text-xs text-ink-muted" data-testid="room-scene-defaults">
              <p>Enemy artwork: Use enemy default</p>
              <p>Placement: Use enemy default</p>
            </div>
          ) : (
            <div className="space-y-3" data-testid="room-scene-override">
              <AssetField
                label="Enemy sprite"
                testId="room-sprite"
                category="enemy_sprite"
                value={scene.spriteAssetId}
                fallback="the enemy’s own sprite"
                disabled={readOnly}
                onChange={(spriteAssetId) => setScene({ spriteAssetId })}
              />
              <AssetField
                label="Enemy full art"
                testId="room-full-art"
                category="enemy_art"
                value={scene.artworkAssetId}
                fallback="the enemy’s own full art"
                disabled={readOnly}
                onChange={(artworkAssetId) => setScene({ artworkAssetId })}
              />
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  aria-label="Custom sprite placement"
                  checked={scene.spritePlacement !== null}
                  disabled={readOnly}
                  onChange={(e) =>
                    setScene({ spritePlacement: e.target.checked ? enemyPlacement : null })
                  }
                />
                Place the sprite differently in this room
              </label>
              {scene.spritePlacement !== null ? (
                <PlacementControls
                  value={scene.spritePlacement}
                  disabled={readOnly}
                  onChange={(spritePlacement) => setScene({ spritePlacement })}
                />
              ) : (
                <p className="text-xs text-ink-muted">Placement: Use enemy default</p>
              )}
            </div>
          ))}
        <div className="flex flex-wrap gap-2">
          {fight && !readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                patch({
                  scene:
                    scene === null
                      ? { spriteAssetId: null, artworkAssetId: null, spritePlacement: null }
                      : null,
                })
              }
            >
              {scene === null ? 'Override scene' : 'Use enemy defaults'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={previewing}
            onClick={() => setPreviewing(!previewing)}
          >
            {previewing ? 'Hide preview' : 'Preview Scene'}
          </Button>
        </div>
        {previewing && (
          <ScenePreview
            testId="room-scene-preview"
            background={roomBackground(room, zone)}
            sprite={sprite}
            placement={scene?.spritePlacement ?? enemyPlacement}
          />
        )}
        {previewing && fight && !sprite?.assetId && !sprite?.artworkPath && (
          <p className="text-xs text-ink-subtle" data-testid="room-scene-no-sprite">
            This enemy has no sprite, so the fight shows its full artwork instead of a composed
            scene.
          </p>
        )}
      </div>

      <Advanced
        title="Connections & notes"
        testId="room-connections"
        hint="Add next room and Add branch set these for you. Change them here to make paths rejoin somewhere else."
        open={dangling.length > 0}
      >
        {room.type === 'boss' ? (
          <p className="text-xs text-ink-muted">A Boss is the final room: it leads nowhere.</p>
        ) : (
          <fieldset className="text-xs text-ink-muted">
            <legend>Leads to (up to {DUNGEON_MAX_ROOM_EXITS})</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {candidates.map((other) => {
                const linked = room.next.includes(other.id);
                return (
                  <label key={other.id} className="flex items-center gap-1 text-sm text-ink">
                    <input
                      type="checkbox"
                      aria-label={`${title} leads to ${roomTitle(other)}`}
                      checked={linked}
                      disabled={readOnly || (!linked && room.next.length >= DUNGEON_MAX_ROOM_EXITS)}
                      onChange={(e) =>
                        patch({
                          next: e.target.checked
                            ? [...room.next, other.id]
                            : room.next.filter((id) => id !== other.id),
                        })
                      }
                    />
                    {roomTitle(other)}
                  </label>
                );
              })}
              {candidates.length === 0 && <span>No other room can follow this one.</span>}
            </div>
            {dangling.length > 0 && !readOnly && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => patch({ next: room.next.filter((id) => !dangling.includes(id)) })}
              >
                Remove {dangling.length === 1 ? 'the link' : 'links'} to deleted rooms
              </Button>
            )}
          </fieldset>
        )}
        {room.id !== layout.startRoomId && !readOnly && (
          <Button type="button" size="sm" variant="ghost" onClick={onMakeStart}>
            Make this the start room
          </Button>
        )}
        <label className="block text-xs text-ink-muted">
          Notes (never shown to players)
          <textarea
            aria-label="Room notes"
            className="mt-1 block min-h-16 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
            value={room.notes}
            disabled={readOnly}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </label>
        <p className="text-xs text-ink-subtle">
          Room id <span className="font-mono">{room.id}</span>
        </p>
      </Advanced>
    </div>
  );
}
