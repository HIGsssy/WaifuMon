/** Read-only authoring assistance. Pool membership never creates policy. */
import { encounterSpecies, isEncounterAction, type DungeonDefinition } from '../content/dungeonDefinition';
import { resolveSharedPools } from '../sharedPools/sharedPoolDefinition';
import {
  dungeonSpeciesTerms,
  dungeonSpeciesUnavailableReason,
  withDungeonSpeciesPolicy,
  type DungeonEncounterValidationSource,
} from './dungeonEncounterValidation';
import type { DungeonIssue } from './dungeonValidation';

export interface SpeciesAccessReference {
  roomId: string;
  roomName: string;
  actionId: string;
  actionName: string;
  direct: boolean;
  poolId?: string;
  poolName?: string;
  sharedPoolKey?: string;
}

/**
 * Use the validator's structural reachability, with locks/conditions treated
 * as potentially satisfiable. This is a review of possible encounters, never
 * a simulated draw or a proof that a player can satisfy every condition.
 * Keep the original definition for shared-key provenance; resolve only draws.
 */
export function describeDungeonSpeciesAccess(
  draft: DungeonDefinition,
  source: DungeonEncounterValidationSource,
  issues: readonly DungeonIssue[],
) {
  const definition = resolveSharedPools(draft, source.sharedPools ?? new Map());
  const unreachable = new Set(issues.filter(i => i.code === 'room_unreachable' || i.code === 'action_unreachable').map(i => i.path));
  const references = new Map<string, SpeciesAccessReference[]>();
  definition.rooms.forEach((room, r) => {
    if (unreachable.has(`rooms[${r}]`)) return;
    room.actions.forEach((action, a) => {
      if (!isEncounterAction(action) || unreachable.has(`rooms[${r}].actions[${a}]`)) return;
      const poolId = action.source.kind === 'pool' ? action.source.poolId : undefined;
      const pool = draft.speciesPools?.find(p => p.id === poolId);
      for (const species of encounterSpecies(definition, action)) {
        const uses = references.get(species) ?? [];
        uses.push({
          roomId: room.id, roomName: room.name, actionId: action.id,
          actionName: action.label || (action.type === 'rescue' ? 'Rescue' : 'Wild Encounter'),
          direct: action.type === 'rescue' && action.mode === 'direct',
          ...(pool ? { poolId: pool.id, poolName: pool.name, ...(pool.sharedPoolKey ? { sharedPoolKey: pool.sharedPoolKey } : {}) } : {}),
        });
        references.set(species, uses);
      }
    });
  });
  return [...references].sort(([a], [b]) => a.localeCompare(b)).map(([species, references]) => {
    const policy = withDungeonSpeciesPolicy(source.species(species), draft.speciesPolicies, species);
    const terms = dungeonSpeciesTerms(policy, draft.key);
    const central = policy?.access?.find(a => a.dungeon === draft.key);
    const captureReason = dungeonSpeciesUnavailableReason(policy, draft.key, false);
    const directReason = references.some(r => r.direct) ? dungeonSpeciesUnavailableReason(policy, draft.key, true) : null;
    // Never replace an existing entry or suggest overriding a central denial.
    const canAdd = !!policy?.enabled && !policy.regionExclusive && !policy.owned &&
      (captureReason === 'not_permitted' ||
        (directReason !== null && (!central || central.directRescue === true)));
    return {
      species, references,
      authorization: terms?.source ?? (captureReason === null ? 'unrestricted' as const : 'none' as const),
      perPlayerLimit: terms?.perPlayerLimit ?? null,
      captureReason, directReason, canAdd,
    };
  });
}
