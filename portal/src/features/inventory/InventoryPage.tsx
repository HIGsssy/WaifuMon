/**
 * `/inventory` — what the player is carrying (plan §8.5).
 *
 * Grouped by the item's own `category`; the order below is presentation, and
 * the API already sorts within a category. No "Use Item" button — item effects
 * are a gameplay mutation and belong in Discord (§4).
 *
 * **Item artwork.** Items carry an `emoji` in the content model and no image
 * path, and the assets directory has no item art at all. The resolver's
 * silhouette answers, but a coloured emoji tile reads far better at thumbnail
 * size, so that is what renders. First-party item art is filed as API feedback.
 */
import { Backpack, type LucideIcon } from 'lucide-react';
import { Boxes, FlaskConical, Shirt, Sparkles } from 'lucide-react';

import { useInventory } from '@/api/hooks/usePlayerResources';
import type { InventoryEntry, ItemCategory } from '@/api/types';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/format';

interface CategoryMeta {
  label: string;
  description: string;
  icon: LucideIcon;
}

/** Display order and copy for the four content categories. */
const CATEGORIES: ReadonlyArray<[ItemCategory, CategoryMeta]> = [
  ['capture', { label: 'Capture', description: 'Charms that improve your odds.', icon: Sparkles }],
  ['consumable', { label: 'Consumables', description: 'One-use effects.', icon: FlaskConical }],
  ['material', { label: 'Materials', description: 'Crafting and trade goods.', icon: Boxes }],
  ['cosmetic', { label: 'Cosmetics', description: 'Looks, not power.', icon: Shirt }],
];

function ItemRow({ entry }: { entry: InventoryEntry }) {
  const { item, quantity } = entry;

  return (
    <li className="flex items-start gap-4 border-b border-border py-4 last:border-0">
      {/* Emoji tile: the only artwork the content model gives items today. */}
      <div
        aria-hidden="true"
        className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-sunken text-2xl"
      >
        {item.emoji ?? '📦'}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="font-medium text-ink">{item.name}</h3>
          {item.isGuaranteedCapture && <Badge variant="outline">Guaranteed capture</Badge>}
          {item.captureModifier !== null && !item.isGuaranteedCapture && (
            <Badge variant="outline">×{item.captureModifier} capture</Badge>
          )}
          {!item.purchasable && <Badge variant="outline">Not for sale</Badge>}
        </div>
        <p className="mt-1 text-sm text-ink-muted">{item.description}</p>
      </div>

      <span className="tabular shrink-0 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-sm font-medium text-ink">
        ×{formatNumber(quantity)}
      </span>
    </li>
  );
}

export function InventoryPage() {
  const session = useCurrentSession();
  const inventory = useInventory(session.playerId);

  const entries = inventory.data ?? [];
  const totalItems = entries.reduce((sum, entry) => sum + entry.quantity, 0);

  const grouped = CATEGORIES.map(
    ([category, meta]) =>
      [category, meta, entries.filter((entry) => entry.item.category === category)] as const,
  ).filter(([, , items]) => items.length > 0);

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Charms, materials and everything else you are carrying."
        actions={
          inventory.data ? (
            <span className="tabular text-sm text-ink-muted">
              {formatNumber(totalItems)} item{totalItems === 1 ? '' : 's'}
            </span>
          ) : undefined
        }
      />

      {inventory.isError ? (
        <ErrorState
          error={inventory.error}
          onRetry={() => void inventory.refetch()}
          title="Couldn't load your inventory."
        />
      ) : inventory.isPending ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading your inventory">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Backpack}
          title="Your inventory is empty"
          description="Nothing in the bag yet."
          hint={
            <>
              Claim your daily on Discord with{' '}
              <code className="font-mono text-ink">/waifumon daily</code>.
            </>
          }
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(([category, meta, items]) => (
            <section key={category} aria-labelledby={`category-${category}`}>
              <Card>
                <div className="mb-2 flex items-center gap-3">
                  <meta.icon className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  <h2 id={`category-${category}`} className="font-display text-lg text-ink">
                    {meta.label}
                  </h2>
                  <span className="tabular ml-auto text-sm text-ink-subtle">{items.length}</span>
                </div>
                <p className="mb-1 text-sm text-ink-subtle">{meta.description}</p>
                <ul>
                  {items.map((entry) => (
                    <ItemRow key={entry.item.id} entry={entry} />
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
