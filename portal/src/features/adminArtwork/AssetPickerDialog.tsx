/**
 * Pick a managed artwork asset: a filtered, searchable grid of what has been
 * uploaded. Selecting returns the asset — callers store its id and never ask
 * an admin to type one.
 *
 * Browse + select only; uploading is the field's job (`AssetField`) and
 * managing is the Artwork Assets page's.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  ARTWORK_ASSETS_QUERY_KEY,
  ARTWORK_CATEGORIES,
  ARTWORK_CATEGORY_LABELS,
  artworkAssetBlob,
  artworkAssetSource,
  listArtworkAssets,
  type ArtworkAsset,
  type ArtworkAssetCategory,
} from '@/api/adminArtworkAssets';
import { ErrorState } from '@/components/layout/ErrorState';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { cn } from '@/lib/cn';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import { assetSummary } from './assetHelpers';

/** The grid itself, shared by the dialog and the Artwork Assets page. */
export function AssetGrid({
  category,
  lockCategory = false,
  selectedId,
  includeDisabled = false,
  onSelect,
}: {
  /** The category shown first. */
  category?: ArtworkAssetCategory | undefined;
  /** Hide the category filter: this picker is for one kind of image. */
  lockCategory?: boolean;
  selectedId?: string | null | undefined;
  includeDisabled?: boolean;
  onSelect: (asset: ArtworkAsset) => void;
}) {
  const [filter, setFilter] = useState<ArtworkAssetCategory | ''>(category ?? '');
  const [text, setText] = useState('');
  const search = useDebouncedValue(text, 250);
  const query = useQuery({
    queryKey: [...ARTWORK_ASSETS_QUERY_KEY, 'list', filter, search, includeDisabled],
    queryFn: ({ signal }) =>
      listArtworkAssets(
        {
          category: filter || undefined,
          q: search,
          limit: 120,
          ...(includeDisabled ? {} : { status: 'active' as const }),
        },
        signal,
      ),
  });
  const assets = query.data?.assets ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="asset-grid">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-xs text-ink-muted">
          Search
          <Input
            aria-label="Search artwork"
            placeholder="Name or file name"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {!lockCategory && (
          <label className="text-xs text-ink-muted">
            Category
            <select
              aria-label="Filter by category"
              className={selectClass}
              value={filter}
              onChange={(e) => setFilter(e.target.value as ArtworkAssetCategory | '')}
            >
              <option value="">All categories</option>
              {ARTWORK_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ARTWORK_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {query.isError && (
        <ErrorState
          variant="inline"
          showReason
          title="Could not load artwork"
          error={query.error}
        />
      )}
      {query.isSuccess && (
        <p className="text-xs text-ink-muted" role="status" data-testid="asset-grid-summary">
          {assets.length > 0
            ? `${assets.length} of ${query.data.total} shown`
            : filter === '' && search.trim() === ''
              ? 'No artwork has been uploaded yet. Shipped artwork is still used wherever nothing is uploaded.'
              : 'No artwork matches. Upload some, or change the filter.'}
        </p>
      )}
      <ul className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((asset) => (
          <li key={asset.id}>
            <button
              type="button"
              aria-label={`Select ${asset.name}`}
              aria-pressed={asset.id === selectedId}
              data-testid={`asset-card-${asset.id}`}
              onClick={() => onSelect(asset)}
              className={cn(
                'w-full space-y-1 rounded-md border p-2 text-left',
                asset.id === selectedId
                  ? 'border-accent ring-1 ring-accent'
                  : 'border-border hover:border-accent',
              )}
            >
              <AuthoredArtwork
                source={artworkAssetSource(asset)}
                load={artworkAssetBlob}
                className="flex h-24 w-full items-center justify-center overflow-hidden rounded bg-surface-sunken"
                testIdPrefix={`asset-thumb-${asset.id}`}
                emptyLabel=""
                missingLabel={() => 'File missing'}
                alt={() => asset.name}
              />
              <span className="block truncate text-sm text-ink">{asset.name}</span>
              <span className="block truncate text-xs text-ink-muted">
                {ARTWORK_CATEGORY_LABELS[asset.category]}
                {asset.status === 'disabled' ? ' · disabled' : ''}
              </span>
              <span className="block truncate text-xs text-ink-subtle">{assetSummary(asset)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AssetPickerDialog({
  open,
  title,
  category,
  selectedId,
  onClose,
  onSelect,
}: {
  open: boolean;
  title: string;
  category: ArtworkAssetCategory;
  selectedId: string | null;
  onClose: () => void;
  onSelect: (asset: ArtworkAsset) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Close artwork picker">
        <div className="flex max-h-[80vh] min-h-0 flex-col gap-3">
          <div>
            <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
            <DialogDescription className="text-xs text-ink-muted">
              Artwork uploaded through the Portal. Pick one to use it here.
            </DialogDescription>
          </div>
          {open && (
            <AssetGrid
              category={category}
              selectedId={selectedId}
              onSelect={(asset) => {
                onSelect(asset);
                onClose();
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
