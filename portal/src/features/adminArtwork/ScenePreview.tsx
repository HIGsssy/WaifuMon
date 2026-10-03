/**
 * Sprite placement controls, and the composed scene they produce.
 *
 * The preview is rendered by the server with the same compositor a Discord
 * screen uses — the Portal draws nothing itself — so what an admin sees here
 * is the image a player gets. There is no drag-and-drop: placement is a
 * preset, a scale and two offsets.
 */
import { useState } from 'react';

import {
  DEFAULT_SPRITE_PLACEMENT,
  FALLBACK_ARTWORK_META,
  SPRITE_ANCHORS,
  SPRITE_ANCHOR_LABELS,
  scenePreviewBlob,
  type ArtworkLayerRef,
  type ScenePreviewRequest,
  type SpriteAnchor,
  type SpritePlacement,
} from '@/api/adminArtworkAssets';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

const LIMITS = FALLBACK_ARTWORK_META.placement;
const clamp = (n: number, min: number, max: number) => Math.min(Math.max(Math.trunc(n), min), max);

function BoundedNumber({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  // Keeps what is typed while focused, so the field can be cleared and retyped.
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        aria-label={label}
        className="w-24"
        value={text ?? value}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const n = Number(raw);
          if (raw.trim() !== '' && raw.trim() !== '-' && Number.isFinite(n))
            onChange(clamp(n, min, max));
        }}
        onBlur={() => setText(null)}
      />
    </label>
  );
}

export function PlacementControls({
  value,
  disabled,
  onChange,
}: {
  value: SpritePlacement;
  disabled: boolean;
  onChange: (next: SpritePlacement) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="placement-controls">
      <label className="text-xs text-ink-muted">
        Position
        <select
          aria-label="Sprite position"
          className={selectClass}
          value={value.anchor}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, anchor: e.target.value as SpriteAnchor })}
        >
          {SPRITE_ANCHORS.map((anchor) => (
            <option key={anchor} value={anchor}>
              {SPRITE_ANCHOR_LABELS[anchor]}
            </option>
          ))}
        </select>
      </label>
      <BoundedNumber
        label="Scale (%)"
        value={Math.round(value.scaleBasisPoints / 100)}
        min={LIMITS.scaleMin / 100}
        max={LIMITS.scaleMax / 100}
        disabled={disabled}
        onChange={(percent) => onChange({ ...value, scaleBasisPoints: percent * 100 })}
      />
      <BoundedNumber
        label="Offset X (px)"
        value={value.offsetX}
        min={-LIMITS.offsetXMax}
        max={LIMITS.offsetXMax}
        disabled={disabled}
        onChange={(offsetX) => onChange({ ...value, offsetX })}
      />
      <BoundedNumber
        label="Offset Y (px)"
        value={value.offsetY}
        min={-LIMITS.offsetYMax}
        max={LIMITS.offsetYMax}
        disabled={disabled}
        onChange={(offsetY) => onChange({ ...value, offsetY })}
      />
    </div>
  );
}

const hasImage = (ref: ArtworkLayerRef | null | undefined) =>
  Boolean(ref?.assetId || ref?.artworkPath);
const loadScene = (source: string) => scenePreviewBlob(JSON.parse(source) as ScenePreviewRequest);

/** The composed scene for a background and (optionally) a sprite. */
export function ScenePreview({
  background,
  sprite,
  placement,
  testId = 'scene-preview',
}: {
  background: ArtworkLayerRef | null;
  sprite?: ArtworkLayerRef | null;
  placement?: SpritePlacement;
  testId?: string;
}) {
  const request: ScenePreviewRequest | null = hasImage(background)
    ? {
        background: background!,
        ...(hasImage(sprite)
          ? { sprite: sprite!, placement: placement ?? DEFAULT_SPRITE_PLACEMENT }
          : {}),
      }
    : null;
  // The request is the source: any change to it is a new picture. Debounced so
  // nudging an offset does not render a scene per keystroke.
  const source = useDebouncedValue(request ? JSON.stringify(request) : null, 300);
  const { width, height } = FALLBACK_ARTWORK_META.scene;
  return (
    <div className="space-y-1" data-testid={testId}>
      <AuthoredArtwork
        source={source}
        load={loadScene}
        className="flex aspect-video w-full max-w-xl items-center justify-center overflow-hidden rounded-md border border-border bg-surface-sunken"
        testIdPrefix={testId}
        emptyLabel="Choose a background to preview the scene."
        missingLabel={() =>
          'This scene could not be composed — an image is missing or unavailable.'
        }
        alt={() => 'Composed scene preview'}
      />
      <p className="text-xs text-ink-subtle">
        Rendered by the server exactly as Discord shows it: {width}×{height}. The sprite keeps its
        proportions and never leaves the frame.
      </p>
    </div>
  );
}
