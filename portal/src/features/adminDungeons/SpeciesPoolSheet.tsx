import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getDungeonSpecies,
  type DungeonDefinition,
  type DungeonSpeciesPoolEntry,
  type DungeonSpeciesPoolOdds,
} from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { DungeonConditionEditor } from './DungeonConditionEditor';
import { withMember } from './dungeonEventModel';
import {
  newSpeciesEntry,
  speciesPoolUsage,
  updateSpeciesPool,
  SPECIES_POOL_LIMITS,
} from './dungeonSpeciesModel';
import {
  DungeonSpeciesPicker,
  SpeciesAvailability,
  SpeciesThumb,
  speciesReasonText,
} from './DungeonSpeciesPicker';
import { EMPTY_SPECIES_SCENARIO, useSpeciesInsight } from './useSpeciesInsight';
import type { EventIssueTarget, FriendlyIssue } from './dungeonText';
const hint = 'text-xs text-ink-muted';
const percent = (p: number) => `${Number((p * 100).toFixed(2))}%`;
export function Odds({
  odds,
  names,
  label,
}: {
  odds: DungeonSpeciesPoolOdds;
  names: Map<string, string>;
  label: string;
}) {
  return (
    <section aria-label={label} className="space-y-2">
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className={hint}>
        Total eligible weight: {odds.totalWeight}. Nothing: {percent(odds.nothingProbability)}.
        Unavailable outcome: {percent(odds.unavailableProbability)}.
      </p>
      <ul className="space-y-1 text-sm">
        {odds.entries.map((e) => (
          <li key={e.id} className={e.eligible ? '' : 'text-ink-muted'}>
            {e.species ? (names.get(e.species) ?? e.species) : 'Nothing'}:{' '}
            <strong>{percent(e.probability)}</strong> · weight {e.weight}
            {!e.eligible
              ? ` · Excluded: ${e.reason === 'condition' ? 'condition does not hold' : 'already encountered this run'}`
              : e.unavailableReason
                ? ` · Draws unavailable: ${speciesReasonText[e.unavailableReason]}`
                : ' · Eligible'}
          </li>
        ))}
      </ul>
      <p className={hint}>
        Effective selection rarity distribution:{' '}
        {Object.entries(odds.rarityDistribution)
          .map(([r, p]) => `${r} ${percent(p)}`)
          .join(' · ') || 'No species in the draw'}
        .
      </p>
      <p className={hint}>
        Obtainable rarity distribution (share of all draws):{' '}
        {Object.entries(odds.obtainableRarityDistribution)
          .map(([r, p]) => `${r} ${percent(p)}`)
          .join(' · ') || 'None'}
        .
      </p>
    </section>
  );
}
export function SpeciesPoolSheet({
  poolId,
  definition,
  disabled,
  issues,
  focus,
  onChange,
  onClose,
}: {
  poolId: string;
  definition: DungeonDefinition;
  disabled: boolean;
  issues: FriendlyIssue[];
  focus?: EventIssueTarget & { nonce: number };
  onChange: (d: DungeonDefinition) => void;
  onClose: () => void;
}) {
  const pool = definition.speciesPools?.find((p) => p.id === poolId);
  const [picking, setPicking] = useState<string | null>(null);
  const [scenario, setScenario] = useState(EMPTY_SPECIES_SCENARIO);
  const body = useRef<HTMLDivElement>(null);
  const catalogue = useQuery({
    queryKey: ['dungeon-species', definition.key],
    queryFn: ({ signal }) => getDungeonSpecies(definition.key, signal),
  });
  const insight = useSpeciesInsight(definition, scenario);
  useEffect(() => {
    if (!pool) onClose();
  }, [pool, onClose]);
  useEffect(() => {
    if (!focus) return;
    const timer = window.setTimeout(() => {
      const root = body.current;
      const scope = focus.entryId
        ? root?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focus.entryId)}"]`)
        : root;
      const field = focus.field
        ? scope?.querySelector<HTMLElement>(`[data-species-field="${CSS.escape(focus.field)}"]`)
        : scope;
      const target = field ?? scope;
      target?.scrollIntoView?.({ block: 'nearest' });
      target?.querySelector<HTMLElement>('input, select, button')?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focus]);
  if (!pool) return null;
  const species = catalogue.data?.species ?? [];
  const bySlug = new Map(species.map((s) => [s.slug, s]));
  const names = new Map(species.map((s) => [s.slug, s.name]));
  const analysis = insight.pools?.find((p) => p.poolId === poolId);
  const update = (entries: DungeonSpeciesPoolEntry[]) =>
    onChange(updateSpeciesPool(definition, poolId, (p) => ({ ...p, entries })));
  const setEntry = (entry: DungeonSpeciesPoolEntry) =>
    update(pool.entries.map((e) => (e.id === entry.id ? entry : e)));
  const toggle = (key: 'flags' | 'completedRooms' | 'seenSpecies', id: string, checked: boolean) =>
    setScenario((s) => ({
      ...s,
      [key]: checked ? [...s[key], id] : s[key].filter((v) => v !== id),
    }));
  const slugs = [...new Set(pool.entries.flatMap((e) => ('species' in e ? [e.species] : [])))];
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        closeLabel="Close WaifuMon pool"
        className="w-full max-w-full sm:w-[42rem] sm:max-w-[95vw]"
        data-testid="species-pool-editor"
      >
        <div
          ref={body}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pt-14 sm:p-6 sm:pt-14"
        >
          <SheetTitle className="text-lg font-semibold">
            WaifuMon pool: {pool.name || 'Unnamed'}
          </SheetTitle>
          <SheetDescription>
            Changes belong to your dungeon draft. Selection odds come from the runtime’s server
            analysis.
          </SheetDescription>
          <p className={`${hint} break-words`} title={`Pool ID: ${pool.id}`}>
            {speciesPoolUsage(definition, poolId)
              .map((u) => u.name)
              .join('; ') || 'Not used yet'}
            .
          </p>
          {!!issues.length && (
            <ul aria-label="To do in this WaifuMon pool" className="space-y-1 text-sm">
              {issues.map((i, n) => (
                <li key={n} className={i.level === 'review' ? hint : 'text-danger'}>
                  {i.title} {i.help}
                </li>
              ))}
            </ul>
          )}
          {catalogue.isError && (
            <p role="alert" className="text-sm text-danger">
              The species catalogue could not be loaded.{' '}
              <Button variant="link" onClick={() => void catalogue.refetch()}>
                Retry species catalogue
              </Button>
            </p>
          )}
          <fieldset disabled={disabled} className="space-y-3">
            <label className="block space-y-1 text-sm" data-species-field="name">
              Pool name
              <Input
                aria-label="WaifuMon pool name"
                maxLength={80}
                value={pool.name}
                onChange={(e) =>
                  onChange(
                    updateSpeciesPool(definition, poolId, (p) => ({ ...p, name: e.target.value })),
                  )
                }
              />
            </label>
            <section aria-label="Pool entries" data-species-field="entries" className="space-y-2">
              <h3 className="text-sm font-semibold">Entries</h3>
              <p className={hint}>
                Weights are compared with each other. Unavailable species keep their weight and
                resolve as unavailable; their weight never moves to another species.
              </p>
              <ol className="space-y-3">
                {pool.entries.map((e, index) => {
                  const n = index + 1,
                    sp = 'species' in e ? bySlug.get(e.species) : undefined;
                  const duplicate =
                    'species' in e &&
                    pool.entries.filter((x) => 'species' in x && x.species === e.species).length >
                      1;
                  const invalidWeight =
                    !Number.isInteger(e.weight) ||
                    e.weight < 1 ||
                    e.weight > SPECIES_POOL_LIMITS.weight;
                  return (
                    <li
                      key={e.id}
                      data-entry-id={e.id}
                      data-testid="species-pool-entry"
                      className="space-y-2 rounded border border-border p-3"
                    >
                      <div data-species-field="species" className="space-y-2">
                        {'species' in e ? (
                          <>
                            {sp ? (
                              <div className="flex gap-2">
                                <SpeciesThumb species={sp} />
                                <div className="min-w-0">
                                  <p className="break-words text-sm font-medium">{sp.name}</p>
                                  <SpeciesAvailability species={sp} />
                                </div>
                              </div>
                            ) : (
                              <p role="alert" className="break-words text-sm text-danger">
                                {catalogue.isPending
                                  ? 'Loading species…'
                                  : catalogue.isError
                                    ? 'Catalogue unavailable; use Retry species catalogue.'
                                    : `Unavailable species: ${e.species || 'none chosen'}. Replace or remove this entry.`}
                              </p>
                            )}
                            {duplicate && (
                              <p role="alert" className="text-sm text-danger">
                                This species appears more than once. Remove a duplicate before
                                publishing.
                              </p>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Entry ${n}: replace species`}
                              onClick={() => setPicking(e.id)}
                            >
                              Replace species
                            </Button>
                          </>
                        ) : (
                          <p className="text-sm font-medium">Nothing</p>
                        )}
                      </div>
                      <label className="block text-sm" data-species-field="weight">
                        Weight
                        <Input
                          type="number"
                          min={1}
                          max={SPECIES_POOL_LIMITS.weight}
                          step={1}
                          aria-label={`Entry ${n} weight`}
                          aria-invalid={invalidWeight}
                          value={Number.isFinite(e.weight) ? e.weight || '' : ''}
                          onChange={(ev) =>
                            setEntry({
                              ...e,
                              weight: ev.target.value === '' ? 0 : Number(ev.target.value),
                            })
                          }
                        />
                      </label>
                      {invalidWeight && (
                        <p role="alert" className="text-xs text-danger">
                          Weight must be a whole number from 1 to 1,000,000. Finish this field
                          before saving.
                        </p>
                      )}
                      {'species' in e ? (
                        <label className="flex gap-2 text-sm" data-species-field="oncePerRun">
                          <input
                            type="checkbox"
                            aria-label={`Entry ${n}: once per run`}
                            checked={e.oncePerRun !== false}
                            onChange={(ev) => setEntry({ ...e, oncePerRun: ev.target.checked })}
                          />
                          At most once per run, after this species has been presented anywhere in
                          the run
                        </label>
                      ) : (
                        <label className="block text-sm" data-species-field="text">
                          Nothing text (optional)
                          <Input
                            aria-label={`Entry ${n} nothing text`}
                            maxLength={200}
                            value={e.text ?? ''}
                            onChange={(ev) =>
                              setEntry(withMember(e, 'text', ev.target.value || undefined))
                            }
                          />
                        </label>
                      )}
                      <div data-species-field="when">
                        <DungeonConditionEditor
                          label={`Entry ${n} is in the draw`}
                          definition={definition}
                          value={e.when}
                          onChange={(when) => setEntry(withMember(e, 'when', when))}
                        />
                      </div>
                      {!disabled && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove species pool entry ${n}`}
                          onClick={() => update(pool.entries.filter((x) => x.id !== e.id))}
                        >
                          Remove entry
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
              {!disabled && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pool.entries.length >= SPECIES_POOL_LIMITS.entries}
                    onClick={() => setPicking('new')}
                  >
                    + Add species
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pool.entries.length >= SPECIES_POOL_LIMITS.entries}
                    onClick={() => update([...pool.entries, newSpeciesEntry(pool, null)])}
                  >
                    + Add Nothing
                  </Button>
                </div>
              )}
            </section>
            {picking && !disabled && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">
                  {picking === 'new' ? 'Add species' : 'Replace species'}
                </h3>
                {catalogue.isPending && <p role="status">Loading species…</p>}
                {catalogue.isError && (
                  <p role="alert">
                    The species catalogue could not be loaded.{' '}
                    <Button variant="link" onClick={() => void catalogue.refetch()}>
                      Try again
                    </Button>
                  </p>
                )}
                {catalogue.data && (
                  <DungeonSpeciesPicker
                    species={species}
                    disabled={disabled}
                    listed={
                      new Set(
                        pool.entries.flatMap((e) =>
                          'species' in e && e.id !== picking ? [e.species] : [],
                        ),
                      )
                    }
                    onSelect={(slug) => {
                      if (!bySlug.get(slug)?.permitted) return;
                      if (picking === 'new') {
                        if (pool.entries.length < SPECIES_POOL_LIMITS.entries)
                          update([...pool.entries, newSpeciesEntry(pool, slug)]);
                      } else {
                        const entry = pool.entries.find((e) => e.id === picking);
                        if (entry && 'species' in entry) setEntry({ ...entry, species: slug });
                      }
                      setPicking(null);
                    }}
                  />
                )}
                <Button variant="ghost" size="sm" onClick={() => setPicking(null)}>
                  Cancel species selection
                </Button>
              </section>
            )}
          </fieldset>
          <section aria-label="Probability insight" className="space-y-3">
            <h3 className="text-sm font-semibold">Probability insight</h3>
            <p className={hint}>
              Selection probabilities, not capture success chances. Conditions and once-per-run
              remove entries. Central policy and acquisition limits can produce unavailable outcomes
              without changing selection odds.
            </p>
            {insight.failed && (
              <p role="alert" className="text-sm text-danger">
                Probability preview could not be loaded. Change a setting to retry.
              </p>
            )}
            {insight.unreadable && (
              <p role="status" className={hint}>
                Finish blank or invalid fields in this draft to see its probabilities.
              </p>
            )}
            {!analysis && !insight.failed && !insight.unreadable && (
              <p role="status" className={hint}>
                Waiting for server probabilities…
              </p>
            )}
            {analysis && (
              <Odds odds={analysis.base} names={names} label="With every entry in the draw" />
            )}
            <fieldset className="space-y-2 rounded border border-border p-3">
              <legend className="px-1 text-sm font-medium">Simulate a run</legend>
              <p className={hint}>
                These assumptions only affect this preview. They are never saved or read from a real
                player.
              </p>
              {definition.flags
                .filter((f) => f.scope === 'run')
                .map((f) => (
                  <label key={f.key} className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`Assume flag ${f.description || f.key}`}
                      checked={scenario.flags.includes(f.key)}
                      onChange={(e) => toggle('flags', f.key, e.target.checked)}
                    />
                    {f.description || f.key} is set
                  </label>
                ))}
              {definition.rooms.map((r) => (
                <label key={r.id} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Assume completed room ${r.name || r.id}`}
                    checked={scenario.completedRooms.includes(r.id)}
                    onChange={(e) => toggle('completedRooms', r.id, e.target.checked)}
                  />
                  {r.name || r.id} completed
                </label>
              ))}
              {slugs.map((slug) => (
                <div key={slug} className="space-y-1">
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`Assume encountered ${names.get(slug) ?? slug}`}
                      checked={scenario.seenSpecies.includes(slug)}
                      onChange={(e) => toggle('seenSpecies', slug, e.target.checked)}
                    />
                    {names.get(slug) ?? slug} already encountered
                  </label>
                  <label className="block text-sm">
                    Copies acquired in this dungeon across runs
                    <Input
                      type="number"
                      min={0}
                      max={Number.MAX_SAFE_INTEGER}
                      step={1}
                      aria-label={`Assumed acquisitions for ${names.get(slug) ?? slug}`}
                      value={scenario.acquisitions[slug] ?? 0}
                      onChange={(e) => {
                        const count = Number(e.target.value);
                        if (Number.isSafeInteger(count) && count >= 0)
                          setScenario((s) => ({
                            ...s,
                            acquisitions: { ...s.acquisitions, [slug]: count },
                          }));
                      }}
                    />
                  </label>
                </div>
              ))}
            </fieldset>
            {analysis && (
              <Odds odds={analysis.scenario} names={names} label="In this simulated run" />
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
