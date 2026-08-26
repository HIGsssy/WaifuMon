/**
 * The tracker is throwaway view state, so what matters is that it defaults
 * sanely, merges patches without clobbering neighbours, resets cleanly, and
 * lets go of players who wandered off. `parseFilterInput` guards the only
 * untrusted input in the feature: four free-text modal boxes.
 */
import { describe, expect, it } from 'vitest';
import {
  createCollectionFilterTracker,
  defaultCollectionFilterState,
  hasActiveFilters,
  parseFilterInput,
  type FilterInputRaw,
} from '../../src/discord/collectionFilterTracker';

const MAX_LEVEL = 50;

const blank: FilterInputRaw = { name: '', minLevel: '', maxLevel: '', minCopies: '' };
const input = (patch: Partial<FilterInputRaw>): FilterInputRaw => ({ ...blank, ...patch });

describe('createCollectionFilterTracker', () => {
  it('hands back defaults for an unknown player', () => {
    const tracker = createCollectionFilterTracker();
    expect(tracker.get(1)).toEqual(defaultCollectionFilterState());
  });

  it('merges patches instead of replacing state', () => {
    const tracker = createCollectionFilterTracker();
    tracker.set(1, { name: 'saku', minLevel: 10 });
    tracker.set(1, { page: 3 });
    expect(tracker.get(1)).toMatchObject({ name: 'saku', minLevel: 10, page: 3 });
  });

  it('keeps players isolated from each other', () => {
    const tracker = createCollectionFilterTracker();
    tracker.set(1, { name: 'saku' });
    expect(tracker.get(2).name).toBeNull();
  });

  it('resets back to defaults', () => {
    const tracker = createCollectionFilterTracker();
    tracker.set(1, { name: 'saku', minCopies: 3, page: 4, sortBy: 'newest' });
    expect(tracker.reset(1)).toEqual(defaultCollectionFilterState());
    expect(tracker.get(1)).toEqual(defaultCollectionFilterState());
  });

  it('sweeps entries that went stale past the ttl', () => {
    const tracker = createCollectionFilterTracker({ ttlMs: 1000 });
    const t0 = 1_000_000;
    tracker.set(1, { name: 'saku' }, t0);
    // A later write for someone else sweeps the idle entry.
    tracker.set(2, { name: 'neko' }, t0 + 5000);
    expect(tracker.get(1).name).toBeNull();
    expect(tracker.get(2).name).toBe('neko');
  });

  it('keeps entries that are still fresh', () => {
    const tracker = createCollectionFilterTracker({ ttlMs: 10_000 });
    const t0 = 1_000_000;
    tracker.set(1, { name: 'saku' }, t0);
    tracker.set(2, { name: 'neko' }, t0 + 500);
    expect(tracker.get(1).name).toBe('saku');
  });
});

describe('hasActiveFilters', () => {
  it('ignores sort and page', () => {
    const state = { ...defaultCollectionFilterState(), sortBy: 'newest' as const, page: 4 };
    expect(hasActiveFilters(state)).toBe(false);
  });

  it('is true for any real filter', () => {
    for (const patch of [{ name: 'x' }, { minLevel: 2 }, { maxLevel: 9 }, { minCopies: 2 }]) {
      expect(hasActiveFilters({ ...defaultCollectionFilterState(), ...patch })).toBe(true);
    }
  });
});

describe('parseFilterInput', () => {
  it('treats every blank box as "no filter"', () => {
    const result = parseFilterInput(blank, MAX_LEVEL);
    expect(result).toEqual({
      ok: true,
      patch: { name: null, minLevel: null, maxLevel: null, minCopies: null },
    });
  });

  it('trims the name and drops a whitespace-only one', () => {
    expect(parseFilterInput(input({ name: '  saku  ' }), MAX_LEVEL)).toMatchObject({
      patch: { name: 'saku' },
    });
    expect(parseFilterInput(input({ name: '   ' }), MAX_LEVEL)).toMatchObject({
      patch: { name: null },
    });
  });

  it('parses a level range', () => {
    expect(parseFilterInput(input({ minLevel: '10', maxLevel: '30' }), MAX_LEVEL)).toMatchObject({
      patch: { minLevel: 10, maxLevel: 30 },
    });
  });

  it('clamps levels into the configured range', () => {
    expect(parseFilterInput(input({ maxLevel: '999' }), MAX_LEVEL)).toMatchObject({
      patch: { maxLevel: MAX_LEVEL },
    });
    expect(parseFilterInput(input({ minLevel: '0' }), MAX_LEVEL)).toMatchObject({
      patch: { minLevel: 1 },
    });
  });

  it('rejects an inverted range rather than silently swapping it', () => {
    const result = parseFilterInput(input({ minLevel: '30', maxLevel: '10' }), MAX_LEVEL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Min level');
  });

  it('rejects non-numeric input and names the offending field', () => {
    const result = parseFilterInput(input({ minLevel: 'ten' }), MAX_LEVEL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Min level');

    const copies = parseFilterInput(input({ minCopies: '-2' }), MAX_LEVEL);
    expect(copies.ok).toBe(false);
    if (!copies.ok) expect(copies.error).toContain('Min copies');
  });

  it('treats 0 and 1 copies as no minimum', () => {
    for (const raw of ['0', '1']) {
      expect(parseFilterInput(input({ minCopies: raw }), MAX_LEVEL)).toMatchObject({
        patch: { minCopies: null },
      });
    }
  });

  it('keeps a real copies minimum', () => {
    expect(parseFilterInput(input({ minCopies: '3' }), MAX_LEVEL)).toMatchObject({
      patch: { minCopies: 3 },
    });
  });
});
