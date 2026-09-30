/**
 * World Encounters — Vendors: every vendor an `open_vendor` effect can open,
 * what it sells, and which encounters open it.
 */
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { useReference, useVendors } from './useAuthoringData';

export function VendorsListPage() {
  const canWrite = useHasPermission('encounters.write');
  const query = useVendors();
  const items = useReference().data?.items ?? [];
  const itemName = (slug: string) => items.find((i) => i.slug === slug)?.name ?? slug;
  const vendors = [...(query.data?.vendors ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Vendors"
        description="Merchants an encounter can open. Each vendor sets its own prices and how much each visit offers."
        actions={
          canWrite ? (
            <Button asChild variant="accent">
              <Link to="/admin/encounters/vendors/new">New vendor</Link>
            </Button>
          ) : undefined
        }
      />
      {query.isPending && <Skeleton className="h-32 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load vendors"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && vendors.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted">No vendors yet.</Card>
      )}
      {vendors.length > 0 && (
        <Card className="divide-y divide-border">
          {vendors.map((v) => (
            <div
              key={v.vendorKey}
              className="flex flex-wrap items-start gap-3 px-4 py-3"
              data-testid="vendor-row"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/admin/encounters/vendors/${encodeURIComponent(v.vendorKey)}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {v.name}
                  </Link>
                  {v.stock.length === 0 ? (
                    <Badge variant="danger">No inventory</Badge>
                  ) : (
                    <Badge variant="outline">
                      {v.stock.length} item{v.stock.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                  {v.usedBy.length === 0 && <Badge variant="outline">Not used</Badge>}
                </div>
                {v.stock.length > 0 && (
                  <p className="mt-1 text-xs text-ink-muted">
                    {v.stock
                      .map(
                        (s) =>
                          `${itemName(s.itemSlug)} ${s.price.toLocaleString('en-US')} ${s.currency === 'waifubux' ? 'WB' : 'Essence'}`,
                      )
                      .join(' · ')}
                  </p>
                )}
                <p className="text-xs text-ink-subtle">
                  {v.usedBy.length > 0
                    ? `Opened by ${v.usedBy.map((e) => e.name).join(', ')}`
                    : 'No encounter opens this vendor.'}
                </p>
              </div>
              <Button size="sm" variant="outline" asChild>
                <Link to={`/admin/encounters/vendors/${encodeURIComponent(v.vendorKey)}`}>
                  Edit
                </Link>
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
