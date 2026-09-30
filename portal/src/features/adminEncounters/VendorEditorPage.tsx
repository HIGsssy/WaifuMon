/**
 * World Encounters — create or edit one vendor: identity, inventory with this
 * vendor's own prices, and the encounters that open it.
 *
 * Vendors have no draft/active lifecycle in the engine, so a saved change
 * reaches the next visit to every encounter that opens the vendor. A shop a
 * player already has open keeps the stock it opened with.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  VENDORS_QUERY_KEY,
  createAdminVendor,
  deleteAdminVendor,
  getAdminVendor,
  updateAdminVendor,
} from '@/api/adminVendors';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { slugify, uniqueSlug } from './slugs';
import { REFERENCE_KEY, useReference, useVendors } from './useAuthoringData';
import { VendorFields } from './VendorFields';
import {
  EMPTY_VENDOR_FORM,
  vendorFormErrors,
  vendorFormFrom,
  vendorFormWarnings,
  vendorInputOf,
  type VendorFormState,
} from './vendorForm';

/** Keyed by vendor, for the same reason as the encounter editor. */
export function VendorEditorPage() {
  const { vendorKey } = useParams<{ vendorKey?: string }>();
  return <VendorEditor key={vendorKey ?? 'new'} />;
}

function VendorEditor() {
  const { vendorKey: keyParam } = useParams<{ vendorKey?: string }>();
  const isNew = !keyParam;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('encounters.write');
  const reference = useReference().data;
  const vendorsQuery = useVendors();

  const vendorQuery = useQuery({
    queryKey: [...VENDORS_QUERY_KEY, keyParam],
    queryFn: ({ signal }) => getAdminVendor(keyParam!, signal),
    enabled: !isNew,
  });

  // "Clone" arrives here as a new vendor with the source's form in router state.
  const cloneOf = (location.state as { clone?: VendorFormState } | null)?.clone;
  const [form, setForm] = useState<VendorFormState>(cloneOf ?? EMPTY_VENDOR_FORM);
  const [loaded, setLoaded] = useState(isNew);
  useEffect(() => {
    if (vendorQuery.data && !loaded) {
      setForm(vendorFormFrom(vendorQuery.data));
      setLoaded(true);
    }
  }, [vendorQuery.data, loaded]);

  const takenKeys = useMemo(
    () => new Set((vendorsQuery.data?.vendors ?? []).map((v) => v.vendorKey)),
    [vendorsQuery.data],
  );
  const itemSlugs = useMemo(
    () => (reference ? new Set(reference.items.map((i) => i.slug)) : undefined),
    [reference],
  );
  const errors = vendorFormErrors(form, { isNew, takenKeys, ...(itemSlugs ? { itemSlugs } : {}) });
  const warnings = vendorFormWarnings(form);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: VENDORS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: REFERENCE_KEY });
  };
  const save = useMutation({
    mutationFn: () =>
      isNew
        ? createAdminVendor({ vendorKey: form.vendorKey, ...vendorInputOf(form) })
        : updateAdminVendor(form.vendorKey, vendorInputOf(form)),
    onSuccess: (saved) => {
      refresh();
      if (isNew)
        navigate(`/admin/encounters/vendors/${encodeURIComponent(saved.vendorKey)}`, {
          replace: true,
        });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteAdminVendor(form.vendorKey),
    onSuccess: () => {
      refresh();
      navigate('/admin/encounters/vendors');
    },
  });

  if (!isNew && vendorQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (!isNew && vendorQuery.isError) {
    return (
      <ErrorState
        title="Could not load vendor"
        error={vendorQuery.error}
        onRetry={() => void vendorQuery.refetch()}
      />
    );
  }
  const usedBy = vendorQuery.data?.usedBy ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={isNew ? 'New vendor' : `Edit vendor — ${form.name || form.vendorKey}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/admin/encounters/vendors">Back to vendors</Link>
            </Button>
            {!isNew && canWrite && (
              <Button
                variant="outline"
                type="button"
                onClick={() =>
                  navigate('/admin/encounters/vendors/new', {
                    state: {
                      clone: {
                        ...form,
                        name: `${form.name} (copy)`,
                        vendorKey: uniqueSlug(slugify(`${form.name} copy`, 'vendor'), takenKeys),
                        keyFromName: true,
                      },
                    },
                  })
                }
              >
                Clone
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <Card className="space-y-4 p-4">
          <VendorFields
            form={form}
            isNew={isNew}
            takenKeys={takenKeys}
            items={reference?.items ?? []}
            onChange={setForm}
            disabled={!canWrite}
          />
          {(errors.length > 0 || warnings.length > 0) && (
            <ul className="space-y-1 text-xs" data-testid="vendor-issues">
              {errors.map((e) => (
                <li key={e} className="text-danger">
                  {e}
                </li>
              ))}
              {warnings.map((w) => (
                <li key={w} className="text-ink-muted" data-testid="vendor-warning">
                  ⚠ {w}
                </li>
              ))}
            </ul>
          )}
          {save.isError && <ErrorState title="Could not save the vendor" error={save.error} />}
          {save.isSuccess && !save.isPending && <p className="text-xs text-ink-muted">Saved.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="accent"
              disabled={!canWrite || errors.length > 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : isNew ? 'Create vendor' : 'Save vendor'}
            </Button>
            {!canWrite && (
              <span className="text-xs text-ink-muted">You do not have write permission.</span>
            )}
          </div>
        </Card>

        {!isNew && (
          <Card className="space-y-3 p-4 text-sm">
            <h2 className="text-sm font-semibold uppercase text-ink-muted">Opened by</h2>
            {usedBy.length === 0 ? (
              <p className="text-ink-muted">No encounter opens this vendor yet.</p>
            ) : (
              <ul className="space-y-1" data-testid="vendor-used-by">
                {usedBy.map((e) => (
                  <li key={e.slug}>
                    <Link to={`/admin/encounters/${e.id}`} className="text-accent underline">
                      {e.name}
                    </Link>{' '}
                    <span className="text-xs text-ink-muted">{e.lifecycle}</span>
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <div className="border-t border-border pt-3">
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={usedBy.length > 0 || remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete vendor "${form.name}"?`)) remove.mutate();
                  }}
                >
                  Delete vendor
                </Button>
                {usedBy.length > 0 && (
                  <p className="mt-1 text-xs text-ink-muted">
                    Point these encounters at another vendor before deleting this one.
                  </p>
                )}
                {remove.isError && (
                  <ErrorState title="Could not delete the vendor" error={remove.error} />
                )}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
