/**
 * `/shop` — the catalogue, read-only (plan §8.6).
 *
 * `available` and `availabilityNote` come straight from the shop service and
 * are rendered verbatim. The Portal deliberately does **not** re-derive
 * purchasability, and deliberately does not compare a price against the
 * player's balance — affordability is a rule, and rules live in one place
 * (§16). The catalogue is player-independent for exactly that reason.
 *
 * No purchase button; a footer note points at the Discord command.
 */
import { Store } from 'lucide-react';

import { useShopCatalog } from '@/api/hooks/usePlayerResources';
import type { ShopCatalogEntry } from '@/api/types';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CurrencyChip } from '@/components/waifumon/CurrencyChip';
import { cn } from '@/lib/cn';

function ShopTile({ entry }: { entry: ShopCatalogEntry }) {
  const { item, available, availabilityNote, currency } = entry;

  return (
    <Card
      className={cn(
        'relative flex h-full flex-col gap-3',
        !available && 'opacity-70 grayscale-[0.4]',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-sunken text-2xl"
        >
          {item.emoji ?? '🛒'}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-ink">{item.name}</h3>
          <p className="mt-1 text-sm text-ink-muted">{item.description}</p>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {item.buyPrice === null ? (
          <span className="text-sm text-ink-subtle">No price</span>
        ) : (
          <CurrencyChip kind={currency} value={item.buyPrice} />
        )}
        {item.isGuaranteedCapture && <Badge variant="outline">Guaranteed</Badge>}
        {item.captureModifier !== null && !item.isGuaranteedCapture && (
          <Badge variant="outline">×{item.captureModifier}</Badge>
        )}
        {/* The service's own words for why a row cannot be bought. */}
        {!available && (
          <Badge variant="danger" className="ml-auto">
            {availabilityNote ?? 'Not currently available'}
          </Badge>
        )}
      </div>
    </Card>
  );
}

export function ShopPage() {
  const catalog = useShopCatalog();
  const entries = catalog.data ?? [];

  return (
    <>
      <PageHeader
        title="Shop"
        description="What is for sale today."
        actions={
          catalog.data ? (
            <span className="tabular text-sm text-ink-muted">{entries.length} listed</span>
          ) : undefined
        }
      />

      {catalog.isError ? (
        <ErrorState
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
          title="Couldn't load the shop."
        />
      ) : catalog.isPending ? (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-busy="true"
          aria-label="Loading the shop"
        >
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-44 rounded-2xl" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Store}
          title="The shop is currently closed"
          description="Nothing is listed right now. Check back later."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
              <ShopTile key={entry.item.id} entry={entry} />
            ))}
          </div>
          <p className="mt-8 text-center text-sm text-ink-subtle">
            Buying happens in Discord — use{' '}
            <code className="font-mono text-ink">/waifumon shop</code>.
          </p>
        </>
      )}
    </>
  );
}
