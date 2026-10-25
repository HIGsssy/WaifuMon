import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpeciesContentSchema } from '../../../src/modules/content/schemas';
import { DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { describeSpeciesAuthoring, type DungeonAuthoringSpecies } from '../../../src/modules/dungeons/engine/speciesAuthoring';
import {
  dungeonSpeciesTerms,
  dungeonSpeciesUnavailableReason,
  withDungeonSpeciesPolicy,
  type DungeonSpeciesPolicy,
} from '../../../src/modules/dungeons/validation/dungeonEncounterValidation';

const exclusive: DungeonSpeciesPolicy = { enabled: true, restricted: true, access: [] };
const regional: DungeonSpeciesPolicy = { enabled: true, restricted: true, regionExclusive: true, access: [] };
const ordinary: DungeonSpeciesPolicy = { enabled: true, restricted: false };
const own = (perPlayerLimit: number | 'unlimited', directRescue?: boolean) => ({ species: 'x', perPlayerLimit, ...(directRescue ? { directRescue } : {}) });

describe('dungeon-owned species terms', () => {
  it('a dungeon_exclusive species with empty dungeonAccess is valid content', () => {
    const [example] = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/dungeons/examples/dungeon-exclusive-waifumon.json'), 'utf8'));
    const parsed = SpeciesContentSchema.parse({ ...example, dungeonAccess: [] });
    expect(parsed).toMatchObject({ enabled: true, tags: ['dungeon_exclusive'], dungeonAccess: [] });
  });

  it('admits a dungeon_exclusive species by the dungeon’s own entry alone, and only in that dungeon', () => {
    expect(dungeonSpeciesUnavailableReason(exclusive, 'a', false)).toBe('not_permitted');
    expect(dungeonSpeciesUnavailableReason({ ...exclusive, owned: own(1) }, 'a', false)).toBeNull();
    // Entries are judged per dungeon: B's entries are never read for A.
    expect(dungeonSpeciesUnavailableReason(withDungeonSpeciesPolicy(exclusive, [own(1)], 'y'), 'a', false)).toBe('not_permitted');
    expect(dungeonSpeciesUnavailableReason({ ...exclusive, owned: own(1) }, 'a', false, 1)).toBe('player_limit');
  });

  it('never admits a region-exclusive species without species content', () => {
    expect(dungeonSpeciesUnavailableReason({ ...regional, owned: own(1) }, 'a', false)).toBe('not_permitted');
    expect(dungeonSpeciesUnavailableReason({ ...regional, access: [{ dungeon: 'a' }], owned: own(1) }, 'a', false, 1)).toBe('player_limit');
  });

  it('Direct Rescue needs explicit permission and a finite limit', () => {
    expect(dungeonSpeciesUnavailableReason({ ...exclusive, owned: own(1) }, 'a', true)).toBe('direct_not_permitted');
    expect(dungeonSpeciesUnavailableReason({ ...exclusive, owned: own('unlimited', true) }, 'a', true)).toBe('direct_limit_missing');
    expect(dungeonSpeciesUnavailableReason({ ...exclusive, owned: own(2, true) }, 'a', true)).toBeNull();
    expect(dungeonSpeciesUnavailableReason({ ...ordinary, owned: own(2, true) }, 'a', true)).toBeNull();
  });

  it('applies the stricter of species content and the dungeon entry', () => {
    const both = (access: NonNullable<DungeonSpeciesPolicy['access']>, owned: ReturnType<typeof own>) => dungeonSpeciesTerms({ ...exclusive, access, owned }, 'a');
    expect(both([{ dungeon: 'a', perPlayerLimit: 1 }], own('unlimited'))).toEqual({ perPlayerLimit: 1, directRescue: false, source: 'both' });
    expect(both([{ dungeon: 'a' }], own(3))).toEqual({ perPlayerLimit: 3, directRescue: false, source: 'both' });
    expect(both([{ dungeon: 'a', perPlayerLimit: 2, directRescue: true }], own(5))).toEqual({ perPlayerLimit: 2, directRescue: false, source: 'both' });
    expect(both([{ dungeon: 'a', perPlayerLimit: 4, directRescue: true }], own(2, true))).toEqual({ perPlayerLimit: 2, directRescue: true, source: 'both' });
    expect(dungeonSpeciesTerms({ ...exclusive, access: [{ dungeon: 'b', perPlayerLimit: 1 }], owned: own(9) }, 'a')).toEqual({ perPlayerLimit: 9, directRescue: false, source: 'dungeon' });
  });

  it('leaves legacy content-only and ordinary species exactly as before', () => {
    expect(dungeonSpeciesUnavailableReason(ordinary, 'a', false, 100)).toBeNull();
    expect(dungeonSpeciesUnavailableReason(ordinary, 'a', true)).toBe('direct_not_permitted');
    const legacy = { ...exclusive, access: [{ dungeon: 'a', perPlayerLimit: 1, directRescue: true }] };
    expect(dungeonSpeciesUnavailableReason(legacy, 'a', true)).toBeNull();
    expect(dungeonSpeciesUnavailableReason(legacy, 'a', false, 1)).toBe('player_limit');
    expect(dungeonSpeciesUnavailableReason(legacy, 'b', false)).toBe('not_permitted');
  });

  it('an absent speciesPolicies never materialises, so legacy definitions hash as before', () => {
    const base = {
      key: 'k', name: 'K', entranceRoomId: 'r', rooms: [{ id: 'r', name: 'R', kind: 'exit' }],
    };
    expect('speciesPolicies' in DungeonDefinitionSchema.parse(base)).toBe(false);
  });

  it('pool odds annotate a dungeon-owned entry from the definition being authored', () => {
    const catalogue: DungeonAuthoringSpecies[] = [{
      slug: 'x', name: 'X', rarity: 'SR', archetype: 'human', affinity: 'switch', enabled: true,
      regionExclusive: false, dungeonExclusive: true, dungeonAccess: [], permitted: false,
      unavailableReason: 'not_permitted', dungeonPolicyAllowed: true, perPlayerLimit: null,
      directRescue: { available: false, reason: 'not_permitted' },
    }];
    const speciesPools = [{ id: 'p', name: 'P', entries: [{ id: 'e', weight: 1, species: 'x', oncePerRun: true }] }];
    const reason = (speciesPolicies?: ReturnType<typeof own>[]) =>
      describeSpeciesAuthoring({ key: 'a', speciesPools, ...(speciesPolicies ? { speciesPolicies } : {}) }, catalogue).speciesPools[0]!.base.entries[0]!.unavailableReason;
    expect(reason()).toBe('not_permitted');
    expect(reason([own(1)])).toBeNull();
  });
});
