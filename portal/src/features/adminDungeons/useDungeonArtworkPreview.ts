import { useEffect, useState } from 'react';
import {
  dungeonArtworkBlob,
  dungeonArtworkSource,
  managedDungeonArtworkBlob,
  type DungeonArtworkRef,
} from '@/api/adminDungeons';

export type DungeonArtworkPreview =
  { state: 'none' | 'loading' | 'missing' } | { state: 'shown'; url: string };

/** The picture a reference resolves to on this server, fetched the way a run finds it. */
export function usePreview(ref: DungeonArtworkRef | null | undefined): DungeonArtworkPreview {
  const source = dungeonArtworkSource(ref);
  const [preview, setPreview] = useState<DungeonArtworkPreview>({
    state: source ? 'loading' : 'none',
  });
  useEffect(() => {
    if (!source) {
      setPreview({ state: 'none' });
      return;
    }
    setPreview({ state: 'loading' });
    let url: string | null = null;
    let cancelled = false;
    // Fetched the way a run finds it: a shipped file by path, an upload by its content.
    void (
      ref?.kind === 'shipped'
        ? dungeonArtworkBlob(ref.path)
        : managedDungeonArtworkBlob(ref!.category, ref!.contentHash)
    )
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreview({ state: 'shown', url });
      })
      .catch(() => {
        if (!cancelled) setPreview({ state: 'missing' });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // `source` is the reference's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  return preview;
}
