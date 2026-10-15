/** Structural checks, plus live catalogue and policy checks when a source is supplied (`dungeonSpeciesPolicy.ts`). */
import {
  ACTION_OUTCOMES,
  isEncounterAction,
  encounterSpecies,
  type DungeonDefinition,
  type DungeonSpeciesAccess,
  type DungeonCondition,
} from '../content/dungeonDefinition';
import { destinationFor } from '../engine/routing';
import type { DungeonEncounterUnavailableReason } from '../engine/types';
import type { DungeonIssue, DungeonIssueCode } from './dungeonValidation';
import type { EventValidationTools } from './dungeonEventValidation';

export interface DungeonSpeciesPolicy {
  enabled: boolean;
  restricted: boolean;
  access?: readonly DungeonSpeciesAccess[];
}
/** `acquiredCount` is the player's cross-run count from the acquisition ledger, read in the step's transaction. */
export function dungeonSpeciesUnavailableReason(
  policy: DungeonSpeciesPolicy | undefined,
  dungeon: string,
  direct: boolean,
  acquiredCount = 0,
): DungeonEncounterUnavailableReason | null {
  if (!policy) return 'missing';
  if (!policy.enabled) return 'disabled';
  const access = policy.access?.find((a) => a.dungeon === dungeon);
  if (policy.restricted && !access) return 'not_permitted';
  if (direct && !access?.directRescue) return 'direct_not_permitted';
  if (direct && typeof access?.perPlayerLimit !== 'number')
    return 'direct_limit_missing';
  if (
    typeof access?.perPlayerLimit === 'number' &&
    acquiredCount >= access.perPlayerLimit
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
          live.species(slug),
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
        if (reason && reason !== 'player_limit')
          add(
            codes[reason],
            'error',
            `${path}.source`,
            `Species "${slug}" is unavailable: ${reason}.`,
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
