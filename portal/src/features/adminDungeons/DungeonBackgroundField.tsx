/**
 * One picture a dungeon uses, as an author manages it:
 *
 *     Choose  →  see it  →  Replace or Clear
 *
 * The preview is fetched through the same lookup a run uses, so a picture that
 * shows here is one players get — and one that cannot be found says so, in
 * words, instead of pretending to be set. Where the stored reference lives
 * (an uploaded image named by its content, or a file shipped with the game)
 * is under "Details"; choosing never needs it.
 *
 * Choosing an upload stores `{ kind: 'managed', category, contentHash, name }`,
 * the portable reference validation and gameplay expect. Nothing is rewritten
 * by looking: the stored reference changes only on Choose, Clear or an edit
 * under Details.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  dungeonArtworkBlob,
  dungeonArtworkSource,
  managedDungeonArtworkBlob,
  type DungeonArtworkRef,
} from '@/api/adminDungeons';
import type { ArtworkAssetCategory } from '@/api/adminArtworkAssets';
import { useHasPermission } from '@/auth/useSession';
import { ArtworkPickerDialog } from '@/components/admin/ArtworkPicker';
import { LoadedArtwork } from '@/components/media/LoadedArtwork';
import { dungeonArtworkSource as shippedDungeonArtwork } from '@/components/admin/artworkSources';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AssetPickerDialog } from '@/features/adminArtwork/AssetPickerDialog';

type Preview = { state: 'none' | 'loading' | 'missing' } | { state: 'shown'; url: string };

function usePreview(ref: DungeonArtworkRef | null | undefined): Preview {
  const source = dungeonArtworkSource(ref);
  const [preview, setPreview] = useState<Preview>({ state: source ? 'loading' : 'none' });
  useEffect(() => {
    if (!source) {
      setPreview({ state: 'none' });
      return;
    }
    setPreview({ state: 'loading' });
    let url: string | null = null;
    let cancelled = false;
    // Fetched the way a run finds it: a shipped file by path, an upload by its content.
    void (
      ref?.kind === 'shipped'
        ? dungeonArtworkBlob(ref.path)
        : managedDungeonArtworkBlob(ref!.category, ref!.contentHash)
    )
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreview({ state: 'shown', url });
      })
      .catch(() => {
        if (!cancelled) setPreview({ state: 'missing' });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // `source` is the reference's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  return preview;
}

const pictureName = (ref: DungeonArtworkRef) =>
  ref.kind === 'managed'
    ? (ref.name ?? 'Uploaded picture')
    : (ref.path.split('/').pop() ?? ref.path);

export function DungeonBackgroundField({
  label,
  hint,
  testId,
  value,
  category,
  inherited,
  disabled,
  onChange,
}: {
  /** `Scene background`, `Dungeon artwork`, `Room background`. */
  label: string;
  /** Where players see it. */
  hint: string;
  testId: string;
  value: DungeonArtworkRef | null | undefined;
  /** The kind of upload the picker opens on. */
  category: ArtworkAssetCategory;
  /** For a room: the dungeon-wide picture it shows while it has none of its own. */
  inherited?: { from: string; value: DungeonArtworkRef | null | undefined } | undefined;
  disabled: boolean;
  onChange: (ref: DungeonArtworkRef | null) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [files, setFiles] = useState(false);
  const [details, setDetails] = useState(false);
  const canBrowse = useHasPermission('artwork.read');
  const own = value ?? null;
  const shown = own ?? inherited?.value ?? null;
  const preview = usePreview(shown);
  const lower = label.toLowerCase();
  const status = own
    ? preview.state === 'missing'
      ? null
      : inherited
        ? `This room has its own background: ${pictureName(own)}.`
        : pictureName(own)
    : inherited
      ? inherited.value
        ? `Uses ${inherited.from}. Choose a picture to give this room its own.`
        : `No background yet: neither this room nor ${inherited.from} has one.`
      : 'Not set.';
  return (
    <div className="space-y-2" data-testid={testId}>
      <div>
        <span className="text-sm font-medium">{label}</span>
        <p className="text-xs text-ink-muted">{hint}</p>
      </div>
      <div
        className={`flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border bg-surface-sunken ${preview.state === 'missing' ? 'border-danger' : 'border-border'}`}
      >
        {preview.state === 'shown' && (
          <LoadedArtwork
            url={preview.url}
            alt={`${label}: ${shown ? pictureName(shown) : ''}`}
            className={`h-full w-full object-cover ${own ? '' : 'opacity-60'}`}
            testId={`${testId}-image`}
          />
        )}
        {preview.state === 'loading' && <span className="text-xs text-ink-muted">Loading…</span>}
        {preview.state === 'none' && (
          <span className="px-3 text-center text-xs text-ink-muted">No picture</span>
        )}
        {preview.state === 'missing' && (
          <span className="px-3 text-center text-xs text-danger" role="alert">
            This picture can’t be found on this server, so players won’t see it.
          </span>
        )}
      </div>
      {status && (
        <p className="text-xs text-ink-muted" data-testid={`${testId}-status`}>
          {status}
        </p>
      )}
      {preview.state === 'missing' && shown && (
        <p className="text-xs text-ink-muted" data-testid={`${testId}-missing`}>
          {shown.kind === 'managed'
            ? `“${pictureName(shown)}” was removed or switched off in Artwork, or this dungeon came from another server. Choose a picture again, or clear it.`
            : `No file named “${pictureName(shown)}” is shipped with the game here. Choose a picture, or clear it.`}
          {!own && inherited ? ` (It comes from ${inherited.from}.)` : ''}
        </p>
      )}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          {canBrowse && (
            <Button
              variant="outline"
              size="sm"
              aria-label={`${own ? 'Replace' : 'Choose'} ${lower}`}
              onClick={() => setPicker(true)}
            >
              {own ? 'Replace…' : 'Choose…'}
            </Button>
          )}
          {own && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Clear ${lower}`}
              onClick={() => onChange(null)}
            >
              {inherited ? `Use ${inherited.from}` : 'Clear'}
            </Button>
          )}
        </div>
      )}
      {!canBrowse && !disabled && (
        <p className="text-xs text-ink-muted">
          Choosing uploaded pictures needs access to Artwork.
        </p>
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={details}
          aria-label={`${label} details`}
          onClick={() => setDetails(!details)}
        >
          {details ? <ChevronDown /> : <ChevronRight />} Details
        </Button>
        {details && (
          <div className="mt-1 space-y-2 rounded-md border border-border p-2 text-xs">
            {!own && <p className="text-ink-muted">Nothing is stored for this picture.</p>}
            {own?.kind === 'managed' && (
              <dl className="space-y-1">
                <div>
                  <dt className="inline text-ink-muted">Uploaded picture: </dt>
                  <dd className="inline">{own.name ?? 'unnamed'}</dd>
                </div>
                <div>
                  <dt className="inline text-ink-muted">Library: </dt>
                  <dd className="inline">{own.category}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Content fingerprint</dt>
                  <dd className="font-mono break-all">{own.contentHash}</dd>
                </div>
              </dl>
            )}
            {own?.kind === 'shipped' && (
              <p className="text-ink-muted">A file shipped with the game, under assets/.</p>
            )}
            <label className="block space-y-1">
              <span className="text-ink-muted">
                {own?.kind === 'shipped' ? 'File path' : 'Use a file shipped with the game instead'}
              </span>
              <Input
                aria-label={`${label} path`}
                className="font-mono"
                placeholder="dungeons/…"
                disabled={disabled}
                value={own?.kind === 'shipped' ? own.path : ''}
                onChange={(e) => {
                  const path = e.target.value.trim();
                  if (path) onChange({ kind: 'shipped', path });
                  // Emptying the box clears a file path; it never discards an upload.
                  else if (own?.kind === 'shipped') onChange(null);
                }}
              />
            </label>
            {/^assets\//i.test(own?.kind === 'shipped' ? own.path : '') && (
              <p className="text-danger" role="alert">
                Paths are relative to the assets folder — drop the leading “assets/”.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {!disabled && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Browse shipped files for ${lower}`}
                  onClick={() => setFiles(true)}
                >
                  Browse shipped files…
                </Button>
              )}
              {canBrowse && (
                <Link className="underline" to="/admin/artwork">
                  Open Artwork
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
      <AssetPickerDialog
        open={picker}
        title={`Choose ${lower}`}
        category={category}
        selectedId={null}
        onClose={() => setPicker(false)}
        onSelect={(asset) =>
          onChange({
            kind: 'managed',
            category: asset.category,
            contentHash: asset.contentHash,
            name: asset.name,
          })
        }
      />
      <ArtworkPickerDialog
        open={files}
        onClose={() => setFiles(false)}
        source={shippedDungeonArtwork}
        selectedPath={own?.kind === 'shipped' ? own.path : null}
        onSelect={(path) => onChange({ kind: 'shipped', path })}
        title={`Browse shipped files for ${lower}`}
      />
    </div>
  );
}
