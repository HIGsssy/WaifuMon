/**
 * Admin Waifumon Gallery artwork — `<Artwork>` with QA failure semantics.
 *
 * The player `<Artwork>` degrades a failed image to the silhouette, which is
 * exactly right for a player (it reads as "a Waifumon you haven't met") and
 * exactly wrong for a QA tool, where missing artwork is the finding. This
 * wrapper keeps every other `<Artwork>` guarantee — reserved aspect box, lazy
 * loading, rendition buckets, resolver-generated alt text — and replaces the
 * failure path only:
 *
 *   - the gallery API already says the file is `missing` or `unsafe` → the QA
 *     placeholder is rendered straight away, and no request is made;
 *   - the browser fails to load a file the API called available → the same
 *     placeholder, via `<Artwork>`'s `onLoadFailure` notification.
 *
 * Player `<Artwork>` is untouched: this composes it rather than changing it.
 */
import { ImageOff, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import type { GalleryArtworkStatus } from '@/api/adminGallery';
import { cn } from '@/lib/cn';

import { Artwork } from './Artwork';

export interface AdminGalleryArtworkProps {
  slug: string;
  appearanceId: string;
  /** What the gallery API reported for this exact appearance's file. */
  status: GalleryArtworkStatus;
  /** Alt text subject, e.g. "Alley Catgirl — Level 20". */
  label: string;
  /** Width drawn at, in CSS pixels — picks the rendition bucket. */
  displayWidth: number;
  aspect?: string;
  fit?: 'cover' | 'contain';
  priority?: boolean;
  className?: string;
}

export type AdminArtworkProblem = 'missing' | 'unsafe' | 'failed';

export function AdminGalleryArtwork({
  slug,
  appearanceId,
  status,
  label,
  displayWidth,
  aspect = 'aspect-[3/4]',
  fit = 'cover',
  priority = false,
  className,
}: AdminGalleryArtworkProps) {
  // Which identity failed, not "has something failed" — a card re-used for a
  // different appearance does not inherit the previous one's failure.
  const identity = `${slug}/${appearanceId}/${displayWidth}`;
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);

  const problem: AdminArtworkProblem | null =
    status === 'missing'
      ? 'missing'
      : status === 'unsafe'
        ? 'unsafe'
        : failedIdentity === identity
          ? 'failed'
          : null;

  if (problem) {
    return (
      <ArtworkProblem
        problem={problem}
        appearanceId={appearanceId}
        label={label}
        aspect={aspect}
        {...(className ? { className } : {})}
      />
    );
  }

  return (
    <Artwork
      asset={{ kind: 'waifumon', slug, variant: appearanceId, adminGallery: true }}
      name={label}
      displayWidth={displayWidth}
      aspect={aspect}
      fit={fit}
      priority={priority}
      {...(className ? { className } : {})}
      onLoadFailure={() => setFailedIdentity(identity)}
    />
  );
}

const PROBLEM_TEXT: Record<AdminArtworkProblem, { title: string; detail: string }> = {
  missing: { title: 'Artwork Missing', detail: 'No file exists for this appearance.' },
  unsafe: {
    title: 'Artwork Unavailable',
    detail: 'The file resolves outside the assets folder and is refused.',
  },
  failed: { title: 'Artwork Failed to Load', detail: 'The server did not return this image.' },
};

/**
 * The QA placeholder: same aspect box as real artwork, so a grid stays aligned,
 * and deliberately unlike the player silhouette — striped, iconned and labelled.
 */
export function ArtworkProblem({
  problem,
  appearanceId,
  label,
  aspect = 'aspect-[3/4]',
  className,
}: {
  problem: AdminArtworkProblem;
  appearanceId: string;
  label: string;
  aspect?: string;
  className?: string;
}) {
  const text = PROBLEM_TEXT[problem];
  const Icon = problem === 'unsafe' ? ShieldAlert : ImageOff;
  return (
    <div
      role="img"
      aria-label={`${text.title}: ${label} (${appearanceId})`}
      data-testid={`artwork-problem-${problem}`}
      className={cn(
        'relative flex flex-col items-center justify-center gap-2 overflow-hidden border-2 border-dashed border-danger/50 bg-danger-soft p-3 text-center text-danger',
        'bg-[repeating-linear-gradient(135deg,transparent_0,transparent_10px,rgb(0_0_0/0.04)_10px,rgb(0_0_0/0.04)_20px)]',
        aspect,
        className,
      )}
    >
      <Icon className="size-8 shrink-0" aria-hidden="true" />
      <p className="text-sm font-semibold">{text.title}</p>
      <p className="font-mono text-xs break-all">{appearanceId}</p>
      <p className="text-xs opacity-80">{text.detail}</p>
    </div>
  );
}
