/**
 * Admin — create or edit one equipment definition.
 *
 * The page reads in the order an author thinks: what it is, how strong it
 * rolls, what it looks like — then whether it can be rolled and obtained.
 *
 *   - **The server decides validity.** Every rule (ranges, locks, roll
 *     policy) is checked by the shared definition schema; refusals appear at
 *     the fields they name. The form only hides fields a rarity does not use.
 *   - **New equipment starts disabled.** Saving never changes the enabled
 *     state; enabling is its own reviewed action with its reward impact shown.
 *   - **Saves are optimistic.** A save names the revision it loaded; if
 *     someone else saved first the server refuses with 409 and the page says
 *     so and offers a reload — it never overwrites.
 *   - **Previews are the real engine.** The analysis and sample rolls come
 *     from the server, on the published rules, and grant nothing.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  EQUIPMENT_CATALOGUE_QUERY_KEY,
  EQUIPMENT_RARITIES,
  EQUIPMENT_SLOTS,
  SLOT_LABELS,
  createCatalogueDefinition,
  equipmentArtworkBlob,
  formatMultiplier,
  getCatalogueDefinition,
  getCatalogueHistory,
  invalidateCatalogueQueries,
  updateCatalogueDefinition,
  validateCatalogueDefinition,
  type CatalogueDetail,
  type EquipmentIssue,
  type EquipmentRarity,
  type EquipmentSlotName,
  type EquipmentStaleDetails,
} from '@/api/adminEquipment';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ArtworkPickerDialog } from '@/components/admin/ArtworkPicker';
import { equipmentArtworkSource } from '@/components/admin/artworkSources';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Section } from '@/features/adminDungeons/zoneFormParts';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import {
  AvailabilityCard,
  DuplicateDefinitionDialog,
  EnableDefinitionDialog,
  IssueList,
  RarityBadge,
  RollPreviewPanel,
  StatusBadge,
} from './catalogueParts';
import {
  FIELD_EFFECTS,
  FIELD_PATHS,
  blankForm,
  equipmentPath,
  formOf,
  inputOf,
  isHighRarity,
  issuesAt,
  keyError,
  keyFromName,
  refusedIssues,
  type EquipmentForm,
} from './equipmentModel';

export function EquipmentCreatePage() {
  return <DefinitionEditor mode="create" definitionKey="" />;
}

/** Keyed by definition, so navigating between definitions starts from a clean draft. */
export function EquipmentEditorPage() {
  const { key } = useParams<{ key: string }>();
  return <DefinitionEditor key={key} mode="edit" definitionKey={key ?? ''} />;
}

function FieldHint({ children, testId }: { children: string; testId?: string }) {
  return (
    <p className="text-xs text-ink-subtle" {...(testId ? { 'data-testid': testId } : {})}>
      {children}
    </p>
  );
}

