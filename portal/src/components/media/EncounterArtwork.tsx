/**
 * Preview for a World Encounter's authored artwork path.
 *
 * A thin binding of {@link AuthoredArtwork} to the encounter admin artwork
 * route (gated on `encounters.read`). See that component for why editors load
 * bytes through the API instead of building a URL from a stored path, and for
 * the empty / missing / resolved states.
 */
import { adminEncounterArtworkBlob } from '@/api/adminEncounters';

import { AuthoredArtwork } from './AuthoredArtwork';

export interface EncounterArtworkProps {
  path: string | null;
  /** Rendered height. The image letterboxes into it rather than stretching. */
  className?: string;
}

export function EncounterArtwork({ path, className }: EncounterArtworkProps) {
  return (
    <AuthoredArtwork
      source={path}
      load={(p) => adminEncounterArtworkBlob(p)}
      {...(className ? { className } : {})}
      testIdPrefix="encounter-artwork"
      emptyLabel="No artwork — the encounter renders text-only."
      missingLabel={(p) => (
        <>
          No file at <code>{p}</code> — check the path, or leave it empty.
        </>
      )}
      alt={(p) => `Artwork at ${p}`}
    />
  );
}
