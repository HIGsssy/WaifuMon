/**
 * One managed-artwork reference in an editor: what is selected, a preview,
 * and the four things an author does with it — select an existing asset,
 * upload a new one (validated, stored and selected in one step, without
 * leaving the editor), clear it, and see what it falls back to.
 *
 * The stored value is the asset's id; nobody types one.
 */
import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  ARTWORK_ASSETS_QUERY_KEY,
  ARTWORK_CATEGORY_LABELS,
  artworkAssetBlob,
  artworkAssetSource,
  uploadArtworkAsset,
  type ArtworkAsset,
  type ArtworkAssetCategory,
} from '@/api/adminArtworkAssets';
import { useHasPermission } from '@/auth/useSession';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Button } from '@/components/ui/button';

import {
  ACCEPTED_UPLOAD_TYPES,
  assetSummary,
  describeUploadError,
  useArtworkAsset,
} from './assetHelpers';
import { AssetPickerDialog } from './AssetPickerDialog';

export function AssetField({
  label,
  testId,
  value,
  category,
  fallback,
  disabled,
  onChange,
}: {
  /** `Zone artwork`, `Sprite`… — also names the buttons. */
  label: string;
  testId: string;
  value: string | null;
  /** The category new uploads get, and the picker opens on. */
  category: ArtworkAssetCategory;
  /** What shows while nothing is selected, e.g. "the shipped path dungeons/zones/x.webp". */
  fallback: string;
  disabled: boolean;
  onChange: (assetId: string | null, asset: ArtworkAsset | null) => void;
}) {
  const queryClient = useQueryClient();
  const canUpload = useHasPermission('artwork.write');
  const canBrowse = useHasPermission('artwork.read');
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const asset = useArtworkAsset(canBrowse ? value : null);
  const lower = label.toLowerCase();

  const upload = useMutation({
    mutationFn: (file: File) => uploadArtworkAsset(file, { category }),
    onSuccess: (created) => {
      queryClient.setQueryData([...ARTWORK_ASSETS_QUERY_KEY, 'asset', created.id], created);
      void queryClient.invalidateQueries({ queryKey: [...ARTWORK_ASSETS_QUERY_KEY, 'list'] });
      onChange(created.id, created);
    },
  });

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        {!disabled && (
          <>
            {canBrowse && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Select ${lower}`}
                onClick={() => setPickerOpen(true)}
              >
                Select…
              </Button>
            )}
            {canUpload && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Upload ${lower}`}
                  disabled={upload.isPending}
                  onClick={() => fileInput.current?.click()}
                >
                  {upload.isPending ? 'Uploading…' : 'Upload…'}
                </Button>
                <input
                  ref={fileInput}
                  id={inputId}
                  type="file"
                  className="sr-only"
                  aria-label={`${label} file`}
                  data-testid={`${testId}-file`}
                  accept={ACCEPTED_UPLOAD_TYPES}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset so choosing the same file again still fires.
                    e.target.value = '';
                    if (file) upload.mutate(file);
                  }}
                />
              </>
            )}
            {value !== null && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Clear ${lower}`}
                onClick={() => onChange(null, null)}
              >
                Clear
              </Button>
            )}
          </>
        )}
      </div>
      {upload.isError && (
        <p className="text-xs text-danger" role="alert" data-testid={`${testId}-upload-error`}>
          {describeUploadError(upload.error)}
        </p>
      )}
      {value === null ? (
        <p className="text-xs text-ink-subtle" data-testid={`${testId}-fallback`}>
          No uploaded artwork — uses {fallback}.
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-muted" data-testid={`${testId}-selected`}>
            {asset === undefined && 'Loading…'}
            {asset === null &&
              (canBrowse
                ? 'This artwork no longer exists — select another or clear it.'
                : 'Uploaded artwork is selected.')}
            {asset && (
              <>
                <span className="text-ink">{asset.name}</span> ·{' '}
                {ARTWORK_CATEGORY_LABELS[asset.category]} · {assetSummary(asset)}
                {asset.status === 'disabled' && (
                  <span className="text-danger"> · disabled, so {fallback} is shown instead</span>
                )}
              </>
            )}
          </p>
          {asset && (
            <AuthoredArtwork
              source={artworkAssetSource(asset)}
              load={artworkAssetBlob}
              testIdPrefix={`${testId}-preview`}
              emptyLabel=""
              missingLabel={() =>
                'The stored file is missing — replace this artwork on the Artwork Assets page.'
              }
              alt={() => `${label}: ${asset.name}`}
            />
          )}
        </>
      )}
      <AssetPickerDialog
        open={pickerOpen}
        title={`Select ${lower}`}
        category={category}
        selectedId={value}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => {
          queryClient.setQueryData([...ARTWORK_ASSETS_QUERY_KEY, 'asset', picked.id], picked);
          onChange(picked.id, picked);
        }}
      />
    </div>
  );
}
