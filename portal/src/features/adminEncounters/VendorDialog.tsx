/**
 * Create or edit a vendor without leaving the encounter editor.
 *
 * The encounter's own unsaved changes stay on screen behind the dialog; on
 * save the dialog hands the saved vendor back so the calling effect can link
 * it (create) or refresh its summary (edit).
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { AdminEncounterReference } from '@/api/adminEncounters';
import {
  VENDORS_QUERY_KEY,
  createAdminVendor,
  updateAdminVendor,
  type AdminVendor,
} from '@/api/adminVendors';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/layout/ErrorState';
import { REFERENCE_KEY } from './useAuthoringData';
import { VendorFields } from './VendorFields';
import {
  EMPTY_VENDOR_FORM,
  vendorFormErrors,
  vendorFormFrom,
  vendorFormWarnings,
  vendorInputOf,
  type VendorFormState,
} from './vendorForm';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Absent: create a new vendor. */
  vendor?: AdminVendor | undefined;
  vendors: readonly AdminVendor[];
  items: AdminEncounterReference['items'];
  onSaved: (vendor: AdminVendor) => void;
}

export function VendorDialog({ open, onClose, vendor, vendors, items, onSaved }: Props) {
  const queryClient = useQueryClient();
  const isNew = vendor == null;
  const [form, setForm] = useState<VendorFormState>(EMPTY_VENDOR_FORM);

  useEffect(() => {
    if (open) setForm(vendor ? vendorFormFrom(vendor) : EMPTY_VENDOR_FORM);
  }, [open, vendor]);

  const takenKeys = useMemo(() => new Set(vendors.map((v) => v.vendorKey)), [vendors]);
  const itemSlugs = useMemo(() => new Set(items.map((i) => i.slug)), [items]);
  const errors = vendorFormErrors(form, { isNew, takenKeys, itemSlugs });
  const warnings = vendorFormWarnings(form);

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? createAdminVendor({ vendorKey: form.vendorKey, ...vendorInputOf(form) })
        : updateAdminVendor(form.vendorKey, vendorInputOf(form)),
    onSuccess: (saved) => {
      // Put the saved vendor in the cache straight away, so the picker that
      // is about to select it already offers it; the refetch then confirms.
      queryClient.setQueryData<{ vendors: AdminVendor[] }>(VENDORS_QUERY_KEY, (old) =>
        old
          ? {
              vendors: [...old.vendors.filter((v) => v.vendorKey !== saved.vendorKey), saved],
            }
          : { vendors: [saved] },
      );
      void queryClient.invalidateQueries({ queryKey: VENDORS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: REFERENCE_KEY });
      onSaved(saved);
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <Card className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto p-5">
          <DialogTitle className="text-lg font-semibold">
            {isNew ? 'Create vendor' : `Edit vendor — ${vendor.name}`}
          </DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            {isNew
              ? 'The new vendor is saved straight away and linked to this choice. Your encounter changes stay unsaved until you save the encounter.'
              : 'Changes apply to every encounter that opens this vendor, from the next visit on.'}
          </DialogDescription>
          <VendorFields
            form={form}
            isNew={isNew}
            takenKeys={takenKeys}
            items={items}
            onChange={setForm}
          />
          {(errors.length > 0 || warnings.length > 0) && (
            <ul className="space-y-1 text-xs" data-testid="vendor-dialog-issues">
              {errors.map((e) => (
                <li key={e} className="text-danger">
                  {e}
                </li>
              ))}
              {warnings.map((w) => (
                <li key={w} className="text-ink-muted">
                  ⚠ {w}
                </li>
              ))}
            </ul>
          )}
          {save.isError && <ErrorState title="Could not save the vendor" error={save.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="accent"
              disabled={errors.length > 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : isNew ? 'Create and link vendor' : 'Save vendor'}
            </Button>
          </div>
        </Card>
      </DialogContent>
    </Dialog>
  );
}
