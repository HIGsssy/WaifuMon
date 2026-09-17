/**
 * The variants authored for one result type.
 *
 * Variants are numbered by position ("Variant 2") rather than by database id,
 * and each row answers the questions an author asks at a glance: is it on,
 * what does it say, how likely is it among the enabled variants, and what
 * image does it use.
 *
 * Disabling or deleting the last enabled variant is allowed — the built-in
 * screen takes over — but the row says so before it happens.
 */
import { useState } from 'react';

import type {
  PresentationKeyReference,
  ResultPresentationVariant,
} from '@/api/adminResultPresentations';
import { PresentationArtwork } from '@/components/media/PresentationArtwork';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { artworkModeLabel, excerpt, formatShare, selectionShare } from './presentationMath';

const THUMB_FRAME =
  'flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-sunken text-[10px]';

export interface VariantListProps {
  keyRef: PresentationKeyReference;
  variants: readonly ResultPresentationVariant[];
  canWrite: boolean;
  busyId: number | null;
  onEdit: (variant: ResultPresentationVariant) => void;
  onSetEnabled: (variant: ResultPresentationVariant, enabled: boolean) => void;
  onDelete: (variant: ResultPresentationVariant) => void;
}

type Confirming = { id: number; action: 'delete' | 'disable' } | null;

export function VariantList({
  keyRef,
  variants,
  canWrite,
  busyId,
  onEdit,
  onSetEnabled,
  onDelete,
}: VariantListProps) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  const enabledCount = variants.filter((v) => v.enabled).length;

  if (variants.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-sm text-ink-muted" data-testid="no-variants">
        No variants yet. Players see the built-in screen.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {variants.map((variant, index) => {
        const label = `Variant ${index + 1}`;
        const share = selectionShare(variant, variants);
        const isLastEnabled = variant.enabled && enabledCount === 1;
        const text = variant.flavorText?.trim() ? excerpt(variant.flavorText) : null;
        const confirm = confirming?.id === variant.id ? confirming.action : null;
        return (
          <li
            key={variant.id}
            className="rounded-md border border-border bg-surface-raised p-3"
            data-testid={`variant-row-${index + 1}`}
          >
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label}</span>
                  <Badge variant={variant.enabled ? 'solid' : 'outline'}>
                    {variant.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                  <span className="text-xs text-ink-muted">Weight {variant.weight}</span>
                  <span className="text-xs text-ink-muted" data-testid="variant-chance">
                    {share === null ? 'Disabled' : formatShare(share)}
                  </span>
                </div>
                {text ? (
                  <p className="text-sm text-ink" data-testid="variant-excerpt">
                    “{text}”
                  </p>
                ) : (
                  <p className="text-sm italic text-ink-muted" data-testid="variant-excerpt">
                    {keyRef.emptyFlavorDescription}
                  </p>
                )}
                <p className="text-xs text-ink-muted" data-testid="variant-artwork">
                  {variant.artworkMode === 'encountered'
                    ? 'Encountered Waifumon artwork'
                    : variant.artworkMode === 'custom'
                      ? `${artworkModeLabel('custom')}: ${variant.artworkPath ?? ''}`
                      : artworkModeLabel('none')}
                </p>
              </div>
              {variant.artworkMode === 'custom' && (
                <PresentationArtwork path={variant.artworkPath} className={THUMB_FRAME} />
              )}
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="default" onClick={() => onEdit(variant)}>
                {canWrite ? 'Edit' : 'View'}
              </Button>
              {canWrite && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === variant.id}
                    onClick={() =>
                      variant.enabled && isLastEnabled
                        ? setConfirming({ id: variant.id, action: 'disable' })
                        : onSetEnabled(variant, !variant.enabled)
                    }
                  >
                    {variant.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === variant.id}
                    onClick={() => setConfirming({ id: variant.id, action: 'delete' })}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>

            {confirm && (
              <div
                role="alertdialog"
                aria-label={confirm === 'delete' ? `Delete ${label}?` : `Disable ${label}?`}
                className="mt-2 space-y-2 rounded-md border border-danger/40 bg-danger-soft p-3 text-sm"
              >
                <p>
                  {confirm === 'delete' ? (
                    <>
                      Delete <strong>{label}</strong>
                      {text ? <> (“{text}”)</> : null}
                      {variant.artworkMode === 'custom' && variant.artworkPath
                        ? `, artwork ${variant.artworkPath}`
                        : ''}
                      ? This cannot be undone.
                    </>
                  ) : (
                    <>
                      Disable <strong>{label}</strong>?
                    </>
                  )}
                </p>
                {isLastEnabled && (
                  <p data-testid="fallback-warning">
                    This is the last enabled variant for {keyRef.label}. Players will see the
                    built-in screen: {keyRef.fallbackDescription}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setConfirming(null);
                      if (confirm === 'delete') onDelete(variant);
                      else onSetEnabled(variant, false);
                    }}
                  >
                    {confirm === 'delete' ? `Delete ${label}` : `Disable ${label}`}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Keep it
                  </Button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
