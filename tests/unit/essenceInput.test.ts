/**
 * Custom Essence-batch input validation.
 *
 * The modal takes a number of *applications*, not raw Essence, so these tests
 * pin both the arithmetic (applications × cost vs. balance) and the ordering of
 * the rejections — a player who is both broke and over the cap should be told
 * about the cap, which is the thing they typed.
 */
import { describe, expect, it } from 'vitest';
import {
  maxAffordableApplications,
  parseEssenceApplications,
  type EssenceBatchLimits,
} from '../../src/discord/essenceInput';

const limits = (patch: Partial<EssenceBatchLimits> = {}): EssenceBatchLimits => ({
  cap: 100,
  costPer: 10,
  balance: 1000,
  maxUseful: 50,
  ...patch,
});

describe('maxAffordableApplications', () => {
  it('takes the tightest of cap, balance and usefulness', () => {
    expect(maxAffordableApplications(limits())).toBe(50); // maxUseful binds
    expect(maxAffordableApplications(limits({ balance: 70 }))).toBe(7); // balance binds
    expect(maxAffordableApplications(limits({ maxUseful: 999, balance: 99999 }))).toBe(100);
  });

  it('is zero when she is capped or the player cannot afford one', () => {
    expect(maxAffordableApplications(limits({ maxUseful: 0 }))).toBe(0);
    expect(maxAffordableApplications(limits({ balance: 9 }))).toBe(0);
  });

  it('never returns a negative count', () => {
    expect(maxAffordableApplications(limits({ balance: 0, maxUseful: 0 }))).toBe(0);
  });
});

describe('parseEssenceApplications', () => {
  it('accepts a plain positive integer', () => {
    expect(parseEssenceApplications('5', limits())).toEqual({ ok: true, applications: 5 });
    expect(parseEssenceApplications('  7 ', limits())).toEqual({ ok: true, applications: 7 });
  });

  it('rejects blank input', () => {
    const result = parseEssenceApplications('   ', limits());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('how many times');
  });

  it('rejects non-numeric, decimal and negative input', () => {
    for (const raw of ['five', '2.5', '-3', '1e3', '٣']) {
      expect(parseEssenceApplications(raw, limits()).ok).toBe(false);
    }
  });

  it('rejects zero', () => {
    expect(parseEssenceApplications('0', limits()).ok).toBe(false);
  });

  it('rejects above the hard cap and names it', () => {
    const result = parseEssenceApplications('101', limits());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('100×');
  });

  it('rejects everything once she is at max level', () => {
    const result = parseEssenceApplications('1', limits({ maxUseful: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('max level');
  });

  it('rejects an amount that overshoots the level cap, naming the useful max', () => {
    const result = parseEssenceApplications('9', limits({ maxUseful: 4 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('4×');
  });

  it('rejects an amount the balance cannot cover, showing cost and balance', () => {
    const result = parseEssenceApplications('10', limits({ balance: 55 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('100'); // 10 × 10 Essence
      expect(result.error).toContain('55');
    }
  });

  it('allows spending the balance down to exactly zero', () => {
    expect(parseEssenceApplications('10', limits({ balance: 100 }))).toEqual({
      ok: true,
      applications: 10,
    });
  });

  it('allows exactly the useful maximum', () => {
    expect(parseEssenceApplications('4', limits({ maxUseful: 4 }))).toEqual({
      ok: true,
      applications: 4,
    });
  });

  it('reports the cap before the balance when both are exceeded', () => {
    // The cap is about what they typed; the balance is about what they own.
    const result = parseEssenceApplications('500', limits({ balance: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('at most');
  });
});
