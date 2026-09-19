/**
 * `/admin/gallery/:slug` — the artwork QA page for one species.
 *
 * One detail request carries every *authored* appearance with its metadata,
 * runtime presence, artwork status and findings. Previous/next follow the
 * gallery's filtered order: the gallery's query string rides along on the URL,
 * and the same filter function runs over the (usually already cached) catalog.
 */
import { ArrowLeft, ChevronLeft, ChevronRight, SearchX } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import type { GallerySpeciesDetail } from '@/api/adminGallery';
import { isPortalApiError } from '@/api/client';
import { useAdminGalleryCatalog, useAdminGallerySpecies } from '@/api/hooks/useAdminGallery';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { titleCase } from '@/lib/format';
import { cn } from '@/lib/cn';

import { AppearanceQaCard } from './AppearanceQaCard';
import { EnabledBadge, GalleryZoneBadge, IssueBadge, RuntimeBadge } from './GalleryBadges';
import { GalleryLightbox } from './GalleryLightbox';
import {
  distinctValues,
  filterGallerySpecies,
  neighboursOf,
  readGalleryFilters,
} from './galleryFilters';
import { describeDiagnostic, sourceLabel, summarizeIssues } from './galleryLabels';

/** One column on a phone; all six of today's appearances in a row on a wide screen. */
const APPEARANCE_GRID =
  'grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6';

