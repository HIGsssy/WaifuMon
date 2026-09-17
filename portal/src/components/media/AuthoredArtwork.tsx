/**
 * Preview for artwork an admin author points at — an authored path (a World
 * Encounter or a Result Presentation) or, for a release preview, a Waifumon
 * by slug.
 *
 * The Portal's image resolver deliberately never turns a stored path into a
 * URL: physical paths are an internal detail. Editors are the screens where
 * the path *is* the subject, so this asks the admin API for the **bytes**,
 * through a caller-supplied, permission-gated loader, and shows them via an
 * object URL. Feature code never builds an image URL itself.
 *
 * Three explicit states, because "no artwork" and "the path is wrong" are
 * different things an author must tell apart:
 *
 *   - **empty**    — no source given;
 *   - **missing**  — the API has no file for it (usually a typo);
 *   - **resolved** — the image.
 *
 * Lives in `components/media/` because it owns the `<img>`; the
 * `no-restricted-syntax` rule scoped to `src/features/**` keeps it that way.
 */
import { useEffect, useState, type ReactNode } from 'react';

export interface AuthoredArtworkProps {
  /** What to load: an authored path, or a species slug. Empty → empty state. */
  source: string | null;
  /** Fetches the bytes. A rejection renders the missing state. */
  load: (source: string) => Promise<Blob>;
  /** Frame classes. The image letterboxes into it rather than stretching. */
  className?: string;
  /** Prefix for `data-testid`s: `<prefix>-empty|loading|missing|image`. */
  testIdPrefix: string;
  emptyLabel: ReactNode;
  missingLabel: (source: string) => ReactNode;
  alt: (source: string) => string;
}

type State =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'resolved'; url: string };

const ARTWORK_FRAME =
  'flex h-40 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface-sunken';

export function AuthoredArtwork({
  source,
  load,
  className,
  testIdPrefix,
  emptyLabel,
  missingLabel,
  alt,
}: AuthoredArtworkProps) {
  const [state, setState] = useState<State>({ kind: 'empty' });
  const trimmed = source?.trim() ?? '';

  useEffect(() => {
    if (!trimmed) {
      setState({ kind: 'empty' });
      return;
    }
    setState({ kind: 'loading' });
    let objectUrl: string | null = null;
    let cancelled = false;

    void load(trimmed)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: 'resolved', url: objectUrl });
      })
      .catch(() => {
        // A 404 is the expected answer for a typo, and every other failure
        // reads the same way to an author: there is no image there.
        if (!cancelled) setState({ kind: 'missing' });
      });

    return () => {
      cancelled = true;
      // Object URLs are retained until revoked; a preview that re-renders on
      // every keystroke would otherwise leak one per character typed.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `load` is expected to be a stable module function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed]);

  const frame = className ?? ARTWORK_FRAME;

  if (state.kind === 'empty') {
    return (
      <div className={frame} data-testid={`${testIdPrefix}-empty`}>
        <span className="text-xs text-ink-muted">{emptyLabel}</span>
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className={frame} data-testid={`${testIdPrefix}-loading`}>
        <span className="text-xs text-ink-muted">Loading preview…</span>
      </div>
    );
  }
  if (state.kind === 'missing') {
    return (
      <div className={frame} data-testid={`${testIdPrefix}-missing`}>
        <span className="text-xs text-ink-muted">{missingLabel(trimmed)}</span>
      </div>
    );
  }
  return (
    <div className={frame}>
      <img
        src={state.url}
        alt={alt(trimmed)}
        data-testid={`${testIdPrefix}-image`}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
