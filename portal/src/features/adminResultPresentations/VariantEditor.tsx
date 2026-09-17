/**
 * Create / edit one Result Presentation variant, with a live preview of the
 * **unsaved** form.
 *
 * Rules come from the server's reference data (legal artwork modes, the
 * default mode, limits); the form only mirrors them for convenience, and the
 * server remains the authority on every save. The result type is fixed — a
 * variant is created under one and never moves.
 *
 * The preview is a server call that validates the form with the write rules
 * and renders it with the same screen model Discord uses. It persists
 * nothing, and it previews *this* form's variant, never a weighted pick.
 */
import { useId, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';

import {
  createResultPresentation,
  fieldIssuesOf,
  previewResultPresentation,
  updateResultPresentation,
  type ArtworkMode,
  type PresentationKeyReference,
  type ResultPresentationFields,
  type ResultPresentationReference,
  type ResultPresentationVariant,
} from '@/api/adminResultPresentations';
import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import { ResultPresentationPreviewCard } from './ResultPresentationPreviewCard';
import { artworkModeLabel, formatShare, selectionShare } from './presentationMath';

export interface VariantEditorProps {
  keyRef: PresentationKeyReference;
  reference: ResultPresentationReference;
  /** The variant being edited, or null to create one under `keyRef`. */
  variant: ResultPresentationVariant | null;
  /** Every stored variant for this result type, for the chance estimate. */
  siblings: readonly ResultPresentationVariant[];
  canWrite: boolean;
  onSaved: (variant: ResultPresentationVariant) => void;
  onClose: () => void;
}

interface FormState {
  flavorText: string;
  weight: string;
  enabled: boolean;
  artworkMode: ArtworkMode;
  artworkPath: string;
}

function initialForm(keyRef: PresentationKeyReference, variant: ResultPresentationVariant | null): FormState {
  if (variant) {
    return {
      flavorText: variant.flavorText ?? '',
      weight: String(variant.weight),
      enabled: variant.enabled,
      artworkMode: variant.artworkMode,
      artworkPath: variant.artworkPath ?? '',
    };
  }
  return {
    flavorText: '',
    weight: '1',
    enabled: true,
    artworkMode: keyRef.defaultArtworkMode,
    artworkPath: '',
  };
}

function parseWeight(raw: string, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= 1 && value <= max ? value : null;
}

export function VariantEditor({
  keyRef,
  reference,
  variant,
  siblings,
  canWrite,
  onSaved,
  onClose,
}: VariantEditorProps) {
  const ids = useId();
  const [form, setForm] = useState<FormState>(() => initialForm(keyRef, variant));
  const [speciesSlug, setSpeciesSlug] = useState<string | null>(reference.defaultPreviewSpeciesSlug);
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  const isRelease = keyRef.allowedArtworkModes.includes('encountered');
  const weight = parseWeight(form.weight, reference.maxWeight);
  const textTooLong = form.flavorText.length > reference.flavorTextMaxLength;
  const needsPath = form.artworkMode === 'custom' && form.artworkPath.trim() === '';
  const localError = weight === null
    ? `Weight must be a whole number from 1 to ${reference.maxWeight}.`
    : textTooLong
      ? `Flavor text must be at most ${reference.flavorTextMaxLength} characters.`
      : needsPath
        ? 'Custom artwork needs an artwork path.'
        : null;

  const fields = (): ResultPresentationFields => ({
    enabled: form.enabled,
    weight: weight ?? 0,
    flavorText: form.flavorText.trim() === '' ? null : form.flavorText,
    artworkMode: form.artworkMode,
    artworkPath: form.artworkMode === 'custom' ? form.artworkPath.trim() : null,
  });

  const save = useMutation({
    mutationFn: () =>
      variant
        ? updateResultPresentation(variant.id, fields())
        : createResultPresentation({ presentationKey: keyRef.key, ...fields() }),
    onSuccess: onSaved,
  });
  const saveIssues = save.isError ? fieldIssuesOf(save.error) : {};
  const deletedElsewhere =
    save.isError && variant !== null && isPortalApiError(save.error) && save.error.isNotFound;

  // Live preview of the unsaved form. Debounced so typing is not a request
  // per keystroke; the previous preview stays up while the next one loads.
  const previewRequest = useMemo(
    () => ({
      variant: {
        presentationKey: keyRef.key,
        flavorText: form.flavorText.trim() === '' ? null : form.flavorText,
        artworkMode: form.artworkMode,
        artworkPath: form.artworkMode === 'custom' ? form.artworkPath.trim() || null : null,
      },
      ...(isRelease ? { previewSpeciesSlug: speciesSlug } : {}),
    }),
    [keyRef.key, form.flavorText, form.artworkMode, form.artworkPath, isRelease, speciesSlug],
  );
  const debouncedRequest = useDebouncedValue(previewRequest, 300);
  const previewBlocked = debouncedRequest.variant.flavorText !== null &&
    debouncedRequest.variant.flavorText.length > reference.flavorTextMaxLength;
  const previewCustomWithoutPath =
    debouncedRequest.variant.artworkMode === 'custom' && !debouncedRequest.variant.artworkPath;
  const preview = useQuery({
    queryKey: ['admin', 'result-presentations', 'preview', debouncedRequest],
    queryFn: ({ signal }) => previewResultPresentation(debouncedRequest, signal),
    enabled: !previewBlocked && !previewCustomWithoutPath,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const previewIssues = preview.isError ? fieldIssuesOf(preview.error) : {};

  // Chance among enabled variants, with this form's weight and state in place
  // of the stored one.
  const share = useMemo(() => {
    const others = siblings.filter((s) => s.id !== variant?.id);
    const self = { id: variant?.id ?? -1, enabled: form.enabled, weight: weight ?? 0 };
    return selectionShare(self, [...others, self]);
  }, [siblings, variant?.id, form.enabled, weight]);
  const otherEnabled = siblings.filter((s) => s.id !== variant?.id && s.enabled).length;

  const title = variant ? `Edit variant — ${keyRef.label}` : `New variant — ${keyRef.label}`;
  const readOnly = !canWrite;

  return (
    <Card className="grid gap-6 p-4 lg:grid-cols-2" data-testid="variant-editor">
      <form
        className="space-y-4"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly && !localError) save.mutate();
        }}
      >
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-ink-muted" data-testid="editor-result-type">
            Result type: {keyRef.label} <code>{keyRef.key}</code> — fixed for this variant.
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor={`${ids}-flavor`} className="text-sm font-medium">
            Flavor text <span className="text-ink-muted">(optional)</span>
          </label>
          <textarea
            id={`${ids}-flavor`}
            className="min-h-28 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.flavorText}
            maxLength={reference.flavorTextMaxLength}
            disabled={readOnly}
            onChange={(e) => set('flavorText', e.target.value)}
          />
          <div className="flex justify-between gap-2 text-xs text-ink-muted">
            <span>
              Gameplay values — amounts, balances, items and quantities — are added automatically.
              Write only the flavor. {form.flavorText.trim() === '' && keyRef.emptyFlavorDescription}
            </span>
            <span data-testid="flavor-counter">
              {form.flavorText.length}/{reference.flavorTextMaxLength}
            </span>
          </div>
          {saveIssues.flavorText && <p className="text-xs text-danger">{saveIssues.flavorText}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor={`${ids}-weight`} className="text-sm font-medium">
            Weight
          </label>
          <Input
            id={`${ids}-weight`}
            inputMode="numeric"
            value={form.weight}
            disabled={readOnly}
            onChange={(e) => set('weight', e.target.value)}
            aria-invalid={weight === null}
          />
          <p className="text-xs text-ink-muted">
            Higher weight makes this variant more likely relative to other enabled variants for this
            result.
          </p>
          <p className="text-xs text-ink-muted" data-testid="editor-chance">
            {share === null
              ? 'Disabled — this variant will not be shown.'
              : `${formatShare(share)} chance among ${otherEnabled + 1} enabled variant${otherEnabled === 0 ? '' : 's'}. This percentage applies only after this result type has already occurred.`}
          </p>
          {saveIssues.weight && <p className="text-xs text-danger">{saveIssues.weight}</p>}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={readOnly}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          Enabled
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Artwork</legend>
          {keyRef.allowedArtworkModes.map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${ids}-artwork-mode`}
                value={mode}
                checked={form.artworkMode === mode}
                disabled={readOnly}
                onChange={() => set('artworkMode', mode)}
              />
              {artworkModeLabel(mode)}
            </label>
          ))}
          {saveIssues.artworkMode && <p className="text-xs text-danger">{saveIssues.artworkMode}</p>}
        </fieldset>

        {form.artworkMode === 'custom' && (
          <div className="space-y-1">
            <label htmlFor={`${ids}-path`} className="text-sm font-medium">
              Artwork path
            </label>
            <Input
              id={`${ids}-path`}
              value={form.artworkPath}
              disabled={readOnly}
              placeholder="results/coins.webp"
              onChange={(e) => set('artworkPath', e.target.value)}
            />
            <p className="text-xs text-ink-muted">
              Relative to <code>assets/</code>. Supported:{' '}
              {reference.supportedArtworkExtensions.map((ext) => `.${ext}`).join(', ')}. The file must
              already be on the server.
            </p>
            {(saveIssues.artworkPath ?? previewIssues.artworkPath) && (
              <p className="text-xs text-danger" data-testid="artwork-path-error">
                {saveIssues.artworkPath ?? previewIssues.artworkPath}
              </p>
            )}
          </div>
        )}

        {save.isError && (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft p-2 text-sm text-danger">
            {deletedElsewhere
              ? 'This variant no longer exists — it may have been deleted elsewhere. Close the editor and refresh.'
              : save.error instanceof Error
                ? save.error.message
                : 'Could not save.'}
          </p>
        )}
        {localError && !readOnly && (
          <p className="text-xs text-danger" data-testid="editor-local-error">
            {localError}
          </p>
        )}

        <div className="flex gap-2">
          {canWrite && (
            <Button type="submit" variant="accent" disabled={Boolean(localError) || save.isPending}>
              {save.isPending ? 'Saving…' : variant ? 'Save changes' : 'Create variant'}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            {canWrite ? 'Cancel' : 'Close'}
          </Button>
        </div>
      </form>

      <section className="space-y-3" aria-label="Live preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Live preview</h3>
          {isRelease && (
            <label className="flex items-center gap-2 text-xs">
              Preview Waifumon
              <select
                className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                value={speciesSlug ?? ''}
                onChange={(e) => setSpeciesSlug(e.target.value || null)}
                aria-label="Preview Waifumon"
              >
                {reference.previewSpecies.map((sp) => (
                  <option key={sp.slug} value={sp.slug}>
                    {sp.name} ({sp.rarity})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {isRelease && (
          <p className="text-xs text-ink-muted">
            The preview Waifumon is only for this preview. It is not saved and does not target the
            variant at any Waifumon.
          </p>
        )}
        {previewBlocked || previewCustomWithoutPath ? (
          <p className="text-xs text-ink-muted" data-testid="preview-waiting">
            {previewCustomWithoutPath
              ? 'Enter an artwork path to preview custom artwork.'
              : 'Shorten the flavor text to preview it.'}
          </p>
        ) : preview.data ? (
          <ResultPresentationPreviewCard preview={preview.data} />
        ) : preview.isError ? null : (
          <p className="text-xs text-ink-muted">Loading preview…</p>
        )}
        {preview.isError && (
          <p role="status" className="text-xs text-danger" data-testid="preview-error">
            Preview unavailable:{' '}
            {Object.values(previewIssues)[0] ??
              (preview.error instanceof Error ? preview.error.message : 'unknown error')}
          </p>
        )}
      </section>
    </Card>
  );
}
