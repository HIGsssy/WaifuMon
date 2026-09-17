/**
 * Result Presentation artwork previews, bound to the presentation admin
 * routes (gated on `presentations.read` — not on any encounter permission).
 *
 *   - {@link PresentationArtwork} — a variant's custom artwork, by authored path;
 *   - {@link PreviewWaifumonArtwork} — a Waifumon's release-screen artwork, by
 *     species slug, for the "Encountered Waifumon" preview.
 *
 * Both are {@link AuthoredArtwork}: bytes through the API, never a URL built
 * from a path.
 */
import {
  resultPresentationArtworkBlob,
  resultPresentationSpeciesArtworkBlob,
} from '@/api/adminResultPresentations';

import { AuthoredArtwork } from './AuthoredArtwork';

export function PresentationArtwork({
  path,
  className,
}: {
  path: string | null;
  className?: string;
}) {
  return (
    <AuthoredArtwork
      source={path}
      load={(p) => resultPresentationArtworkBlob(p)}
      {...(className ? { className } : {})}
      testIdPrefix="presentation-artwork"
      emptyLabel="No artwork path yet."
      missingLabel={(p) => (
        <>
          No image at <code>{p}</code> — players will see this result without artwork until the file
          exists.
        </>
      )}
      alt={(p) => `Custom artwork at ${p}`}
    />
  );
}

export function PreviewWaifumonArtwork({
  slug,
  name,
  className,
}: {
  slug: string | null;
  name: string | null;
  className?: string;
}) {
  return (
    <AuthoredArtwork
      source={slug}
      load={(s) => resultPresentationSpeciesArtworkBlob(s)}
      {...(className ? { className } : {})}
      testIdPrefix="preview-waifumon-artwork"
      emptyLabel="Pick a preview Waifumon to see her artwork."
      missingLabel={() => `${name ?? 'This Waifumon'} has no artwork available.`}
      alt={() => `${name ?? 'Waifumon'} artwork (preview)`}
    />
  );
}
