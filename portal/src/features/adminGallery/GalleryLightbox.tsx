/**
 * Full-size QA preview for one appearance, with previous/next across every
 * authored appearance of the species — missing ones included, shown as their
 * QA placeholder rather than skipped.
 *
 * Radix supplies the focus trap, Escape and the scroll lock. The image is the
 * 1024 rendition through the secure admin route; the original file is only
 * ever requested through the explicit "Open original" link.
 */
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import type { GalleryAppearance } from '@/api/adminGallery';
import { AdminGalleryArtwork } from '@/components/media/AdminGalleryArtwork';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { adminGalleryArtworkUrl } from '@/images/providers/adminGalleryApi';

/** The largest rendition. */
export const LIGHTBOX_DISPLAY_WIDTH = 1024;

export interface GalleryLightboxProps {
  speciesName: string;
  speciesSlug: string;
  appearances: readonly GalleryAppearance[];
  /** The open appearance's index, or `null` when closed. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
}

export function GalleryLightbox({
  speciesName,
  speciesSlug,
  appearances,
  index,
  onIndexChange,
}: GalleryLightboxProps) {
  const current = index === null ? undefined : appearances[index];
  const count = appearances.length;
  const step = (delta: number) => {
    if (index === null || count === 0) return;
    onIndexChange((index + delta + count) % count);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    }
  };
  const original =
    current && current.artwork.status === 'available'
      ? adminGalleryArtworkUrl(speciesSlug, current.id, null)
      : null;

  return (
    <Dialog open={current !== undefined} onOpenChange={(open) => !open && onIndexChange(null)}>
      {current && (
        <DialogContent closeLabel="Close preview" onKeyDown={onKeyDown}>
          <div className="flex max-h-full w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl">
            <div className="min-w-0 pr-10">
              <DialogTitle className="font-display text-lg text-ink">
                {speciesName} — {current.name}
              </DialogTitle>
              <DialogDescription className="font-mono text-xs text-ink-subtle">
                {current.id} · {(index ?? 0) + 1} of {count}
              </DialogDescription>
            </div>

            <div className="mx-auto w-full max-w-[min(100%,calc(62vh*0.75))]">
              <AdminGalleryArtwork
                key={current.id}
                slug={speciesSlug}
                appearanceId={current.id}
                status={current.artwork.status}
                label={`${speciesName} — ${current.name}`}
                displayWidth={LIGHTBOX_DISPLAY_WIDTH}
                fit="contain"
                priority
                className="rounded-lg"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => step(-1)} disabled={count < 2}>
                  <ChevronLeft aria-hidden="true" />
                  Previous
                </Button>
                <Button variant="outline" size="sm" onClick={() => step(1)} disabled={count < 2}>
                  Next
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
              {original && (
                <Button variant="ghost" size="sm" asChild>
                  <a href={original} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Open original
                  </a>
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