export function AdminGallerySpeciesPage() {
  const { slug = '' } = useParams();
  const [searchParams] = useSearchParams();
  const detail = useAdminGallerySpecies(slug);
  const catalog = useAdminGalleryCatalog();
  // Keyed to the species: paging to the next one never opens her lightbox.
  const [open, setOpen] = useState<{ slug: string; index: number } | null>(null);
  const lightbox = open?.slug === slug ? open.index : null;
  const setLightbox = (index: number | null) =>
    setOpen(index === null ? null : { slug, index });

  const query = searchParams.toString();
  const search = query ? `?${query}` : '';

  const neighbours = useMemo(() => {
    const list = catalog.data?.species ?? [];
    if (list.length === 0) return null;
    const filters = readGalleryFilters(searchParams, {
      races: distinctValues(list, 'race'),
      affinities: distinctValues(list, 'affinity'),
    });
    return neighboursOf(list, filterGallerySpecies(list, filters), slug);
  }, [catalog.data, searchParams, slug]);

  const notFound =
    detail.isError && isPortalApiError(detail.error) && detail.error.code === 'SPECIES_NOT_FOUND';

  return (
    <>
      <nav
        className="mb-4 flex flex-wrap items-center justify-between gap-2"
        aria-label="Gallery navigation"
      >
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/admin/gallery${search}`}>
            <ArrowLeft aria-hidden="true" />
            Waifumon Gallery
          </Link>
        </Button>
        {neighbours && (
          <div className="flex items-center gap-2">
            <NeighbourLink
              to={
                neighbours.previous ? `/admin/gallery/${neighbours.previous.slug}${search}` : null
              }
              label={
                neighbours.previous
                  ? `Previous species: ${neighbours.previous.name}`
                  : 'No previous species'
              }
            >
              <ChevronLeft aria-hidden="true" />
              <span className="hidden sm:inline">Previous</span>
            </NeighbourLink>
            {neighbours.position > 0 && (
              <span className="tabular text-xs text-ink-muted">
                {neighbours.position} / {neighbours.total}
              </span>
            )}
            <NeighbourLink
              to={neighbours.next ? `/admin/gallery/${neighbours.next.slug}${search}` : null}
              label={neighbours.next ? `Next species: ${neighbours.next.name}` : 'No next species'}
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight aria-hidden="true" />
            </NeighbourLink>
          </div>
        )}
      </nav>

      {notFound ? (
        <EmptyState
          icon={SearchX}
          title="Species not found"
          description={`No content file defines a species with the slug "${slug}".`}
        />
      ) : detail.isError ? (
        <ErrorState
          error={detail.error}
          onRetry={() => void detail.refetch()}
          title="Couldn't load this species."
        />
      ) : detail.isPending ? (
        <div aria-busy="true" aria-label="Loading species" className="space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-40 w-full rounded-2xl" />
          <div className={APPEARANCE_GRID}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />
            ))}
          </div>
        </div>
      ) : (
        <SpeciesQa species={detail.data} onEnlarge={setLightbox} />
      )}

      {detail.data && (
        <GalleryLightbox
          speciesName={detail.data.name}
          speciesSlug={detail.data.slug}
          appearances={detail.data.appearances}
          index={lightbox}
          onIndexChange={setLightbox}
        />
      )}
    </>
  );
}

function NeighbourLink({
  to,
  label,
  children,
}: {
  to: string | null;
  label: string;
  children: ReactNode;
}) {
  if (!to) {
    return (
      <Button variant="outline" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to={to} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}

function SpeciesQa({
  species,
  onEnlarge,
}: {
  species: GallerySpeciesDetail;
  onEnlarge: (index: number) => void;
}) {
  const s = species;
  const issueSummary = summarizeIssues(s.issues);
  const bonus = s.buddyBonus;

  return (
    <>
      <header className="mb-5">
        <h1 className="font-display text-2xl leading-tight text-ink sm:text-3xl">{s.name}</h1>
        <p className="font-mono text-sm text-ink-subtle">{s.slug}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <RarityBadge rarity={s.rarity} />
          <Badge variant="outline">
            <span className="sr-only">Type: </span>
            {titleCase(s.race)}
          </Badge>
          <Badge variant="outline">
            <span className="sr-only">Affinity: </span>
            {titleCase(s.affinity)}
          </Badge>
          <GalleryZoneBadge species={s} />
          <Badge variant="outline">
            <span className="sr-only">Content rating: </span>
            {titleCase(s.contentRating)}
          </Badge>
          <RuntimeBadge species={s} />
          <EnabledBadge species={s} />
          <IssueBadge count={s.issues.length} showNone />
        </div>
      </header>

      <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="species-metadata"
          className="rounded-2xl border border-border bg-surface p-4"
        >
          <h2 id="species-metadata" className="mb-3 text-sm font-semibold text-ink">
            Content
          </h2>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Meta label="Source">{sourceLabel(s.source)}</Meta>
            <Meta label="Authored enabled">{s.authoredEnabled ? 'Yes' : 'No'}</Meta>
            <Meta label="Runtime loaded">{s.runtime.loaded ? 'Yes' : 'No'}</Meta>
            {s.runtime.loaded && (
              <Meta label="Runtime enabled">
                {s.runtime.enabled ? 'Yes' : 'No'}
                {s.runtime.disabledByLoader && ' — disabled by the loader (no default artwork)'}
              </Meta>
            )}
            <Meta label="Appearances">
              <span className="tabular">
                {s.appearanceCounts.authored} authored ·{' '}
                {s.appearanceCounts.inRuntime === null
                  ? 'not loaded'
                  : `${s.appearanceCounts.inRuntime} in runtime`}{' '}
                · {s.appearanceCounts.artworkAvailable} with artwork
              </span>
            </Meta>
            <Meta label="Archetype">{titleCase(s.archetype)}</Meta>
            {s.baseCaptureRate !== null && (
              <Meta label="Base capture rate">
                <span className="tabular">{s.baseCaptureRate}</span>
              </Meta>
            )}
            <Meta label="Encounter weight">
              <span className="tabular">{s.perSpeciesWeight}</span>
            </Meta>
            {s.eventKey && <Meta label="Event key">{s.eventKey}</Meta>}
            {bonus?.name && (
              <Meta label="Buddy bonus">
                {bonus.name}
                {bonus.flavorText && (
                  <span className="block text-ink-muted">{bonus.flavorText}</span>
                )}
              </Meta>
            )}
            {s.tags.length > 0 && (
              <Meta label="Tags">
                <span className="flex flex-wrap gap-1">
                  {s.tags.map((tag) => (
                    <Badge key={tag} variant="default" className="font-mono">
                      {tag}
                    </Badge>
                  ))}
                </span>
              </Meta>
            )}
          </dl>
          {s.description && <p className="mt-3 text-sm text-ink-muted">{s.description}</p>}
        </section>

        <section
          aria-labelledby="species-findings"
          className="rounded-2xl border border-border bg-surface p-4"
        >
          <h2 id="species-findings" className="mb-3 text-sm font-semibold text-ink">
            Findings
          </h2>
          {issueSummary.length === 0 && s.loaderDiagnostics.length === 0 ? (
            <p className="text-sm text-ink-muted">No issues found for this species.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {issueSummary.map(({ issue, severity, count }) => (
                <li
                  key={issue.code}
                  className={cn(severity === 'error' ? 'text-danger' : 'text-ink')}
                >
                  <span className="font-medium">{severity === 'error' ? 'Error' : 'Warning'}:</span>{' '}
                  {issue.label}
                  {count > 1 && <span className="tabular"> ×{count}</span>}
                  {issue.description && (
                    <span className="block text-xs text-ink-muted">{issue.description}</span>
                  )}
                  {!issue.known && (
                    <span className="block font-mono text-xs text-ink-muted">
                      Unrecognised code
                    </span>
                  )}
                </li>
              ))}
              {s.loaderDiagnostics.map((d) => (
                <li key={`${d.code}-${d.appearanceId}`} className="text-ink-muted">
                  <span className="font-medium">Loader:</span> {describeDiagnostic(d.code).label}{' '}
                  <span className="font-mono text-xs">({d.appearanceId})</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="species-appearances">
        <h2 id="species-appearances" className="mb-3 text-lg font-semibold text-ink">
          Appearances <span className="tabular text-ink-muted">({s.appearances.length})</span>
        </h2>
        <ul className={APPEARANCE_GRID} aria-label="Authored appearances">
          {s.appearances.map((appearance, index) => (
            <li key={appearance.id}>
              <AppearanceQaCard
                appearance={appearance}
                speciesName={s.name}
                speciesSlug={s.slug}
                speciesLoaded={s.runtime.loaded}
                onEnlarge={() => onEnlarge(index)}
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="text-ink break-words">{children}</dd>
    </div>
  );
}
