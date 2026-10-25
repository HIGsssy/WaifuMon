/** Structural checks, plus live catalogue and policy checks when a source is supplied (`dungeonSpeciesPolicy.ts`). */
import {
  ACTION_OUTCOMES,
  isEncounterAction,
  encounterSpecies,
  type DungeonDefinition,
  type DungeonSpeciesAccess,
  type DungeonSpeciesPolicyEntry,
  type DungeonCondition,
} from '../content/dungeonDefinition';
import { destinationFor } from '../engine/routing';
import type { DungeonEncounterUnavailableReason } from '../engine/types';
import type { DungeonIssue, DungeonIssueCode } from './dungeonValidation';
import type { EventValidationTools } from './dungeonEventValidation';

export interface DungeonSpeciesPolicy {
  enabled: boolean;
  restricted: boolean;
  /** Region exclusivity is a promise only species content can waive; a dungeon's own entry cannot. */
  regionExclusive?: boolean;
  access?: readonly DungeonSpeciesAccess[];
  /** The judging dungeon's own entry for this species: its draft at validation, its published revision live. */
  owned?: DungeonSpeciesPolicyEntry;
}
/** The terms one dungeon offers a species on, from species content, the dungeon's own entry, or both. */
export interface DungeonSpeciesTerms {
  perPlayerLimit: number | 'unlimited';
  directRescue: boolean;
  source: 'content' | 'dungeon' | 'both';
}
/** `policy` with the dungeon's own entry for `slug`, when it has one. */
export function withDungeonSpeciesPolicy(
  policy: DungeonSpeciesPolicy | undefined,
  entries: readonly DungeonSpeciesPolicyEntry[] | undefined,
  slug: string,
): DungeonSpeciesPolicy | undefined {
  const owned = entries?.find((e) => e.species === slug);
  return policy && owned ? { ...policy, owned } : policy;
}
/**
 * Where species content and the dungeon both set terms, the stricter of each
 * applies: the lower finite limit, and a direct rescue only if both allow it.
 * Neither source can loosen what the other restricts.
 */
export function dungeonSpeciesTerms(
  policy: DungeonSpeciesPolicy | undefined,
  dungeon: string,
): DungeonSpeciesTerms | null {
  const content = policy?.access?.find((a) => a.dungeon === dungeon);
  const owned = policy?.owned;
  if (!content && !owned) return null;
  const contentLimit = content?.perPlayerLimit ?? 'unlimited';
  if (!owned) return { perPlayerLimit: contentLimit, directRescue: content!.directRescue === true, source: 'content' };
  if (!content) return { perPlayerLimit: owned.perPlayerLimit, directRescue: owned.directRescue === true, source: 'dungeon' };
  const limits = [contentLimit, owned.perPlayerLimit].filter((l): l is number => typeof l === 'number');
  return {
    perPlayerLimit: limits.length ? Math.min(...limits) : 'unlimited',
    directRescue: content.directRescue === true && owned.directRescue === true,
    source: 'both',
  };
}
/**
 * `acquiredCount` is the player's cross-run count from the acquisition ledger, read in the step's transaction.
 *
 * A restricted species is permitted by a `dungeonAccess` entry naming this
 * dungeon, or — unless she is region-exclusive — by the dungeon's own entry.
 */
