/**
 * BuddyBonusService — buddy resolution and the content join, without a
 * database.
 *
 * The queries are stubbed rather than run: what is under test is *which* bonus
 * a player has in force, which is a decision, not a query plan. The queries
 * themselves are exercised by the integration suite.
 */
import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '../../src/db/client';
import type { LoadedContent, SpeciesContent } from '../../src/modules/content/schemas';
import {
  createBuddyBonusService,
  findBuddyBonus,
} from '../../src/modules/buddyBonus/buddyBonusService';

/**
 * A drizzle-shaped stub: every builder method returns the chain, and awaiting
 * it yields the next queued result. Calls are consumed in order, which is
 * exactly how the service issues them.
 */
function fakeTx(results: unknown[][]): { tx: DbOrTx; remaining: () => number } {
  const queue = [...results];
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'limit', 'for']) {
    chain[method] = () => chain;
  }
  chain['then'] = (resolve: (rows: unknown[]) => unknown) => resolve(queue.shift() ?? []);
  const tx = {
    select: () => chain,
    selectDistinct: () => chain,
  } as unknown as DbOrTx;
  return { tx, remaining: () => queue.length };
}

const species = (over: Partial<SpeciesContent>): SpeciesContent =>
  ({
    slug: 'test_subject',
    name: 'Test Subject',
    rarity: 'R',
    archetype: 'human',
    contentRating: 'suggestive',
    affinity: 'switch',
    baseCaptureRate: null,
    description: '',
    tags: [],
    imagePath: 'x.png',
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    ...over,
  }) as SpeciesContent;

function contentWith(...list: SpeciesContent[]): LoadedContent {
  return { species: list } as unknown as LoadedContent;
}

const CAPTURE_BONUS = {
  name: 'Test Bonus',
  flavorText: 'Display only.',
  effectId: 'capture_chance' as const,
  value: 10,
};

describe('getActiveBuddyBonus', () => {
  it('returns nothing when no buddy is equipped', async () => {
    const svc = createBuddyBonusService({
      getContent: () => contentWith(species({ buddyBonus: CAPTURE_BONUS })),
    });
    const { tx } = fakeTx([[{ buddyWaifuId: null }]]);
    expect(await svc.getActiveBuddyBonus(tx, 1)).toBeNull();
    expect(await svc.percentFor(tx, 1, 'capture_chance')).toBe(0);
  });

  it('returns nothing when the equipped buddy has been released out from under the pointer', async () => {
    const svc = createBuddyBonusService({
      getContent: () => contentWith(species({ buddyBonus: CAPTURE_BONUS })),
    });
    const { tx } = fakeTx([
      [{ buddyWaifuId: 7 }],
      [{ slug: 'test_subject', name: 'Test Subject', releasedAt: new Date() }],
    ]);
    expect(await svc.getActiveBuddyBonus(tx, 1)).toBeNull();
  });

  it('returns nothing when the buddy species authors no bonus', async () => {
    const svc = createBuddyBonusService({ getContent: () => contentWith(species({})) });
    const { tx } = fakeTx([
      [{ buddyWaifuId: 7 }],
      [{ slug: 'test_subject', name: 'Test Subject', releasedAt: null }],
    ]);
    expect(await svc.getActiveBuddyBonus(tx, 1)).toBeNull();
  });

  it('returns the equipped buddy’s authored bonus', async () => {
    const svc = createBuddyBonusService({
      getContent: () => contentWith(species({ buddyBonus: CAPTURE_BONUS })),
    });
    const { tx } = fakeTx([
      [{ buddyWaifuId: 7 }],
      [{ slug: 'test_subject', name: 'Test Subject', releasedAt: null }],
    ]);
    expect(await svc.getActiveBuddyBonus(tx, 1)).toEqual({
      bonus: CAPTURE_BONUS,
      buddyWaifuId: 7,
      speciesSlug: 'test_subject',
      speciesName: 'Test Subject',
    });
  });
});

