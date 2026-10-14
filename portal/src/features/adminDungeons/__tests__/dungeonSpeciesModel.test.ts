import { describe, expect, it } from 'vitest';
import { starterDungeon } from '../dungeonModel';
import {
  createSpeciesPool,
  deleteSpeciesPool,
  duplicateSpeciesPool,
  incompleteSpeciesIssues,
  newSpeciesEntry,
  speciesPoolUsage,
  updateSpeciesPool,
} from '../dungeonSpeciesModel';
import { friendlyIssue } from '../dungeonText';
describe('species pool draft edits', () => {
  it('mints stable identities, copies independently and cleans up the optional member', () => {
    const base = starterDungeon('test', 'Test', ['waifu-valley']);
    const made = createSpeciesPool(base);
    expect(made.id).toMatch(/^sp_[a-f0-9]{32}$/);
    const first = made.definition.speciesPools![0]!;
    const entry = newSpeciesEntry(first, 'android');
    expect(entry.id).toMatch(/^se_[a-f0-9]{32}$/);
    const edited = updateSpeciesPool(made.definition, made.id!, (p) => ({
      ...p,
      name: 'Wild',
      entries: [entry],
    }));
    const copy = duplicateSpeciesPool(edited, made.id!);
    expect(copy.id).not.toBe(made.id);
    expect(copy.definition.speciesPools![1]!.entries).toEqual([entry]);
    expect(copy.definition.speciesPools![1]!.entries).not.toBe(edited.speciesPools![0]!.entries);
    const renamed = updateSpeciesPool(copy.definition, copy.id!, (p) => ({
      ...p,
      name: 'Copy',
      entries: p.entries.map((e) => ({ ...e, weight: 8 })),
    }));
    expect(renamed.speciesPools![0]).toEqual(edited.speciesPools![0]);
    expect(renamed.speciesPools![1]!.id).toBe(copy.id);
    expect(deleteSpeciesPool(deleteSpeciesPool(renamed, made.id!), copy.id!)).toEqual(base);
    expect(base).not.toHaveProperty('speciesPools');
  });
  it('lists every encounter reference and refuses deletion, ignoring same-id event pools', () => {
    const made = createSpeciesPool(starterDungeon('test', 'Test', ['waifu-valley']));
    const d = {
      ...made.definition,
      eventPools: [
        { id: made.id!, name: 'Event', entries: [{ id: 'no', weight: 1, nothing: true as const }] },
      ],
    };
    d.rooms[0]!.actions.push(
      ...['wild_encounter', 'rescue'].map((type) => ({
        id: type,
        type,
        source: { kind: 'pool' as const, poolId: made.id! },
      })),
    );
    expect(speciesPoolUsage(d, made.id!)).toHaveLength(2);
    expect(deleteSpeciesPool(d, made.id!)).toBe(d);
    expect(
      speciesPoolUsage(
        {
          ...d,
          rooms: d.rooms.map((r) => ({
            ...r,
            actions: [{ id: 'e', type: 'event', source: { kind: 'pool', poolId: made.id! } }],
          })),
        },
        made.id!,
      ),
    ).toEqual([]);
  });
  it('unfinished fields block saving and checklist targets the exact stable pool/entry', () => {
    const made = createSpeciesPool(starterDungeon('test', 'Test', ['waifu-valley']));
    const d = updateSpeciesPool(made.definition, made.id!, (p) => ({
      ...p,
      name: '',
      entries: [{ id: 'bad', weight: 0, species: '' }],
    }));
    const issues = incompleteSpeciesIssues(d, 'editor_incomplete');
    expect(issues.map((i) => i.path)).toEqual([
      'speciesPools[0].name',
      'speciesPools[0].entries[0].species',
      'speciesPools[0].entries[0].weight',
    ]);
    expect(friendlyIssue(issues[2]!, d)).toMatchObject({
      level: 'finish',
      eventTarget: { kind: 'speciesPool', id: made.id, entryId: 'bad', field: 'weight' },
    });
  });
});
