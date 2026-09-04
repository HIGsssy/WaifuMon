/**
 * Portal Admin — encounter editor.
 *
 * Renders a structured form driven by
 * {@link getAdminEncounterReference} for canonical selectors. Reads
 * (edit path) or seeds (create path) the encounter, tracks a draft in
 * React state, and POSTs the whole tree on Save.
 *
 * The choice tree delegates to {@link ChoiceEditor}; effect trees to
 * {@link EffectEditor}. Both live-side-by-side with the preview panel so
 * an author can watch the computed success chance update as they type.
 *
 * The Save button is disabled until the required fields carry a value —
 * a UX hint, not a security boundary. The server re-validates against
 * `EncounterInputSchema`, and validation errors flash inline.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createAdminEncounter,
  getAdminEncounter,
  getAdminEncounterReference,
  updateAdminEncounter,
  type AdminEncounterReference,
  type EncounterInputPayload,
} from '@/api/adminEncounters';
import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';

import { ChoiceEditor, type ChoiceDraft } from './ChoiceEditor';
import type { EffectShape } from './EffectEditor';
import { AdminEncounterPreviewPanel } from './AdminEncounterPreviewPanel';

interface Draft {
  slug: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  weight: number;
  lifecycle: 'draft' | 'active' | 'disabled';
  huntEligible: boolean;
  travelEligible: boolean;
  cooldownSeconds: number;
  artworkPath: string | null;
  chainedEncounterSlug: string | null;
  choicesRequired: boolean;
  regions: string[];
  routes: Array<{ fromRegion: string; toRegion: string }>;
  choices: ChoiceDraft[];
  metadata: Record<string, unknown>;
}

const EMPTY_DRAFT: Draft = {
  slug: '',
  name: '',
  description: '',
  type: 'decision',
  rarity: 'common',
  weight: 10,
  lifecycle: 'draft',
  huntEligible: true,
  travelEligible: false,
  cooldownSeconds: 0,
  artworkPath: null,
  chainedEncounterSlug: null,
  choicesRequired: true,
  regions: [],
  routes: [],
  choices: [],
  metadata: {},
};

function toPayload(d: Draft): EncounterInputPayload {
  return {
    slug: d.slug,
    name: d.name,
    description: d.description,
    type: d.type,
    rarity: d.rarity,
    weight: d.weight,
    lifecycle: d.lifecycle,
    huntEligible: d.huntEligible,
    travelEligible: d.travelEligible,
    cooldownSeconds: d.cooldownSeconds,
    artworkPath: d.artworkPath,
    chainedEncounterSlug: d.chainedEncounterSlug,
    choicesRequired: d.choicesRequired,
    regions: d.regions,
    routes: d.routes,
    choices: d.choices.map((c) => ({
      label: c.label,
      emoji: c.emoji,
      requirements: c.requirements as Record<string, unknown>,
      check: c.check as unknown as Record<string, unknown>,
      successEffects: c.successEffects,
      failureEffects: c.failureEffects,
    })),
    metadata: d.metadata,
  };
}

function draftFrom(server: Awaited<ReturnType<typeof getAdminEncounter>>): Draft {
  return {
    slug: server.slug,
    name: server.name,
    description: server.description,
    type: server.type,
    rarity: server.rarity,
    weight: server.weight,
    lifecycle: server.lifecycle,
    huntEligible: server.huntEligible,
    travelEligible: server.travelEligible,
    cooldownSeconds: server.cooldownSeconds,
    artworkPath: server.artworkPath,
    chainedEncounterSlug: server.chainedEncounterSlug,
    choicesRequired: server.choicesRequired,
    regions: server.regions,
    routes: server.routes,
    choices: server.choices.map((c) => ({
      label: c.label,
      emoji: c.emoji,
      requirements: c.requirements as ChoiceDraft['requirements'],
      check: c.check as ChoiceDraft['check'],
      successEffects: c.successEffects as unknown as EffectShape[],
      failureEffects: c.failureEffects as unknown as EffectShape[],
    })),
    metadata: server.metadata,
  };
}

export function AdminEncounterEditorPage() {
  const { id: idParam } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('encounters.write');
  const canPublish = useHasPermission('encounters.publish');
  const isNew = !idParam;
  const encounterId = idParam ? Number(idParam) : null;

  const referenceQuery = useQuery({
    queryKey: ['admin', 'encounters', 'reference'],
    queryFn: ({ signal }) => getAdminEncounterReference(signal),
  });

  const encounterQuery = useQuery({
    queryKey: ['admin', 'encounters', encounterId],
    queryFn: ({ signal }) => (encounterId ? getAdminEncounter(encounterId, signal) : null),
    enabled: encounterId != null,
  });

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [hasLoaded, setHasLoaded] = useState(isNew);

  useEffect(() => {
    if (encounterQuery.data && !hasLoaded) {
      setDraft(draftFrom(encounterQuery.data));
      setHasLoaded(true);
    }
  }, [encounterQuery.data, hasLoaded]);

  const saveMutation = useMutation({
    mutationFn: async (payload: EncounterInputPayload) => {
      if (encounterId != null) return updateAdminEncounter(encounterId, payload);
      return createAdminEncounter(payload);
    },
    onSuccess: (saved) => {
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ['admin', 'encounters'] });
      if (isNew) navigate(`/admin/encounters/${saved.id}`, { replace: true });
    },
    onError: (err) => setSaveError(err),
  });

  const patch = (updates: Partial<Draft>) => setDraft((d) => ({ ...d, ...updates }));

  const canSave =
    canWrite &&
    draft.slug.trim().length > 0 &&
    draft.name.trim().length > 0 &&
    (draft.huntEligible || draft.travelEligible) &&
    (!draft.choicesRequired || draft.choices.length > 0) &&
    !saveMutation.isPending;

  const wireRegionToggle = (region: string) =>
    patch({
      regions: draft.regions.includes(region)
        ? draft.regions.filter((r) => r !== region)
        : [...draft.regions, region],
    });

  const reference = referenceQuery.data;
  const canPublishDraft =
    canPublish || draft.lifecycle !== 'active'; // draft/disabled are always writable

  const previewSlot = useMemo(
    () =>
      isNew
        ? null
        : encounterId != null && hasLoaded
          ? (
              <AdminEncounterPreviewPanel
                encounterId={encounterId}
                reference={reference}
              />
            )
          : null,
    [encounterId, hasLoaded, isNew, reference],
  );

  if (encounterQuery.isPending && !isNew) {
    return (
      <Card className="p-4">
        <Skeleton className="h-64 w-full" />
      </Card>
    );
  }
  if (encounterQuery.isError) {
    return (
      <ErrorState
        title="Could not load encounter"
        error={encounterQuery.error}
        onRetry={() => void encounterQuery.refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={isNew ? 'New encounter' : `Edit — ${draft.name || draft.slug}`}
        description={isNew ? 'Author a new World Encounter definition.' : draft.slug}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/admin/encounters">Back to list</Link>
            </Button>
            {!isNew && (
              <Button variant="outline" asChild>
                <Link to={`/admin/encounters/${encounterId}/preview`}>Full preview</Link>
              </Button>
            )}
          </div>
        }
      />

      {saveError != null && (
        <ErrorState
          title="Save failed"
          error={saveError}
          onRetry={() => void saveMutation.mutate(toPayload(draft))}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="space-y-4 p-4 lg:col-span-2">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase text-ink-muted">General</legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-ink-muted">
                Slug
                <Input
                  value={draft.slug}
                  onChange={(e) => patch({ slug: e.target.value })}
                  placeholder="lowercase_snake_case"
                  disabled={!isNew}
                />
              </label>
              <label className="text-xs text-ink-muted">
                Name
                <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
              </label>
              <label className="text-xs text-ink-muted col-span-2">
                Description
                <textarea
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  rows={3}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs text-ink-muted">
                Type
                <select
                  value={draft.type}
                  onChange={(e) => patch({ type: e.target.value })}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
                >
                  {(reference?.types ?? ['decision']).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                Rarity
                <select
                  value={draft.rarity}
                  onChange={(e) => patch({ rarity: e.target.value })}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
                >
                  {(reference?.rarities ?? ['common']).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                Weight
                <Input
                  type="number"
                  min="1"
                  value={draft.weight}
                  onChange={(e) => patch({ weight: Number(e.target.value) })}
                />
              </label>
              <label className="text-xs text-ink-muted">
                Lifecycle
                <select
                  value={draft.lifecycle}
                  onChange={(e) => patch({ lifecycle: e.target.value as Draft['lifecycle'] })}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
                >
                  {(reference?.lifecycles ?? ['draft', 'active', 'disabled']).map((l) => (
                    <option
                      key={l}
                      value={l}
                      disabled={l === 'active' && !canPublish && draft.lifecycle !== 'active'}
                    >
                      {l}
                      {l === 'active' && !canPublish && ' (requires publish)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                Cooldown (seconds)
                <Input
                  type="number"
                  min="0"
                  value={draft.cooldownSeconds}
                  onChange={(e) => patch({ cooldownSeconds: Number(e.target.value) })}
                />
              </label>
              <label className="text-xs text-ink-muted">
                Artwork path (relative to assets/)
                <Input
                  value={draft.artworkPath ?? ''}
                  onChange={(e) => patch({ artworkPath: e.target.value.trim() || null })}
                  placeholder="encounters/foo.png"
                />
              </label>
              <label className="text-xs text-ink-muted">
                Chained encounter slug
                <Input
                  value={draft.chainedEncounterSlug ?? ''}
                  onChange={(e) =>
                    patch({ chainedEncounterSlug: e.target.value.trim() || null })
                  }
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-4 pt-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.huntEligible}
                  onChange={(e) => patch({ huntEligible: e.target.checked })}
                />
                Hunt eligible
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.travelEligible}
                  onChange={(e) => patch({ travelEligible: e.target.checked })}
                />
                Travel eligible
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.choicesRequired}
                  onChange={(e) => patch({ choicesRequired: e.target.checked })}
                />
                Choices required
              </label>
            </div>
          </fieldset>

          <fieldset className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs uppercase text-ink-muted">Regions</legend>
            <p className="text-xs text-ink-muted">
              No regions selected = globally eligible for the enabled sources.
            </p>
            <div className="flex flex-wrap gap-2">
              {(reference?.regions ?? []).map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={draft.regions.includes(r) ? 'default' : 'outline'}
                  onClick={() => wireRegionToggle(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs uppercase text-ink-muted">Travel routes</legend>
            <p className="text-xs text-ink-muted">
              Directional. Empty = every travel edge (when Travel is enabled).
            </p>
            {draft.routes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {draft.routes.map((r, i) => (
                  <Badge key={`${r.fromRegion}-${r.toRegion}-${i}`} variant="outline">
                    {r.fromRegion} → {r.toRegion}
                    <button
                      type="button"
                      className="ml-2"
                      onClick={() =>
                        patch({ routes: draft.routes.filter((_, k) => k !== i) })
                      }
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <select
                id="route-from"
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
              >
                <option value="">from…</option>
                {(reference?.regions ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select
                id="route-to"
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
              >
                <option value="">to…</option>
                {(reference?.regions ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const from = (document.getElementById('route-from') as HTMLSelectElement)?.value;
                  const to = (document.getElementById('route-to') as HTMLSelectElement)?.value;
                  if (from && to && from !== to) {
                    patch({ routes: [...draft.routes, { fromRegion: from, toRegion: to }] });
                  }
                }}
              >
                Add route
              </Button>
            </div>
          </fieldset>

          <fieldset className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs uppercase text-ink-muted">Choices</legend>
            <div className="space-y-3">
              {draft.choices.map((c, i) => (
                <ChoiceEditor
                  key={i}
                  index={i}
                  choice={c}
                  reference={reference}
                  onChange={(next) => {
                    const list = [...draft.choices];
                    list[i] = next;
                    patch({ choices: list });
                  }}
                  onRemove={() =>
                    patch({ choices: draft.choices.filter((_, k) => k !== i) })
                  }
                  onMoveUp={
                    i > 0
                      ? () => {
                          const list = [...draft.choices];
                          const above = list[i - 1]!;
                          const here = list[i]!;
                          list[i - 1] = here;
                          list[i] = above;
                          patch({ choices: list });
                        }
                      : undefined
                  }
                  onMoveDown={
                    i < draft.choices.length - 1
                      ? () => {
                          const list = [...draft.choices];
                          const below = list[i + 1]!;
                          const here = list[i]!;
                          list[i + 1] = here;
                          list[i] = below;
                          patch({ choices: list });
                        }
                      : undefined
                  }
                />
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  patch({
                    choices: [
                      ...draft.choices,
                      {
                        label: 'New choice',
                        emoji: null,
                        requirements: {},
                        check: { type: 'none' },
                        successEffects: [],
                        failureEffects: [],
                      },
                    ],
                  })
                }
              >
                + Add choice
              </Button>
            </div>
          </fieldset>

          <div className="flex items-center gap-3 pt-2">
            <Button
              type="button"
              disabled={!canSave || !canPublishDraft}
              onClick={() => saveMutation.mutate(toPayload(draft))}
            >
              {saveMutation.isPending ? 'Saving…' : isNew ? 'Create encounter' : 'Save changes'}
            </Button>
            {!canWrite && (
              <span className="text-xs text-ink-muted">You do not have write permission.</span>
            )}
          </div>
        </Card>

        <div className="space-y-4">{previewSlot}</div>
      </div>
    </div>
  );
}

// silence unused-import warnings if references were removed by a later edit
void isPortalApiError;
void ({} as AdminEncounterReference);
