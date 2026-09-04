/**
 * Preview for an encounter's authored artwork path.
 *
 * The Portal's image resolver deliberately never turns a stored `imagePath`
 * into a URL — physical paths are an internal detail that must not reach
 * pages. The encounter editor is the one screen where the path *is* the
 * subject: an author types it and has to see what they typed. So this does not
 * construct a filesystem-derived URL either; it asks the admin API for the
 * bytes, through the same permission-gated client every other admin call uses.
 *
 * Three states, all of them explicit, because "no artwork" and "the path is
 * wrong" are different things an author needs to tell apart:
 *
 *   - **empty**    — no path authored. Encounters render fine without one.
 *   - **missing**  — a path is authored but the API has no file for it,
 *                    which is almost always a typo.
 *   - **resolved** — the image.
 *
 * Lives in `components/media/` beside {@link Artwork} rather than in the
 * feature folder, and for the same reason that one does: this is the component
 * that owns the `<img>`, so feature code names an encounter's artwork and never
 * touches a path-shaped URL itself. The `no-restricted-syntax` rule that
 * enforces that is scoped to `src/features/**`, and nothing here suppresses it.
 *
 * It is a sibling of `<Artwork>` rather than a use of it because the two answer
 * different questions. `<Artwork>` resolves an `AssetId` — a *logical* asset
 * whose URL is derived from a slug, deliberately never from a stored path.
 * An encounter's artwork is an authored path, so teaching the resolver chain to
 * accept one would push the very coupling §12 forbids into every provider.
 */
import { useEffect, useState } from 'react';

import { adminEncounterArtworkBlob } from '@/api/adminEncounters';

export interface EncounterArtworkProps {
  path: string | null;
  /** Rendered height. The image letterboxes into it rather than stretching. */
  className?: string;
}

type State =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'resolved'; url: string };

export function EncounterArtwork({ path, className }: EncounterArtworkProps) {
  const [state, setState] = useState<State>({ kind: 'empty' });

  useEffect(() => {
    const trimmed = path?.trim();
    if (!trimmed) {
      setState({ kind: 'empty' });
      return;
    }
    setState({ kind: 'loading' });
    let objectUrl: string | null = null;
    let cancelled = false;

    void adminEncounterArtworkBlob(trimmed)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: 'resolved', url: objectUrl });
      })
      .catch(() => {
        // A 404 is the expected answer for a typo, and every other failure
        // reads the same way to an author: there is no image at that path.
        if (!cancelled) setState({ kind: 'missing' });
      });

    return () => {
      cancelled = true;
      // Object URLs are retained until revoked; a preview that re-renders on
      // every keystroke would otherwise leak one per character typed.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  const frame =
    className ??
    'flex h-40 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface-sunken';

  if (state.kind === 'empty') {
    return (
      <div className={frame} data-testid="encounter-artwork-empty">
        <span className="text-xs text-ink-muted">No artwork — the encounter renders text-only.</span>
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className={frame} data-testid="encounter-artwork-loading">
        <span className="text-xs text-ink-muted">Loading preview…</span>
      </div>
    );
  }
  if (state.kind === 'missing') {
    return (
      <div className={frame} data-testid="encounter-artwork-missing">
        <span className="text-xs text-ink-muted">
          No file at <code>{path}</code> — check the path, or leave it empty.
        </span>
      </div>
    );
  }
  return (
    <div className={frame}>
      <img
        src={state.url}
        alt={`Artwork at ${path}`}
        data-testid="encounter-artwork-image"
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
