import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSharedPool,
  duplicateSharedPool,
  enableSharedPool,
  exportSharedPools,
  getSharedPool,
  importSharedPools,
  listSharedPools,
  saveSharedPool,
  sharedPoolReferences,
  SHARED_POOL_QUERY,
  type SharedPoolDefinition,
  type SharedPoolPackage,
} from '@/api/adminDungeonSpeciesPools';
import { type DungeonCondition, getDungeonSpecies } from '@/api/adminDungeons';
import { useHasPermission } from '@/auth/useSession';
import { PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/layout/ErrorState';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { availablePoolKey, poolKeyFromName, validPoolKey } from './sharedPoolForm';
import { DungeonSpeciesPicker, SpeciesThumb } from '@/features/adminDungeons/DungeonSpeciesPicker';

function download(pkg: SharedPoolPackage) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'dungeon-waifumon-pools.json';
  link.click();
  URL.revokeObjectURL(url);
}
const blank = (): SharedPoolDefinition => ({
  key: '',
  name: '',
  description: '',
  enabled: false,
  entries: [],
});
export function SharedPoolsPage() {
  const { key } = useParams();
  const navigate = useNavigate(),
    client = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const [search, setSearch] = useState(''),
    [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<SharedPoolDefinition | null>(null),
    [revision, setRevision] = useState<number | null>(null);
  const [saved, setSaved] = useState<SharedPoolDefinition | null>(null);
  const [manualKey, setManualKey] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [conditionErrors, setConditionErrors] = useState<Record<string, string>>({});
  const [copyKey, setCopyKey] = useState(''),
    [picking, setPicking] = useState(false);
  const [importText, setImportText] = useState(''),
    [review, setReview] = useState<{
      pkg: SharedPoolPackage;
      revisions: Record<string, number | null>;
    } | null>(null);
  const pools = useQuery({
    queryKey: SHARED_POOL_QUERY,
    queryFn: ({ signal }) => listSharedPools(signal),
  });
  const detail = useQuery({
    queryKey: [...SHARED_POOL_QUERY, key],
    queryFn: ({ signal }) => getSharedPool(key!, signal),
    enabled: !!key,
  });
  const references = useQuery({
    queryKey: [...SHARED_POOL_QUERY, key, 'references'],
    queryFn: ({ signal }) => sharedPoolReferences(key!, signal),
    enabled: !!key,
  });
  const species = useQuery({
    queryKey: ['dungeon-species', 'shared_pool_catalogue'],
    queryFn: ({ signal }) => getDungeonSpecies('shared_pool_catalogue', signal),
    enabled: !!draft,
  });
  useEffect(() => {
    setDraft(null);
    setRevision(null);
    setCreating(false);
    setPicking(false);
    setConditionErrors({});
    setSaved(null);
    setManualKey(null);
    setShowErrors(false);
  }, [key]);
  useEffect(() => {
    if (detail.data && key && draft === null) {
      setDraft(structuredClone(detail.data.definition));
      setRevision(detail.data.revision);
      setSaved(structuredClone(detail.data.definition));
    }
  }, [detail.data, key, draft]);
  const operation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: SHARED_POOL_QUERY });
    },
  });
  const run = (action: () => Promise<unknown>) => operation.mutate(action);
  const busy = operation.isPending;
  const names = new Map(species.data?.species.map((s) => [s.slug, s.name]));
  const bySlug = new Map(species.data?.species.map((s) => [s.slug, s]));
  const taken = new Set(pools.data?.map((p) => p.definition.key));
  const generatedKey = availablePoolKey(draft?.name ?? '', taken);
  const poolKey = key ? (draft?.key ?? key) : (manualKey ?? generatedKey);
  const keyError = !validPoolKey(poolKey)
    ? 'Use lowercase letters, numbers and single underscores, up to 64 characters.'
    : !key && taken.has(poolKey)
      ? `This identifier is already used. Try ${availablePoolKey(poolKey, taken)}.`
      : null;
  const invalidWeight = (weight: number) =>
    !Number.isInteger(weight) || weight < 1 || weight > 1000000;
  const hasConditionErrors =
    draft?.entries.some((e) => Object.hasOwn(conditionErrors, e.id)) ?? false;
  const dirty =
    !!draft && (!saved || JSON.stringify(draft) !== JSON.stringify(saved) || hasConditionErrors);
  const formErrors = draft
    ? [
        ...(!draft.name.trim() ? ['Name is required.'] : []),
        ...(keyError ? [keyError] : []),
        ...(!draft.entries.some((e) => 'species' in e) ? ['Add at least one WaifuMon.'] : []),
        ...(draft.entries.some((e) => invalidWeight(e.weight))
          ? ['Each weight must be a whole number from 1 to 1,000,000.']
          : []),
        ...(hasConditionErrors ? ['Fix the condition JSON before saving.'] : []),
      ]
    : [];
  function removeSpecies(slug: string) {
    setDraft(
      (current) =>
        current && {
          ...current,
          entries: current.entries.filter((e) => !('species' in e) || e.species !== slug),
        },
    );
  }
  function add(slug: string | null) {
    if (
      !draft ||
      draft.entries.length >= 50 ||
      (slug && draft.entries.some((e) => 'species' in e && e.species === slug))
    )
      return;
    let n = 1;
    while (draft.entries.some((e) => e.id === `entry_${n}`)) n++;
    setDraft({
      ...draft,
      entries: [
        ...draft.entries,
        slug
          ? { id: `entry_${n}`, species: slug, weight: 1, oncePerRun: true }
          : { id: `entry_${n}`, nothing: true, weight: 1 },
      ],
    });
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title="Dungeon WaifuMon Pools"
        description="Shared encounter membership and weights. Each dungeon controls acquisition permission and limits. Edits affect future runs; active runs keep their starting pool."
      />
      {operation.isError && <ErrorState title="Pool operation failed" error={operation.error} />}
      {!key && !creating && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Search pools"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {canWrite && (
              <Button
                onClick={() => {
                  setDraft(blank());
                  setRevision(null);
                  setSaved(null);
                  setManualKey(null);
                  setShowErrors(false);
                  setConditionErrors({});
                  setCreating(true);
                }}
              >
                Create pool
              </Button>
            )}
          </div>
          {pools.isPending && <p role="status">Loading pools…</p>}
          {pools.isError && (
            <ErrorState
              title="Could not load pools"
              error={pools.error}
              onRetry={() => void pools.refetch()}
            />
          )}
          <ul className="space-y-2">
            {pools.data
              ?.filter((p) =>
                `${p.definition.key} ${p.definition.name} ${p.definition.description}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map(({ definition: p, revision: r }) => (
                <li key={p.key} className="rounded border border-border p-3">
                  <Link to={`/admin/dungeons/waifumon-pools/${p.key}`} className="underline">
                    {p.name}
                  </Link>
                  <p className="text-sm">
                    {p.key} · {p.enabled ? 'Enabled' : 'Disabled'} · revision {r} ·{' '}
                    {p.entries.length} entries
                  </p>
                  <p>{p.description}</p>
                </li>
              ))}
          </ul>
          <details className="rounded border border-border p-3">
            <summary className="cursor-pointer font-medium">Advanced / Import–Export</summary>
            <div className="mt-3 space-y-3">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run(async () => download(await exportSharedPools()))}
              >
                Export all JSON
              </Button>
              {canWrite && (
                <section aria-label="Import pools" className="space-y-2">
                  <h2>Import pool JSON</h2>
                  <p>
                    New pools start disabled. Existing activation stays local. Review all
                    destination keys before applying.
                  </p>
                  <input
                    aria-label="Pool JSON file"
                    type="file"
                    accept=".json,application/json"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        run(async () => {
                          if (file.size > 2 * 1024 * 1024)
                            throw new Error('Pool file exceeds 2 MiB.');
                          setImportText(await file.text());
                          setReview(null);
                        });
                    }}
                  />
                  <textarea
                    aria-label="Pool JSON"
                    className="min-h-32 w-full rounded border border-border bg-surface p-2"
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value);
                      setReview(null);
                    }}
                  />
                  <Button
                    disabled={busy || !pools.data}
                    onClick={() =>
                      run(async () => {
                        const pkg = JSON.parse(importText) as SharedPoolPackage;
                        if (
                          pkg.format !== 'waifumon-dungeon-species-pools' ||
                          pkg.schemaVersion !== 1 ||
                          !Array.isArray(pkg.pools) ||
                          !pkg.pools.length
                        )
                          throw new Error('Choose a Dungeon WaifuMon Pools v1 package.');
                        const current = await listSharedPools();
                        setReview({
                          pkg,
                          revisions: Object.fromEntries(
                            pkg.pools.map((p) => [
                              p.key,
                              current.find((r) => r.definition.key === p.key)?.revision ?? null,
                            ]),
                          ),
                        });
                      })
                    }
                  >
                    Review import
                  </Button>
                  {review && (
                    <div className="space-y-2">
                      <ul>
                        {review.pkg.pools.map((p) => (
                          <li key={p.key}>
                            {p.key}:{' '}
                            {review.revisions[p.key] === null
                              ? 'create disabled'
                              : `replace revision ${review.revisions[p.key]}, preserve enabled status`}{' '}
                            · {p.name} · {p.entries.length} entries
                          </li>
                        ))}
                      </ul>
                      <p>
                        Applying replaces the listed pools with this JSON. Unlisted pools are
                        preserved.
                      </p>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await importSharedPools(review.pkg, review.revisions);
                            setReview(null);
                            setImportText('');
                          })
                        }
                      >
                        Apply reviewed import
                      </Button>
                    </div>
                  )}
                </section>
              )}
            </div>
          </details>
        </>
      )}
      {key && detail.isPending && <p role="status">Loading pool…</p>}
      {detail.isError && <ErrorState title="Could not load pool" error={detail.error} />}
      {draft && (key || creating) && (
        <section aria-label="Pool editor" className="space-y-3">
          <Button
            variant="outline"
            onClick={() => {
              setDraft(null);
              setCreating(false);
              navigate('/admin/dungeons/waifumon-pools');
            }}
          >
            Back to pools
          </Button>
          <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
            <strong>{draft.enabled ? 'Enabled' : 'Disabled'}</strong>
            <span>{revision === null ? 'New pool · starts disabled' : `Revision ${revision}`}</span>
            <span>{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          </div>
          {key && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const fresh = await getSharedPool(key);
                  setDraft(structuredClone(fresh.definition));
                  setSaved(structuredClone(fresh.definition));
                  setRevision(fresh.revision);
                  setConditionErrors({});
                  setShowErrors(false);
                })
              }
            >
              {dirty ? 'Reload and discard edits' : 'Reload saved pool'}
            </Button>
          )}
          {!key && pools.isPending && (
            <p role="status" className="text-sm">
              Checking available identifiers…
            </p>
          )}
          {!key && pools.isError && (
            <ErrorState
              title="Could not check available identifiers"
              error={pools.error}
              onRetry={() => void pools.refetch()}
            />
          )}
          <fieldset disabled={!canWrite || busy} className="space-y-4">
            <label className="block space-y-1">
              Name <span aria-hidden="true">*</span>
              <Input
                aria-label="Pool name"
                required
                autoFocus={creating}
                maxLength={80}
                value={draft.name}
                aria-invalid={showErrors && !draft.name.trim()}
                aria-describedby={showErrors && !draft.name.trim() ? 'pool-name-error' : undefined}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {showErrors && !draft.name.trim() && (
              <p id="pool-name-error" role="alert" className="text-sm text-danger">
                Name is required.
              </p>
            )}
            <label className="block space-y-1">
              Description
              <Input
                aria-label="Pool description"
                maxLength={600}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <p className="text-xs text-ink-muted">
              {key ? 'Identifier (fixed)' : 'Identifier (automatically generated)'}:{' '}
              <code className="break-all" data-testid="pool-key-preview">
                {draft.name.trim() || key ? poolKey : 'Generated from the name'}
              </code>
            </p>
            {!key &&
              draft.name.trim() &&
              manualKey === null &&
              generatedKey !== poolKeyFromName(draft.name) && (
                <p className="text-xs text-ink-muted">
                  That name’s identifier is already in use. Suggested available identifier:{' '}
                  {generatedKey}.
                </p>
              )}
            {!key && (
              <details className="rounded border border-border p-3">
                <summary className="cursor-pointer text-sm">Advanced identifier</summary>
                <p className="my-2 text-xs text-ink-muted">
                  Optional technical identifier for JSON references. Set it before creation; it
                  stays fixed afterwards.
                </p>
                <label className="block text-sm">
                  Pool key
                  <Input
                    aria-label="Pool key"
                    maxLength={64}
                    value={poolKey}
                    aria-invalid={!!keyError}
                    onChange={(e) => setManualKey(e.target.value)}
                  />
                </label>
                {keyError && (
                  <p role="alert" className="text-sm text-danger">
                    {keyError}
                  </p>
                )}
                <Button variant="outline" size="sm" onClick={() => setManualKey(null)}>
                  Use automatic identifier
                </Button>
              </details>
            )}
            <section aria-label="Choose WaifuMon" className="space-y-2">
              <h2 className="font-medium">
                WaifuMon <span aria-hidden="true">*</span>
              </h2>
              <p className="text-xs text-ink-muted">
                Choose at least one. Each dungeon still controls acquisition permission and limits.
              </p>
              <Button variant="outline" onClick={() => setPicking(!picking)}>
                {picking ? 'Close WaifuMon picker' : 'Add WaifuMon'}
              </Button>
              {picking && (
                <>
                  {species.isPending && <p role="status">Loading WaifuMon…</p>}
                  {species.isError && (
                    <ErrorState
                      title="Could not load species"
                      error={species.error}
                      onRetry={() => void species.refetch()}
                    />
                  )}
                  {species.data && (
                    <DungeonSpeciesPicker
                      species={species.data.species}
                      regions={species.data.regions ?? []}
                      dungeonKey="shared_pool_catalogue"
                      purpose="shared_pool"
                      listed={
                        new Set(draft.entries.flatMap((e) => ('species' in e ? [e.species] : [])))
                      }
                      disabled={busy || !canWrite}
                      onSelect={(slug) => {
                        if (draft.entries.length < 50) add(slug);
                      }}
                      onRemove={removeSpecies}
                    />
                  )}
                  {draft.entries.length >= 50 && (
                    <p role="status" className="text-sm">
                      This pool has 50 entries. Remove an entry before adding another.
                    </p>
                  )}
                </>
              )}
            </section>
            <section aria-label="Selected WaifuMon and weights" className="space-y-2">
              <h2 className="font-medium">
                Selected WaifuMon and weights · {draft.entries.filter((e) => 'species' in e).length}{' '}
                selected
              </h2>
              <p className="text-xs text-ink-muted">
                Larger weights appear more often relative to other entries. Nothing is an empty
                encounter outcome.
              </p>
              {!draft.entries.length && (
                <p className="text-sm text-ink-muted">
                  No WaifuMon selected yet. Use Add WaifuMon to start.
                </p>
              )}
              <ol className="space-y-3">
                {draft.entries.map((entry, i) => (
                  <li key={entry.id} className="space-y-2 rounded border border-border p-3">
                    <div className="flex items-center gap-2">
                      {'species' in entry && bySlug.get(entry.species) && (
                        <SpeciesThumb species={bySlug.get(entry.species)!} compact />
                      )}
                      <p className="min-w-0 flex-1 break-words text-sm font-medium">
                        {'species' in entry
                          ? (names.get(entry.species) ?? entry.species)
                          : 'Nothing'}
                        {'when' in entry && entry.when ? ' · Conditional' : ''}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={
                          'species' in entry
                            ? `Remove selected ${names.get(entry.species) ?? entry.species}`
                            : `Remove Nothing entry ${i + 1}`
                        }
                        onClick={() =>
                          setDraft({ ...draft, entries: draft.entries.filter((_, n) => n !== i) })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                    <div className="grid items-center gap-3 sm:grid-cols-2">
                      <label className="text-sm">
                        Weight <span aria-hidden="true">*</span>
                        <Input
                          type="number"
                          aria-label={`Entry ${i + 1} weight`}
                          min={1}
                          max={1000000}
                          value={entry.weight || ''}
                          aria-invalid={invalidWeight(entry.weight)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              entries: draft.entries.map((v, n) =>
                                n === i ? { ...v, weight: Number(e.target.value) } : v,
                              ),
                            })
                          }
                        />
                      </label>
                      {'species' in entry ? (
                        <label className="flex gap-2">
                          <input
                            type="checkbox"
                            aria-label={`Entry ${i + 1} once per run`}
                            checked={entry.oncePerRun !== false}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                entries: draft.entries.map((v, n) =>
                                  n === i ? { ...v, oncePerRun: e.target.checked } : v,
                                ),
                              })
                            }
                          />
                          At most once per run
                        </label>
                      ) : (
                        <label>
                          Nothing text
                          <Input
                            value={entry.text ?? ''}
                            maxLength={200}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                entries: draft.entries.map((v, n) =>
                                  n === i ? { ...v, text: e.target.value } : v,
                                ),
                              })
                            }
                          />
                        </label>
                      )}
                    </div>
                    {invalidWeight(entry.weight) && (
                      <p role="alert" className="text-sm text-danger">
                        Weight must be a whole number from 1 to 1,000,000.
                      </p>
                    )}
                    {'species' in entry && (
                      <p className="text-xs text-ink-muted">
                        Once per run excludes her after she has been presented anywhere in that run.
                      </p>
                    )}
                    <details
                      open={!!entry.when || Object.hasOwn(conditionErrors, entry.id)}
                      className="rounded border border-border p-2"
                    >
                      <summary className="cursor-pointer text-sm">
                        Advanced condition {entry.when ? '(configured)' : '(optional)'}
                      </summary>
                      <p className="my-2 text-xs text-ink-muted">
                        Only draw this entry when the condition holds. Flag and room names must
                        exist in every referencing dungeon.
                      </p>
                      <label className="block text-sm">
                        Optional condition JSON (blank means always)
                        <textarea
                          key={`${draft.key}:${revision}:${entry.id}`}
                          aria-label={`Entry ${i + 1} condition JSON`}
                          className="w-full rounded border border-border bg-surface p-2"
                          defaultValue={entry.when ? JSON.stringify(entry.when) : ''}
                          onChange={(e) => {
                            try {
                              const when = e.target.value.trim()
                                ? (JSON.parse(e.target.value) as DungeonCondition)
                                : undefined;
                              setConditionErrors((old) => {
                                const next = { ...old };
                                delete next[entry.id];
                                return next;
                              });
                              setDraft({
                                ...draft,
                                entries: draft.entries.map((v, n) => {
                                  if (n !== i) return v;
                                  const next = { ...v };
                                  if (when) next.when = when;
                                  else delete next.when;
                                  return next;
                                }),
                              });
                            } catch {
                              setConditionErrors((old) => ({
                                ...old,
                                [entry.id]: 'Enter valid condition JSON before saving.',
                              }));
                            }
                          }}
                        />
                      </label>
                      {Object.hasOwn(conditionErrors, entry.id) && (
                        <p role="alert" className="text-sm text-danger">
                          {conditionErrors[entry.id]}
                        </p>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
              <Button
                variant="outline"
                disabled={draft.entries.length >= 50}
                onClick={() => add(null)}
              >
                Add Nothing outcome
              </Button>
            </section>
            {showErrors && formErrors.length > 0 && (
              <ul role="alert" className="space-y-1 text-sm text-danger">
                {formErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            <div>
              <Button
                disabled={!canWrite || busy || (!key && !pools.data) || (!dirty && !!key)}
                onClick={() =>
                  run(async () => {
                    setShowErrors(true);
                    if (formErrors.length) return;
                    const definition = { ...draft, key: poolKey };
                    if (revision === null) {
                      const current = await listSharedPools();
                      client.setQueryData(SHARED_POOL_QUERY, current);
                      if (current.some((p) => p.definition.key === poolKey))
                        throw new Error(
                          'This identifier was just taken. Review the available identifier and save again.',
                        );
                    }
                    const saved =
                      revision === null
                        ? await createSharedPool(definition)
                        : await saveSharedPool(definition, revision);
                    setDraft(saved.definition);
                    setSaved(structuredClone(saved.definition));
                    setRevision(saved.revision);
                    setCreating(false);
                    navigate(`/admin/dungeons/waifumon-pools/${saved.definition.key}`);
                  })
                }
              >
                Save pool
              </Button>
            </div>
          </fieldset>
          {key && (
            <>
              <div className="flex flex-wrap gap-2">
                {canWrite && (
                  <Button
                    variant="outline"
                    disabled={busy || revision === null || dirty}
                    onClick={() =>
                      run(async () => {
                        const saved = await enableSharedPool(key, !draft.enabled, revision!);
                        setDraft(saved.definition);
                        setSaved(structuredClone(saved.definition));
                        setRevision(saved.revision);
                      })
                    }
                  >
                    {draft.enabled ? 'Disable pool' : 'Enable pool'}
                  </Button>
                )}
              </div>
              {canWrite && dirty && (
                <p className="text-xs text-ink-muted">
                  Save your changes before changing pool availability.
                </p>
              )}
              <details className="rounded border border-border p-3">
                <summary className="cursor-pointer font-medium">Advanced / Import–Export</summary>
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-ink-muted">
                    Export uses the saved pool. Import pools from the catalogue page.
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => run(async () => download(await exportSharedPools(key)))}
                  >
                    Export JSON
                  </Button>
                  {canWrite && (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        aria-label="Duplicate pool key"
                        placeholder="New stable key"
                        value={copyKey}
                        onChange={(e) => setCopyKey(e.target.value)}
                      />
                      <Button
                        disabled={busy || !copyKey || revision === null}
                        onClick={() =>
                          run(async () => {
                            const saved = await duplicateSharedPool(key, copyKey, revision!);
                            setCopyKey('');
                            navigate(`/admin/dungeons/waifumon-pools/${saved.definition.key}`);
                          })
                        }
                      >
                        Duplicate saved pool
                      </Button>
                    </div>
                  )}
                </div>
              </details>
              <section aria-label="Where used">
                <h2>Where used</h2>
                <p>Disabling blocks future runs. Active runs retain their pool.</p>
                {references.isPending && <p>Loading references…</p>}
                {references.isError && (
                  <ErrorState title="Could not load references" error={references.error} />
                )}
                <ul>
                  {references.data?.map((r) => (
                    <li key={`${r.dungeonKey}:${r.source}:${r.poolId}`}>
                      <Link
                        className="underline"
                        to={`/admin/dungeons/definitions/${r.dungeonKey}`}
                      >
                        {r.name}
                      </Link>{' '}
                      · {r.source} · {r.poolId}
                    </li>
                  ))}
                </ul>
                {references.data?.length === 0 && <p>No draft or published dungeon references.</p>}
              </section>
            </>
          )}
        </section>
      )}
    </div>
  );
}
