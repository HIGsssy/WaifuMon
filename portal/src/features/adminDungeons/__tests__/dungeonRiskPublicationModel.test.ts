import { describe, expect, it } from 'vitest';
import type { DungeonPublishedInfo } from '@/api/adminDungeons';
import { starterDungeon } from '../dungeonModel';
import { publicationState, publishExplanation } from '../dungeonPublicationModel';
import {
  abandonKeepsMore,
  effectiveAbandon,
  parseRetention,
  retentionLabel,
  withAbandon,
  withDefeat,
} from '../dungeonRiskModel';

const legacy = { progressionCurrency: null, defeatCurrencyRetentionBasisPoints: 5000 };

describe('currency risk model', () => {
  it('writes both rates into a new dungeon', () => {
    expect(starterDungeon('k', 'K', []).settings).toStrictEqual({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 5000,
      abandonCurrencyRetentionBasisPoints: 0,
    });
  });
  it('falls back to the defeat rate for abandoning, and adds the field only when asked', () => {
    expect(effectiveAbandon(legacy)).toBe(5000);
    expect(withDefeat(legacy, 0)).toStrictEqual({
      ...legacy,
      defeatCurrencyRetentionBasisPoints: 0,
    });
    const own = withAbandon(legacy, 10000);
    expect(own.abandonCurrencyRetentionBasisPoints).toBe(10000);
    expect(abandonKeepsMore(own)).toBe(true);
    expect(abandonKeepsMore(legacy)).toBe(false);
    expect(withAbandon(own, null)).toStrictEqual(legacy);
  });
  it('reads percentages and names presets', () => {
    expect(parseRetention('50')).toEqual({ ok: true, basisPoints: 5000 });
    expect(parseRetention(' 12.5% ')).toEqual({ ok: true, basisPoints: 1250 });
    expect(parseRetention('0.07')).toEqual({ ok: true, basisPoints: 7 });
    for (const bad of ['', 'half', '-1', '100.5', '1.234'])
      expect(parseRetention(bad).ok).toBe(false);
    expect(retentionLabel(0)).toBe('Keep nothing (0%)');
    expect(retentionLabel(3333)).toBe('Keep 33.33%');
  });
});

const published = { number: 2 } as DungeonPublishedInfo;
describe('publication state', () => {
  it('names each state', () => {
    const label = (source: Parameters<typeof publicationState>[0], unsaved = false) =>
      publicationState(source, unsaved).label;
    expect(label({ published: null, draftDiffers: true })).toBe('Not published yet');
    expect(label({ published, draftDiffers: false })).toBe('Matches publication');
    expect(label({ published, draftDiffers: false }, true)).toBe('Dungeon changed');
    expect(label({ published, draftDiffers: false, dependenciesDiffer: true })).toBe(
      'Loot changed',
    );
    expect(label({ published, draftDiffers: true, dependenciesDiffer: true })).toBe(
      'Dungeon and loot changed',
    );
  });
  it('still says what changed when the server reports a difference it cannot itemise', () => {
    const state = publicationState({ published, draftDiffers: false, dependenciesDiffer: true });
    expect(state.changes.map((c) => c.text)).toEqual([
      'The rewards this dungeon relies on are not the ones that were published.',
    ]);
    expect(publishExplanation(state)).toContain('changes to the loot it uses');
  });
  it('flags a broken dependency even before the first publication', () => {
    const state = publicationState({
      published: null,
      draftDiffers: true,
      dependencyChanges: [
        {
          kind: 'table',
          tableKey: 'gone',
          name: 'Lost Cache',
          status: 'missing',
          publishedHash: null,
          currentHash: null,
        },
      ],
    });
    expect(state).toMatchObject({ kind: 'unpublished', broken: true, label: 'Loot needs repair' });
  });
});
