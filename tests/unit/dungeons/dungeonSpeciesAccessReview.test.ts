import { describe, expect, it } from 'vitest';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';
import { describeDungeonSpeciesAccess } from '../../../src/modules/dungeons/validation/dungeonSpeciesAccessReview';
import { validateDungeonDefinition } from '../../../src/modules/dungeons/validation/dungeonValidation';
import type { DungeonEncounterValidationSource, DungeonSpeciesPolicy } from '../../../src/modules/dungeons/validation/dungeonEncounterValidation';
import type { DungeonDefinition } from '../../../src/modules/dungeons/content/dungeonDefinition';

const slugs = ['recovery_wing_valkyrie', 'ridge_wolf_girl', 'showroom_demo_unit', 'yukata_attendant', 'glint_moth', 'skyline_gondolier', 'trailhead_marshal', 'vent_diver'];
const exclusive: DungeonSpeciesPolicy = { enabled: true, restricted: true };
function setup() {
  const policies = new Map(slugs.map(s => [s, { ...exclusive }]));
  const sharedPools = new Map([['master_dungeon_pool_n_r', {
    key: 'master_dungeon_pool_n_r', name: 'master dungeon pool N R', description: '', enabled: true,
    entries: slugs.map((species, n) => ({ id: `e${n}`, species, weight: n + 1, oncePerRun: true })),
  }]]);
  const source: DungeonEncounterValidationSource = {
    sharedPools, species: s => policies.get(s), item: () => undefined, hasUsableCaptureItem: () => true,
  };
  const d = singleRoomDungeon([{ id: 'meet', type: 'wild_encounter', source: { kind: 'pool', poolId: 'p' }, intro: '', capture: {} }], d => {
    d.speciesPools = [{ id: 'p', name: 'Master reference', sharedPoolKey: 'master_dungeon_pool_n_r', entries: [] }];
  });
  const review = (draft: DungeonDefinition = d) => {
    const validation = validateDungeonDefinition(draft, { encounterSource: source });
    return { validation, rows: describeDungeonSpeciesAccess(draft, source, validation.issues) };
  };
  return { d, source, policies, sharedPools, review };
}

