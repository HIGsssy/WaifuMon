/**
 * `trigger_waifumon_encounter` authoring shapes: what validates, what is
 * refused, and how every accepted shape normalises.
 *
 * Backward compatibility is the load-bearing part. Stored effects are
 * re-parsed through `EffectSchema` on every load and *dropped* if they fail
 * (see `hydrate.ts`), so a legacy shape that stopped validating would vanish
 * from live content silently.
 */
import { describe, expect, it } from 'vitest';
import {
  EffectSchema,
  normalizeWaifumonSelection,
  type WaifumonEncounterEffect,
} from '../../../src/modules/worldEncounters/types';
import { hydrateChoice } from '../../../src/modules/worldEncounters/hydrate';
import { createEffectExecutor } from '../../../src/modules/worldEncounters/effectExecutor';
import type { WorldEncounterChoiceRow } from '../../../src/modules/worldEncounters/worldEncounterRepository';

const T = 'trigger_waifumon_encounter' as const;

function parse(raw: unknown): WaifumonEncounterEffect {
  const effect = EffectSchema.parse(raw);
  if (effect.type !== T) throw new Error('wrong effect type');
  return effect;
}

function rejects(raw: unknown): void {
  expect(EffectSchema.safeParse(raw).success).toBe(false);
}

describe('legacy shapes still validate and mean what they meant', () => {
  it('legacy random `{ type }`', () => {
    expect(normalizeWaifumonSelection(parse({ type: T }))).toEqual({ mode: 'legacy_random' });
  });

  it('legacy specific `{ type, speciesSlug }`', () => {
    expect(normalizeWaifumonSelection(parse({ type: T, speciesSlug: 'some_species' }))).toEqual({
      mode: 'specific',
      speciesSlug: 'some_species',
    });
  });

  it('survives hydration from a stored row unchanged', () => {
    const row = {
      id: 1,
      sortOrder: 0,
      label: 'x',
      emoji: null,
      requirementsJson: {},
      checkJson: { type: 'none' },
      successEffectsJson: [{ type: T }, { type: T, speciesSlug: 'some_species' }],
      failureEffectsJson: [],
    } as unknown as WorldEncounterChoiceRow;
    expect(hydrateChoice(row).successEffects).toEqual([
      { type: T },
      { type: T, speciesSlug: 'some_species' },
    ]);
  });
});

describe('new selection shapes validate', () => {
  it('specific selector', () => {
    expect(
      normalizeWaifumonSelection(
        parse({ type: T, selection: { mode: 'specific', speciesSlug: 'some_species' } }),
      ),
    ).toEqual({ mode: 'specific', speciesSlug: 'some_species' });
  });

  it('unfiltered random defaults to region scope', () => {
    expect(parse({ type: T, selection: { mode: 'random' } }).selection).toEqual({
      mode: 'random',
      poolScope: 'region',
    });
  });

  it.each(['region', 'global'] as const)('%s scope', (poolScope) => {
    expect(parse({ type: T, selection: { mode: 'random', poolScope } }).selection).toEqual({
      mode: 'random',
      poolScope,
    });
  });

  it('rarity, race and affinity filters, alone and combined', () => {
    for (const filters of [
      { rarities: ['LR'] },
      { races: ['demon', 'spirit'] },
      { affinities: ['primal'] },
      { rarities: ['UR', 'LR'], races: ['demon', 'spirit'], affinities: ['primal', 'dominant'] },
    ]) {
      const selection = { mode: 'random', poolScope: 'region', ...filters };
      expect(parse({ type: T, selection }).selection).toEqual(selection);
    }
  });

  it('the LR Trail shape normalises to a strict region LR selector', () => {
    expect(
      normalizeWaifumonSelection(
        parse({ type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } }),
      ),
    ).toEqual({ mode: 'random', poolScope: 'region', rarities: ['LR'] });
  });
});

describe('refused shapes', () => {
  const random = (extra: Record<string, unknown>) => ({
    type: T,
    selection: { mode: 'random', poolScope: 'region', ...extra },
  });

  it('non-canonical rarity, race, affinity and scope values', () => {
    rejects(random({ rarities: ['XR'] }));
    rejects(random({ rarities: ['lr'] }));
    rejects(random({ races: ['orc'] }));
    // The canonical race vocabulary is lowercase; "Demon" is not a second
    // spelling of it.
    rejects(random({ races: ['Demon'] }));
    rejects(random({ affinities: ['feral'] }));
    rejects(random({ affinities: ['Primal'] }));
    rejects({ type: T, selection: { mode: 'random', poolScope: 'world' } });
  });

  it('specific mode without a species', () => {
    rejects({ type: T, selection: { mode: 'specific' } });
    rejects({ type: T, selection: { mode: 'specific', speciesSlug: 'Not A Slug' } });
  });

  it('contradictory mode-specific fields', () => {
    rejects({ type: T, selection: { mode: 'specific', speciesSlug: 'a', rarities: ['LR'] } });
    rejects({ type: T, selection: { mode: 'specific', speciesSlug: 'a', poolScope: 'region' } });
    rejects(random({ speciesSlug: 'a' }));
    rejects({
      type: T,
      speciesSlug: 'a',
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
    });
  });

  it('malformed selection data', () => {
    rejects({ type: T, selection: 'LR' });
    rejects({ type: T, selection: { poolScope: 'region' } });
    rejects({ type: T, selection: { mode: 'weighted' } });
    rejects(random({ rarities: 'LR' }));
    // A misspelled key must not silently become an unfiltered sighting.
    rejects(random({ rarity: ['LR'] }));
    rejects({ type: T, selector: { mode: 'random' } });
  });

  it('empty and repeated filter lists', () => {
    rejects(random({ rarities: [] }));
    rejects(random({ races: [] }));
    rejects(random({ affinities: [] }));
    rejects(random({ rarities: ['LR', 'LR'] }));
  });
});

describe('effect executor hands the resolver one normalised payload', () => {
  const executor = createEffectExecutor({
    currency: {} as never,
    inventory: {} as never,
    progression: {} as never,
    collection: {} as never,
    essenceAward: {} as never,
  });

  async function payloadFor(raw: unknown) {
    const out = await executor.apply(
      {} as never,
      { playerId: 1, buddyWaifuId: null, buddySpeciesName: null, encounterId: 1 },
      [EffectSchema.parse(raw)],
    );
    expect(out.followUps).toHaveLength(1);
    expect(out.followUps[0]!.kind).toBe(T);
    return out.followUps[0]!.payload;
  }

  it('legacy random → empty payload (the hunt draw, unchanged)', async () => {
    expect(await payloadFor({ type: T })).toEqual({});
  });

  it('both specific shapes → speciesSlug', async () => {
    expect(await payloadFor({ type: T, speciesSlug: 'a' })).toEqual({ speciesSlug: 'a' });
    expect(
      await payloadFor({ type: T, selection: { mode: 'specific', speciesSlug: 'a' } }),
    ).toEqual({ speciesSlug: 'a' });
  });

  it('random selector → selection, filters intact', async () => {
    const selection = { mode: 'random', poolScope: 'region', rarities: ['LR'] };
    expect(await payloadFor({ type: T, selection })).toEqual({ selection });
  });
});
