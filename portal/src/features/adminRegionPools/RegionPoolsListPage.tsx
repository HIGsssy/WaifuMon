/**
 * Admin — Region Pools overview.
 *
 * Every region the game knows, with the state of its encounter pool: what is
 * published (live for hunting once the region is released), whether the draft
 * has unpublished changes, per-rarity coverage and drift. Regions are not
 * created, deleted or released here — release state belongs to the region
 * catalogue and is shown read-only.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import {
  NOT_HUNTABLE_RARITY,
  REGION_POOL_RARITIES,
  listRegionPools,
  regionPoolKeys,
  type RegionPoolListItem,
} from '@/api/adminRegionPools';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { formatWhen, SOURCE_LABELS } from './regionPoolModel';
import { ReleaseBadge } from './regionPoolParts';

export function RegionPoolsListPage() {
  const canWrite = useHasPermission('regions.write');
  const canPublish = useHasPermission('regions.publish');
  const query = useQuery({
    queryKey: regionPoolKeys.list(),
    queryFn: ({ signal }) => listRegionPools(signal),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Region Pools"
        description="Which Waifumon each region's hunt can meet. A hunt rolls a rarity first, then picks a species of that rarity from the region's published pool by weight. Drafts never reach hunting until they are published."
      />
      <p className="text-xs text-ink-muted" data-testid="region-pools-access">
        Your access:{' '}
        {canPublish && canWrite
          ? 'edit drafts and publish'
          : canPublish
            ? 'publish and roll back (no draft editing)'
            : canWrite
              ? 'edit drafts (publishing needs regions.publish)'
              : 'read only'}
        . Regions are released or withheld in the region catalogue, not here.
      </p>

      {query.isPending && <Skeleton className="h-64 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load Region Pools"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Regions">
          {query.data.regions.map((item) => (
            <RegionCard key={item.region.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RegionCard({ item }: { item: RegionPoolListItem }) {
  const { region, published } = item;
  const total = Object.values(item.rarityCounts).reduce((sum, n) => sum + n, 0);
  return (
    <li data-testid={`region-card-${region.id}`}>
      <Card className="h-full space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">
              <Link
                to={`/admin/region-pools/${region.id}`}
                className="text-accent underline-offset-4 hover:underline"
              >
                {region.name}
              </Link>
            </h2>
            <p className="font-mono text-xs text-ink-subtle">{region.id}</p>
          </div>
          <div className="flex flex-wrap gap-1">
            <ReleaseBadge region={region} />
            {region.isDefault && <Badge variant="outline">Default / fallback region</Badge>}
            {item.unpublishedChanges && <Badge variant="solid">Unpublished draft changes</Badge>}
            {item.driftStatus === 'drift' && <Badge variant="danger">Drift</Badge>}
            {!item.hasPool && <Badge variant="danger">No pool yet</Badge>}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-ink-subtle">Published revision</dt>
            <dd className="text-ink">{published ? `#${published.number}` : 'None'}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Draft revision</dt>
            <dd className="text-ink">{item.draftRevision ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Published species</dt>
            <dd className="text-ink">{total}</dd>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-ink-subtle">Last published</dt>
            <dd className="text-ink">
              {published
                ? `${formatWhen(published.publishedAt)}${published.publishedBy ? ` by ${published.publishedBy}` : ''} · ${SOURCE_LABELS[published.source]}`
                : 'Never'}
            </dd>
          </div>
        </dl>

        <div>
          <p className="text-xs text-ink-subtle">Rarity coverage (published)</p>
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={`${region.name} rarity coverage`}>
            {[...REGION_POOL_RARITIES, NOT_HUNTABLE_RARITY].map((rarity) => {
              const n = item.rarityCounts[rarity] ?? 0;
              const hunted = rarity !== NOT_HUNTABLE_RARITY;
              return (
                <li
                  key={rarity}
                  className={`inline-flex items-center gap-1 text-xs ${hunted && n === 0 ? 'text-danger' : 'text-ink-muted'}`}
                >
                  <RarityBadge rarity={rarity} />
                  <span>
                    {n}
                    {hunted && n === 0 && <span> (empty — falls back)</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </Card>
    </li>
  );
}