describe('encounter Species Access review', () => {
  it('resolves the eight-species shared pool without granting rights or changing weights', () => {
    const { d, review, sharedPools } = setup();
    const before = structuredClone(d), poolBefore = structuredClone(sharedPools);
    const { validation, rows } = review();
    expect(validation.issues.filter(i => i.code === 'species_not_permitted')).toHaveLength(8);
    expect(rows).toHaveLength(8);
    expect(rows.every(r => r.canAdd && r.authorization === 'none' && r.captureReason === 'not_permitted')).toBe(true);
    expect(rows[0]!.references).toEqual([expect.objectContaining({ roomId: 'hall', actionId: 'meet', poolId: 'p', sharedPoolKey: 'master_dungeon_pool_n_r' })]);
    expect(d).toEqual(before); expect(sharedPools).toEqual(poolBefore);
    const approved = { ...d, speciesPolicies: slugs.map(species => ({ species, perPlayerLimit: 2 })) };
    expect(review(approved).validation.issues.filter(i => i.code === 'species_not_permitted')).toEqual([]);
    expect(review(approved).rows.every(r => r.authorization === 'dungeon' && r.perPlayerLimit === 2 && !r.canAdd)).toBe(true);
  });

  it('distinguishes central, dungeon, combined and missing authorization; retains stricter terms', () => {
    const { d, policies, review } = setup();
    policies.set(slugs[0]!, { ...exclusive, access: [{ dungeon: d.key, perPlayerLimit: 1 }] });
    policies.set(slugs[1]!, { ...exclusive, access: [{ dungeon: d.key, perPlayerLimit: 3, directRescue: false }] });
    d.speciesPolicies = [{ species: slugs[1]!, perPlayerLimit: 5, directRescue: true }, { species: slugs[2]!, perPlayerLimit: 7 }];
    const { rows } = review();
    expect(rows.find(r => r.species === slugs[0])).toMatchObject({ authorization: 'content', perPlayerLimit: 1, canAdd: false });
    expect(rows.find(r => r.species === slugs[1])).toMatchObject({ authorization: 'both', perPlayerLimit: 3, canAdd: false });
    expect(rows.find(r => r.species === slugs[2])).toMatchObject({ authorization: 'dungeon', perPlayerLimit: 7, canAdd: false });
    expect(rows.filter(r => r.canAdd)).toHaveLength(5);
  });

  it('deduplicates species across local/shared pools and named capture rescues, retaining all provenance', () => {
    const { d, review } = setup();
    d.speciesPools!.push({ id: 'local', name: 'Local', entries: [{ id: 'e', species: slugs[0]!, weight: 1, oncePerRun: false }] });
    d.rooms[0]!.actions.push({ ...d.rooms[0]!.actions[0]!, id: 'local_meet', source: { kind: 'pool', poolId: 'local' } } as never);
    d.rooms[0]!.actions.push({ id: 'rescue', type: 'rescue', mode: 'capture', source: { kind: 'species', species: slugs[0]! }, intro: '', capture: {}, outcomes: {} } as never);
    const { rows } = review();
    expect(rows).toHaveLength(8);
    expect(rows.find(r => r.species === slugs[0])!.references.map(r => r.actionId)).toEqual(['meet', 'local_meet', 'rescue']);
  });

  it('excludes unused pools and structurally unreachable rooms/actions, retains conditional possible draws', () => {
    const { d, policies, review } = setup();
    for (const s of ['unused', 'dead', 'skipped', 'conditional']) policies.set(s, exclusive);
    d.speciesPools!.push({ id: 'unused', name: 'Unused', entries: [{ id: 'e', species: 'unused', weight: 1, oncePerRun: true }] });
    const named = (id: string) => ({ id, type: 'wild_encounter' as const, source: { kind: 'species' as const, species: id }, intro: '', capture: {}, outcomes: {} });
    d.rooms.push({ ...d.rooms[0]!, id: 'unreachable', actions: [named('dead')] } as never);
    d.rooms[0]!.actions.unshift({ ...named('conditional'), when: { type: 'flag', flag: 'lever', equals: true, scope: 'run' } } as never);
    d.rooms[0]!.actions.push({ id: 'stop', type: 'leave', label: '', optional: false, outcomes: {} }, named('skipped') as never);
    expect(review().rows.map(r => r.species)).toEqual([...slugs, 'conditional'].sort());
    expect(review().validation.issues).toContainEqual(expect.objectContaining({ code: 'species_pool_unused', severity: 'warning' }));
    d.speciesPolicies = [{ species: 'unused', perPlayerLimit: 1 }];
    expect(review().validation.issues).toContainEqual(expect.objectContaining({ code: 'species_policy_unused', severity: 'warning' }));
  });

  it('never suggests bypassing disabled/missing/region policy or central Direct Rescue denial', () => {
    const { d, policies, review } = setup();
    policies.delete(slugs[0]!);
    policies.set(slugs[1]!, { ...exclusive, enabled: false });
    policies.set(slugs[2]!, { ...exclusive, regionExclusive: true });
    policies.set(slugs[3]!, { ...exclusive, access: [{ dungeon: d.key, perPlayerLimit: 2 }] });
    d.rooms[0]!.actions[0] = { id: 'direct', type: 'rescue', mode: 'direct', source: { kind: 'pool', poolId: 'p' }, intro: '', outcomes: {} } as never;
    const { rows } = review();
    for (const s of slugs.slice(0, 4)) expect(rows.find(r => r.species === s)!.canAdd).toBe(false);
    expect(rows.find(r => r.species === slugs[3])).toMatchObject({ captureReason: null, directReason: 'direct_not_permitted' });
    d.speciesPolicies = slugs.slice(4).map(species => ({ species, perPlayerLimit: 2 }));
    expect(review().rows.find(r => r.species === slugs[4])!.directReason).toBe('direct_not_permitted');
    d.speciesPolicies.forEach(p => { p.directRescue = true; });
    expect(review().rows.find(r => r.species === slugs[4])!.directReason).toBeNull();
  });

  it('does not substitute fallback species for disabled/missing shared dependencies', () => {
    const { sharedPools, review } = setup();
    sharedPools.values().next().value!.enabled = false;
    expect(review().rows).toEqual([]);
    expect(review().validation.issues).toContainEqual(expect.objectContaining({ code: 'species_pool_missing', severity: 'error' }));
    sharedPools.clear();
    expect(review().rows).toEqual([]);
  });

  it('can supply a finite Direct Rescue limit only when central policy already allows that permission', () => {
    const { d, policies, review } = setup();
    const species = slugs[0]!;
    policies.set(species, { ...exclusive, access: [{ dungeon: d.key, directRescue: true, perPlayerLimit: 'unlimited' }] });
    d.rooms[0]!.actions = [{ id: 'direct', type: 'rescue', mode: 'direct', source: { kind: 'species', species }, intro: '', outcomes: {} } as never];
    expect(review().rows[0]).toMatchObject({ authorization: 'content', captureReason: null, directReason: 'direct_limit_missing', canAdd: true });
    d.speciesPolicies = [{ species, perPlayerLimit: 2 }];
    expect(review().rows[0]).toMatchObject({ authorization: 'both', directReason: 'direct_not_permitted', canAdd: false });
    d.speciesPolicies[0]!.directRescue = true;
    expect(review().rows[0]).toMatchObject({ authorization: 'both', perPlayerLimit: 2, directReason: null, canAdd: false });
    policies.set(species, { ...exclusive, access: [{ dungeon: d.key, directRescue: false, perPlayerLimit: 1 }] });
    expect(review().rows[0]).toMatchObject({ authorization: 'both', perPlayerLimit: 1, directReason: 'direct_not_permitted', canAdd: false });
  });
});
