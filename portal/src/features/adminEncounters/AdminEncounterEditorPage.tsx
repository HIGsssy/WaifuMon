/**
 * Portal Admin — encounter editor.
 *
 * Organised around how an author thinks about an encounter rather than how it
 * is stored:
 *
 *   Basics · Where it appears · Frequency · Choices · Advanced (collapsed)
 *
 * Choices are cards that summarise themselves and expand on demand; outcomes
 * carry their own follow-up ("continue to another encounter", or create one in
 * a step); vendors are picked, previewed, edited and created in place. The
 * stored shape is untouched — `toPayload` still sends exactly the fields the
 * API has always taken — so existing encounters load and save as before.
 *
 * Save is disabled while `validateDraft` reports errors — a UX courtesy, not a
 * security boundary. The server re-validates against `EncounterInputSchema`
 * and its own cross-field rules, and refusals are listed inline.
 *
 * Two Waifumon-sighting rules gate Save here, unchanged:
 *
 *   - a Specific Species sighting with no species blocks every save;
 *   - a random selector that matches nothing in any enabled region blocks
 *     *publishing* only. Whether it matches is the server's selector preview
 *     answer; nothing here evaluates a selector. The server enforces the same
 *     rule on activation.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createAdminEncounter,
  getAdminEncounter,
  previewSpeciesSelector,
  updateAdminEncounter,
  type AdminEncounter,
  type EncounterInputPayload,
  type SelectorPreviewEncounter,
} from '@/api/adminEncounters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { EncounterArtwork } from '@/components/media/EncounterArtwork';
import { ArtworkPickerDialog } from '@/components/admin/ArtworkPicker';
import { encounterArtworkSource } from '@/components/admin/artworkSources';

import {
  AuthoringContext,
  type AuthoringContextValue,
  type EncounterSummary,
} from './AuthoringContext';
import { ChoiceCard } from './ChoiceCard';
import type { ChoiceDraft } from './ChoiceEditor';
import {
  ChainContextPanel,
  NewEncounterChooser,
  PreviewDrawer,
  ValidationSummary,
} from './EditorPanels';
import { EligibilityEditor } from './EligibilityEditor';
import {
  EMPTY_DRAFT,
  draftFrom,
  randomSelections,
  saveIssuesOf,
  toPayload,
  type Draft,
} from './encounterDraft';
import { buildEncounterGraph, type GraphEncounter } from './encounterGraph';
import { validateDraft } from './encounterValidation';
import { EntitySelect, selectClass } from './EntitySelect';
import { setChoiceFollowUp, type OutcomeBranch } from './followUps';
import { FrequencyEditor } from './FrequencyEditor';
import { slugify, uniqueSlug } from './slugs';
import { draftForTemplate, isTemplate, type EncounterTemplate } from './templates';
import {
  useEncounterList,
  useEncounterSettings,
  useNameLookups,
  useReference,
  useVendors,
} from './useAuthoringData';

/** The publish-blocking explanation, verbatim wherever it is shown. */
export const SELECTOR_PUBLISH_BLOCKED =
  'This selector does not match any enabled Waifumon in any region where this encounter can run.';

const TYPE_LABELS: Record<string, string> = {
  decision: 'Decision',
  skill_check: 'Skill check',
  combat: 'Combat',
  vendor: 'Vendor',
  deity: 'Deity',
  discovery: 'Discovery',
};

const TEXTAREA = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink';

function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="space-y-3 p-4" data-testid={testId}>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
        {description && <p className="text-xs text-ink-muted">{description}</p>}
      </div>
      {children}
    </Card>
  );
}

function appearsLabel(e: Pick<GraphEncounter, 'huntEligible' | 'travelEligible'>): string {
  if (e.huntEligible && e.travelEligible) return 'Hunt + Travel';
  if (e.huntEligible) return 'Hunt';
  if (e.travelEligible) return 'Travel';
  return 'chain-only';
}

