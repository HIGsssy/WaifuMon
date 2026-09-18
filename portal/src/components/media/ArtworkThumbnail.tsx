/**
 * A small, lazily-loaded preview of one authored artwork file — the artwork
 * picker's card image.
 *
 * It is {@link AuthoredArtwork} (bytes through the consumer's permission-gated
 * route, shown via an object URL), deferred until the card scrolls near the
 * viewport, so opening a folder requests only the images an author can see.
 * The full-size file is scaled down by the browser; no thumbnail files are
 * generated.
 *
 * A failed load shows a placeholder inside the card and nothing else: one
 * broken file never breaks the grid around it.
 */
import { useEffect, useRef, useState } from 'react';

import { AuthoredArtwork } from './AuthoredArtwork';

export interface ArtworkThumbnailProps {
  path: string;
  load: (path: string) => Promise<Blob>;
  alt: string;
}

const THUMB_FRAME =
  'flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-surface-sunken';

/** True once the element has come within `rootMargin` of the viewport. */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  // Environments without IntersectionObserver (tests, very old browsers)
  // simply load straight away.
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (near || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);

  return [ref, near];
}

export function ArtworkThumbnail({ path, load, alt }: ArtworkThumbnailProps) {
  const [ref, near] = useNearViewport<HTMLDivElement>();

  return (
    <div ref={ref} className="w-full">
      {near ? (
        <AuthoredArtwork
          source={path}
          load={load}
          className={THUMB_FRAME}
          testIdPrefix="artwork-thumbnail"
          emptyLabel=""
          missingLabel={() => 'Preview unavailable'}
          alt={() => alt}
        />
      ) : (
        <div className={THUMB_FRAME} data-testid="artwork-thumbnail-deferred" />
      )}
    </div>
  );
}