describe('percentForSpecies', () => {
  const encountered = {
    id: 42,
    slug: 'met_in_the_wild',
    archetype: 'android',
    affinity: 'primal',
    rarity: 'SSR',
  };

  function serviceWithBonus(bonus: unknown) {
    return createBuddyBonusService({
      getContent: () =>
        contentWith(
          species({ slug: 'buddy_species', buddyBonus: bonus as never }),
          species({ slug: 'met_in_the_wild', archetype: 'android', race: 'android' }),
        ),
    });
  }

  const buddyRows = [
    [{ buddyWaifuId: 7 }],
    [{ slug: 'buddy_species', name: 'Buddy', releasedAt: null }],
  ];

  it('resolves race from authored content, not just the archetype string', async () => {
    const svc = serviceWithBonus({
      ...CAPTURE_BONUS,
      value: 15,
      target: { type: 'race', value: 'android' },
    });
    const { tx } = fakeTx(buddyRows);
    expect(await svc.percentForSpecies(tx, 1, 'capture_chance', encountered)).toBe(15);
  });

  it('does not query ownership unless the bonus targets ownership', async () => {
    const svc = serviceWithBonus({ ...CAPTURE_BONUS, value: 7 });
    const { tx, remaining } = fakeTx([...buddyRows, [{ speciesId: 42 }]]);
    expect(await svc.percentForSpecies(tx, 1, 'capture_chance', encountered)).toBe(7);
    // The ownership row set was never consumed.
    expect(remaining()).toBe(1);
  });

  it('applies an owned-target bonus only to species the player already has', async () => {
    const bonus = { ...CAPTURE_BONUS, value: 5, target: { type: 'ownership', value: 'owned' } };
    const owned = createBuddyBonusService({
      getContent: () =>
        contentWith(species({ slug: 'buddy_species', buddyBonus: bonus as never })),
    });
    expect(
      await owned.percentForSpecies(
        fakeTx([...buddyRows, [{ speciesId: 42 }]]).tx,
        1,
        'capture_chance',
        encountered,
      ),
    ).toBe(5);
    expect(
      await owned.percentForSpecies(
        fakeTx([...buddyRows, []]).tx,
        1,
        'capture_chance',
        encountered,
      ),
    ).toBe(0);
  });

  it('applies an unowned-target bonus only to species the player lacks', async () => {
    const bonus = { ...CAPTURE_BONUS, value: 5, target: { type: 'ownership', value: 'unowned' } };
    const svc = createBuddyBonusService({
      getContent: () =>
        contentWith(species({ slug: 'buddy_species', buddyBonus: bonus as never })),
    });
    expect(
      await svc.percentForSpecies(fakeTx([...buddyRows, []]).tx, 1, 'capture_chance', encountered),
    ).toBe(5);
    expect(
      await svc.percentForSpecies(
        fakeTx([...buddyRows, [{ speciesId: 42 }]]).tx,
        1,
        'capture_chance',
        encountered,
      ),
    ).toBe(0);
  });

  it('contributes nothing when the buddy’s bonus is a different effect', async () => {
    const svc = serviceWithBonus({ ...CAPTURE_BONUS, effectId: 'essence_gain' });
    const { tx } = fakeTx(buddyRows);
    expect(await svc.percentForSpecies(tx, 1, 'capture_chance', encountered)).toBe(0);
  });
});

describe('content-driven by construction', () => {
  it('a brand-new species using an existing effectId works with no code change', async () => {
    // Nothing about this species exists anywhere in the codebase: it is added
    // to the snapshot here exactly as a new JSON file would add it.
    const newcomer = species({
      slug: 'species_that_did_not_exist_yesterday',
      name: 'Newcomer',
      buddyBonus: {
        name: 'Fresh Ink',
        flavorText: 'Fresh Ink: +42% Essence gained.',
        effectId: 'essence_gain',
        value: 42,
      } as never,
    });
    const svc = createBuddyBonusService({ getContent: () => contentWith(newcomer) });
    const { tx } = fakeTx([
      [{ buddyWaifuId: 3 }],
      [{ slug: 'species_that_did_not_exist_yesterday', name: 'Newcomer', releasedAt: null }],
    ]);
    expect(await svc.percentFor(tx, 1, 'essence_gain')).toBe(42);
  });

  it('reads a snapshot edited in place, the way an admin reload republishes one', async () => {
    const entry = species({ slug: 'buddy_species' });
    const content = contentWith(entry);
    const svc = createBuddyBonusService({ getContent: () => content });
    expect(svc.bonusForSpeciesSlug('buddy_species')).toBeNull();

    entry.buddyBonus = { ...CAPTURE_BONUS, value: 25 } as never;
    expect(svc.bonusForSpeciesSlug('buddy_species')?.value).toBe(25);
  });

  it('exposes bonuses to display surfaces without a player or a query', () => {
    const content = contentWith(species({ slug: 'buddy_species', buddyBonus: CAPTURE_BONUS }));
    expect(findBuddyBonus(content, 'buddy_species')).toEqual(CAPTURE_BONUS);
    expect(findBuddyBonus(content, 'nobody')).toBeNull();
  });
});
