/**
 * One authored appearance on the species QA page: its artwork and everything
 * the gallery API knows about it.
 *
 * The state strip is the point of the card. "Authored / Runtime / Artwork"
 * sit side by side in words, so a look the author wrote but the runtime
 * dropped for missing art reads as exactly that — not just as a missing image.
 * Optional fields render only when authored; nothing is padded with dashes.
 */
import { Check, Maximize2, Star, X } from 'lucide-react';
import type { ReactNode } from 'react';

import type { GalleryAppearance } from '@/api/adminGallery';
import { AdminGalleryArtwork } from '@/components/media/AdminGalleryArtwork';
import { Badge } from '@/components/ui/badge';
import { titleCase } from '@/lib/format';
import { cn } from '@/lib/cn';

import { describeDiagnostic, describeIssue } from './galleryLabels';

/** Drawn at up to ~384 CSS px wide → the 512 bucket on a 1× display. */
export const APPEARANCE_DISPLAY_WIDTH = 512;

export interface AppearanceQaCardProps {
  appearance: GalleryAppearance;
  speciesName: string;
  speciesSlug: string;
  /** Whether the species is in the gameplay snapshot at all. */
  speciesLoaded: boolean;
  onEnlarge: () => void;
}

const ARTWORK_STATUS_TEXT = {
  available: 'Available',
  missing: 'Missing',
  unsafe: 'Unsafe (refused)',
} as const;

export function AppearanceQaCard({
  appearance,
  speciesName,
  speciesSlug,
  speciesLoaded,
  onEnlarge,
}: AppearanceQaCardProps) {
  const a = appearance;
  const label = `${speciesName} — ${a.name}`;
  const available = a.artwork.status === 'available';
  const renditions = a.artwork.renditions;

  return (
    <article
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface"
      aria-labelledby={`appearance-${a.id}-title`}
      data-testid={`appearance-card-${a.id}`}
    >
      {available ? (
        <button
          type="button"
          onClick={onEnlarge}
          className="group relative block w-full cursor-zoom-in text-left"
          aria-label={`Enlarge ${a.name} artwork`}
        >
          <AdminGalleryArtwork
            slug={speciesSlug}
            appearanceId={a.id}
            status={a.artwork.status}
            label={label}
            displayWidth={APPEARANCE_DISPLAY_WIDTH}
          />
          <span className="pointer-events-none absolute right-2 bottom-2 rounded-md bg-black/55 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Maximize2 className="size-4" aria-hidden="true" />
          </span>
        </button>
      ) : (
        <AdminGalleryArtwork
          slug={speciesSlug}
          appearanceId={a.id}
          status={a.artwork.status}
          label={label}
          displayWidth={APPEARANCE_DISPLAY_WIDTH}
        />
      )}

      <div className="flex flex-1 flex-col gap-3 p-3">
        <header className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 id={`appearance-${a.id}-title`} className="text-sm font-semibold text-ink">
              {a.name}
            </h3>
            {a.isDefault && (
              <Badge variant="solid">
                <Star className="size-3" aria-hidden="true" />
                Default
              </Badge>
            )}
          </div>
          <p className="font-mono text-xs break-all text-ink-subtle">{a.id}</p>
        </header>

        <ul className="grid grid-cols-3 gap-1 text-center text-xs" aria-label="Appearance state">
          <StateCell label="Authored" ok value="Yes" />
          <StateCell
            label="Runtime"
            ok={a.inRuntime}
            value={a.inRuntime ? 'Yes' : speciesLoaded ? 'No' : 'Not loaded'}
          />
          <StateCell
            label="Artwork"
            ok={available}
            value={
              available && a.artwork.format
                ? a.artwork.format.toUpperCase()
                : ARTWORK_STATUS_TEXT[a.artwork.status]
            }
          />
        </ul>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <Field label="Unlock">
            {a.unlockLabel}{' '}
            <span className="font-mono text-ink-subtle">
              ({a.unlock.type}
              {a.unlock.atLevel !== undefined ? ` ≥ ${a.unlock.atLevel}` : ''})
            </span>
          </Field>
          <Field label="Rating">
            {titleCase(a.contentRating)}{' '}
            <span className="text-ink-subtle">
              ({a.contentRatingSource === 'appearance' ? 'override' : 'inherited'})
            </span>
          </Field>
          <Field label="Cosmetic">{titleCase(a.cosmeticRarity)}</Field>
          <Field label="Sort order">
            <span className="tabular">{a.sortOrder}</span>
          </Field>
          {a.introducedVersion && <Field label="Introduced">{a.introducedVersion}</Field>}
          {a.tags.length > 0 && <Field label="Tags">{a.tags.join(', ')}</Field>}
          <Field label="AssetId">
            <span className="font-mono break-all">
              {a.assetId.kind}/{a.assetId.slug}/{a.assetId.variant}
            </span>
          </Field>
          {renditions && (
            <Field label="Thumbnails">
              <span className="inline-flex flex-wrap gap-2">
                {Object.entries(renditions).map(([width, present]) => (
                  <span
                    key={width}
                    className={cn(
                      'tabular inline-flex items-center gap-0.5',
                      !present && 'text-danger',
                    )}
                  >
                    {present ? (
                      <Check className="size-3" aria-hidden="true" />
                    ) : (
                      <X className="size-3" aria-hidden="true" />
                    )}
                    {width}
                    <span className="sr-only">{present ? ' present' : ' missing'}</span>
                  </span>
                ))}
              </span>
            </Field>
          )}
          {a.implicit && (
            <Field label="Catalog">
              <span className="text-ink-subtle">Implicit — species authors no appearance list</span>
            </Field>
          )}
        </dl>

        {(a.description || a.flavorText) && (
          <div className="space-y-1 text-xs text-ink-muted">
            {a.description && <p>{a.description}</p>}
            {a.flavorText && <p className="italic">“{a.flavorText}”</p>}
          </div>
        )}

        {(a.issues.length > 0 || a.loaderDiagnostics.length > 0) && (
          <ul className="mt-auto space-y-1 text-xs" aria-label={`${a.name} findings`}>
            {a.loaderDiagnostics.map((code) => {
              const d = describeDiagnostic(code);
              return (
                <li key={`diag-${code}`} className="text-ink-muted">
                  <span className="font-medium">Loader:</span> {d.label}
                </li>
              );
            })}
            {a.issues.map((issue, i) => {
              const d = describeIssue(issue.code);
              return (
                <li
                  key={`${issue.code}-${i}`}
                  className={cn(issue.severity === 'error' ? 'text-danger' : 'text-ink-muted')}
                  title={d.description ?? undefined}
                >
                  <span className="font-medium">
                    {issue.severity === 'error' ? 'Error' : 'Warning'}:
                  </span>{' '}
                  {d.label}
                  {!d.known && <span className="font-mono"> (unrecognised)</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}

function StateCell({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <li
      className={cn(
        'rounded-md border px-1 py-1',
        ok
          ? 'border-border bg-surface-sunken text-ink'
          : 'border-danger/40 bg-danger-soft text-danger',
      )}
    >
      <span className="block text-[0.65rem] tracking-wide uppercase opacity-75">{label}</span>
      <span className="font-medium">{value}</span>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}
