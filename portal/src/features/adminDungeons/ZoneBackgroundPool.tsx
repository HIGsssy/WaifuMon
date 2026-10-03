/**
 * A zone's background pool, and the scene preview that goes with it.
 *
 * Each background is one image — uploaded (a managed asset) or shipped in Git
 * (a path under `assets/`) — with a weight and an optional depth range. When
 * a run is generated, every node draws one by weight from the backgrounds
 * that cover its depth; the choice is stored on the run and never re-rolled.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  ENEMY_ARTWORK_QUERY_KEY,
  listEnemyArtwork,
  type ArtworkLayerRef,
} from '@/api/adminArtworkAssets';
import {
  dungeonArtworkBlob,
  type DungeonBackgroundDoc,
  type DungeonZoneDoc,
  type DungeonZoneIssue,
} from '@/api/adminDungeons';
import { ArtworkPickerDialog } from '@/components/admin/ArtworkPicker';
import { dungeonArtworkSource } from '@/components/admin/artworkSources';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AssetField } from '@/features/adminArtwork/AssetField';
import { AssetPickerDialog } from '@/features/adminArtwork/AssetPickerDialog';
import { ScenePreview } from '@/features/adminArtwork/ScenePreview';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import { issuesAt, newBackground } from './dungeonModel';

function Num({
  label,
  value,
  min,
  disabled,
  onChange,
  blank,
}: {
  label: string;
  value: number | null;
  min: number;
  disabled: boolean;
  /** Empty is allowed and means "no limit". */
  blank?: boolean;
  onChange: (next: number | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <Input
        type="number"
        min={min}
        aria-label={label}
        className="w-24"
        placeholder={blank ? 'no limit' : undefined}
        value={text ?? value ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === '') {
            if (blank) onChange(null);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.trunc(n)));
        }}
        onBlur={() => setText(null)}
      />
    </label>
  );
}

