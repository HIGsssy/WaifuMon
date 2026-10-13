import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  listSceneSprites,
  getSceneSprite,
  createSceneSprite,
  updateSceneSprite,
  archiveSceneSprite,
  deleteSceneSprite,
  SCENE_SPRITES_QUERY_KEY,
  SCENE_SPRITE_CATEGORIES,
  type SceneSpriteInput,
  type SceneSpriteDetail,
} from '@/api/adminDungeonSceneSprites';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AssetField } from '@/features/adminArtwork/AssetField';
import { PlacementControls, ScenePreview } from '@/features/adminArtwork/ScenePreview';

const empty = (): SceneSpriteInput => ({
  name: '',
  category: null,
  assetId: '',
  placement: { anchor: 'bottom-center', scaleBasisPoints: 5000, offsetX: 0, offsetY: 0 },
  mirror: false,
  visualLayer: 'background',
});
const selectClass = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm';
export function SceneSpritesPage() {
  const canWrite = useHasPermission('dungeons.write');
  const canPreview = useHasPermission('artwork.read');
  const queryClient = useQueryClient();
  const catalogue = useQuery({
    queryKey: SCENE_SPRITES_QUERY_KEY,
    queryFn: listSceneSprites,
    staleTime: 30_000,
  });
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loaded, setLoaded] = useState<SceneSpriteDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [form, setForm] = useState<SceneSpriteInput>(empty);
  const [background, setBackground] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const set = (patch: Partial<SceneSpriteInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const accept = (sprite: SceneSpriteDetail) => {
    setLoaded(sprite);
    setKey(sprite.key);
    setForm({
      name: sprite.name,
      category: sprite.category,
      assetId: sprite.assetId,
      placement: sprite.placement,
      mirror: sprite.mirror,
      visualLayer: sprite.visualLayer,
    });
    setEditing(true);
    setDirty(false);
  };
  const work = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        isPortalApiError(e)
          ? [
              e.message,
              ...(
                (e.details?.issues as Array<{ path: string; message: string }> | undefined) ?? []
              ).map((i) => `${i.path}: ${i.message}`),
            ].join(' ')
          : 'The sprite could not be saved or loaded.',
      );
    } finally {
      setPending(false);
    }
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: SCENE_SPRITES_QUERY_KEY });
  const mayLeave = () => !dirty || window.confirm('Discard unsaved sprite changes?');
  return (
    <div className="space-y-4">
      <PageHeader
        title="Dungeon Scene Sprites"
        description="Reusable environmental artwork for dungeon rooms and activities."
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
        <section
          className="min-w-0 space-y-3 rounded-lg border border-border p-4"
          aria-label="Scene sprite catalogue"
        >
          <Input
            aria-label="Search scene sprites"
            placeholder="Search by name or identifier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Include archived sprites
          </label>
          {canWrite && (
            <Button
              disabled={pending}
              onClick={() => {
                if (!mayLeave()) return;
                setLoaded(null);
                setForm(empty());
                setKey('');
                setEditing(true);
                setError(null);
                setDirty(false);
              }}
            >
              Create sprite
            </Button>
          )}
          {catalogue.isLoading && <p>Loading sprites…</p>}
          {catalogue.isError && (
            <p role="alert">
              Could not load scene sprites.{' '}
              <button className="underline" onClick={() => void catalogue.refetch()}>
                Retry
              </button>
            </p>
          )}
          <ul className="space-y-1">
            {catalogue.data?.sprites
              .filter(
                (s) =>
                  (showArchived || !s.archived) &&
                  `${s.name} ${s.key} ${s.category ?? ''}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              )
              .map((s) => (
                <li key={s.key}>
                  <button
                    className="w-full break-words rounded border border-border p-2 text-left text-sm"
                    disabled={pending}
                    onClick={() => {
                      if (mayLeave()) void work(async () => accept(await getSceneSprite(s.key)));
                    }}
                  >
                    {s.name} {s.archived && '(archived)'}
                    <span className="block text-xs text-ink-muted">
                      {s.key} · {s.category ?? 'No category'}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
        {editing && (
          <section
            className="min-w-0 space-y-4 rounded-lg border border-border p-4"
            aria-label="Scene sprite editor"
          >
            <label className="block text-sm">
              Unique identifier
              <Input
                aria-label="Sprite identifier"
                disabled={!!loaded || !canWrite || pending}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label className="block text-sm">
              Display name
              <Input
                aria-label="Sprite display name"
                disabled={!canWrite || pending}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              Category
              <select
                className={selectClass}
                aria-label="Sprite category"
                disabled={!canWrite || pending}
                value={form.category ?? ''}
                onChange={(e) =>
                  set({ category: (e.target.value || null) as SceneSpriteInput['category'] })
                }
              >
                <option value="">No category</option>
                {SCENE_SPRITE_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <AssetField
              label="Scene sprite artwork"
              testId="scene-sprite-artwork"
              value={form.assetId || null}
              category="dungeon_scene_sprite"
              fallback="no image; select artwork before saving"
              disabled={!canWrite || pending}
              onChange={(id) => set({ assetId: id ?? '' })}
            />
            <p className="text-xs text-ink-muted">
              Transparent PNG or WebP works best. To replace artwork, upload or select another image
              here. Published dungeons keep their chosen image.
            </p>
            <h2 className="font-semibold">Default placement</h2>
            <PlacementControls
              value={form.placement}
              disabled={!canWrite || pending}
              onChange={(placement) => set({ placement })}
            />
            <label className="flex gap-2 text-sm">
              <input
                aria-label="Mirror sprite"
                type="checkbox"
                disabled={!canWrite || pending}
                checked={form.mirror}
                onChange={(e) => set({ mirror: e.target.checked })}
              />
              Mirror horizontally
            </label>
            <label className="block text-sm">
              Visual layer
              <select
                aria-label="Sprite visual layer"
                className={selectClass}
                disabled={!canWrite || pending}
                value={form.visualLayer}
                onChange={(e) =>
                  set({ visualLayer: e.target.value as SceneSpriteInput['visualLayer'] })
                }
              >
                <option value="background">Behind Buddy and enemies</option>
                <option value="foreground">In front of Buddy and enemies</option>
              </select>
            </label>
            {canPreview && (
              <>
                <AssetField
                  label="Preview background"
                  testId="scene-sprite-preview-background"
                  value={background}
                  category="dungeon_background"
                  fallback="choose a background for preview"
                  disabled={pending}
                  onChange={setBackground}
                />
                <ScenePreview
                  background={background ? { assetId: background } : null}
                  environmentalSprites={
                    form.assetId
                      ? [
                          {
                            ref: { assetId: form.assetId },
                            placement: form.placement,
                            mirror: form.mirror,
                            visualLayer: form.visualLayer,
                          },
                        ]
                      : []
                  }
                />
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending || !key || !form.name.trim() || !form.assetId}
                  onClick={() =>
                    void work(async () => {
                      accept(
                        loaded
                          ? await updateSceneSprite(key, form, loaded.revision)
                          : await createSceneSprite(key, form),
                      );
                      await refresh();
                    })
                  }
                >
                  {pending ? 'Working…' : 'Save sprite'}
                </Button>
                {loaded && (
                  <>
                    <Button
                      disabled={pending || dirty}
                      variant="outline"
                      onClick={() =>
                        void work(async () => {
                          accept(await archiveSceneSprite(key, !loaded.archived, loaded.revision));
                          await refresh();
                        })
                      }
                    >
                      {loaded.archived ? 'Restore sprite' : 'Archive sprite'}
                    </Button>
                    <Button
                      disabled={pending || dirty || loaded.references.length > 0}
                      variant="outline"
                      onClick={() => {
                        if (window.confirm('Delete this unused sprite?'))
                          void work(async () => {
                            await deleteSceneSprite(key, loaded.revision);
                            setEditing(false);
                            setLoaded(null);
                            await refresh();
                          });
                      }}
                    >
                      Delete unused sprite
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        if (mayLeave()) void work(async () => accept(await getSceneSprite(key)));
                      }}
                    >
                      Reload
                    </Button>
                  </>
                )}
              </div>
            )}
            {loaded && (
              <>
                <h2 className="font-semibold">Where it is used</h2>
                <p className="text-xs text-ink-muted">
                  Archiving prevents new publication; existing published dungeons keep this sprite.
                </p>
                <ul className="space-y-1 text-sm">
                  {loaded.references.map((r, i) => (
                    <li key={i}>
                      <Link
                        className="underline"
                        to={`/admin/dungeons/definitions/${encodeURIComponent(r.dungeonKey)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.name}
                      </Link>{' '}
                      · {r.source} · room {r.roomId}
                      {r.actionId ? ` · activity ${r.actionId}` : ''}
                    </li>
                  ))}
                </ul>
                {!loaded.references.length && (
                  <p className="text-sm text-ink-muted">No dungeon references.</p>
                )}
                <details>
                  <summary>History</summary>
                  <ul className="text-xs">
                    {loaded.events.map((e, i) => (
                      <li key={i}>
                        {e.action} · {e.actor ?? 'Admin API'} · {e.createdAt}
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
