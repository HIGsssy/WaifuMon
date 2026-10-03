/**
 * Enemy artwork: for each combat enemy, its full artwork, its transparent
 * sprite, and where that sprite stands by default in a composed scene.
 *
 * Enemies themselves are authored in Git (`content/combat/enemies.json`) and
 * are not edited here. What this page edits is the uploaded-artwork override
 * on top: each of the three fields is optional, and clearing one falls back
 * to the shipped value.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import {
  DEFAULT_SPRITE_PLACEMENT,
  ENEMY_ARTWORK_QUERY_KEY,
  listEnemyArtwork,
  saveEnemyArtwork,
  type EnemyArtworkEntry,
  type SpritePlacement,
} from '@/api/adminArtworkAssets';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AssetField } from '@/features/adminArtwork/AssetField';
import { PlacementControls, ScenePreview } from '@/features/adminArtwork/ScenePreview';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

interface Draft {
  artworkAssetId: string | null;
  spriteAssetId: string | null;
  /** Null means "use the shipped placement". */
  spritePlacement: SpritePlacement | null;
}

const draftOf = (enemy: EnemyArtworkEntry): Draft => ({
  artworkAssetId: enemy.managed?.artworkAssetId ?? null,
  spriteAssetId: enemy.managed?.spriteAssetId ?? null,
  spritePlacement: enemy.managed?.spritePlacement ?? null,
});
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function EnemyEditor({ enemy, readOnly }: { enemy: EnemyArtworkEntry; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(enemy));
  const [backgroundAssetId, setBackgroundAssetId] = useState<string | null>(null);
  // A save (ours or someone else's) replaces the baseline.
  useEffect(() => setDraft(draftOf(enemy)), [enemy]);

  const shippedPlacement = enemy.shippedPlacement ?? DEFAULT_SPRITE_PLACEMENT;
  const placement = draft.spritePlacement ?? shippedPlacement;
  const dirty = !same(draft, draftOf(enemy));
  const save = useMutation({
    mutationFn: () =>
      saveEnemyArtwork(enemy.key, { ...draft, expectedRevision: enemy.managed?.revision ?? 0 }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ENEMY_ARTWORK_QUERY_KEY }),
  });
  const stale = isPortalApiError(save.error) && save.error.code === 'ENEMY_ARTWORK_STALE';
  const hasSprite = draft.spriteAssetId !== null || enemy.spriteArtworkPath !== null;

  return (
    <div className="space-y-4" data-testid="enemy-artwork-editor">
      <Card className="space-y-3 p-4" data-testid="enemy-full-artwork">
        <div>
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Full Artwork</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Shown for a Delve fight when no scene can be composed. Combat Trials still use the
            shipped file.
          </p>
        </div>
        <AssetField
          label="Full artwork"
          testId="enemy-art-asset"
          category="enemy_art"
          value={draft.artworkAssetId}
          fallback={enemy.artworkPath ? `the shipped file ${enemy.artworkPath}` : 'no full artwork'}
          disabled={readOnly}
          onChange={(artworkAssetId) => setDraft({ ...draft, artworkAssetId })}
        />
      </Card>

      <Card className="space-y-3 p-4" data-testid="enemy-sprite">
        <div>
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Sprite</h2>
          <p className="mt-1 text-xs text-ink-muted">
            A transparent cut-out of the enemy, layered over the dungeon background of the node it
            is fought on. Optional: without one, a fight shows the full artwork.
          </p>
        </div>
        <AssetField
          label="Sprite"
          testId="enemy-sprite-asset"
          category="enemy_sprite"
          value={draft.spriteAssetId}
          fallback={
            enemy.spriteArtworkPath ? `the shipped sprite ${enemy.spriteArtworkPath}` : 'no sprite'
          }
          disabled={readOnly}
          onChange={(spriteAssetId) => setDraft({ ...draft, spriteAssetId })}
        />
      </Card>

      <Card className="space-y-3 p-4" data-testid="enemy-placement">
        <div>
          <h2 className="text-sm font-semibold uppercase text-ink-muted">
            Default Sprite Placement
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Where the sprite stands in every scene. Scale is the sprite’s height as a share of the
            scene’s.
          </p>
        </div>
        <PlacementControls
          value={placement}
          disabled={readOnly}
          onChange={(spritePlacement) => setDraft({ ...draft, spritePlacement })}
        />
        {draft.spritePlacement !== null && !readOnly && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDraft({ ...draft, spritePlacement: null })}
          >
            Use the shipped placement
          </Button>
        )}
        <AssetField
          label="Preview background"
          testId="enemy-preview-background"
          category="dungeon_background"
          value={backgroundAssetId}
          fallback="nothing — choose a background to see the scene. This is only for the preview and is not saved"
          disabled={false}
          onChange={setBackgroundAssetId}
        />
        {hasSprite ? (
          <ScenePreview
            background={backgroundAssetId ? { assetId: backgroundAssetId } : null}
            sprite={{ assetId: draft.spriteAssetId, artworkPath: enemy.spriteArtworkPath }}
            placement={placement}
          />
        ) : (
          <p className="text-xs text-ink-subtle" data-testid="enemy-no-sprite">
            This enemy has no sprite, so there is no scene to preview.
          </p>
        )}
      </Card>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="accent"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save enemy artwork'}
          </Button>
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setDraft(draftOf(enemy))}>
              Discard changes
            </Button>
          )}
          <span className="text-xs text-ink-muted" role="status" data-testid="enemy-artwork-status">
            {save.isSuccess && !dirty
              ? 'Saved. Runs started from now on use it.'
              : dirty
                ? 'Unsaved changes.'
                : ''}
          </span>
        </div>
      )}
      {save.isError && (
        <ErrorState
          variant="inline"
          title={
            stale
              ? 'Someone else saved this enemy’s artwork first — it has been reloaded'
              : 'Could not save'
          }
          error={save.error}
        />
      )}
    </div>
  );
}

export function EnemyArtworkPage() {
  const canWrite = useHasPermission('dungeons.write');
  const query = useQuery({
    queryKey: ENEMY_ARTWORK_QUERY_KEY,
    queryFn: ({ signal }) => listEnemyArtwork(signal),
  });
  const enemies = query.data?.enemies ?? [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = enemies.find((e) => e.key === selectedKey) ?? enemies[0] ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Enemy Artwork"
        description="Full artwork, sprite and sprite placement for each enemy. A run keeps the artwork choices it started with; replacing an image updates it everywhere."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/dungeons">Back to dungeons</Link>
          </Button>
        }
      />
      {query.isError && (
        <ErrorState variant="inline" title="Could not load enemies" error={query.error} />
      )}
      {query.isSuccess && enemies.length === 0 && (
        <Card className="p-4 text-sm text-ink-muted">No enemies are defined on this server.</Card>
      )}
      {selected && (
        <>
          <label className="block text-xs text-ink-muted">
            Enemy
            <select
              aria-label="Enemy"
              className={selectClass}
              value={selected.key}
              onChange={(e) => setSelectedKey(e.target.value)}
            >
              {enemies.map((enemy) => (
                <option key={enemy.key} value={enemy.key}>
                  {enemy.name}
                  {enemy.enabled ? '' : ' (disabled)'}
                  {enemy.visual.spriteAssetId || enemy.visual.spriteArtworkPath
                    ? ' — has sprite'
                    : ''}
                </option>
              ))}
            </select>
          </label>
          <EnemyEditor key={selected.key} enemy={selected} readOnly={!canWrite} />
        </>
      )}
    </div>
  );
}
