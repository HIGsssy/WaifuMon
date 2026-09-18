/**
 * The admin artwork picker: browse or search existing authored artwork and
 * pick one file, returning its canonical relative path
 * (`results/hunt/purse-01.webp`).
 *
 * Shared Portal admin infrastructure. It knows nothing about the screen that
 * opened it — no presentation keys, no artwork modes, no encounter fields.
 * What it may see is decided entirely by the {@link ArtworkSource} it is
 * given: that consumer's permission-gated routes, rooted by the server at the
 * folders that consumer owns. The Portal never chooses which folders are
 * exposed.
 *
 * Browse + select only. Nothing here uploads, renames, moves or deletes.
 *
 *   - One folder at a time (the server never returns the whole tree); folders
 *     first, then images, with breadcrumbs and an Up button.
 *   - A debounced search over file names and folder names; clearing it
 *     returns to the folder that was open.
 *   - Thumbnails load lazily, only for cards near the viewport, through the
 *     consumer's existing artwork route. A broken image is a placeholder in
 *     its own card.
 *   - Opened with a current path, it starts in that file's folder and marks
 *     the file. If that folder has gone, it falls back to the top level and
 *     says so; the caller's field is untouched until something is picked.
 */
import { useEffect, useId, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ArrowUp, Folder, Search, X } from 'lucide-react';

import type {
  ArtworkFile,
  ArtworkFolder,
  ArtworkSearchResults,
  ArtworkSource,
} from '@/api/adminArtwork';
import { isPortalApiError } from '@/api/client';
import { ArtworkThumbnail } from '@/components/media/ArtworkThumbnail';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

/** How long typing settles before a search is sent. */
export const ARTWORK_SEARCH_DEBOUNCE_MS = 250;

/** The folder part of a relative path, or undefined when there is none. */
function folderOf(path: string | null | undefined): string | undefined {
  const trimmed = path?.trim() ?? '';
  const slash = trimmed.lastIndexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : undefined;
}

/** An author-facing sentence for a failed request. */
function describeError(error: unknown): string {
  if (isPortalApiError(error)) {
    if (error.status === 403) return 'You do not have permission to browse this artwork.';
    if (error.isTransportError) return 'Could not reach the server. Try again in a moment.';
    if (error.message) return error.message;
  }
  return 'Something went wrong loading artwork.';
}

/** A 400 or 404 — the folder is bad or gone, as opposed to the API failing. */
function isMissingFolder(error: unknown): boolean {
  return isPortalApiError(error) && (error.status === 404 || error.status === 400);
}

export interface ArtworkBrowserProps {
  /** The consumer's picker routes. */
  source: ArtworkSource;
  /** The path currently in the caller's field, if any. */
  selectedPath: string | null;
  /** A file was chosen. Receives its canonical relative path. */
  onSelect: (path: string) => void;
}

