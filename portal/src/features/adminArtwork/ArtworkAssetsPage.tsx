/**
 * Artwork Assets — images uploaded through the Portal.
 *
 *   - **Upload**: pick a category and a file; the server validates the bytes
 *     and stores them outside Git.
 *   - **Browse**: filter by category, search by name or file name.
 *   - **Manage** the selected asset: rename, move category, replace the image
 *     (same asset, so everything using it updates), disable, delete — with
 *     what references it and its change history alongside.
 *
 * Shipped artwork under `assets/` is not listed here; it stays in Git and is
 * what a zone or enemy falls back to.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import {
  ARTWORK_ASSETS_QUERY_KEY,
  ARTWORK_CATEGORIES,
  ARTWORK_CATEGORY_LABELS,
  FALLBACK_ARTWORK_META,
  artworkAssetBlob,
  artworkAssetSource,
  deleteArtworkAsset,
  formatBytes,
  getArtworkAsset,
  getArtworkMeta,
  replaceArtworkAsset,
  setArtworkAssetEnabled,
  updateArtworkAsset,
  uploadArtworkAsset,
  type ArtworkAsset,
  type ArtworkAssetCategory,
  type ArtworkAssetReference,
} from '@/api/adminArtworkAssets';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import { ACCEPTED_UPLOAD_TYPES, assetSummary, describeUploadError } from './assetHelpers';
import { AssetGrid } from './AssetPickerDialog';

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const ACTION_LABELS: Record<string, string> = {
  upload: 'Uploaded',
  replace: 'Image replaced',
  update: 'Renamed or moved',
  disable: 'Disabled',
  enable: 'Enabled',
  delete: 'Deleted',
  reference_added: 'Now used by',
  reference_removed: 'No longer used by',
};

function referenceLink(ref: ArtworkAssetReference): { to: string; label: string } {
  if (ref.kind === 'boss') {
    return { to: `/admin/bosses/${encodeURIComponent(ref.key)}`, label: `Boss ${ref.name ?? ref.key}` };
  }
  return ref.kind === 'dungeon_zone'
    ? { to: `/admin/dungeons/zones/${ref.key}`, label: `Zone ${ref.name ?? ref.key}` }
    : {
        to: `/admin/enemies/${encodeURIComponent(ref.key)}`,
        label: `Enemy ${ref.name ?? ref.key}`,
      };
}

function References({ references }: { references: ArtworkAssetReference[] }) {
  if (references.length === 0) {
    return (
      <p className="text-xs text-ink-muted" data-testid="asset-references">
        Not used anywhere yet.
      </p>
    );
  }
  return (
    <ul className="space-y-0.5 text-xs" data-testid="asset-references">
      {references.map((ref) => {
        const { to, label } = referenceLink(ref);
        return (
          <li key={`${ref.kind}:${ref.key}:${ref.field}`}>
            <Link to={to} className="text-accent underline">
              {label}
            </Link>{' '}
            <span className="text-ink-muted">({ref.field})</span>
          </li>
        );
      })}
    </ul>
  );
}

function UploadCard({ onUploaded }: { onUploaded: (asset: ArtworkAsset) => void }) {
  const queryClient = useQueryClient();
  const meta =
    useQuery({
      queryKey: [...ARTWORK_ASSETS_QUERY_KEY, 'meta'],
      queryFn: ({ signal }) => getArtworkMeta(signal),
      staleTime: 300_000,
    }).data ?? FALLBACK_ARTWORK_META;
  const [category, setCategory] = useState<ArtworkAssetCategory>('dungeon_background');
  const [name, setName] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadArtworkAsset(file, { category, name }),
    onSuccess: (asset) => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ARTWORK_ASSETS_QUERY_KEY });
      onUploaded(asset);
    },
  });

  return (
    <Card className="space-y-3 p-4" data-testid="asset-upload">
      <div>
        <h2 className="text-sm font-semibold uppercase text-ink-muted">Upload</h2>
        <p className="mt-1 text-xs text-ink-muted">
          PNG, WebP or JPEG, up to {formatBytes(meta.maxBytes)} and {meta.maxDimension}px on the
          longest edge. Backgrounds look best at {meta.scene.width * 2}×{meta.scene.height * 2}{' '}
          (16:9); enemy sprites should be transparent PNG or WebP, cropped close, around{' '}
          {meta.scene.height * 2}px tall.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Category
          <select
            aria-label="Upload category"
            className={selectClass}
            value={category}
            onChange={(e) => setCategory(e.target.value as ArtworkAssetCategory)}
          >
            {ARTWORK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ARTWORK_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-48 flex-1 text-xs text-ink-muted">
          Name (optional)
          <Input
            aria-label="Upload name"
            placeholder="Defaults to the file name"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button
          type="button"
          variant="accent"
          disabled={upload.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {upload.isPending ? 'Uploading…' : 'Choose file…'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          className="sr-only"
          aria-label="Artwork file"
          data-testid="asset-upload-file"
          accept={ACCEPTED_UPLOAD_TYPES}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
      </div>
      {upload.isError && (
        <p className="text-xs text-danger" role="alert" data-testid="asset-upload-error">
          {describeUploadError(upload.error)}
        </p>
      )}
      {upload.isSuccess && (
        <p className="text-xs text-ink-muted" role="status" data-testid="asset-upload-done">
          Uploaded “{upload.data.name}”. It is selected below.
        </p>
      )}
    </Card>
  );
}

function ManagePanel({
  assetId,
  canWrite,
  onGone,
}: {
  assetId: string;
  canWrite: boolean;
  onGone: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: [...ARTWORK_ASSETS_QUERY_KEY, 'detail', assetId],
    queryFn: ({ signal }) => getArtworkAsset(assetId, signal),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ARTWORK_ASSETS_QUERY_KEY });
  const [name, setName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const rename = useMutation({
    mutationFn: (patch: { name?: string; category?: ArtworkAssetCategory }) =>
      updateArtworkAsset(assetId, patch),
    onSuccess: () => {
      setName(null);
      refresh();
    },
  });
  const replace = useMutation({
    mutationFn: (file: File) => replaceArtworkAsset(assetId, file),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setArtworkAssetEnabled(assetId, enabled),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteArtworkAsset(assetId),
    onSuccess: () => {
      refresh();
      onGone();
    },
    onSettled: () => setConfirmDelete(false),
  });

  if (detail.isError)
    return (
      <ErrorState
        variant="inline"
        showReason
        title="Could not load this artwork"
        error={detail.error}
      />
    );
  if (!detail.data) return <p className="text-xs text-ink-muted">Loading…</p>;
  const { asset, references, events } = detail.data;
  const inUse =
    isPortalApiError(remove.error) && remove.error.code === 'ARTWORK_ASSET_IN_USE'
      ? ((remove.error.details as { references?: ArtworkAssetReference[] } | undefined)
          ?.references ?? references)
      : null;

  return (
    <Card className="space-y-3 p-4" data-testid="asset-manage">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Manage</h2>
          <p className="mt-1 text-sm text-ink" data-testid="asset-manage-name">
            {asset.name}
            {asset.status === 'disabled' && (
              <span className="ml-2 text-xs text-danger">Disabled</span>
            )}
          </p>
          <p className="text-xs text-ink-muted" data-testid="asset-manage-meta">
            {ARTWORK_CATEGORY_LABELS[asset.category]} · {assetSummary(asset)} · version{' '}
            {asset.version}
          </p>
          <p className="text-xs text-ink-subtle">
            File “{asset.originalFilename}” · updated {formatWhen(asset.updatedAt)}
            {asset.updatedBy ? ` by ${asset.updatedBy}` : ''}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(asset.id);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy asset ID'}
        </Button>
      </div>

      <AuthoredArtwork
        source={artworkAssetSource(asset)}
        load={artworkAssetBlob}
        className="flex h-64 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface-sunken"
        testIdPrefix="asset-manage-preview"
        emptyLabel=""
        missingLabel={() => 'The stored file is missing. Replace the image to repair this asset.'}
        alt={() => asset.name}
      />

      {canWrite && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-48 flex-1 text-xs text-ink-muted">
              Name
              <Input
                aria-label="Asset name"
                maxLength={100}
                value={name ?? asset.name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                rename.isPending ||
                name === null ||
                name.trim() === '' ||
                name.trim() === asset.name
              }
              onClick={() => rename.mutate({ name: name!.trim() })}
            >
              Rename
            </Button>
            <label className="text-xs text-ink-muted">
              Category
              <select
                aria-label="Asset category"
                className={selectClass}
                value={asset.category}
                disabled={rename.isPending}
                onChange={(e) =>
                  rename.mutate({ category: e.target.value as ArtworkAssetCategory })
                }
              >
                {ARTWORK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {ARTWORK_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={replace.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {replace.isPending ? 'Replacing…' : 'Replace image…'}
            </Button>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              aria-label="Replacement file"
              data-testid="asset-replace-file"
              accept={ACCEPTED_UPLOAD_TYPES}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) replace.mutate(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(asset.status !== 'active')}
            >
              {asset.status === 'active' ? 'Disable' : 'Enable'}
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Delete permanently
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={references.length > 0}
                title={
                  references.length > 0
                    ? 'Clear every reference first, or disable it instead'
                    : undefined
                }
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-subtle">
            Replacing keeps this asset, so everything using it shows the new image. Disabling keeps
            the file but makes whatever uses it fall back to its shipped artwork.
          </p>
          {replace.isError && (
            <p className="text-xs text-danger" role="alert" data-testid="asset-replace-error">
              {describeUploadError(replace.error)}
            </p>
          )}
          {replace.isSuccess && (
            <p className="text-xs text-ink-muted" role="status" data-testid="asset-replace-done">
              Image replaced — now version {replace.data.version}.
            </p>
          )}
          {toggle.isSuccess &&
            toggle.data.asset.status === 'disabled' &&
            toggle.data.references.length > 0 && (
              <p
                className="text-xs text-ink-muted"
                role="status"
                data-testid="asset-disabled-notice"
              >
                Disabled. {toggle.data.references.length} place(s) now show their shipped artwork
                instead.
              </p>
            )}
          {inUse && (
            <div className="text-xs text-danger" role="alert" data-testid="asset-in-use">
              This artwork is still in use and was not deleted. Clear it from:
              <References references={inUse} />
            </div>
          )}
          {remove.isError && !inUse && (
            <ErrorState variant="inline" showReason title="Could not delete" error={remove.error} />
          )}
          {rename.isError && (
            <ErrorState variant="inline" showReason title="Could not save" error={rename.error} />
          )}
          {toggle.isError && (
            <ErrorState
              variant="inline"
              showReason
              title="Could not change status"
              error={toggle.error}
            />
          )}
        </>
      )}

      <div>
        <h3 className="text-xs font-semibold uppercase text-ink-muted">Used by</h3>
        <References references={references} />
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase text-ink-muted">History</h3>
        <ul className="space-y-0.5 text-xs text-ink-muted" data-testid="asset-history">
          {events.map((event) => (
            <li key={event.id}>
              {formatWhen(event.createdAt)} — {ACTION_LABELS[event.action] ?? event.action}
              {typeof event.details.entity === 'string' ? ` ${event.details.entity}` : ''}
              {event.actor ? ` · ${event.actor}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function ArtworkAssetsPage() {
  const canWrite = useHasPermission('artwork.write');
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Artwork Assets"
        description="Images uploaded here are used by dungeon zones and enemies straight away — no commit or deploy. Artwork shipped in Git stays where it is and remains the fallback."
      />
      {canWrite && <UploadCard onUploaded={(asset) => setSelected(asset.id)} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex max-h-[70vh] min-h-64 flex-col gap-3 p-4" data-testid="asset-browse">
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Browse</h2>
          <AssetGrid
            includeDisabled
            selectedId={selected}
            onSelect={(asset) => setSelected(asset.id)}
          />
        </Card>
        {selected ? (
          <ManagePanel
            key={selected}
            assetId={selected}
            canWrite={canWrite}
            onGone={() => setSelected(null)}
          />
        ) : (
          <Card className="p-4 text-sm text-ink-muted" data-testid="asset-manage-empty">
            Select an image to see where it is used, replace it, or remove it.
          </Card>
        )}
      </div>
    </div>
  );
}