/** A chain-only draft follow-up: reached through its parent, so it needs no source. */
function followUpDraft(name: string, slug: string, parent: Draft): Draft {
  return {
    ...EMPTY_DRAFT,
    slug,
    name,
    type: 'decision',
    rarity: parent.rarity,
    lifecycle: 'draft',
    huntEligible: false,
    travelEligible: false,
    choices: [
      {
        label: 'Continue',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [],
        failureEffects: [],
      },
    ],
  };
}

/**
 * Keyed by the route's id: moving from one encounter's editor to another's
 * (a follow-up just created, a "Reached from" link) reuses this route
 * element, and without the key the previous encounter's draft would stay on
 * screen.
 */
export function AdminEncounterEditorPage() {
  const { id } = useParams<{ id?: string }>();
  return <EncounterEditor key={id ?? 'new'} />;
}

function EncounterEditor() {
  const { id: idParam } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('encounters.write');
  const canPublish = useHasPermission('encounters.publish');
  const artworkPathId = useId();
  const statusId = useId();
  const slugId = useId();
  const [artworkPickerOpen, setArtworkPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isNew = !idParam;
  const encounterId = idParam ? Number(idParam) : null;
  const templateParam = searchParams.get('template');
  const template: EncounterTemplate | null = isTemplate(templateParam) ? templateParam : null;

  const referenceQuery = useReference();
  const listQuery = useEncounterList();
  const vendorsQuery = useVendors();
  const settingsQuery = useEncounterSettings();
  const reference = referenceQuery.data;

  const encounterQuery = useQuery({
    queryKey: ['admin', 'encounters', encounterId],
    queryFn: ({ signal }) => (encounterId ? getAdminEncounter(encounterId, signal) : null),
    enabled: encounterId != null,
  });

  const [draft, setDraft] = useState<Draft>(() =>
    template ? draftForTemplate(template) : EMPTY_DRAFT,
  );
  const [saved, setSaved] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [hasLoaded, setHasLoaded] = useState(isNew);
  // New encounters derive their slug from the name until the author edits it.
  const [slugTouched, setSlugTouched] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() =>
    isNew ? new Set(draft.choices.map((_, i) => i)) : new Set(),
  );

  useEffect(() => {
    if (encounterQuery.data && !hasLoaded) {
      const loaded = draftFrom(encounterQuery.data);
      setDraft(loaded);
      setSaved(loaded);
      setHasLoaded(true);
    }
  }, [encounterQuery.data, hasLoaded]);

  // Picking a template on the chooser starts that draft.
  useEffect(() => {
    if (isNew && template) {
      const next = draftForTemplate(template);
      setDraft(next);
      setExpanded(new Set(next.choices.map((_, i) => i)));
      setSlugTouched(false);
    }
  }, [isNew, template]);

  const encounters: AdminEncounter[] | null = listQuery.data?.encounters ?? null;
  const otherEncounters = useMemo(
    () => (encounters ?? []).filter((e) => e.id !== encounterId),
    [encounters, encounterId],
  );
  const otherSlugs = useMemo(
    () => (encounters ? new Set(otherEncounters.map((e) => e.slug)) : null),
    [encounters, otherEncounters],
  );

  const patch = (updates: Partial<Draft>) => setDraft((d) => ({ ...d, ...updates }));
  const setName = (name: string) => patch({ name });
  // A new encounter's slug follows its name — unique against every existing
  // slug, recomputed when the list arrives — until the author edits it.
  useEffect(() => {
    if (!isNew || slugTouched) return;
    setDraft((d) => {
      const slug = d.name.trim() ? uniqueSlug(slugify(d.name), otherSlugs ?? new Set()) : '';
      return slug === d.slug ? d : { ...d, slug };
    });
  }, [isNew, slugTouched, otherSlugs, draft.name]);

  // The chain graph with this draft standing in for its saved self.
  const draftNode: GraphEncounter = useMemo(
    () => ({ ...draft, ...(encounterId != null ? { id: encounterId } : {}) }),
    [draft, encounterId],
  );
  const graph = useMemo(
    () => (encounters ? buildEncounterGraph([...otherEncounters, draftNode]) : null),
    [encounters, otherEncounters, draftNode],
  );
  const role = graph?.roleOf(draft.slug) ?? null;
  const names = useNameLookups(otherEncounters);

  // The same context object the selector editors preview with, so these
  // checks share their query cache rather than asking the server twice.
  const encounterContext: SelectorPreviewEncounter = {
    huntEligible: draft.huntEligible,
    travelEligible: draft.travelEligible,
    regions: draft.regions,
    routes: draft.routes,
  };
  const selectors = randomSelections(draft);
  const selectorChecks = useQueries({
    queries: selectors.map(({ selection }) => ({
      queryKey: ['admin', 'encounters', 'selector-preview', selection, encounterContext],
      queryFn: () => previewSpeciesSelector({ selection, encounter: encounterContext }),
      staleTime: 30_000,
    })),
  });
  // Zero candidates in every enabled region — the `selector_no_candidates`
  // condition, as the server computed it. Zero in only some regions is a
  // warning shown by the selector editor and does not block publishing.
  const deadSelectors = selectors.filter(
    (_, i) => selectorChecks[i]?.data?.matchesAnywhere === false,
  );
  const publishBlocked = deadSelectors.length > 0;
  const wantsPublish = draft.lifecycle === 'active';

  const validation = validateDraft(draft, {
    isNew,
    otherSlugs,
    graph,
    vendors: vendorsQuery.data?.vendors ?? null,
    enabledRegions: reference?.enabledRegions,
    itemName: names.item,
  });
  const canPublishDraft = canPublish || draft.lifecycle !== 'active'; // draft/disabled are always writable
  const saveBlocked = validation.errors.length > 0 || (wantsPublish && publishBlocked);
  const dirty = isNew || (saved != null && JSON.stringify(saved) !== JSON.stringify(draft));

  const saveMutation = useMutation({
    mutationFn: async (snapshot: Draft) => {
      const payload: EncounterInputPayload = toPayload(snapshot);
      if (encounterId != null) return updateAdminEncounter(encounterId, payload);
      return createAdminEncounter(payload);
    },
    onSuccess: (result, snapshot) => {
      setSaveError(null);
      // What was sent is what is now saved; edits made while the request was
      // in flight stay visible as unsaved.
      setSaved(snapshot);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'encounters'] });
      if (isNew) navigate(`/admin/encounters/${result.id}`, { replace: true });
    },
    onError: (err) => setSaveError(err),
  });

  // Create a follow-up in one step: link it from this outcome, save this
  // encounter (so the new one is reachable — the server refuses a chain-only
  // encounter nothing links to), create the follow-up, then open it.
  const followUpMutation = useMutation({
    mutationFn: async ({
      choiceIndex,
      branch,
      name,
    }: {
      choiceIndex: number;
      branch: OutcomeBranch;
      name: string;
    }) => {
      const taken = new Set([...(otherSlugs ?? []), draft.slug]);
      const childSlug = uniqueSlug(slugify(name), taken);
      const parent = setChoiceFollowUp(draft, choiceIndex, branch, childSlug);
      const savedParent =
        encounterId != null
          ? await updateAdminEncounter(encounterId, toPayload(parent))
          : await createAdminEncounter(toPayload(parent));
      setDraft(parent);
      setSaved(parent);
      const child = await createAdminEncounter(toPayload(followUpDraft(name, childSlug, parent)));
      return { savedParent, child };
    },
    onSuccess: ({ child }) => {
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'encounters'] });
      navigate(`/admin/encounters/${child.id}`);
    },
    onError: (err) => setSaveError(err),
  });

  const encounterSummary = (slug: string): EncounterSummary | null => {
    const e = graph?.encounters.get(slug) ?? otherEncounters.find((x) => x.slug === slug);
    if (!e) return null;
    const parents = graph?.roleOf(slug).parents ?? [];
    return {
      id: e.id ?? null,
      name: e.name,
      lifecycle: e.lifecycle,
      appears: appearsLabel(e),
      linkedFrom: parents
        .filter((p) => p !== draft.slug)
        .map((p) => graph?.encounters.get(p)?.name ?? p),
    };
  };

  const encounterOptions = useMemo(
    () =>
      [...otherEncounters]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const parents = (graph?.roleOf(e.slug).parents ?? []).filter((p) => p !== draft.slug);
          const bits = [e.lifecycle, appearsLabel(e)];
          if (parents.length > 0) bits.push(`linked from ${parents.length}`);
          return { value: e.slug, label: e.name, hint: bits.join(' · ') };
        }),
    [otherEncounters, graph, draft.slug],
  );

  const followUpBlocked = !canWrite
    ? 'You do not have write permission.'
    : !canPublishDraft
      ? 'Saving an active encounter needs the publish permission.'
      : saveBlocked
        ? 'Fix the problems listed at the top first — creating a follow-up saves this encounter.'
        : null;

  const authoring: AuthoringContextValue = {
    names,
    encounterOptions,
    encounterSummary,
    createFollowUp: (choiceIndex, branch, name) =>
      followUpMutation.mutate({ choiceIndex, branch, name }),
    createFollowUpBlocked: followUpBlocked,
    creatingFollowUp: followUpMutation.isPending,
  };

  const canSave = canWrite && canPublishDraft && !saveBlocked && !saveMutation.isPending;

  const setChoices = (choices: ChoiceDraft[]) => patch({ choices });
  const swapChoices = (a: number, b: number) => {
    const list = [...draft.choices];
    [list[a], list[b]] = [list[b]!, list[a]!];
    setChoices(list);
    setExpanded((prev) => {
      const next = new Set(prev);
      const hasA = prev.has(a);
      const hasB = prev.has(b);
      next.delete(a);
      next.delete(b);
      if (hasA) next.add(b);
      if (hasB) next.add(a);
      return next;
    });
  };

  if (isNew && !template && searchParams.get('template') == null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="New encounter"
          description="Pick a starting point."
          actions={
            <Button variant="outline" asChild>
              <Link to="/admin/encounters">Back to list</Link>
            </Button>
          }
        />
        <Card className="p-4">
          <NewEncounterChooser
            onPick={(t) => setSearchParams({ template: t }, { replace: true })}
          />
        </Card>
      </div>
    );
  }

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

  const roleBadges: string[] = [];
  if (role) {
    if (!role.spawns) roleBadges.push('Chain-only');
    else roleBadges.push(appearsLabel(draft));
    if (role.parents.length > 0) roleBadges.push(`Child of ${role.parents.length}`);
    if (role.children.length > 0) roleBadges.push(`Leads to ${role.children.length}`);
  }

  return (
    <AuthoringContext.Provider value={authoring}>
      <div className="space-y-6">
        <PageHeader
          title={isNew ? 'New encounter' : `Edit — ${draft.name || draft.slug}`}
          {...(isNew ? { description: 'Author a new World Encounter.' } : {})}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <Link to="/admin/encounters">Back to list</Link>
              </Button>
              {!isNew && (
                <Button variant="outline" type="button" onClick={() => setPreviewOpen(true)}>
                  Preview
                </Button>
              )}
            </div>
          }
        />

        {/* Status and Save live together at the top: the two decisions an author makes every time. */}
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <label htmlFor={statusId} className="text-xs text-ink-muted">
            Status
          </label>
          <select
            id={statusId}
            value={draft.lifecycle}
            onChange={(e) => patch({ lifecycle: e.target.value as Draft['lifecycle'] })}
            className={cn(selectClass, 'w-auto')}
          >
            {(reference?.lifecycles ?? ['draft', 'active', 'disabled']).map((l) => (
              <option
                key={l}
                value={l}
                disabled={
                  l === 'active' && draft.lifecycle !== 'active' && (!canPublish || publishBlocked)
                }
              >
                {l === 'draft' ? 'Draft' : l === 'active' ? 'Active' : 'Disabled'}
                {l === 'active' && !canPublish && ' (requires publish)'}
                {l === 'active' && canPublish && publishBlocked && ' (blocked)'}
              </option>
            ))}
          </select>
          {roleBadges.map((b) => (
            <Badge key={b} variant="outline">
              {b}
            </Badge>
          ))}
          <div className="flex-1" />
          {!canWrite && (
            <span className="text-xs text-ink-muted">You do not have write permission.</span>
          )}
          {dirty && canWrite && <span className="text-xs text-ink-muted">Unsaved changes</span>}
          <Button
            type="button"
            variant="accent"
            disabled={!canSave}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? 'Saving…' : isNew ? 'Create encounter' : 'Save changes'}
          </Button>
        </Card>

        {saveError != null && (
          <div className="space-y-2">
            <ErrorState
              title="Save failed"
              error={saveError}
              onRetry={() => void saveMutation.mutate(draft)}
            />
            {saveIssuesOf(saveError).length > 0 && (
              <ul
                className="list-disc rounded-md border border-destructive/50 bg-destructive/5 p-3 pl-8 text-xs text-destructive"
                data-testid="save-error-issues"
              >
                {saveIssuesOf(saveError).map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <ValidationSummary errors={validation.errors} warnings={validation.warnings} />

        {publishBlocked && (
          <div
            className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
            data-testid="publish-blockers"
          >
            <p className="font-medium">{SELECTOR_PUBLISH_BLOCKED}</p>
            <p className="mt-1 text-xs">
              {wantsPublish
                ? 'This encounter cannot be published while it is here. Set Status to Draft to save your changes, or change the selector.'
                : 'You can save this encounter as a draft, but it cannot be published until the selector matches something.'}
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {deadSelectors.map(({ where }) => (
                <li key={where}>{where}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
          <div className="space-y-6">
            <Section title="Basics" testId="section-basics">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-ink-muted">
                  Name
                  <Input
                    value={draft.name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="A Strange Door"
                  />
                </label>
                <label className="text-xs text-ink-muted">
                  Type
                  <select
                    value={draft.type}
                    onChange={(e) => patch({ type: e.target.value })}
                    className={selectClass}
                  >
                    {(reference?.types ?? [draft.type]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t] ?? t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-ink-muted sm:col-span-2">
                  Description
                  <textarea
                    value={draft.description}
                    onChange={(e) => patch({ description: e.target.value })}
                    rows={3}
                    className={TEXTAREA}
                  />
                </label>
                <div className="text-xs text-ink-muted sm:col-span-2">
                  <span className="block">Artwork</span>
                  <div className="mt-1 flex flex-wrap items-start gap-3">
                    <div className="w-56">
                      <EncounterArtwork path={draft.artworkPath} />
                    </div>
                    <div className="min-w-56 flex-1 space-y-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setArtworkPickerOpen(true)}
                      >
                        Browse Artwork
                      </Button>
                      <label htmlFor={artworkPathId} className="block">
                        Artwork path (relative to assets/)
                      </label>
                      <Input
                        id={artworkPathId}
                        value={draft.artworkPath ?? ''}
                        onChange={(e) => patch({ artworkPath: e.target.value.trim() || null })}
                        placeholder="encounters/bandit_ambush.webp"
                      />
                    </div>
                  </div>
                  <ArtworkPickerDialog
                    open={artworkPickerOpen}
                    onClose={() => setArtworkPickerOpen(false)}
                    source={encounterArtworkSource}
                    selectedPath={draft.artworkPath}
                    onSelect={(path) => patch({ artworkPath: path })}
                    title="Browse encounter artwork"
                  />
                </div>
              </div>
            </Section>

            <Section title="Where it appears" testId="section-eligibility">
              <EligibilityEditor
                value={draft}
                onChange={(p) => patch(p)}
                reference={reference}
                role={role}
              />
            </Section>

            <Section title="Frequency" testId="section-frequency">
              <FrequencyEditor
                rarity={draft.rarity}
                weight={draft.weight}
                cooldownSeconds={draft.cooldownSeconds}
                spawns={draft.huntEligible || draft.travelEligible}
                role={role}
                onChange={(p) => patch(p)}
                reference={reference}
                settings={settingsQuery.data}
              />
            </Section>

            <Section
              title="Choices"
              description="What the player can do. Each choice summarises itself — open one to edit its requirements, resolution, results and follow-ups."
              testId="section-choices"
            >
              {draft.choices.length > 1 && (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(new Set(draft.choices.map((_, i) => i)))}
                  >
                    Expand all
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(new Set())}
                  >
                    Collapse all
                  </Button>
                </div>
              )}
              <div className="space-y-3">
                {draft.choices.map((c, i) => (
                  <ChoiceCard
                    key={i}
                    index={i}
                    choice={c}
                    reference={reference}
                    encounterContext={encounterContext}
                    expanded={expanded.has(i)}
                    onToggle={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                    onChange={(next) =>
                      setChoices(draft.choices.map((x, k) => (k === i ? next : x)))
                    }
                    onRemove={() => {
                      setChoices(draft.choices.filter((_, k) => k !== i));
                      setExpanded(
                        (prev) =>
                          new Set([...prev].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k))),
                      );
                    }}
                    onMoveUp={i > 0 ? () => swapChoices(i, i - 1) : undefined}
                    onMoveDown={
                      i < draft.choices.length - 1 ? () => swapChoices(i, i + 1) : undefined
                    }
                  />
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setExpanded((prev) => new Set(prev).add(draft.choices.length));
                    setChoices([
                      ...draft.choices,
                      {
                        label: 'New choice',
                        emoji: null,
                        requirements: {},
                        check: { type: 'none' },
                        successEffects: [],
                        failureEffects: [],
                      },
                    ]);
                  }}
                >
                  + Add choice
                </Button>
              </div>
            </Section>

            <details
              className="rounded-lg border border-border bg-surface p-4"
              data-testid="section-advanced"
            >
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Advanced
              </summary>
              <div className="mt-3 space-y-4">
                <div className="text-xs text-ink-muted">
                  <label htmlFor={slugId}>Slug</label>
                  <Input
                    id={slugId}
                    value={draft.slug}
                    disabled={!isNew}
                    onChange={(e) => {
                      setSlugTouched(true);
                      patch({ slug: e.target.value.trim() });
                    }}
                    placeholder="lowercase_snake_case"
                  />
                  <span className="mt-1 block text-[11px]">
                    {isNew
                      ? 'Generated from the name. Used by exports and by other encounters to refer to this one; it cannot change after creation.'
                      : 'Fixed after creation — other encounters and exports refer to it.'}
                  </span>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={draft.choicesRequired}
                    onChange={(e) => patch({ choicesRequired: e.target.checked })}
                  />
                  <span>
                    Choices required
                    <span className="block text-xs text-ink-muted">
                      When on (the usual case), the encounter must have at least one choice.
                    </span>
                  </span>
                </label>
                <div>
                  <EntitySelect
                    label="After any choice, continue to (encounter-level follow-up)"
                    value={draft.chainedEncounterSlug ?? ''}
                    options={encounterOptions}
                    placeholder="— none —"
                    searchLabel="Search encounters"
                    onChange={(slug) => patch({ chainedEncounterSlug: slug || null })}
                  />
                  <p className="mt-1 text-[11px] text-ink-muted">
                    Older way of chaining: used after any choice whose result has no follow-up of
                    its own. Prefer the follow-up on each choice result.
                  </p>
                </div>
                {Object.keys(draft.metadata).length > 0 && (
                  <div className="text-xs text-ink-muted">
                    Metadata (kept as-is on save)
                    <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-surface-sunken p-2">
                      {JSON.stringify(draft.metadata, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </details>
          </div>

          {/* Beside the form on wide screens; above it otherwise, so a chain
              follow-up never hides its context below Advanced. */}
          <aside className="order-first space-y-4 xl:order-none">
            <ChainContextPanel slug={draft.slug} graph={graph} />
          </aside>
        </div>

        {!isNew && encounterId != null && hasLoaded && (
          <PreviewDrawer
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            encounterId={encounterId}
            reference={reference}
            dirty={dirty}
          />
        )}
      </div>
    </AuthoringContext.Provider>
  );
}