export function ArtworkBrowser({ source, selectedPath, onSelect }: ArtworkBrowserProps) {
  const ids = useId();
  const current = selectedPath?.trim() || null;
  const initialFolder = folderOf(current);

  const [folder, setFolder] = useState<string | undefined>(initialFolder);
  const [fellBackFrom, setFellBackFrom] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query.trim(), ARTWORK_SEARCH_DEBOUNCE_MS);
  const searching = query.trim() !== '' && debounced !== '';

  const listing = useQuery({
    queryKey: ['admin', 'artwork-picker', source.scope, 'browse', folder ?? ''],
    queryFn: ({ signal }) => source.browse(folder, signal),
    enabled: !searching,
    retry: false,
  });

  const results = useQuery({
    queryKey: ['admin', 'artwork-picker', source.scope, 'search', debounced],
    queryFn: ({ signal }) => source.search(debounced, signal),
    enabled: searching,
    retry: false,
  });

  // The current file's folder is a best guess: if it has been moved or
  // deleted, open the top level instead of stranding the author on an error.
  useEffect(() => {
    if (
      folder !== undefined &&
      folder === initialFolder &&
      fellBackFrom === null &&
      listing.isError &&
      isMissingFolder(listing.error)
    ) {
      setFellBackFrom(folder);
      setFolder(undefined);
    }
  }, [folder, initialFolder, fellBackFrom, listing.isError, listing.error]);

  const open = (next: string | null | undefined) => {
    setFolder(next ? next : undefined);
  };

  const dir = listing.data;
  const breadcrumbs = dir?.breadcrumbs ?? [];
  const multiRoot = dir ? dir.path === '' || dir.parent === '' : false;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="artwork-browser">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
          aria-hidden
        />
        <label htmlFor={`${ids}-search`} className="sr-only">
          Search artwork
        </label>
        <Input
          id={`${ids}-search`}
          type="search"
          className="pr-10 pl-9"
          placeholder="Search by file or folder name…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        {query !== '' && (
          <button
            type="button"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-muted hover:text-ink"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {current && (
        <p className="truncate text-xs text-ink-muted" data-testid="artwork-browser-current">
          Current: <code>{current}</code>
        </p>
      )}
      {fellBackFrom !== null && !searching && (
        <p role="status" className="text-xs text-ink-muted" data-testid="artwork-browser-fallback">
          The folder <code>{fellBackFrom}</code> could not be opened — the current artwork may have
          been moved or deleted. Showing the top level instead; your path is unchanged until you
          pick something.
        </p>
      )}

      {searching ? (
        <SearchResults
          query={debounced}
          state={results}
          source={source}
          current={current}
          onSelect={onSelect}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!dir || dir.parent === null}
              onClick={() => open(dir?.parent)}
              aria-label="Up one folder"
            >
              <ArrowUp /> Up
            </Button>
            <nav aria-label="Folder" className="min-w-0 flex-1">
              <ol
                className="flex flex-wrap items-center gap-1 text-sm"
                data-testid="artwork-breadcrumbs"
              >
                {multiRoot && (
                  <li>
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => open(undefined)}
                    >
                      All artwork
                    </button>
                  </li>
                )}
                {breadcrumbs.map((crumb, i) => {
                  const last = i === breadcrumbs.length - 1;
                  return (
                    <li key={crumb.path} className="flex items-center gap-1">
                      {(i > 0 || multiRoot) && <span className="text-ink-muted">/</span>}
                      {last ? (
                        <span aria-current="page" className="font-medium">
                          {crumb.name}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={() => open(crumb.path)}
                        >
                          {crumb.name}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listing.isPending ? (
              <p className="py-8 text-center text-sm text-ink-muted">Loading artwork…</p>
            ) : listing.isError ? (
              isMissingFolder(listing.error) &&
              folder === initialFolder &&
              fellBackFrom === null ? (
                <p className="py-8 text-center text-sm text-ink-muted">Loading artwork…</p>
              ) : (
                <div
                  role="alert"
                  className="space-y-2 py-8 text-center text-sm"
                  data-testid="artwork-browser-error"
                >
                  <p className="text-danger">{describeError(listing.error)}</p>
                  {folder !== undefined && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => open(undefined)}
                    >
                      Go to the top level
                    </Button>
                  )}
                </div>
              )
            ) : dir && dir.directories.length === 0 && dir.files.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-muted">This folder has no artwork.</p>
            ) : dir ? (
              <ul
                className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
                data-testid="artwork-grid"
              >
                {dir.directories.map((d) => (
                  <li key={d.path}>
                    <FolderCard folder={d} onOpen={() => open(d.path)} />
                  </li>
                ))}
                {dir.files.map((f) => (
                  <li key={f.path}>
                    <FileCard file={f} source={source} current={current} onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function SearchResults({
  query,
  state,
  source,
  current,
  onSelect,
}: {
  query: string;
  state: UseQueryResult<ArtworkSearchResults>;
  source: ArtworkSource;
  current: string | null;
  onSelect: (path: string) => void;
}) {
  if (state.isPending) {
    return <p className="py-8 text-center text-sm text-ink-muted">Searching…</p>;
  }
  if (state.isError) {
    return (
      <p
        role="alert"
        className="py-8 text-center text-sm text-danger"
        data-testid="artwork-search-error"
      >
        Search failed: {describeError(state.error)}
      </p>
    );
  }
  const { results, truncated, limit } = state.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-xs text-ink-muted" role="status" data-testid="artwork-search-summary">
        {results.length === 0
          ? `No artwork matches “${query}”.`
          : truncated
            ? `Showing the first ${limit} matches for “${query}” — more exist. Refine your search to narrow them down.`
            : `${results.length} match${results.length === 1 ? '' : 'es'} for “${query}”.`}
      </p>
      {results.length > 0 && (
        <ul
          className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 md:grid-cols-4"
          data-testid="artwork-search-results"
        >
          {results.map((f) => (
            <li key={f.path}>
              <FileCard file={f} source={source} current={current} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FolderCard({ folder, onOpen }: { folder: ArtworkFolder; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-md border border-border bg-surface-raised p-3 text-sm hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      data-testid={`artwork-folder-${folder.path}`}
      aria-label={`Open folder ${folder.name}`}
    >
      <Folder className="size-8 text-ink-muted" aria-hidden />
      <span className="w-full truncate text-center font-medium" title={folder.name}>
        {folder.name}
      </span>
    </button>
  );
}

function FileCard({
  file,
  source,
  current,
  onSelect,
}: {
  file: ArtworkFile;
  source: ArtworkSource;
  current: string | null;
  onSelect: (path: string) => void;
}) {
  const selected = current === file.path;
  return (
    <button
      type="button"
      onClick={() => onSelect(file.path)}
      aria-pressed={selected}
      aria-label={`Use ${file.path}`}
      className={cn(
        'flex h-full w-full flex-col gap-1.5 rounded-md border p-2 text-left hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        selected ? 'border-accent bg-accent-soft' : 'border-border',
      )}
      data-testid={`artwork-file-${file.path}`}
    >
      <ArtworkThumbnail path={file.path} load={source.loadImage} alt={file.name} />
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-sm font-medium" title={file.name}>
          {file.name}
        </span>
        {selected && (
          <span className="shrink-0 rounded bg-accent px-1 text-[10px] font-semibold text-accent-ink">
            Current
          </span>
        )}
      </span>
      <span className="truncate text-xs text-ink-muted" title={file.path}>
        {file.folder}/
      </span>
    </button>
  );
}

export interface ArtworkPickerDialogProps extends ArtworkBrowserProps {
  open: boolean;
  /** Close without choosing (Cancel, Escape, the close button). */
  onClose: () => void;
  title?: string;
}

/**
 * {@link ArtworkBrowser} in a modal. Picking a file calls `onSelect` and then
 * `onClose`; the browser's state is discarded on close, so each opening starts
 * from the caller's current path.
 */
export function ArtworkPickerDialog({
  open,
  onClose,
  onSelect,
  title = 'Browse artwork',
  ...browser
}: ArtworkPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Close artwork browser">
        <div className="flex h-[min(85vh,52rem)] w-full max-w-4xl flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-lg">
          <div>
            <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
            <DialogDescription className="text-xs text-ink-muted">
              Pick an image already on the server. Nothing is saved until you save the form.
            </DialogDescription>
          </div>
          <ArtworkBrowser
            {...browser}
            onSelect={(path) => {
              onSelect(path);
              onClose();
            }}
          />
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
