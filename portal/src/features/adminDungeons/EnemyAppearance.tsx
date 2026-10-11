/**
 * How one enemy will look in a fight here: whether it has a combat sprite,
 * and the actual scene — background, Buddy and enemy — composed by the same
 * renderer a run uses. The sprite belongs to the enemy and is set once in the
 * Enemy Catalogue; this only shows the result and points there.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  dungeonArtworkSource,
  previewDungeonScene,
  type DungeonArtworkRef,
  type DungeonReferenceData,
} from '@/api/adminDungeons';
import { useHasPermission } from '@/auth/useSession';
import { LoadedArtwork } from '@/components/media/LoadedArtwork';

/** The fallback order a fight uses, named for the caption. */
const BACKGROUND_NAMES = [
  'this room’s background',
  'the dungeon’s scene background',
  'the dungeon artwork',
];

type Preview =
  | { state: 'loading' | 'none' }
  | {
      state: 'shown';
      url: string;
      mode: 'sprite' | 'full-art';
      background: number | 'plain' | null;
    };

export function EnemyAppearance({
  enemyKey,
  wave,
  reference,
  backgrounds,
}: {
  enemyKey: string;
  /** 1-based, for labels. */
  wave: number;
  reference?: DungeonReferenceData | undefined;
  /** Room background, dungeon scene background, dungeon artwork — in that order. */
  backgrounds: Array<DungeonArtworkRef | null | undefined>;
}) {
  const canOpenEnemy = useHasPermission('enemies.read');
  const enemy = reference?.enemies.find((e) => e.key === enemyKey);
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  // Re-rendered only when the enemy or a background reference actually changes.
  const signature = backgrounds.map((b) => dungeonArtworkSource(b) ?? '').join('|');
  useEffect(() => {
    if (!enemy) return;
    const controller = new AbortController();
    let url: string | null = null;
    setPreview({ state: 'loading' });
    void previewDungeonScene(
      { enemyKey, backgrounds: backgrounds.map((b) => b ?? null) },
      controller.signal,
    )
      .then((scene) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(scene.image);
        setPreview({ state: 'shown', url, mode: scene.mode, background: scene.background });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview({ state: 'none' });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
    // `backgrounds` is summarised by `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enemyKey, enemy === undefined, signature]);
  if (!enemy) return null;

  // What the catalogue says is configured, corrected by what actually rendered.
  const fullArt = preview.state === 'shown' ? preview.mode === 'full-art' : enemy.sprite === false;
  const caption =
    preview.state === 'shown'
      ? preview.mode === 'full-art'
        ? `${enemy.name} has no combat sprite, so its full artwork fills the scene on its own, without the background or the player’s Buddy.`
        : preview.background === 'plain' || preview.background === null
          ? 'No background could be found, so the fight uses a plain stage. Choose a scene background in Dungeon settings.'
          : `${enemy.name}’s combat sprite on ${BACKGROUND_NAMES[preview.background] ?? 'the background'}.`
      : preview.state === 'none'
        ? `${enemy.name} has no sprite or artwork that can be shown, so fights show only the background.`
        : 'Preparing the fight preview…';
  return (
    <div className="space-y-1" data-testid={`wave-${wave}-appearance`}>
      <div
        className={`flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border bg-surface-sunken ${fullArt ? 'border-amber-500' : 'border-border'}`}
      >
        {preview.state === 'shown' ? (
          <LoadedArtwork url={preview.url} alt={`Fight preview for wave ${wave}: ${enemy.name}`} />
        ) : (
          <span className="px-3 text-center text-xs text-ink-muted">
            {preview.state === 'loading' ? 'Loading…' : 'No picture'}
          </span>
        )}
      </div>
      <p className="text-xs text-ink-muted">
        {caption}
        {preview.state === 'shown' &&
          !fullArt &&
          ' The Buddy shown is a stand-in for the player’s own.'}
      </p>
      {canOpenEnemy && (
        <p className="text-xs">
          <Link
            className="underline"
            to={`/admin/enemies/${encodeURIComponent(enemyKey)}`}
            // A new tab, so unsaved dungeon edits are not left behind.
            target="_blank"
            rel="noreferrer"
          >
            {fullArt ? `Add a combat sprite for ${enemy.name}` : `Change ${enemy.name}’s sprite`}
          </Link>{' '}
          <span className="text-ink-muted">(opens the Enemy Catalogue)</span>
        </p>
      )}
    </div>
  );
}
