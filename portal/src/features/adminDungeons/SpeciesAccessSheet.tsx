import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getDungeonSpecies, type DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SpeciesAvailability, SpeciesThumb } from './DungeonSpeciesPicker';
import {
  DEFAULT_SPECIES_LIMIT,
  directRescueSlugs,
  dungeonSpeciesSlugs,
  removeSpeciesPolicy,
  setSpeciesPolicy,
  speciesPolicyOf,
  speciesPoolUsage,
} from './dungeonSpeciesModel';
import type { EventIssueTarget, FriendlyIssue } from './dungeonText';

const hint = 'text-xs text-ink-muted';

/** Where a species is used in this draft: pools that list her and encounters that name her. */
function usageOf(d: DungeonDefinition, slug: string): string[] {
  const pools = (d.speciesPools ?? [])
    .filter((p) => p.entries.some((e) => 'species' in e && e.species === slug))
    .map((p) => {
      const uses = speciesPoolUsage(d, p.id).length;
      return `Pool “${p.name || 'Unnamed'}” (${uses ? `${uses} encounter${uses > 1 ? 's' : ''}` : 'not used yet'})`;
    });
  const direct = d.rooms.flatMap((r) =>
    r.actions.flatMap((a, n) =>
      (a.type === 'wild_encounter' || a.type === 'rescue') && a.source?.kind === 'species' && a.source.species === slug
        ? [`${r.name || 'Unnamed room'} — ${a.label || (a.type === 'rescue' ? 'Rescue' : 'Wild Encounter')} (activity ${n + 1})`]
        : [],
    ),
  );
  return [...pools, ...direct];
}

/**
 * The dungeon's one place for Species access: whether she may be acquired
 * here, the most copies a player can take from this dungeon across runs, and
 * whether a Direct Rescue may grant her. Pools and encounters decide where she
 * appears; nothing here applies until the dungeon is published.
 */