export function ZoneBackgroundPool({
  backgrounds,
  issues,
  readOnly,
  onChange,
}: {
  backgrounds: DungeonBackgroundDoc[];
  issues: DungeonZoneIssue[];
  readOnly: boolean;
  onChange: (next: DungeonBackgroundDoc[]) => void;
}) {
  const [assetPicker, setAssetPicker] = useState(false);
  const [pathPicker, setPathPicker] = useState(false);
  const update = (i: number, patch: Partial<DungeonBackgroundDoc>) =>
    onChange(backgrounds.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <div className="space-y-3" data-testid="background-pool">
      {backgrounds.length === 0 && (
        <p className="text-xs text-ink-muted" data-testid="background-pool-empty">
          No backgrounds — every node uses the zone background.
        </p>
      )}
      <ul className="space-y-3">
        {backgrounds.map((bg, i) => {
          const n = `Background ${i + 1}`;
          return (
            <li
              key={bg.id}
              className="space-y-2 rounded-md border border-border p-3"
              data-testid={`background-${bg.id}`}
            >
              <div className="flex flex-wrap items-end gap-3">
                <span className="pb-2 font-mono text-xs text-ink-muted">{bg.id}</span>
                <Num
                  label={`${n} weight`}
                  value={bg.weight}
                  min={0}
                  disabled={readOnly}
                  onChange={(w) => update(i, { weight: w ?? 0 })}
                />
                <Num
                  label={`${n} from depth`}
                  value={bg.minDepth}
                  min={1}
                  disabled={readOnly}
                  onChange={(d) => update(i, { minDepth: d ?? 1 })}
                />
                <Num
                  label={`${n} to depth`}
                  value={bg.maxDepth}
                  min={1}
                  blank
                  disabled={readOnly}
                  onChange={(maxDepth) => update(i, { maxDepth })}
                />
                <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    aria-label={`${n} enabled`}
                    checked={bg.enabled}
                    disabled={readOnly}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                {!readOnly && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${n.toLowerCase()}`}
                    onClick={() => onChange(backgrounds.filter((_, j) => j !== i))}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {bg.assetId !== null ? (
                <AssetField
                  label={`${n} image`}
                  testId={`background-${bg.id}-asset`}
                  category="dungeon_background"
                  value={bg.assetId}
                  fallback="nothing, so remove this background or choose an image"
                  // A pool entry names exactly one image, so it is swapped, not cleared.
                  disabled
                  onChange={() => {}}
                />
              ) : (
                <div className="space-y-1">
                  <p className="text-xs text-ink-muted">
                    Shipped file <span className="font-mono">{bg.artworkPath}</span>
                  </p>
                  <AuthoredArtwork
                    source={bg.artworkPath}
                    load={dungeonArtworkBlob}
                    testIdPrefix={`background-${bg.id}-preview`}
                    emptyLabel=""
                    missingLabel={(path) =>
                      `No file at ${path} yet — nodes that draw it use the zone background.`
                    }
                    alt={(path) => `${n}: ${path}`}
                  />
                </div>
              )}
              <ul className="space-y-0.5 text-xs">
                {issuesAt(issues, `backgrounds[${i}]`).map((issue) => (
                  <li
                    key={issue.path + issue.message}
                    className={issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}
                  >
                    {issue.severity === 'error' ? '' : '⚠ '}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setAssetPicker(true)}>
            Add uploaded background…
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setPathPicker(true)}>
            Add shipped background…
          </Button>
        </div>
      )}
      <AssetPickerDialog
        open={assetPicker}
        title="Add a background"
        category="dungeon_background"
        selectedId={null}
        onClose={() => setAssetPicker(false)}
        onSelect={(asset) =>
          onChange([
            ...backgrounds,
            newBackground({ assetId: asset.id, name: asset.name }, backgrounds),
          ])
        }
      />
      <ArtworkPickerDialog
        open={pathPicker}
        onClose={() => setPathPicker(false)}
        source={dungeonArtworkSource}
        selectedPath={null}
        onSelect={(path) =>
          onChange([...backgrounds, newBackground({ artworkPath: path }, backgrounds)])
        }
        title="Add a shipped background"
      />
    </div>
  );
}

const ZONE_BACKGROUND = '__zone__';

/**
 * Preview one of the zone's backgrounds with one of its enemies' sprites,
 * through the production compositor.
 */
export function ZoneScenePreview({ zone }: { zone: DungeonZoneDoc }) {
  const enemies =
    useQuery({
      queryKey: ENEMY_ARTWORK_QUERY_KEY,
      queryFn: ({ signal }) => listEnemyArtwork(signal),
      staleTime: 30_000,
    }).data?.enemies ?? [];
  const pool = zone.backgrounds ?? [];
  const inZone = new Set(
    (['combat', 'elite', 'miniboss', 'boss'] as const).flatMap((p) =>
      zone.pools[p].map((e) => e.enemyKey),
    ),
  );
  const withSprite = enemies.filter(
    (e) =>
      inZone.has(e.key) && (e.visual.spriteAssetId !== null || e.visual.spriteArtworkPath !== null),
  );
  const [backgroundId, setBackgroundId] = useState<string>(pool[0]?.id ?? ZONE_BACKGROUND);
  const [enemyKey, setEnemyKey] = useState<string>('');

  const entry = pool.find((b) => b.id === backgroundId);
  const background: ArtworkLayerRef | null = entry
    ? { assetId: entry.assetId, artworkPath: entry.artworkPath }
    : zone.backgroundAssetId || zone.backgroundArtworkPath
      ? { assetId: zone.backgroundAssetId ?? null, artworkPath: zone.backgroundArtworkPath }
      : null;
  const enemy = withSprite.find((e) => e.key === enemyKey) ?? null;

  return (
    <div className="space-y-3" data-testid="zone-scene-preview">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Background
          <select
            aria-label="Preview background"
            className={selectClass}
            value={entry ? entry.id : ZONE_BACKGROUND}
            onChange={(e) => setBackgroundId(e.target.value)}
          >
            <option value={ZONE_BACKGROUND}>Zone background</option>
            {pool.map((b) => (
              <option key={b.id} value={b.id}>
                {b.id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Enemy sprite
          <select
            aria-label="Preview enemy sprite"
            className={selectClass}
            value={enemy?.key ?? ''}
            onChange={(e) => setEnemyKey(e.target.value)}
          >
            <option value="">None — background only</option>
            {withSprite.map((e) => (
              <option key={e.key} value={e.key}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {withSprite.length === 0 && (
        <p className="text-xs text-ink-subtle" data-testid="zone-scene-no-sprites">
          No enemy in this zone’s pools has a sprite yet — fights show the enemy’s full artwork. Add
          sprites under Enemy Artwork.
        </p>
      )}
      <ScenePreview
        testId="zone-scene"
        background={background}
        sprite={
          enemy
            ? { assetId: enemy.visual.spriteAssetId, artworkPath: enemy.visual.spriteArtworkPath }
            : null
        }
        {...(enemy ? { placement: enemy.visual.spritePlacement } : {})}
      />
    </div>
  );
}
