/**
 * Renders a server-built Result Presentation preview as a Discord-like card.
 *
 * Everything shown comes from the preview endpoint, which lays the screen out
 * with the same model the Discord bot uses — nothing here re-derives titles,
 * mechanical wording or fallback rules. Gameplay values are the server's
 * sample fixture and are marked as such. No controls: a preview does nothing.
 */
import { Badge } from '@/components/ui/badge';
import {
  PresentationArtwork,
  PreviewWaifumonArtwork,
} from '@/components/media/PresentationArtwork';
import type { ResultPresentationPreview } from '@/api/adminResultPresentations';

const PREVIEW_ART_FRAME =
  'mt-3 flex h-48 w-full items-center justify-center overflow-hidden rounded-md bg-surface-sunken';

function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function ResultPresentationPreviewCard({ preview }: { preview: ResultPresentationPreview }) {
  const { screen, artwork } = preview;
  return (
    <div className="space-y-3" data-testid="presentation-preview">
      <p
        className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-ink-muted"
        data-testid="preview-sample-notice"
      >
        <strong className="text-ink">Preview.</strong> {preview.sampleNotice}
      </p>

      <div
        className="rounded-md border border-border border-l-4 bg-surface-raised p-4"
        style={{ borderLeftColor: hexColor(screen.color) }}
      >
        <p className="font-semibold text-ink" data-testid="preview-title">
          {screen.title}
        </p>
        <div className="mt-2 space-y-3 text-sm">
          {screen.sections.map((section, index) =>
            section.sample ? (
              <div
                key={index}
                className="rounded border border-dashed border-border-strong px-2 py-1 text-ink-muted"
                data-testid="preview-sample-section"
              >
                <Badge variant="outline" className="mr-2">
                  Sample
                </Badge>
                <span className="whitespace-pre-line">{section.text}</span>
              </div>
            ) : (
              <p key={index} className="whitespace-pre-line text-ink" data-testid="preview-flavor">
                {section.text}
              </p>
            ),
          )}
        </div>

        {artwork.mode === 'custom' && (
          <>
            <PresentationArtwork path={artwork.path} className={PREVIEW_ART_FRAME} />
            {artwork.status !== 'available' && (
              <p className="mt-1 text-xs text-danger" data-testid="preview-artwork-warning">
                This image cannot be shown to players yet — they will see this result without
                artwork.
              </p>
            )}
          </>
        )}
        {artwork.mode === 'encountered' && (
          <>
            <PreviewWaifumonArtwork
              slug={artwork.species?.slug ?? null}
              name={artwork.species?.name ?? null}
              className={PREVIEW_ART_FRAME}
            />
            <p className="mt-1 text-xs text-ink-muted" data-testid="preview-encountered-note">
              Players see the artwork of whichever Waifumon they released
              {artwork.species ? ` — previewing ${artwork.species.name}` : ''}.
            </p>
          </>
        )}

        {screen.footer && (
          <p className="mt-3 text-xs text-ink-muted" data-testid="preview-footer">
            <Badge variant="outline" className="mr-2">
              Sample
            </Badge>
            {screen.footer}
          </p>
        )}
      </div>

      {preview.flavorNote && (
        <p className="text-xs text-ink-muted" data-testid="preview-flavor-note">
          {preview.flavorNote}
        </p>
      )}
    </div>
  );
}