function DefinitionEditor({
  mode,
  definitionKey,
}: {
  mode: 'create' | 'edit';
  definitionKey: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('equipment.write');
  const readOnly = !canWrite;
  const creating = mode === 'create';

  const detailQuery = useQuery({
    queryKey: [...EQUIPMENT_CATALOGUE_QUERY_KEY, 'definition', definitionKey],
    queryFn: ({ signal }) => getCatalogueDefinition(definitionKey, signal),
    enabled: !creating,
  });
  const historyQuery = useQuery({
    queryKey: [...EQUIPMENT_CATALOGUE_QUERY_KEY, 'history', definitionKey],
    queryFn: ({ signal }) => getCatalogueHistory(definitionKey, signal),
    enabled: !creating,
  });

  const [form, setForm] = useState<EquipmentForm | null>(creating ? blankForm() : null);
  const [loaded, setLoaded] = useState<CatalogueDetail | null>(null);
  const [keyTouched, setKeyTouched] = useState(false);
  const [stale, setStale] = useState<EquipmentStaleDetails | null>(null);
  const [checked, setChecked] = useState<EquipmentIssue[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const adopt = (detail: CatalogueDetail) => {
    setLoaded(detail);
    setForm(formOf(detail.definition));
    setStale(null);
    setChecked(null);
  };
  useEffect(() => {
    if (detailQuery.data && loaded === null) adopt(detailQuery.data);
  }, [detailQuery.data, loaded]);

  const save = useMutation({
    mutationFn: () =>
      creating
        ? createCatalogueDefinition(inputOf(form!))
        : updateCatalogueDefinition(definitionKey, inputOf(form!), loaded!.definition.revision),
    onSuccess: (detail) => {
      invalidateCatalogueQueries(queryClient);
      if (creating) {
        navigate(equipmentPath(detail.definition.key), { replace: true });
        return;
      }
      adopt(detail);
      queryClient.setQueryData(
        [...EQUIPMENT_CATALOGUE_QUERY_KEY, 'definition', definitionKey],
        detail,
      );
    },
    onError: (err) => {
      if (isPortalApiError(err) && err.code === 'EQUIPMENT_DEFINITION_STALE')
        setStale((err.details ?? {}) as EquipmentStaleDetails);
    },
  });
  const check = useMutation({
    mutationFn: () =>
      validateCatalogueDefinition(
        inputOf(form!),
        creating ? { creating: true } : { creating: false, key: definitionKey },
      ),
    onSuccess: (result) => setChecked(result.issues),
  });

  const reload = async () => {
    const result = await detailQuery.refetch();
    if (result.data) adopt(result.data);
  };

  if (!creating) {
    if (detailQuery.isPending) return <Skeleton className="h-64 w-full" />;
    if (detailQuery.isError) {
      return (
        <ErrorState
          title="Could not load the equipment"
          error={detailQuery.error}
          onRetry={() => void detailQuery.refetch()}
        />
      );
    }
  }
  if (form === null || (!creating && loaded === null)) return <Skeleton className="h-64 w-full" />;

  const set = (patch: Partial<EquipmentForm>) => {
    setForm({ ...form, ...patch });
    setChecked(null);
  };
  const high = isHighRarity(form.rarity);
  const locks = loaded?.locks ?? { slotLocked: false, rarityLocked: false, instanceCount: 0 };
  const dirty = creating || JSON.stringify(form) !== JSON.stringify(formOf(loaded!.definition));
  const keyProblem = creating ? keyError(form.key) : null;
  const refused = refusedIssues(save.error);
  const issues = [...refused, ...(checked ?? [])];
  const at = (field: string) => (FIELD_PATHS[field] ?? [field]).flatMap((p) => issuesAt(issues, p));
  const shown = new Set([
    'key',
    'name',
    'description',
    'slot',
    'rarity',
    'multiplierMinBp',
    'multiplierMaxBp',
    'multiplierStepBp',
    'primarySpEligible',
    'maxAdditionalBonuses',
    'tags',
    'regionId',
    'artworkPath',
  ]);
  const elsewhere = issues.filter(
    (i) =>
      ![...shown].some(
        (p) => i.path === p || i.path.startsWith(`${p}.`) || i.path.startsWith(`${p}[`),
      ),
  );
  const conflict =
    isPortalApiError(save.error) &&
    ['EQUIPMENT_KEY_TAKEN', 'EQUIPMENT_SLOT_LOCKED', 'EQUIPMENT_RARITY_LOCKED'].includes(
      save.error.code ?? '',
    )
      ? save.error
      : null;
  const definition = loaded?.definition;

  return (
    <div className="space-y-4">
      <PageHeader
        title={creating ? 'Create equipment' : `Equipment — ${definition!.name}`}
        description={
          creating
            ? 'New equipment starts disabled. Review it, then enable it from the catalogue or this page.'
            : 'Changes reach future drops only. Copies players already own keep the values they rolled.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {!creating && canWrite && (
              <>
                <Button variant="outline" onClick={() => setDuplicating(true)}>
                  Duplicate
                </Button>
                <Button variant="outline" onClick={() => setToggling(true)} disabled={dirty}>
                  {definition!.enabled ? 'Disable' : 'Enable'}
                </Button>
              </>
            )}
            <Button variant="outline" asChild>
              <Link to="/admin/equipment">Back to catalogue</Link>
            </Button>
          </div>
        }
      />

      {stale && (
        <Card
          className="space-y-2 border-danger/40 p-4 text-sm"
          data-testid="stale-banner"
          role="alert"
        >
          <p className="font-medium text-danger">
            This equipment was changed by someone else since you opened it.
          </p>
          <p className="text-ink-muted">
            It is now at revision {stale.currentRevision ?? '?'}
            {stale.updatedBy ? ` (saved by ${stale.updatedBy})` : ''}. Your change was not applied.
            Reload to see their version — your unsaved edits on this page will be discarded.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            Reload latest version
          </Button>
        </Card>
      )}
      {readOnly && (
        <Card className="p-3 text-sm text-ink-muted" data-testid="read-only-notice">
          You can view this equipment but not change it (needs the “equipment.write” permission).
        </Card>
      )}

      {!creating && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <RarityBadge rarity={definition!.rarity} />
          <StatusBadge enabled={definition!.enabled} />
          <span className="text-ink-muted">
            Revision {definition!.revision} · {definition!.ownedCount} cop
            {definition!.ownedCount === 1 ? 'y' : 'ies'} owned
          </span>
          {dirty && (
            <span className="text-xs text-ink-subtle">
              Save your changes before enabling or disabling.
            </span>
          )}
        </div>
      )}

      <Section
        title="Identity"
        hint="What the equipment is called. The name and description change how existing copies are shown."
        testId="equipment-identity"
      >
        <label className="block text-xs text-ink-muted">
          Display name
          <Input
            aria-label="Display name"
            className="mt-1 max-w-md"
            value={form.name}
            disabled={readOnly}
            onChange={(e) =>
              set({
                name: e.target.value,
                ...(creating && !keyTouched ? { key: keyFromName(e.target.value) } : {}),
              })
            }
          />
        </label>
        <IssueList issues={at('name')} testId="issues-name" />
        <label className="block text-xs text-ink-muted">
          Key {creating ? '(lower_snake_case — permanent once created)' : '(permanent)'}
          <Input
            aria-label="Equipment key"
            className="mt-1 max-w-md font-mono"
            value={form.key}
            disabled={!creating || readOnly}
            onChange={(e) => {
              setKeyTouched(true);
              set({ key: e.target.value });
            }}
          />
        </label>
        {keyProblem && form.key !== '' && (
          <p className="text-xs text-danger" role="alert">
            {keyProblem}
          </p>
        )}
        <IssueList issues={at('key')} testId="issues-key" />
        <label className="block text-xs text-ink-muted">
          Description
          <textarea
            aria-label="Description"
            className="mt-1 block w-full max-w-2xl rounded-md border border-border bg-surface p-2 text-sm text-ink"
            rows={3}
            value={form.description}
            disabled={readOnly}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <FieldHint>{FIELD_EFFECTS.display}</FieldHint>
      </Section>

      <Section
        title="Rarity and slot"
        hint="Which slot it fills and how rare it is."
        testId="equipment-class"
      >
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-ink-muted">
            Rarity
            <select
              aria-label="Rarity"
              className={selectClass}
              value={form.rarity}
              disabled={readOnly || locks.rarityLocked}
              onChange={(e) => set({ rarity: e.target.value as EquipmentRarity })}
            >
              {EQUIPMENT_RARITIES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            Slot
            <select
              aria-label="Slot"
              className={selectClass}
              value={form.slot}
              disabled={readOnly || locks.slotLocked}
              onChange={(e) => set({ slot: e.target.value as EquipmentSlotName })}
            >
              {EQUIPMENT_SLOTS.map((s) => (
                <option key={s} value={s}>
                  {SLOT_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(locks.slotLocked || locks.rarityLocked) && (
          <FieldHint testId="lock-notice">{`${FIELD_EFFECTS.locked} ${locks.instanceCount} cop${locks.instanceCount === 1 ? 'y exists' : 'ies exist'}.`}</FieldHint>
        )}
        <IssueList issues={[...at('rarity'), ...at('slot')]} testId="issues-class" />
      </Section>

      <Section
        title="Strength"
        hint="The multiplier each new copy rolls, converting the Buddy's SP into this slot's stat."
        testId="equipment-strength"
      >
        <div className="flex flex-wrap gap-3">
          {(
            [
              ['multiplierMin', 'Minimum multiplier'],
              ['multiplierMax', 'Maximum multiplier'],
              ['multiplierStep', 'Step'],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="text-xs text-ink-muted">
              {label}
              <Input
                aria-label={label}
                className="mt-1 w-28 font-mono"
                value={form[field]}
                disabled={readOnly}
                onChange={(e) => set({ [field]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <FieldHint>{`Written as a decimal: 1.25 means ×1.25. ${FIELD_EFFECTS.future}`}</FieldHint>
        <IssueList
          issues={[...at('multiplierMin'), ...at('multiplierMax'), ...at('multiplierStep')]}
          testId="issues-strength"
        />
      </Section>

      {high ? (
        <Section
          title={`${form.rarity} roll settings`}
          hint="How this item uses its rarity's published rules. The chances and ranges themselves come from the rules, not from here."
          testId="equipment-high"
        >
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              aria-label="Primary SP eligible"
              checked={form.primarySpEligible}
              disabled={readOnly}
              onChange={(e) => set({ primarySpEligible: e.target.checked })}
            />
            Can roll primary SP
          </label>
          <FieldHint>
            When ticked, each new copy takes part in the rarity's primary SP roll — its chance and
            range are set by the published rules.
          </FieldHint>
          <label className="text-xs text-ink-muted">
            Maximum additional bonuses
            <select
              aria-label="Maximum additional bonuses"
              className={selectClass}
              value={form.maxAdditionalBonuses}
              disabled={readOnly}
              onChange={(e) =>
                set({
                  maxAdditionalBonuses: e.target.value as EquipmentForm['maxAdditionalBonuses'],
                })
              }
            >
              <option value="">The rarity's own maximum</option>
              {['0', '1', '2', '3'].map((n) => (
                <option key={n} value={n}>
                  At most {n}
                </option>
              ))}
            </select>
          </label>
          <FieldHint testId="max-bonus-hint">
            A ceiling, not a guarantee: a copy rolls 0 up to this many additional bonuses, with the
            rarity's odds for higher counts spread over the ones allowed.
          </FieldHint>
          <FieldHint>{FIELD_EFFECTS.future}</FieldHint>
          <IssueList
            issues={[...at('primarySpEligible'), ...at('maxAdditionalBonuses')]}
            testId="issues-high"
          />
        </Section>
      ) : (
        <Section title={`${form.rarity} roll settings`} testId="equipment-legacy">
          <p className="text-sm text-ink-muted" data-testid="legacy-notice">
            {form.rarity} equipment uses the standard {form.rarity} roll: its affix and bonus rules
            are fixed. Primary SP and a bonus maximum are available on SSR, UR and LR equipment
            only.
          </p>
        </Section>
      )}

      <Section
        title="Artwork and labels"
        hint="Optional. Artwork lives under the equipment folder."
        testId="equipment-art"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-muted">
            Artwork file
            <Input
              aria-label="Artwork path"
              className="mt-1 w-80 font-mono"
              placeholder="equipment/…"
              value={form.artworkPath}
              disabled={readOnly}
              onChange={(e) => set({ artworkPath: e.target.value })}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => setPicking(true)}
          >
            Browse artwork
          </Button>
          {form.artworkPath && !readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => set({ artworkPath: '' })}
            >
              Clear
            </Button>
          )}
        </div>
        {form.artworkPath && (
          <AuthoredArtwork
            source={form.artworkPath}
            load={equipmentArtworkBlob}
            testIdPrefix="equipment-artwork"
            emptyLabel=""
            missingLabel={() => 'That file is not on this server.'}
            alt={() => `${form.name || 'Equipment'} artwork`}
          />
        )}
        <FieldHint>{FIELD_EFFECTS.display}</FieldHint>
        <IssueList issues={at('artworkPath')} testId="issues-artwork" />
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-ink-muted">
            Tags (comma-separated)
            <Input
              aria-label="Tags"
              className="mt-1 w-72"
              value={form.tags}
              disabled={readOnly}
              onChange={(e) => set({ tags: e.target.value })}
            />
          </label>
          <label className="text-xs text-ink-muted">
            Region id (optional)
            <Input
              aria-label="Region id"
              className="mt-1 w-48 font-mono"
              value={form.regionId}
              disabled={readOnly}
              onChange={(e) => set({ regionId: e.target.value })}
            />
          </label>
        </div>
        <IssueList issues={[...at('tags'), ...at('regionId')]} testId="issues-labels" />
      </Section>

      <IssueList issues={elsewhere} testId="issues-other" />
      {conflict && <ErrorState variant="inline" title="Could not save" error={conflict} />}
      {save.isError && !conflict && !stale && refused.length === 0 && (
        <ErrorState variant="inline" title="Could not save" error={save.error} />
      )}
      {checked && checked.length === 0 && (
        <p className="text-sm text-ink-muted" role="status" data-testid="check-ok">
          No problems found.
        </p>
      )}

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="accent"
            disabled={!dirty || save.isPending || keyProblem !== null}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : creating ? 'Create (disabled)' : 'Save changes'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            Check for problems
          </Button>
          {!creating && dirty && (
            <Button type="button" variant="ghost" onClick={() => adopt(loaded!)}>
              Discard changes
            </Button>
          )}
          {creating && (
            <Button type="button" variant="ghost" asChild>
              <Link to="/admin/equipment">Cancel</Link>
            </Button>
          )}
        </div>
      )}

      {!creating && <AvailabilityCard availability={loaded!.availability} />}

      <Section
        title="Roll preview"
        hint={dirty ? 'Previews the form as it is now, unsaved.' : 'Previews the saved definition.'}
        testId="equipment-preview"
      >
        <p className="text-xs text-ink-muted">
          Range {formatMultiplier(Math.round(Number(form.multiplierMin) * 10_000) || 0)} –{' '}
          {formatMultiplier(Math.round(Number(form.multiplierMax) * 10_000) || 0)}
        </p>
        <RollPreviewPanel target={dirty ? { definition: inputOf(form) } : { key: definitionKey }} />
      </Section>

      {!creating && (
        <Section
          title="History"
          hint="Who changed this equipment, and when."
          testId="equipment-history"
        >
          {historyQuery.data && historyQuery.data.events.length === 0 && (
            <p className="text-xs text-ink-muted">No recorded changes.</p>
          )}
          <ul className="space-y-1 text-sm" data-testid="history-list">
            {(historyQuery.data?.events ?? []).map((e) => (
              <li key={e.id}>
                <span className="text-ink">{e.action}</span>{' '}
                <span className="text-ink-muted">
                  {new Date(e.createdAt).toLocaleString()}
                  {e.actor ? ` by ${e.actor}` : ''}
                  {Array.isArray(e.details.changedFields) &&
                  (e.details.changedFields as string[]).length > 0
                    ? ` — ${(e.details.changedFields as string[]).join(', ')}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <ArtworkPickerDialog
        open={picking}
        onClose={() => setPicking(false)}
        source={equipmentArtworkSource}
        selectedPath={form.artworkPath || null}
        onSelect={(path) => {
          set({ artworkPath: path });
          setPicking(false);
        }}
        title="Choose equipment artwork"
      />
      {toggling && definition && (
        <EnableDefinitionDialog
          definition={definition}
          onClose={() => setToggling(false)}
          onDone={(detail) => {
            adopt(detail);
            queryClient.setQueryData(
              [...EQUIPMENT_CATALOGUE_QUERY_KEY, 'definition', definitionKey],
              detail,
            );
          }}
        />
      )}
      {duplicating && definition && (
        <DuplicateDefinitionDialog source={definition} onClose={() => setDuplicating(false)} />
      )}
    </div>
  );
}
