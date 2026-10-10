/**
 * The Artwork section of the boss editor.
 *
 * A boss shows one of two kinds of picture, and the form holds both:
 *
 *   - **Shipped** (`artwork`) — a file in Git under `assets/bosses/`, picked by
 *     path. It is listed here and never uploaded or deleted here.
 *   - **Uploaded** (`artworkAssetId`) — an image added through this page. While
 *     one is chosen it is what players see; the shipped path stays behind it as
 *     the fallback, so clearing the upload goes back to the shipped file.
 *
 * Choosing or uploading only changes the form: the boss shows the new picture
 * once it is saved, and an encounter already drawn keeps the one it froze.
 * Deleting an upload is refused while any boss still shows it.
 *
 * Without `bosses.write` everything here is visible and nothing can be changed.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  BOSSES_QUERY_KEY,
  deleteBossArtwork,
  getBossArtworkLibrary,
  uploadBossArtwork,
  type BossArtworkInUseDetails,
  type BossArtworkLibrary,
  type BossArtworkUser,
  type BossIssue,
} from '@/api/adminBosses';
import { isPortalApiError } from '@/api/client';
import { ErrorState } from '@/components/layout/ErrorState';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import { bossArtworkSource, bossPath, issuesAt, loadBossArtwork, type BossForm } from './bossModel';
import { BossIssues, Section } from './bossParts';

export const BOSS_ARTWORK_LIBRARY_KEY = [...BOSSES_QUERY_KEY, 'artwork-library'] as const;

const FALLBACK_TYPES = ['image/webp', 'image/png', 'image/jpeg'];
const TILE_FRAME =
  'flex h-24 w-full items-center justify-center overflow-hidden rounded border border-border bg-surface-sunken text-[10px] text-ink-subtle';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What went wrong with an upload, in the server's own words where it has some. */
function describeUploadError(error: unknown, maxBytes: number | undefined): string {
  if (isPortalApiError(error)) {
    if (error.status === 413) {
      return `That file is too large${maxBytes ? ` — the limit is ${formatBytes(maxBytes)}` : ''}.`;
    }
    if (error.status === 403) return 'You do not have permission to upload boss artwork.';
    if (error.code === 'ARTWORK_UPLOAD_INVALID') return error.message;
  }
  return 'The upload failed. Try again in a moment.';
}

/** Why a delete was refused: the bosses (or the open encounter) that still show the image. */
function describeDeleteError(error: unknown): string {
  if (isPortalApiError(error) && error.code === 'ARTWORK_ASSET_IN_USE') {
    const references = ((error.details ?? {}) as BossArtworkInUseDetails).references ?? [];
    const names = [
      ...new Set(
        references.map((r) =>
          r.field.startsWith('liveEncounter')
            ? `an encounter of ${r.name ?? r.key} that is still open`
            : (r.name ?? r.key),
        ),
      ),
    ];
    return names.length > 0
      ? `Still in use by ${names.join(', ')}. Give ${names.length === 1 ? 'it' : 'them'} other artwork first.`
      : 'That artwork is still in use.';
  }
  if (isPortalApiError(error) && error.status === 403) {
    return 'You do not have permission to delete boss artwork.';
  }
  return 'Could not delete that artwork. Try again in a moment.';
}

/** "Used by A, B" with links, or "Not used by any boss". */
function UsedBy({ users, testId }: { users: BossArtworkUser[]; testId: string }) {
  if (users.length === 0) {
    return (
      <p className="text-[11px] text-ink-subtle" data-testid={testId}>
        Not used by any boss
      </p>
    );
  }
  return (
    <p className="text-[11px] text-ink-muted" data-testid={testId}>
      Used by{' '}
      {users.map((user, i) => (
        <span key={user.id}>
          {i > 0 && ', '}
          <Link to={bossPath(user.id)} className="text-accent underline">
            {user.name}
          </Link>
        </span>
      ))}
    </p>
  );
}