export function dungeonSpeciesUnavailableReason(
  policy: DungeonSpeciesPolicy | undefined,
  dungeon: string,
  direct: boolean,
  acquiredCount = 0,
): DungeonEncounterUnavailableReason | null {
  if (!policy) return 'missing';
  if (!policy.enabled) return 'disabled';
  const listed = policy.access?.some((a) => a.dungeon === dungeon) ?? false;
  if (policy.restricted && !listed && !(policy.owned && !policy.regionExclusive)) return 'not_permitted';
  const terms = dungeonSpeciesTerms(policy, dungeon);
  if (direct && !terms?.directRescue) return 'direct_not_permitted';
  if (direct && typeof terms?.perPlayerLimit !== 'number')
    return 'direct_limit_missing';
  if (
    typeof terms?.perPlayerLimit === 'number' &&
    acquiredCount >= terms.perPlayerLimit
  )
    return 'player_limit';
  return null;
}
/** No database imports here. Adapter must use current species and charm definitions. */
export interface DungeonEncounterValidationSource {
  speciesArtwork?(slug: string): boolean;
  species(slug: string): DungeonSpeciesPolicy | undefined;
  item(slug: string): { enabled: boolean; capture: boolean } | undefined;
  hasUsableCaptureItem(
    slug: string,
    rules: NonNullable<
      Extract<
        DungeonDefinition['rooms'][number]['actions'][number],
        { type: 'wild_encounter' }
      >['capture']
    >,
  ): boolean;
}
function contradictory(condition: DungeonCondition | undefined): boolean {
  if (condition?.type !== 'all') return false;
  const seen = new Map<string, boolean>();
  for (const c of condition.conditions) {
    const f =
      c.type === 'flag'
        ? c
        : c.type === 'not' && c.condition.type === 'flag'
          ? { ...c.condition, equals: !c.condition.equals }
          : null;
    if (!f) continue;
    const key = `${f.scope}:${f.flag}`;
    if (seen.has(key) && seen.get(key) !== f.equals) return true;
    seen.set(key, f.equals);
  }
  return false;
}
export function encounterFlagsSet(definition: DungeonDefinition): Set<string> {
  return new Set(
    definition.rooms.flatMap((r) =>
      r.actions.flatMap((a) =>
        isEncounterAction(a)
          ? Object.values(a.results ?? {}).flatMap(
              (r) => r?.flags?.map((f) => f.flag) ?? [],
            )
          : [],
      ),
    ),
  );
}
/** Map schema failures to actionable encounter codes without accepting malformed content. */
export function encounterShapeIssue(
  path: string,
  message: string,
): DungeonIssue | null {
  const code: DungeonIssueCode | null = /^speciesPools.*\.weight$/.test(path)
    ? 'species_pool_weight_invalid'
    : /\.capture(?:\.|$)/.test(path)
      ? 'capture_settings_invalid'
      : /^speciesPools(?:\[\d+\])?\.entries$/.test(path)
        ? 'species_pool_empty'
        : null;
  return code ? { code, path, message, severity: 'error' } : null;
}
export function validateDungeonEncounters(
  definition: DungeonDefinition,
  tools: EventValidationTools,
  live?: DungeonEncounterValidationSource,
): void {
  const { add } = tools;
  const pools = definition.speciesPools ?? [];
  const used = new Set<string>();
  let encounters = 0,
    directRescues = 0;
  const duplicate = (seen: Set<string>, key: string, path: string) => {
    if (seen.has(key))
      add(
        'species_pool_duplicate_entry',
        'error',
        path,
        `Duplicate species pool identity "${key}".`,
      );
    seen.add(key);
  };
  const poolIds = new Set<string>();
  pools.forEach((pool, p) => {
    const path = `speciesPools[${p}]`;
    duplicate(poolIds, pool.id, `${path}.id`);
    const ids = new Set<string>(),
      species = new Set<string>();
    pool.entries.forEach((e, i) => {
      const at = `${path}.entries[${i}]`;
      duplicate(ids, e.id, `${at}.id`);
      if ('species' in e) duplicate(species, e.species, `${at}.species`);
      tools.checkCondition(e.when, `${at}.when`);
    });
    const entries = pool.entries.filter((e) => 'species' in e);
    if (!entries.length)
      add(
        'species_pool_empty',
        'error',
        `${path}.entries`,
        'A species pool needs at least one species entry.',
      );
    else if (entries.every((e) => contradictory(e.when)))
      add(
        'species_pool_always_nothing',
        'warning',
        path,
        'Every species condition is contradictory.',
      );
  });
  definition.rooms.forEach((room, r) =>
    room.actions.forEach((action, a) => {
      if (!isEncounterAction(action)) return;
      encounters++;
      const path = `rooms[${r}].actions[${a}]`;
      const direct = action.type === 'rescue' && action.mode === 'direct';
      for (const slug of encounterSpecies(definition, action)) {
        if (live?.speciesArtwork && !live.speciesArtwork(slug)) add('encounter_artwork_missing', 'warning', `${path}.source`, `WaifuMon "${slug}" has no usable dungeon sprite or standard artwork fallback. Players will see the room scene or text.`);
      }
      if (direct) directRescues++;
      if (action.optional)
        add(
          'encounter_optional',
          'error',
          `${path}.optional`,
          'Encounters already offer Leave and cannot be optional.',
        );
      if (contradictory(action.when))
        add(
          'encounter_condition_impossible',
          'warning',
          `${path}.when`,
          'Encounter condition requires a flag to be both true and false.',
        );
      if (action.source.kind === 'pool') {
        used.add(action.source.poolId);
        if (
          !pools.some(
            (p) =>
              p.id ===
              (action.source.kind === 'pool' ? action.source.poolId : ''),
          )
        )
          add(
            'species_pool_missing',
            'error',
            `${path}.source.poolId`,
            'Species pool does not exist.',
          );
      }
      if (direct ? action.capture !== undefined : action.capture === undefined)
        add(
          'capture_settings_invalid',
          'error',
          `${path}.capture`,
          direct
            ? 'Direct rescues cannot carry capture rules.'
            : 'Capture mode requires capture rules.',
        );
      const known = ACTION_OUTCOMES[action.type].filter(
        (o) => !(direct && o === 'escaped'),
      );
      for (const [outcome, result] of Object.entries(action.results ?? {})) {
        if (!known.includes(outcome))
          add(
            'unknown_outcome',
            'error',
            `${path}.results.${outcome}`,
            `This encounter cannot resolve ${outcome}.`,
          );
        for (const [i, f] of (result?.flags ?? []).entries()) {
          if (tools.flagByKey.get(f.flag)?.scope !== 'run')
            add(
              'encounter_flag_undeclared',
              'error',
              `${path}.results.${outcome}.flags[${i}].flag`,
              `Flag "${f.flag}" must be declared with run scope.`,
            );
        }
      }
      if (direct && action.outcomes.escaped)
        add(
          'unknown_outcome',
          'error',
          `${path}.outcomes.escaped`,
          'Direct rescues cannot escape.',
        );
      for (const outcome of known)
        if (destinationFor(action, outcome).type === 'retreat')
          add(
            'encounter_route_retreat',
            'error',
            `${path}.${action.outcomes[outcome] ? `outcomes.${outcome}` : 'next'}`,
            'Resolved encounters cannot retreat.',
          );
      if (
        direct &&
        !action.when &&
        !definition.connections.some((c) => c.to === room.id && c.requires) &&
        !room.actions.slice(0, a).some((x) => x.type === 'gate')
      )
        add(
          'rescue_ungated',
          'warning',
          path,
          'This direct rescue may be free on arrival.',
        );
      const allowed = action.capture?.allowedItems;
      if (allowed && new Set(allowed).size !== allowed.length)
        add(
          'capture_settings_invalid',
          'error',
          `${path}.capture.allowedItems`,
          'Capture items must be unique.',
        );
      if (!live) return;
      for (const slug of encounterSpecies(definition, action)) {
        const reason = dungeonSpeciesUnavailableReason(
          withDungeonSpeciesPolicy(live.species(slug), definition.speciesPolicies, slug),
          definition.key,
          direct,
        );
        const codes = {
          missing: 'species_missing',
          disabled: 'species_disabled',
          not_permitted: 'species_not_permitted',
          direct_not_permitted: 'rescue_direct_not_permitted',
          direct_limit_missing: 'rescue_direct_limit_missing',
        } as const;
        const repair = {
          missing: '',
          disabled: '',
          not_permitted: ' Add her to this dungeon\'s Species access with a per-player limit.',
          direct_not_permitted: ' Allow Direct Rescue for her in this dungeon\'s Species access.',
          direct_limit_missing: ' Give her a finite per-player limit in this dungeon\'s Species access.',
        } as const;
        if (reason && reason !== 'player_limit')
          add(
            codes[reason],
            'error',
            `${path}.source`,
            `Species "${slug}" is unavailable: ${reason}.${repair[reason]}`,
          );
        if (
          !direct &&
          action.capture &&
          !live.hasUsableCaptureItem(slug, action.capture)
        )
          add(
            'capture_no_usable_item',
            'error',
            `${path}.capture`,
            `No permitted capture item can capture "${slug}".`,
          );
      }
      allowed?.forEach((slug, i) => {
        const item = live.item(slug),
          at = `${path}.capture.allowedItems[${i}]`;
        if (!item)
          add(
            'capture_item_missing',
            'error',
            at,
            `Item "${slug}" does not exist.`,
          );
        else if (!item.capture)
          add(
            'capture_item_not_capture',
            'error',
            at,
            `Item "${slug}" is not a capture item.`,
          );
        else if (!item.enabled)
          add(
            'capture_item_disabled',
            'warning',
            at,
            `Item "${slug}" is disabled.`,
          );
      });
    }),
  );
  validateSpeciesPolicies(definition, tools, live);
  pools.forEach((p, i) => {
    if (!used.has(p.id))
      add(
        'species_pool_unused',
        'warning',
        `speciesPools[${i}]`,
        'No encounter references this species pool.',
      );
  });
  if (encounters > 40)
    add(
      'encounter_too_many',
      'error',
      'rooms',
      'At most 40 encounters are allowed.',
    );
  if (directRescues > 3)
    add(
      'rescue_direct_too_many',
      'error',
      'rooms',
      'At most three direct rescues are allowed.',
    );
}

