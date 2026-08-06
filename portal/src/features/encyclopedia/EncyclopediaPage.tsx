/**
 * `/encyclopedia` — every species in the world (plan §8.7).
 *
 * Unlike the Collection, this page filters entirely client-side and that is
 * correct rather than a compromise: the content snapshot is one cached array of
 * ~50 rows with `staleTime: Infinity`, so there is nothing to fetch per filter
 * and no server round trip to save.
 *
 * The ownership overlay is derived by `useOwnedSlugs`, which walks the
 * collection once per session. `GET /players/{id}/collection/dex` (§25.5) would
 * replace that walk with a single request.
 *
 * Disabled species are hidden: they are content an operator has switched off,
 * not content a player has failed to find.
 */
import { BookOpen, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useContentSpecies } from '@/api/hooks/useContent';
import { useOwnedSlugs } from '@/api/hooks/useOwnedSlugs';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { titleCase } from '@/lib/format';
import { byRarityDesc, RARITY_ORDER, rarityStyle } from '@/lib/rarity';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { cn } from '@/lib/cn';
import { SpeciesCard } from './SpeciesCard';

type Discovery = 'all' | 'discovered' | 'undiscovered';

const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-5';

function Chip({
  active,
  onClick,
  children,
  style,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-transparent bg-ink text-ink-inverse'
          : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
      )}
      style={active ? undefined : style}
    >
      {children}
    </button>
  );
}

export function EncyclopediaPage() {
  const session = useCurrentSession();
  const species = useContentSpecies();
  const owned = useOwnedSlugs(session.playerId);

  // URL-backed, same rule as the Collection: a filtered dex is a shareable link.
  const [searchParams, setSearchParams] = useSearchParams();
  const rarity = searchParams.get('rarity');
  const archetype = searchParams.get('type');
  const discovery = (searchParams.get('discovery') ?? 'all') as Discovery;
  const search = searchParams.get('search') ?? '';

  const [searchDraft, setSearchDraft] = useState(search);
  const debouncedSearch = useDebouncedValue(searchDraft, 250);

  function patch(key: string, value: string | null) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  const enabled = useMemo(
    () => (species.data ?? []).filter((entry) => entry.enabled),
    [species.data],
  );

  const archetypes = useMemo(
    () => [...new Set(enabled.map((entry) => entry.archetype))].sort((a, b) => a.localeCompare(b)),
    [enabled],
  );

  // Memoised so the filter below is not invalidated by a fresh `{}` each render.
  const counts = useMemo(() => owned.data?.countBySlug ?? {}, [owned.data]);

  const visible = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    return enabled
      .filter((entry) => {
        const ownedCount = counts[entry.slug] ?? 0;
        if (rarity && entry.rarity !== rarity) return false;
        if (archetype && entry.archetype !== archetype) return false;
        if (discovery === 'discovered' && ownedCount === 0) return false;
        if (discovery === 'undiscovered' && ownedCount > 0) return false;
        // An undiscovered species must not be findable by typing its name —
        // that would leak the very thing the silhouette hides.
        if (needle && (ownedCount === 0 || !entry.name.toLowerCase().includes(needle))) {
          return false;
        }
        return true;
      })
      .sort((a, b) => byRarityDesc(a.rarity, b.rarity) || a.name.localeCompare(b.name));
  }, [enabled, counts, rarity, archetype, discovery, debouncedSearch]);

  const discoveredCount = enabled.filter((entry) => (counts[entry.slug] ?? 0) > 0).length;
  const hasFilters = Boolean(rarity || archetype || search || discovery !== 'all');

  return (
    <>
      <PageHeader
        title="Encyclopedia"
        description="Every species in the world, discovered or not."
        actions={
          species.data && owned.data ? (
            <span className="tabular text-sm text-ink-muted">
              {discoveredCount} / {enabled.length} discovered
            </span>
          ) : undefined
        }
      />

      {species.isError ? (
        <ErrorState
          error={species.error}
          onRetry={() => void species.refetch()}
          title="Couldn't load the species catalogue."
        />
      ) : (
        <>
          <div className="mb-6 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
                  aria-hidden="true"
                />
                <Input
                  value={searchDraft}
                  onChange={(event) => {
                    setSearchDraft(event.target.value);
                    patch('search', event.target.value);
                  }}
                  placeholder="Search discovered species…"
                  aria-label="Search discovered species"
                  className="pl-9"
                />
              </div>
              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchDraft('');
                    setSearchParams(new URLSearchParams());
                  }}
                >
                  <X aria-hidden="true" />
                  Clear
                </Button>
              )}
            </div>

            <fieldset>
              <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Show</legend>
              <div className="flex flex-wrap gap-1.5">
                {(['all', 'discovered', 'undiscovered'] as const).map((value) => (
                  <Chip
                    key={value}
                    active={discovery === value}
                    onClick={() => patch('discovery', value === 'all' ? null : value)}
                  >
                    {titleCase(value)}
                  </Chip>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">
                Rarity
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {RARITY_ORDER.map((tier) => (
                  <Chip
                    key={tier}
                    active={rarity === tier}
                    onClick={() => patch('rarity', rarity === tier ? null : tier)}
                    style={{ color: `var(${rarityStyle(tier).cssVar})` }}
                  >
                    {tier}
                  </Chip>
                ))}
              </div>
            </fieldset>

            {archetypes.length > 0 && (
              <fieldset>
                <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">
                  Type
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {archetypes.map((value) => (
                    <Chip
                      key={value}
                      active={archetype === value}
                      onClick={() => patch('type', archetype === value ? null : value)}
                    >
                      {titleCase(value)}
                    </Chip>
                  ))}
                </div>
              </fieldset>
            )}
          </div>

          {species.isPending ? (
            <div className={GRID} aria-busy="true" aria-label="Loading the encyclopedia">
              {Array.from({ length: 10 }, (_, index) => (
                <Skeleton key={index} className="aspect-[3/4] rounded-2xl" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No species match your filters"
              description="Try widening the search or clearing a filter."
            />
          ) : (
            <div className={GRID}>
              {visible.map((entry, index) => (
                <SpeciesCard
                  key={entry.slug}
                  species={entry}
                  ownedCount={counts[entry.slug] ?? 0}
                  priority={index < 4}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
