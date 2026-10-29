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
import { DungeonSpeciesPicker } from '@/features/adminDungeons/DungeonSpeciesPicker';

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
  }, [key]);
  useEffect(() => {
    if (detail.data) {
      setDraft(structuredClone(detail.data.definition));
      setRevision(detail.data.revision);
    }
  }, [detail.data]);
  const operation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: SHARED_POOL_QUERY });
    },
  });
  const run = (action: () => Promise<unknown>) => operation.mutate(action);
  const busy = operation.isPending;
  const names = new Map(species.data?.species.map((s) => [s.slug, s.name]));
  function add(slug: string | null) {
    if (!draft) return;
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
    setPicking(false);
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
                  setCreating(true);
                }}
              >
                Create pool
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => run(async () => download(await exportSharedPools()))}
            >
              Export all JSON
            </Button>
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
          {canWrite && (
            <section aria-label="Import pools" className="space-y-2">
              <h2>Import pool JSON</h2>
              <p>
                New pools start disabled. Existing activation stays local. Review all destination
                keys before applying.
              </p>
              <input
                aria-label="Pool JSON file"
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    run(async () => {
                      if (file.size > 2 * 1024 * 1024) throw new Error('Pool file exceeds 2 MiB.');
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
                    Applying replaces the listed pools with this JSON. Unlisted pools are preserved.
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
          <p>
            {revision === null ? 'New pool' : `Editing revision ${revision}`} ·{' '}
            {draft.enabled ? 'Enabled' : 'Disabled'}
          </p>
          <fieldset disabled={!canWrite || busy} className="space-y-3">
            <label className="block">
              Stable key
              <Input
                aria-label="Pool key"
                maxLength={64}
                disabled={!!key}
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              />
            </label>
            <label className="block">
              Name
              <Input
                aria-label="Pool name"
                maxLength={80}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="block">
              Description
              <Input
                aria-label="Pool description"
                maxLength={600}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <p>
              Weights, Nothing outcomes, conditions and once-per-run use the existing dungeon rules.
              Conditions must name flags and rooms declared in every referencing dungeon.
            </p>
            <ol className="space-y-3">
              {draft.entries.map((entry, i) => (
                <li key={entry.id} className="space-y-2 rounded border border-border p-3">
                  <p>
                    {'species' in entry ? (names.get(entry.species) ?? entry.species) : 'Nothing'} ·{' '}
                    {entry.id}
                  </p>
                  <label>
                    Weight
                    <Input
                      type="number"
                      aria-label={`Entry ${i + 1} weight`}
                      min={1}
                      max={1000000}
                      value={entry.weight}
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
                      Once per run
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
                  <label className="block">
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
                  {conditionErrors[entry.id] && <p role="alert">{conditionErrors[entry.id]}</p>}
                  <Button
                    variant="outline"
                    onClick={() =>
                      setDraft({ ...draft, entries: draft.entries.filter((_, n) => n !== i) })
                    }
                  >
                    Remove entry {i + 1}
                  </Button>
                </li>
              ))}
            </ol>
            <Button
              variant="outline"
              disabled={draft.entries.length >= 50}
              onClick={() => setPicking(true)}
            >
              Add species
            </Button>{' '}
            <Button
              variant="outline"
              disabled={draft.entries.length >= 50}
              onClick={() => add(null)}
            >
              Add Nothing
            </Button>
            {picking && (
              <>
                <p>
                  Membership does not authorize acquisition. Dungeon-specific eligibility is checked
                  when each dungeon validates and starts a run.
                </p>
                {species.isPending && <p>Loading species…</p>}
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
                    dungeonKey="shared_pool_catalogue"
                    purpose="shared_pool"
                    listed={
                      new Set(draft.entries.flatMap((e) => ('species' in e ? [e.species] : [])))
                    }
                    disabled={busy}
                    onSelect={add}
                  />
                )}
              </>
            )}
            <div>
              <Button
                disabled={draft.entries.some((e) => !!conditionErrors[e.id])}
                onClick={() =>
                  run(async () => {
                    const saved =
                      revision === null
                        ? await createSharedPool(draft)
                        : await saveSharedPool(draft, revision);
                    setDraft(saved.definition);
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
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(async () => download(await exportSharedPools(key)))}
                >
                  Export JSON
                </Button>
                {canWrite && (
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      revision === null ||
                      JSON.stringify(draft) !== JSON.stringify(detail.data?.definition)
                    }
                    onClick={() =>
                      run(async () => {
                        const saved = await enableSharedPool(key, !draft.enabled, revision!);
                        setDraft(saved.definition);
                        setRevision(saved.revision);
                      })
                    }
                  >
                    {draft.enabled ? 'Disable pool' : 'Enable pool'}
                  </Button>
                )}
              </div>
              {canWrite && (
                <div className="flex gap-2">
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