/** The dungeon's own Species access entries: one per species, explicit terms, and only where they can apply. */
function validateSpeciesPolicies(
  definition: DungeonDefinition,
  { add }: EventValidationTools,
  live?: DungeonEncounterValidationSource,
): void {
  const offered = new Set(dungeonEncounterSlugs(definition));
  const seen = new Set<string>();
  (definition.speciesPolicies ?? []).forEach((entry, i) => {
    const path = `speciesPolicies[${i}]`;
    if (seen.has(entry.species))
      add('species_policy_duplicate', 'error', `${path}.species`, `Species "${entry.species}" has more than one access entry in this dungeon.`);
    seen.add(entry.species);
    if (entry.directRescue && typeof entry.perPlayerLimit !== 'number')
      add('rescue_direct_limit_missing', 'error', `${path}.perPlayerLimit`, `Direct Rescue for "${entry.species}" needs a finite per-player limit.`);
    if (!offered.has(entry.species))
      add('species_policy_unused', 'warning', path, `No encounter in this dungeon can present "${entry.species}"; her access entry has no effect.`);
    if (!live) return;
    const policy = live.species(entry.species);
    if (!policy) {
      add('species_missing', 'error', `${path}.species`, `Species "${entry.species}" does not exist.`);
      return;
    }
    if (policy.regionExclusive && !policy.access?.some((a) => a.dungeon === definition.key))
      add('species_policy_region_exclusive', 'error', `${path}.species`, `Species "${entry.species}" is region-exclusive; only species content can admit her to a dungeon.`);
    const terms = dungeonSpeciesTerms({ ...policy, owned: entry }, definition.key);
    if (terms?.source === 'both')
      add(
        'species_policy_content_overlap',
        'warning',
        path,
        `Species content also sets terms for "${entry.species}" in this dungeon; the stricter of each applies: limit ${terms.perPlayerLimit}, Direct Rescue ${terms.directRescue ? 'allowed' : 'not allowed'}.`,
      );
  });
}
function dungeonEncounterSlugs(definition: DungeonDefinition): string[] {
  return definition.rooms.flatMap((r) => r.actions.flatMap((a) => (isEncounterAction(a) ? encounterSpecies(definition, a) : [])));
}
