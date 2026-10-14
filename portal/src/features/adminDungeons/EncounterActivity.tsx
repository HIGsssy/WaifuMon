import { useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getDungeonSpecies,
  type DungeonAction,
  type DungeonDefinition,
  type DungeonRoom,
} from '@/api/adminDungeons';
import { DEFAULT_SPRITE_PLACEMENT } from '@/api/adminArtworkAssets';
import { PlacementControls } from '@/features/adminArtwork/ScenePreview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DungeonSpeciesPicker, SpeciesAvailability, SpeciesThumb } from './DungeonSpeciesPicker';
import { EMPTY_SPECIES_SCENARIO, useSpeciesInsight } from './useSpeciesInsight';
import { Odds } from './SpeciesPoolSheet';
import { EventEditorContext } from './eventEditorContext';
import { ACTION_OUTCOMES } from './dungeonActionModel';
import { EncounterPreview } from './EncounterPreview';
import { getDungeonCaptureItems } from '@/api/adminDungeons';

const select = 'w-full rounded border border-border bg-surface p-2 text-sm';
const hint = 'text-xs text-ink-muted';
export function EncounterActivity({
  action,
  room,
  definition,
  disabled,
  onChange,
}: {
  action: DungeonAction;
  room: DungeonRoom;
  definition: DungeonDefinition;
  disabled: boolean;
  onChange: (a: DungeonAction) => void;
}) {
  const host = useContext(EventEditorContext);
  const [picking, setPicking] = useState(false);
  const catalogue = useQuery({
    queryKey: ['dungeon-species', definition.key],
    queryFn: ({ signal }) => getDungeonSpecies(definition.key, signal),
  });
  const charms = useQuery({
    queryKey: ['dungeon-capture-items'],
    queryFn: ({ signal }) => getDungeonCaptureItems(signal),
  });
  const insight = useSpeciesInsight(definition, EMPTY_SPECIES_SCENARIO);
  const species = catalogue.data?.species ?? [];
  const named = action.source?.kind === 'species';
  const slug = named && action.source?.kind === 'species' ? action.source.species : '';
  const chosen = species.find((s) => s.slug === slug);
  const poolId = action.source?.kind === 'pool' ? action.source.poolId : '';
  const pool = definition.speciesPools?.find((p) => p.id === poolId);
  const odds = insight.pools?.find((p) => p.poolId === poolId)?.scenario;
  const direct = action.type === 'rescue' && action.mode === 'direct';
  const capture = action.capture ?? { maxAttempts: 3, allowGuaranteedItems: true };
  const patch = (fields: Partial<DungeonAction>) => onChange({ ...action, ...fields });
  const outcomes = (ACTION_OUTCOMES[action.type as 'rescue' | 'wild_encounter'] ?? []).filter(
    (o) => !(direct && o === 'escaped'),
  );
  const result = (
    outcome: string,
    fields: { text?: string; flags?: Array<{ flag: string; value: boolean }> },
  ) => {
    const results = { ...action.results, [outcome]: { ...action.results?.[outcome], ...fields } };
    if (!results[outcome]?.text) delete results[outcome]!.text;
    if (!results[outcome]?.flags?.length) delete results[outcome]!.flags;
    if (!Object.keys(results[outcome]!).length) delete results[outcome];
    const next = { ...action };
    if (Object.keys(results).length) next.results = results;
    else delete next.results;
    onChange(next);
  };
  return (
    <div className="min-w-0 space-y-3" data-testid="encounter-editor">
      <fieldset disabled={disabled} className="min-w-0 space-y-3">
        {action.type === 'rescue' && (
          <label className="block text-sm">
            Rescue mode
            <select
              aria-label="Rescue mode"
              className={select}
              value={action.mode ?? 'capture'}
              onChange={(e) => {
                const next = { ...action, mode: e.target.value as 'capture' | 'direct' };
                if (next.mode === 'direct') delete next.capture;
                else next.capture = capture;
                // Other authored results/routes survive mode switches so invalid settings remain repairable.
                onChange(next);
              }}
            >
              <option value="capture">Capture rescue (uses a charm)</option>
              <option value="direct">Direct rescue (direct grant)</option>
            </select>
          </label>
        )}
        {direct && (
          <p role="note" className={hint}>
            Direct grant: no charm or capture roll. Every species must authorize direct rescue for
            this dungeon and have a finite per-player limit across runs. Invalid drafts can be
            saved; publication is blocked by backend policy.
          </p>
        )}
        <label className="block text-sm">
          Encounter source
          <select
            aria-label="Encounter source"
            className={select}
            value={named ? 'species' : 'pool'}
            onChange={(e) => {
              patch({
                source:
                  e.target.value === 'species'
                    ? { kind: 'species', species: '' }
                    : { kind: 'pool', poolId: '' },
              });
              setPicking(false);
            }}
          >
            <option value="species">Specific WaifuMon</option>
            <option value="pool">WaifuMon pool</option>
          </select>
        </label>
        {named ? (
          <div className="space-y-2">
            {chosen ? (
              <div className="flex gap-2">
                <SpeciesThumb species={chosen} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{chosen.name}</p>
                  <SpeciesAvailability species={chosen} />
                </div>
              </div>
            ) : (
              <p role="alert" className={hint}>
                {slug ? `Missing species: ${slug}. Choose a replacement.` : 'Choose a WaifuMon.'}
              </p>
            )}
            <Button variant="outline" size="sm" onClick={() => setPicking(!picking)}>
              {picking ? 'Close species picker' : 'Choose WaifuMon'}
            </Button>
            {catalogue.isError && (
              <p role="alert">
                Could not load species.{' '}
                <button onClick={() => void catalogue.refetch()}>Retry</button>
              </p>
            )}
            {picking && (
              <DungeonSpeciesPicker
                species={species}
                listed={new Set()}
                disabled={false}
                purpose="encounter"
                onSelect={(species) => {
                  patch({ source: { kind: 'species', species } });
                  setPicking(false);
                }}
              />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <select
              aria-label="WaifuMon pool"
              className={select}
              value={poolId}
              onChange={(e) => patch({ source: { kind: 'pool', poolId: e.target.value } })}
            >
              <option value="">Choose a pool…</option>
              {poolId && !pool && <option value={poolId}>Missing pool ({poolId})</option>}
              {definition.speciesPools?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {pool ? (
              <>
                <p className={hint}>
                  {pool.name} · {pool.entries.length} entries
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => host?.open({ kind: 'speciesPool', id: pool.id })}
                >
                  Edit selected pool
                </Button>
                {odds && (
                  <Odds
                    odds={odds}
                    label="Pool selection probabilities"
                    names={new Map(species.map((s) => [s.slug, s.name]))}
                  />
                )}
                {direct &&
                  pool.entries
                    .flatMap((e) => ('species' in e ? [e.species] : []))
                    .map((slug) => (
                      <p className={hint} key={slug}>
                        {species.find((s) => s.slug === slug)?.name ?? slug}:{' '}
                        {species.find((s) => s.slug === slug)?.directRescue.available
                          ? 'Direct rescue authorized with finite limit'
                          : 'Direct rescue unavailable — authorization and finite limit required'}
                      </p>
                    ))}
              </>
            ) : (
              <p role="alert" className={hint}>
                {poolId
                  ? 'This pool is missing. Its reference is kept; select an existing pool to repair it.'
                  : 'Create a pool in Dungeon settings or choose one here.'}
              </p>
            )}
          </div>
        )}
        <label className="block text-sm">
          Introductory narrative
          <textarea
            aria-label="Encounter introduction"
            className={select}
            rows={3}
            maxLength={600}
            value={action.intro ?? ''}
            onChange={(e) => patch({ intro: e.target.value })}
          />
        </label>
        {!direct && (
          <section className="space-y-2" aria-label="Capture rules">
            <label className="block text-sm">
              Capture attempt limit
              <Input
                type="number"
                min={1}
                max={3}
                step={1}
                aria-label="Capture attempt limit"
                value={capture.maxAttempts}
                onChange={(e) =>
                  patch({ capture: { ...capture, maxAttempts: Number(e.target.value) } })
                }
              />
            </label>
            <label className="block text-sm">
              Permitted capture charms
              <select
                aria-label="Permitted capture charms"
                className={select}
                value={capture.allowedItems ? 'subset' : 'all'}
                onChange={(e) => {
                  const next = { ...capture };
                  if (e.target.value === 'all') delete next.allowedItems;
                  else next.allowedItems = [];
                  patch({ capture: next });
                }}
              >
                <option value="all">All globally eligible charms</option>
                <option value="subset">Authored subset</option>
              </select>
            </label>
            {capture.allowedItems && (
              <div className="space-y-1">
                {[
                  ...new Set([
                    ...(charms.data?.items.map((i) => i.slug) ?? []),
                    ...capture.allowedItems,
                  ]),
                ].map((slug) => {
                  const item = charms.data?.items.find((i) => i.slug === slug);
                  return (
                    <label key={slug} className="flex gap-2 text-xs">
                      <input
                        type="checkbox"
                        aria-label={`Permit charm ${item?.name ?? slug}`}
                        checked={capture.allowedItems!.includes(slug)}
                        onChange={(e) =>
                          patch({
                            capture: {
                              ...capture,
                              allowedItems: e.target.checked
                                ? [...capture.allowedItems!, slug]
                                : capture.allowedItems!.filter((s) => s !== slug),
                            },
                          })
                        }
                      />
                      {item?.name ?? `${slug} (missing or invalid)`}
                      {item && !item.enabled ? ' (disabled)' : ''}
                    </label>
                  );
                })}
                {!capture.allowedItems.length && (
                  <p role="alert" className={hint}>
                    Select at least one charm before saving.
                  </p>
                )}
              </div>
            )}
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="Allow guaranteed capture items"
                checked={capture.allowGuaranteedItems}
                onChange={(e) =>
                  patch({ capture: { ...capture, allowGuaranteedItems: e.target.checked } })
                }
              />
              Allow guaranteed capture items
            </label>
            <p className={hint}>
              One charm is consumed on every resolved capture attempt, including failures. Global
              rarity eligibility and the player’s actual inventory still apply. Capture
              probabilities use the normal backend rules.
            </p>
          </section>
        )}
        <section aria-label="Encounter results" className="space-y-2">
          {outcomes.map((outcome) => (
            <details key={outcome} className="rounded border border-border p-2">
              <summary className="cursor-pointer text-sm">
                {outcome[0]!.toUpperCase() + outcome.slice(1)} result
              </summary>
              <label className="block text-xs">
                Outcome text
                <textarea
                  aria-label={`${outcome} outcome text`}
                  className={select}
                  maxLength={400}
                  value={action.results?.[outcome]?.text ?? ''}
                  onChange={(e) => result(outcome, { text: e.target.value })}
                />
              </label>
              {(action.results?.[outcome]?.flags ?? []).map((write, i) => (
                <div key={i} className="flex flex-wrap gap-2">
                  <select
                    aria-label={`${outcome} result flag ${i + 1}`}
                    className={select}
                    value={write.flag}
                    onChange={(e) =>
                      result(outcome, {
                        flags: action.results![outcome]!.flags!.map((f, n) =>
                          n === i ? { ...f, flag: e.target.value } : f,
                        ),
                      })
                    }
                  >
                    <option value="">Choose a run flag…</option>
                    {write.flag &&
                      !definition.flags.some((f) => f.scope === 'run' && f.key === write.flag) && (
                        <option value={write.flag}>Missing flag ({write.flag})</option>
                      )}
                    {definition.flags
                      .filter((f) => f.scope === 'run')
                      .map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.description || f.key}
                        </option>
                      ))}
                  </select>
                  <label className="flex gap-2 text-xs">
                    <input
                      aria-label={`${outcome} flag ${i + 1} value`}
                      type="checkbox"
                      checked={write.value}
                      onChange={(e) =>
                        result(outcome, {
                          flags: action.results![outcome]!.flags!.map((f, n) =>
                            n === i ? { ...f, value: e.target.checked } : f,
                          ),
                        })
                      }
                    />
                    Remember (unchecked: forget)
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      result(outcome, {
                        flags: action.results![outcome]!.flags!.filter((_, n) => n !== i),
                      })
                    }
                  >
                    Remove flag
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={(action.results?.[outcome]?.flags?.length ?? 0) >= 4}
                onClick={() =>
                  result(outcome, {
                    flags: [...(action.results?.[outcome]?.flags ?? []), { flag: '', value: true }],
                  })
                }
              >
                Add {outcome} result flag
              </Button>
              <p className={hint}>
                Declare run flags in Dungeon settings. Later routes and activities can use these
                flags in their conditions.
              </p>
            </details>
          ))}
        </section>
        <section className="space-y-2" aria-label="Encounter artwork">
          <p className="text-sm font-medium">WaifuMon scene actor placement</p>
          <PlacementControls
            value={action.placement ?? DEFAULT_SPRITE_PLACEMENT}
            disabled={false}
            onChange={(placement) => patch({ placement })}
          />
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Mirror encountered WaifuMon"
              checked={action.mirror ?? false}
              onChange={(e) => patch({ mirror: e.target.checked })}
            />
            Mirror horizontally
          </label>
        </section>
        {Object.keys(action.results ?? {})
          .filter((o) => !outcomes.includes(o))
          .map((o) => (
            <p role="alert" className={hint} key={o}>
              The {o} result is stored but does not apply in this mode.{' '}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const next = { ...action };
                  const results = { ...next.results };
                  delete results[o];
                  if (Object.keys(results).length) next.results = results;
                  else delete next.results;
                  onChange(next);
                }}
              >
                Remove {o} result
              </Button>
            </p>
          ))}
      </fieldset>
      <EncounterPreview action={action} room={room} definition={definition} species={species} />
      <Button variant="outline" size="sm" onClick={() => host?.play()}>
        Test encounter in dungeon sandbox
      </Button>
    </div>
  );
}
