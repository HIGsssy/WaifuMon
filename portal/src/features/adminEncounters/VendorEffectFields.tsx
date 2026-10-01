/**
 * The "Open a vendor" effect: which vendor, what it sells, and the shortcuts
 * to edit it or create a new one without leaving the encounter.
 */
import { useState } from 'react';

import type { AdminEncounterReference } from '@/api/adminEncounters';
import type { AdminVendor } from '@/api/adminVendors';
import { Button } from '@/components/ui/button';
import { useHasPermission } from '@/auth/useSession';
import { EntitySelect } from './EntitySelect';
import { useVendors } from './useAuthoringData';
import { VendorDialog } from './VendorDialog';

interface Props {
  vendorKey: string;
  reference: AdminEncounterReference | undefined;
  onChange: (vendorKey: string) => void;
}

export function VendorEffectFields({ vendorKey, reference, onChange }: Props) {
  const vendorsQuery = useVendors();
  const canWrite = useHasPermission('encounters.write');
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const [showStock, setShowStock] = useState(false);

  // The vendor list carries stock; the reference list is the fallback while
  // it loads (or on a server without the vendor routes).
  const vendors: readonly AdminVendor[] = vendorsQuery.data?.vendors ?? [];
  const options =
    vendors.length > 0
      ? vendors.map((v) => ({
          value: v.vendorKey,
          label: v.name,
          hint:
            v.stock.length === 0
              ? 'no inventory'
              : `${v.stock.length} item${v.stock.length === 1 ? '' : 's'}`,
        }))
      : (reference?.vendors ?? []).map((v) => ({ value: v.vendorKey, label: v.name }));
  const selected = vendors.find((v) => v.vendorKey === vendorKey);
  const items = reference?.items ?? [];
  const itemName = (slug: string) => items.find((i) => i.slug === slug)?.name ?? slug;

  return (
    <div className="space-y-2" data-testid="vendor-effect">
      <EntitySelect
        label="Vendor"
        value={vendorKey}
        options={options}
        placeholder="— pick a vendor —"
        searchLabel="Search vendors"
        onChange={onChange}
      />
      <div className="flex flex-wrap gap-2">
        {selected && (
          <>
            {canWrite && (
              <Button type="button" size="sm" variant="outline" onClick={() => setDialog('edit')}>
                Edit vendor
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-expanded={showStock}
              onClick={() => setShowStock((s) => !s)}
            >
              {showStock ? 'Hide inventory' : 'Preview inventory'}
            </Button>
          </>
        )}
        {canWrite && (
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog('create')}>
            Create new vendor
          </Button>
        )}
      </div>
      {selected && showStock && (
        <div
          className="rounded-md border border-border bg-surface p-2 text-xs"
          data-testid="vendor-inventory-preview"
        >
          {selected.stock.length === 0 ? (
            <p className="text-ink-muted">This vendor has no inventory.</p>
          ) : (
            <ul className="space-y-0.5">
              {selected.stock.map((line) => (
                <li key={line.itemSlug} className="flex justify-between gap-4">
                  <span>{itemName(line.itemSlug)}</span>
                  <span className="tabular text-ink-muted">
                    {line.price.toLocaleString('en-US')}{' '}
                    {line.currency === 'waifubux' ? 'WB' : 'Essence'} · {line.quantity} per visit
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <VendorDialog
        open={dialog != null}
        onClose={() => setDialog(null)}
        vendor={dialog === 'edit' ? selected : undefined}
        vendors={vendors}
        items={items}
        onSaved={(saved) => onChange(saved.vendorKey)}
      />
    </div>
  );
}
