/**
 * Random number utilities behind an injectable interface. The whole hunt
 * pipeline reads through this so tests can drive it with a seeded PRNG for
 * distribution assertions.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Inclusive at both ends. */
  intInclusive(min: number, max: number): number;
}

/** Cryptographically-uninteresting Mulberry32 PRNG; deterministic per seed. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    intInclusive(min, max) {
      if (max < min) throw new RangeError(`intInclusive: max ${max} < min ${min}`);
      return Math.floor(next() * (max - min + 1)) + min;
    },
  };
}

/** Production RNG — wraps Math.random. */
export function defaultRng(): Rng {
  const next = (): number => Math.random();
  return {
    next,
    intInclusive(min, max) {
      if (max < min) throw new RangeError(`intInclusive: max ${max} < min ${min}`);
      return Math.floor(next() * (max - min + 1)) + min;
    },
  };
}

export interface WeightedEntry<T> {
  weight: number;
  value: T;
}

/**
 * Weighted uniform pick. The single utility used for the result table, the
 * rarity table, species-within-rarity, and item sub-tables — the most
 * test-critical code in the project.
 */
export function rollWeighted<T>(entries: readonly WeightedEntry<T>[], rng: Rng): T {
  if (entries.length === 0) {
    throw new RangeError('rollWeighted: entries must not be empty');
  }
  let total = 0;
  for (const e of entries) {
    if (e.weight < 0 || !Number.isFinite(e.weight)) {
      throw new RangeError(`rollWeighted: invalid weight ${e.weight}`);
    }
    total += e.weight;
  }
  if (total <= 0) {
    throw new RangeError('rollWeighted: total weight must be > 0');
  }
  let r = rng.next() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r < 0) return e.value;
  }
  // Floating-point safety net.
  return entries[entries.length - 1]!.value;
}