export function SpeciesAccessSheet({
  definition,
  disabled,
  issues,
  focus,
  onChange,
  onClose,
}: {
  definition: DungeonDefinition;
  disabled: boolean;
  issues: FriendlyIssue[];
  focus?: EventIssueTarget & { nonce: number };
  onChange: (d: DungeonDefinition) => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const catalogue = useQuery({
    queryKey: ['dungeon-species', definition.key],
    queryFn: ({ signal }) => getDungeonSpecies(definition.key, signal),
  });
  useEffect(() => {
    if (!focus?.id) return;
    const timer = window.setTimeout(() => {
      const row = body.current?.querySelector<HTMLElement>(`[data-species-access="${CSS.escape(focus.id)}"]`);
      row?.scrollIntoView?.({ block: 'nearest' });
      row?.querySelector<HTMLElement>('input, button')?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focus]);
  const bySlug = new Map((catalogue.data?.species ?? []).map((s) => [s.slug, s]));
  const slugs = [
    ...new Set([...dungeonSpeciesSlugs(definition), ...(definition.speciesPolicies ?? []).map((p) => p.species)]),
  ];
  const direct = directRescueSlugs(definition);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        closeLabel="Close Species access"
        className="w-full max-w-full sm:w-[42rem] sm:max-w-[95vw]"
        data-testid="species-access-editor"
      >
        <div ref={body} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pt-14 sm:p-6 sm:pt-14">
          <SheetTitle className="text-lg font-semibold">Species access</SheetTitle>
          <SheetDescription>
            This dungeon’s terms for each WaifuMon. Pools and encounters decide where she appears;
            these terms decide whether she can be acquired here. They take effect when the dungeon
            is published.
          </SheetDescription>
          <ul className={`${hint} list-disc space-y-1 pl-5`}>
            <li>
              <strong>Encounter weight</strong> and <strong>At most once per run</strong> are set on
              each pool entry. They control how often she is presented, not how many copies a player
              can keep.
            </li>
            <li>
              <strong>Maximum acquisitions per player from this dungeon</strong> counts every capture
              and rescue of her here, across all runs, pools and encounters. Releasing or converting
              a copy does not give one back.
            </li>
            <li>
              <strong>Direct Rescue permission</strong> lets a Direct Rescue grant her with no capture
              roll. It needs a finite limit.
            </li>
          </ul>
          {!!issues.length && (
            <ul aria-label="To do in Species access" className="space-y-1 text-sm">
              {issues.map((i, n) => (
                <li key={n} className={i.level === 'review' ? hint : 'text-danger'}>
                  {i.title} {i.help}
                </li>
              ))}
            </ul>
          )}
          {catalogue.isPending && <p role="status">Loading species…</p>}
          {catalogue.isError && (
            <p role="alert" className="text-sm text-danger">
              The species catalogue could not be loaded.{' '}
              <Button variant="link" onClick={() => void catalogue.refetch()}>
                Retry species catalogue
              </Button>
            </p>
          )}
          {!slugs.length && (
            <p className="text-sm text-ink-muted">
              No species in this dungeon yet. Add WaifuMon to a pool or an encounter first.
            </p>
          )}
          <fieldset disabled={disabled} className="space-y-3">
            <ul aria-label="Species in this dungeon" className="space-y-3">
              {slugs.map((slug) => {
                const sp = bySlug.get(slug);
                const name = sp?.name ?? slug;
                const entry = speciesPolicyOf(definition, slug);
                const limited = typeof entry?.perPlayerLimit === 'number';
                const invalidLimit =
                  limited && (!Number.isSafeInteger(entry!.perPlayerLimit) || (entry!.perPlayerLimit as number) < 1);
                const used = usageOf(definition, slug);
                return (
                  <li
                    key={slug}
                    data-species-access={slug}
                    data-testid="species-access-row"
                    className="space-y-2 rounded border border-border p-3"
                  >
                    <div className="flex gap-2">
                      {sp && <SpeciesThumb species={sp} />}
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">{name}</p>
                        {sp ? (
                          <SpeciesAvailability species={sp} dungeonKey={definition.key} entry={entry} />
                        ) : (
                          !catalogue.isPending && (
                            <p role="alert" className="text-xs text-danger">
                              Not in the species catalogue.
                            </p>
                          )
                        )}
                        <p className={`${hint} break-words`}>Used in: {used.join('; ') || 'nothing yet'}.</p>
                      </div>
                    </div>
                    {!entry ? (
                      sp && !sp.dungeonPolicyAllowed ? (
                        <p className={hint}>
                          {sp.regionExclusive
                            ? 'Region-exclusive: only species content can admit her to a dungeon.'
                            : 'Disabled species cannot be given access.'}
                        </p>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Add Species access for ${name}`}
                          onClick={() =>
                            onChange(setSpeciesPolicy(definition, { species: slug, perPlayerLimit: DEFAULT_SPECIES_LIMIT }))
                          }
                        >
                          Add Species access
                        </Button>
                      )
                    ) : (
                      <>
                        <fieldset className="space-y-1">
                          <legend className="text-sm">Maximum acquisitions per player from this dungeon</legend>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="radio"
                              name={`limit-${slug}`}
                              aria-label={`${name}: limited acquisitions`}
                              checked={limited}
                              onChange={() =>
                                onChange(setSpeciesPolicy(definition, { ...entry, perPlayerLimit: DEFAULT_SPECIES_LIMIT }))
                              }
                            />
                            Limited to
                            <Input
                              type="number"
                              min={1}
                              step={1}
                              className="w-24"
                              disabled={!limited}
                              aria-label={`${name}: maximum acquisitions per player`}
                              aria-invalid={invalidLimit}
                              value={limited ? (entry.perPlayerLimit as number) || '' : ''}
                              onChange={(e) =>
                                onChange(
                                  setSpeciesPolicy(definition, {
                                    ...entry,
                                    perPlayerLimit: e.target.value === '' ? 0 : Number(e.target.value),
                                  }),
                                )
                              }
                            />
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="radio"
                              name={`limit-${slug}`}
                              aria-label={`${name}: unlimited captures`}
                              checked={!limited}
                              onChange={() =>
                                // Direct Rescue cannot stay on without a finite limit.
                                onChange(setSpeciesPolicy(definition, { species: slug, perPlayerLimit: 'unlimited' }))
                              }
                            />
                            Unlimited captures
                          </label>
                          {invalidLimit && (
                            <p role="alert" className="text-xs text-danger">
                              The limit must be a whole number of 1 or more.
                            </p>
                          )}
                        </fieldset>
                        <label className="flex gap-2 text-sm">
                          <input
                            type="checkbox"
                            aria-label={`${name}: allow Direct Rescue`}
                            disabled={!limited}
                            checked={!!entry.directRescue}
                            onChange={(e) => onChange(setSpeciesPolicy(definition, { ...entry, directRescue: e.target.checked }))}
                          />
                          Allow Direct Rescue {limited ? '' : '(needs a finite limit)'}
                        </label>
                        {direct.has(slug) && !entry.directRescue && (
                          <p className="text-xs text-danger">
                            A Direct Rescue in this dungeon can grant her. Allow Direct Rescue here or
                            change that rescue to capture mode.
                          </p>
                        )}
                        {!disabled && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove Species access for ${name}`}
                            onClick={() => onChange(removeSpeciesPolicy(definition, slug))}
                          >
                            Remove Species access
                          </Button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </div>
      </SheetContent>
    </Sheet>
  );
}