export function BossArtworkSection({
  form,
  set,
  readOnly,
  shippedPaths,
  managed,
  issues,
}: {
  form: BossForm;
  set: (patch: Partial<BossForm>) => void;
  readOnly: boolean;
  /** Shipped artwork paths from the editor's reference data. */
  shippedPaths: readonly string[];
  /** Whether this server stores uploaded boss artwork. */
  managed: boolean;
  issues: BossIssue[];
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** The upload a second click will delete. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);

  const libraryQuery = useQuery({
    queryKey: BOSS_ARTWORK_LIBRARY_KEY,
    queryFn: ({ signal }) => getBossArtworkLibrary(signal),
    enabled: managed,
  });
  const library: BossArtworkLibrary | undefined = libraryQuery.data;
  const limits = library?.limits;
  const refreshLibrary = () =>
    void queryClient.invalidateQueries({ queryKey: BOSS_ARTWORK_LIBRARY_KEY });

  const upload = useMutation({
    mutationFn: (file: File) => uploadBossArtwork(file),
    onSuccess: (asset) => {
      setUploadError(null);
      // Chosen at once: the author uploaded it for this boss.
      set({ artworkAssetId: asset.id });
      refreshLibrary();
    },
    onError: (error) => setUploadError(describeUploadError(error, limits?.maxBytes)),
  });

  const remove = useMutation({
    mutationFn: (assetId: string) => deleteBossArtwork(assetId),
    onSuccess: () => {
      setDeleteError(null);
      setConfirming(null);
      refreshLibrary();
    },
    onError: (error, assetId) => {
      setConfirming(null);
      setDeleteError({ id: assetId, message: describeDeleteError(error) });
      refreshLibrary();
    },
  });

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    if (limits && file.size > limits.maxBytes) {
      setUploadError(`That file is too large — the limit is ${formatBytes(limits.maxBytes)}.`);
      return;
    }
    upload.mutate(file);
  };

  // What the boss already names stays selectable even if this server no longer offers it.
  const shippedOptions = [...new Set([...shippedPaths, ...(form.artwork ? [form.artwork] : [])])];
  const chosenUpload = library?.managed.find((m) => m.asset.id === form.artworkAssetId);
  const source = bossArtworkSource(form);
  const at = (...paths: string[]) => paths.flatMap((p) => issuesAt(issues, p));

  return (
    <Section
      title="Artwork"
      hint="The picture on the boss's announcement. A boss without artwork is announced without one."
      testId="boss-artwork"
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="space-y-3">
          <div data-testid="boss-artwork-current">
            <p className="text-xs text-ink-muted">Shown to players</p>
            {form.artworkAssetId !== '' ? (
              <p className="text-sm text-ink">
                <Badge variant="default">Uploaded</Badge>{' '}
                <span data-testid="boss-artwork-current-name">
                  {chosenUpload?.asset.name ?? 'Uploaded artwork'}
                </span>
                <span
                  className="block font-mono text-[11px] text-ink-subtle"
                  data-testid="boss-artwork-identifier"
                >
                  {form.artworkAssetId}
                </span>
              </p>
            ) : form.artwork !== '' ? (
              <p className="text-sm text-ink">
                <Badge variant="outline">Shipped</Badge>{' '}
                <span className="font-mono text-xs" data-testid="boss-artwork-identifier">
                  {form.artwork}
                </span>
              </p>
            ) : (
              <p className="text-sm text-ink-muted" data-testid="boss-artwork-identifier">
                No artwork
              </p>
            )}
          </div>

          {managed && (
            <div className="space-y-1">
              <p className="text-xs text-ink-muted">Uploaded artwork</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-expanded={libraryOpen}
                  onClick={() => setLibraryOpen(!libraryOpen)}
                >
                  {libraryOpen ? 'Hide artwork library' : 'Browse artwork library'}
                </Button>
                {!readOnly && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={upload.isPending}
                      onClick={() => fileInput.current?.click()}
                    >
                      {upload.isPending ? 'Uploading…' : 'Upload new artwork'}
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      className="sr-only"
                      aria-label="Upload boss artwork"
                      accept={(limits?.mimeTypes ?? FALLBACK_TYPES).join(',')}
                      onChange={(e) => {
                        pickFile(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                    {form.artworkAssetId !== '' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => set({ artworkAssetId: '' })}
                      >
                        Clear uploaded artwork
                      </Button>
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-ink-subtle">
                WebP, PNG or JPEG
                {limits ? `, up to ${formatBytes(limits.maxBytes)}` : ''}. Uploads are stored on
                this server (not in Git) as WebP
                {limits ? `, at most ${limits.storedMaxEdge}px on the longest edge` : ''}. An
                uploaded image is shown instead of the shipped file.
              </p>
              {uploadError && (
                <p
                  className="text-xs text-danger"
                  role="alert"
                  data-testid="boss-artwork-upload-error"
                >
                  {uploadError}
                </p>
              )}
              <BossIssues issues={at('artworkAssetId')} testId="boss-artwork-asset-issues" />
            </div>
          )}

          <div>
            <label className="block text-xs text-ink-muted">
              Shipped artwork{managed && form.artworkAssetId !== '' ? ' (fallback)' : ''}
              <select
                aria-label="Boss artwork"
                className={selectClass}
                value={form.artwork}
                disabled={readOnly}
                onChange={(e) => set({ artwork: e.target.value })}
              >
                <option value="">No artwork</option>
                {shippedOptions.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-xs text-ink-subtle">
              Files shipped under <span className="font-mono">assets/bosses/</span>.
              {managed && form.artworkAssetId !== ''
                ? ' Used only if the uploaded image is disabled or lost.'
                : ''}
            </p>
            <BossIssues issues={at('artwork')} testId="boss-artwork-issues" />
          </div>
        </div>

        <AuthoredArtwork
          source={source}
          load={loadBossArtwork}
          testIdPrefix="boss-artwork-preview"
          emptyLabel="No artwork chosen"
          missingLabel={() =>
            form.artworkAssetId !== ''
              ? 'That uploaded image is not available on this server.'
              : `No file at ${form.artwork} on this server.`
          }
          alt={() => `${form.name || 'Boss'} artwork`}
        />
      </div>

      {managed && libraryOpen && (
        <div className="space-y-3 border-t border-border pt-3" data-testid="boss-artwork-library">
          {libraryQuery.isPending && <Skeleton className="h-24 w-full" />}
          {libraryQuery.isError && (
            <ErrorState
              variant="inline"
              title="Could not load the artwork library"
              error={libraryQuery.error}
            />
          )}
          {library && (
            <>
              <div>
                <h3 className="text-xs font-semibold uppercase text-ink-muted">Uploaded</h3>
                {library.managed.length === 0 ? (
                  <p className="text-xs text-ink-muted" data-testid="boss-artwork-library-empty">
                    Nothing has been uploaded yet.
                  </p>
                ) : (
                  <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {library.managed.map(({ asset, usedBy }) => {
                      const selected = form.artworkAssetId === asset.id;
                      const inUse = usedBy.length > 0;
                      return (
                        <li
                          key={asset.id}
                          className="space-y-1 rounded border border-border p-2"
                          data-testid={`boss-artwork-asset-${asset.id}`}
                        >
                          <AuthoredArtwork
                            source={bossArtworkSource({ artworkAssetId: asset.id })}
                            load={loadBossArtwork}
                            className={TILE_FRAME}
                            testIdPrefix={`boss-artwork-tile-${asset.id}`}
                            emptyLabel="No image"
                            missingLabel={() => 'File missing'}
                            alt={() => asset.name}
                          />
                          <p className="truncate text-xs font-medium text-ink" title={asset.name}>
                            {asset.name}
                            {selected && (
                              <Badge variant="default" className="ml-1">
                                Selected
                              </Badge>
                            )}
                            {asset.status === 'disabled' && (
                              <Badge variant="danger" className="ml-1">
                                Disabled
                              </Badge>
                            )}
                          </p>
                          <p className="text-[11px] text-ink-subtle">
                            {asset.width}×{asset.height} · {formatBytes(asset.fileSize)}
                          </p>
                          <UsedBy users={usedBy} testId={`boss-artwork-usage-${asset.id}`} />
                          {!readOnly && (
                            <div className="flex flex-wrap gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={selected}
                                aria-label={`Use ${asset.name}`}
                                onClick={() => set({ artworkAssetId: asset.id })}
                              >
                                {selected ? 'In use here' : 'Use'}
                              </Button>
                              {confirming === asset.id ? (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="danger"
                                    disabled={remove.isPending}
                                    aria-label={`Confirm delete ${asset.name}`}
                                    onClick={() => remove.mutate(asset.id)}
                                  >
                                    Delete permanently
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setConfirming(null)}
                                  >
                                    Cancel
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={inUse || selected}
                                  aria-label={`Delete ${asset.name}`}
                                  title={
                                    inUse
                                      ? 'In use — give those bosses other artwork first.'
                                      : selected
                                        ? 'Selected on this boss — clear it first.'
                                        : undefined
                                  }
                                  onClick={() => {
                                    setDeleteError(null);
                                    setConfirming(asset.id);
                                  }}
                                >
                                  Delete
                                </Button>
                              )}
                            </div>
                          )}
                          {deleteError?.id === asset.id && (
                            <p
                              className="text-[11px] text-danger"
                              role="alert"
                              data-testid="boss-artwork-delete-error"
                            >
                              {deleteError.message}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase text-ink-muted">
                  Shipped with the game
                </h3>
                <p className="text-[11px] text-ink-subtle">
                  These files live in Git. They change with a deploy and cannot be deleted here.
                </p>
                <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {library.shipped.map(({ path, exists, usedBy }) => {
                    const selected = form.artwork === path;
                    return (
                      <li
                        key={path}
                        className="space-y-1 rounded border border-border p-2"
                        data-testid={`boss-artwork-shipped-${path}`}
                      >
                        <AuthoredArtwork
                          source={exists ? path : null}
                          load={loadBossArtwork}
                          className={TILE_FRAME}
                          testIdPrefix={`boss-artwork-shipped-tile-${path}`}
                          emptyLabel="No file on this server"
                          missingLabel={() => 'File missing'}
                          alt={() => path}
                        />
                        <p className="truncate font-mono text-[11px] text-ink" title={path}>
                          {path}
                          {selected && (
                            <Badge variant="outline" className="ml-1">
                              Selected
                            </Badge>
                          )}
                        </p>
                        <UsedBy users={usedBy} testId={`boss-artwork-shipped-usage-${path}`} />
                        {!readOnly && exists && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={selected}
                            aria-label={`Use shipped ${path}`}
                            onClick={() => set({ artwork: path })}
                          >
                            {selected ? 'In use here' : 'Use'}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
