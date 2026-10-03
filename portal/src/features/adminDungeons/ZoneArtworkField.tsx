/**
 * One zone artwork field: the stored relative path, a picker over the
 * `dungeons/` asset folders, and a preview of what is at that path now.
 *
 * The path is the subject here, so the three states are kept distinct: no
 * artwork set, a path with no file behind it (a typo, or art not deployed
 * yet — the zone still saves and screens fall back), and the image itself.
 * The server refuses an unsafe path; this only shows what it would find.
 */
import { useState } from 'react';

import { dungeonArtworkBlob } from '@/api/adminDungeons';
import { ArtworkPickerDialog } from '@/components/admin/ArtworkPicker';
import { dungeonArtworkSource } from '@/components/admin/artworkSources';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

export function ZoneArtworkField({
  label,
  testId,
  value,
  expectedPath,
  disabled,
  onChange,
}: {
  /** `Artwork` / `Background artwork` — also the input's accessible name, plus " path". */
  label: string;
  testId: string;
  value: string | null;
  /** The conventional path for this zone, e.g. `dungeons/zones/<key>.webp`. */
  expectedPath: string;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // The preview follows typing, but not every keystroke.
  const previewPath = useDebouncedValue(value, 300);
  const startsWithAssets = /^assets\//i.test(value ?? '');

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-64 flex-1 text-xs text-ink-muted">
          {label}
          <Input
            aria-label={`${label} path`}
            className="font-mono"
            placeholder={expectedPath}
            value={value ?? ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.trim() === '' ? null : e.target.value.trim())}
          />
        </label>
        {!disabled && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Browse ${label.toLowerCase()}`}
              onClick={() => setPickerOpen(true)}
            >
              Browse…
            </Button>
            {value !== expectedPath && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Use the conventional ${label.toLowerCase()} path`}
                onClick={() => onChange(expectedPath)}
              >
                Use convention
              </Button>
            )}
            {value !== null && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Clear ${label.toLowerCase()}`}
                onClick={() => onChange(null)}
              >
                Clear
              </Button>
            )}
          </>
        )}
      </div>
      <p className="text-xs text-ink-subtle">
        Expected: <span className="font-mono">{expectedPath}</span> — the file{' '}
        <span className="font-mono">assets/{expectedPath}</span> on the server.
      </p>
      {startsWithAssets && (
        <p className="text-xs text-danger" role="alert">
          Paths are relative to the assets folder — drop the leading “assets/”.
        </p>
      )}
      <AuthoredArtwork
        source={previewPath}
        load={dungeonArtworkBlob}
        testIdPrefix={`${testId}-preview`}
        emptyLabel="No artwork set — screens fall back to the next image, or to text."
        missingLabel={(path) =>
          `No file at ${path} yet. The zone can be saved; screens fall back until it exists.`
        }
        alt={(path) => `${label}: ${path}`}
      />
      <ArtworkPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        source={dungeonArtworkSource}
        selectedPath={value}
        onSelect={(path) => onChange(path)}
        title={`Browse ${label.toLowerCase()}`}
      />
    </div>
  );
}
