import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  listSceneSprites,
  SCENE_SPRITES_QUERY_KEY,
  type SceneSpriteInstance,
  type SceneSpriteSummary,
  type SceneSpriteVisual,
} from '@/api/adminDungeonSceneSprites';
import { previewDungeonScene, type DungeonArtworkRef } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { PlacementControls } from '@/features/adminArtwork/ScenePreview';
import { LoadedArtwork } from '@/components/media/LoadedArtwork';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

const selectClass = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm';
export function instanceVisual(
  sprite: SceneSpriteVisual,
  instance: SceneSpriteInstance,
): SceneSpriteVisual {
  return {
    assetId: sprite.assetId,
    placement: { ...sprite.placement, ...instance.placement },
    mirror: instance.mirror ?? sprite.mirror,
    visualLayer: instance.visualLayer ?? sprite.visualLayer,
  };
}
/** Every newly placed instance owns a copy of the chosen defaults. */
export function newSceneSpriteInstance(sprite: SceneSpriteSummary): SceneSpriteInstance {
  return {
    id: `sprite_${crypto.randomUUID().replaceAll('-', '')}`,
    spriteKey: sprite.key,
    placement: { ...sprite.placement },
    mirror: sprite.mirror,
    visualLayer: sprite.visualLayer,
  };
}
export function SceneSpritesEditor({
  value = [],
  roomSprites = [],
  backgrounds,
  enemyKey,
  disabled,
  onChange,
  scope,
}: {
  value?: SceneSpriteInstance[] | undefined;
  roomSprites?: SceneSpriteInstance[] | undefined;
  backgrounds: Array<DungeonArtworkRef | null | undefined>;
  enemyKey?: string | undefined;
  disabled: boolean;
  onChange: (value: SceneSpriteInstance[] | undefined) => void;
  scope: 'room' | 'activity';
}) {
  const catalogue = useQuery({
    queryKey: SCENE_SPRITES_QUERY_KEY,
    queryFn: listSceneSprites,
    staleTime: 30_000,
  });
  const [selected, setSelected] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [loading, setLoading] = useState(false);
  const sprites = catalogue.data?.sprites ?? [];
  const source = useDebouncedValue(
    JSON.stringify({
      ...(enemyKey ? { enemyKey } : {}),
      backgrounds: backgrounds.map((b) => b ?? null),
      roomSprites: scope === 'room' ? value : roomSprites,
      activitySprites: scope === 'activity' ? value : [],
    }),
    300,
  );
  useEffect(() => {
    const request = JSON.parse(source);
    if (!request.roomSprites.length && !request.activitySprites.length) {
      setUrl(null);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setLoading(true);
    setPreviewError(false);
    setUrl(null);
    void previewDungeonScene(request, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(result.image);
        setUrl(objectUrl);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setPreviewError(true);
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, catalogue.dataUpdatedAt]);
  const change = (next: SceneSpriteInstance[]) => onChange(next.length ? next : undefined);
  const patch = (id: string, next: Partial<SceneSpriteInstance>) =>
    change(value.map((v) => (v.id === id ? { ...v, ...next } : v)));
  return (
    <section
      className="min-w-0 space-y-3 rounded border border-border p-3"
      aria-label={`${scope === 'room' ? 'Room' : 'Activity'} Scene Sprites`}
    >
      <h3 className="text-sm font-semibold">Scene Sprites</h3>
      <p className="text-xs text-ink-muted">
        {scope === 'room'
          ? 'Shown throughout this room. Each activity can add its own sprites too.'
          : 'Shown during this activity, together with the room’s sprites.'}{' '}
        Up to five placements here.
      </p>
      {catalogue.isError && (
        <p role="alert" className="text-xs text-danger">
          Could not load the sprite catalogue.{' '}
          <button className="underline" onClick={() => void catalogue.refetch()}>
            Retry
          </button>
        </p>
      )}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <select
            aria-label={`Add ${scope} scene sprite`}
            className={`${selectClass} min-w-0 flex-1`}
            value={selected}
            disabled={value.length >= 5 || catalogue.isLoading}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a managed sprite…</option>
            {sprites
              .filter((s) => !s.archived)
              .map((s) => (
                <option value={s.key} key={s.key}>
                  {s.name}
                  {s.category ? ` · ${s.category}` : ''}
                </option>
              ))}
          </select>
          <Button
            type="button"
            size="sm"
            disabled={!selected || value.length >= 5}
            onClick={() => {
              const sprite = sprites.find((s) => s.key === selected && !s.archived);
              if (sprite) change([...value, newSceneSpriteInstance(sprite)]);
            }}
          >
            Add sprite
          </Button>
        </div>
      )}
      {value.map((instance, index) => {
        const sprite = sprites.find((s) => s.key === instance.spriteKey);
        const visual = sprite ? instanceVisual(sprite, instance) : null;
        return (
          <div
            className="min-w-0 space-y-2 rounded border border-border p-2"
            key={instance.id}
            aria-label={`Scene sprite ${index + 1}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-words text-sm font-medium">
                {sprite?.name ?? instance.spriteKey} · {index + 1}
              </span>
              {!disabled && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove scene sprite ${index + 1}`}
                  onClick={() => change(value.filter((v) => v.id !== instance.id))}
                >
                  Remove
                </Button>
              )}
            </div>
            {(!sprite || sprite.archived) && (
              <p role="alert" className="text-xs text-danger">
                {sprite?.archived
                  ? 'This sprite is archived. Restore it in the catalogue or remove this placement.'
                  : 'This sprite could not be found. Remove it and select another.'}
              </p>
            )}
            {visual && (
              <>
                <PlacementControls
                  value={visual.placement}
                  disabled={disabled}
                  onChange={(placement) => patch(instance.id, { placement })}
                />
                <div className="flex flex-wrap gap-1" aria-label="Move sprite">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`Move sprite ${index + 1} left`}
                    onClick={() =>
                      patch(instance.id, {
                        placement: {
                          ...visual.placement,
                          offsetX: Math.max(-600, visual.placement.offsetX - 20),
                        },
                      })
                    }
                  >
                    ←
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`Move sprite ${index + 1} right`}
                    onClick={() =>
                      patch(instance.id, {
                        placement: {
                          ...visual.placement,
                          offsetX: Math.min(600, visual.placement.offsetX + 20),
                        },
                      })
                    }
                  >
                    →
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`Move sprite ${index + 1} up`}
                    onClick={() =>
                      patch(instance.id, {
                        placement: {
                          ...visual.placement,
                          offsetY: Math.max(-337, visual.placement.offsetY - 20),
                        },
                      })
                    }
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`Move sprite ${index + 1} down`}
                    onClick={() =>
                      patch(instance.id, {
                        placement: {
                          ...visual.placement,
                          offsetY: Math.min(337, visual.placement.offsetY + 20),
                        },
                      })
                    }
                  >
                    ↓
                  </Button>
                </div>
                <label className="flex gap-2 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`Mirror scene sprite ${index + 1}`}
                    disabled={disabled}
                    checked={visual.mirror}
                    onChange={(e) => patch(instance.id, { mirror: e.target.checked })}
                  />
                  Mirror horizontally
                </label>
                <select
                  className={selectClass}
                  aria-label={`Layer for scene sprite ${index + 1}`}
                  disabled={disabled}
                  value={visual.visualLayer}
                  onChange={(e) =>
                    patch(instance.id, {
                      visualLayer: e.target.value as NonNullable<
                        SceneSpriteInstance['visualLayer']
                      >,
                    })
                  }
                >
                  <option value="background">Behind Buddy and enemies</option>
                  <option value="foreground">In front of Buddy and enemies</option>
                </select>
              </>
            )}
          </div>
        );
      })}
      {(value.length > 0 || roomSprites.length > 0) && (
        <div className="space-y-1">
          <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded border border-border bg-surface-sunken">
            {url ? (
              <LoadedArtwork url={url} alt={`${scope} scene sprite preview`} />
            ) : (
              <p className="px-2 text-center text-xs text-ink-muted">
                {loading
                  ? 'Preparing scene…'
                  : previewError
                    ? 'The preview is unavailable. Your placements are kept.'
                    : 'Preparing scene…'}
              </p>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            Server preview at 1200×675; scale preserves proportions. Use the position presets and
            arrows to move a sprite, or adjust its offsets.
          </p>
        </div>
      )}
      <Link
        className="text-xs underline"
        to="/admin/dungeons/scene-sprites"
        target="_blank"
        rel="noreferrer"
      >
        Manage Dungeon Scene Sprites
      </Link>
    </section>
  );
}
