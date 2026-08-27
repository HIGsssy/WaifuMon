/**
 * Persistent shuffle bag for boss selection — pure, and the whole reason a
 * guild sees all ten bosses before it sees any of them twice.
 *
 * The rules, in the order they bind:
 *
 *   1. **Bag guarantee (inviolable).** Every enabled boss for the region is
 *      drawn exactly once before any is drawn again. This is what the bag is
 *      *for*, and nothing below is allowed to break it.
 *   2. **No repeat across the seam.** The last boss out of one bag may not be
 *      the first out of the next. Enforced by rotating a freshly-shuffled bag
 *      whose head collides, rather than re-shuffling until it happens not to —
 *      cheaper, and it terminates.
 *   3. **Affinity spacing (best effort).** Two bosses of the same affinity
 *      back to back are avoided when a later candidate in the *same bag* can
 *      take the slot. If no such candidate exists, rule 1 wins and the repeat
 *      happens — spacing is a preference, never a guarantee.
 *
 * State is a plain serializable object so it round-trips through a `jsonb`
 * column with no adapter: the remaining ids in draw order, plus the id and
 * affinity of the boss most recently drawn (what rules 2 and 3 compare
 * against).
 *
 * Draws take an injected {@link Rng}, so a test drives the shuffle exactly the
 * way it drives every other roll in this repository.
 */
import type { Affinity } from '../../db/schema';
import type { Rng } from '../../shared/random';

/** The minimum a bag needs to know about a boss to sequence it. */
export interface ShuffleBagCandidate {
  id: string;
  affinity: Affinity;
}

/**
 * Persisted bag state.
 *
 * `remaining` is the *ordered* tail of the current bag. Storing the order
 * rather than a set is what makes a restart invisible: the sequence a guild is
 * partway through survives verbatim, so recovery cannot reroll anything.
 */
export interface ShuffleBagState {
  /** Boss ids still owed by the current bag, in draw order. */
  remaining: string[];
  /** Id of the most recently drawn boss, or null before the first draw. */
  lastBossId: string | null;
  /** Affinity of the most recently drawn boss, or null before the first draw. */
  lastAffinity: Affinity | null;
  /** How many complete bags have been exhausted. Diagnostics and tests. */
  bagsCompleted: number;
}

export function emptyShuffleBagState(): ShuffleBagState {
  return { remaining: [], lastBossId: null, lastAffinity: null, bagsCompleted: 0 };
}

/** Fisher–Yates, driven by the injected RNG. Returns a new array. */
export function shuffle<T>(input: readonly T[], rng: Rng): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.intInclusive(0, i);
    const held = out[i]!;
    out[i] = out[j]!;
    out[j] = held;
  }
  return out;
}

/**
 * Rotate a freshly-shuffled bag so it does not open with `forbiddenId`.
 *
 * Moves the offending head to the *second* position rather than to the end:
 * the goal is only to break the seam, and burying it deeper than necessary
 * would skew the ordering more than the shuffle intended. A single-entry bag
 * (one enabled boss in the region) cannot avoid the repeat and is returned
 * unchanged — rule 1 wins.
 */
export function avoidHeadCollision(bag: string[], forbiddenId: string | null): string[] {
  if (forbiddenId === null || bag.length < 2 || bag[0] !== forbiddenId) return bag;
  const [head, second, ...rest] = bag;
  return [second!, head!, ...rest];
}

/**
 * Refill: a full shuffled bag of every candidate, with the seam repeat broken.
 * `bagsCompleted` advances here, which is what makes "how many bags has this
 * guild been through" answerable from state alone.
 */
export function refillBag(
  state: ShuffleBagState,
  candidates: readonly ShuffleBagCandidate[],
  rng: Rng,
): ShuffleBagState {
  const ids = shuffle(
    candidates.map((c) => c.id),
    rng,
  );
  return {
    ...state,
    remaining: avoidHeadCollision(ids, state.lastBossId),
    bagsCompleted: state.bagsCompleted + 1,
  };
}

export interface ShuffleBagDraw {
  bossId: string;
  state: ShuffleBagState;
  /** True when this draw emptied the bag and forced a refill first. */
  refilled: boolean;
  /**
   * True when the drawn boss shares the previous boss's affinity — i.e. rule 3
   * could not be honoured without breaking rule 1. Surfaced for logging so an
   * operator can see spacing being sacrificed rather than guess at it.
   */
  affinityRepeat: boolean;
}

/**
 * Index of the next boss, preferring one whose affinity differs from the last
 * drawn.
 *
 * Scans forward from the head and takes the first non-matching candidate; if
 * every remaining entry matches (a bag whose tail is all one affinity), it
 * falls back to the head. Deliberately *not* a re-shuffle: reordering the
 * remaining bag to dodge a repeat would change which bosses are still owed
 * relative to the persisted order, and the persisted order is what a restart
 * relies on.
 */
function pickIndexAvoidingAffinity(
  remaining: readonly string[],
  affinityById: ReadonlyMap<string, Affinity>,
  lastAffinity: Affinity | null,
): number {
  if (lastAffinity === null) return 0;
  for (let i = 0; i < remaining.length; i++) {
    if (affinityById.get(remaining[i]!) !== lastAffinity) return i;
  }
  return 0;
}

/**
 * Draw the next boss, refilling first when the bag is empty.
 *
 * Ids in `remaining` that are no longer candidates — a boss disabled in
 * content, or a region change — are dropped rather than drawn. That keeps a
 * content edit from resurrecting a retired boss, and a bag emptied by that
 * filtering simply refills.
 *
 * Returns `null` when the region has no enabled bosses at all; callers treat
 * that as "nothing to schedule" rather than as an error.
 */
export function drawFromBag(
  state: ShuffleBagState,
  candidates: readonly ShuffleBagCandidate[],
  rng: Rng,
): ShuffleBagDraw | null {
  if (candidates.length === 0) return null;

  const affinityById = new Map(candidates.map((c) => [c.id, c.affinity]));
  const valid = state.remaining.filter((id) => affinityById.has(id));

  let working: ShuffleBagState = { ...state, remaining: valid };
  let refilled = false;
  if (working.remaining.length === 0) {
    working = refillBag(working, candidates, rng);
    refilled = true;
  }

  const index = pickIndexAvoidingAffinity(working.remaining, affinityById, working.lastAffinity);
  const bossId = working.remaining[index]!;
  const affinity = affinityById.get(bossId)!;
  const remaining = [...working.remaining.slice(0, index), ...working.remaining.slice(index + 1)];

  return {
    bossId,
    refilled,
    affinityRepeat: working.lastAffinity !== null && working.lastAffinity === affinity,
    state: {
      remaining,
      lastBossId: bossId,
      lastAffinity: affinity,
      bagsCompleted: working.bagsCompleted,
    },
  };
}

/**
 * Normalize whatever came out of the `jsonb` column into valid state.
 *
 * A column that is null (a guild configured before this feature), or that
 * holds something hand-edited and wrong, must not crash the scheduler — the
 * worst acceptable outcome is a guild that starts a fresh bag.
 */
export function parseShuffleBagState(value: unknown): ShuffleBagState {
  const empty = emptyShuffleBagState();
  if (!value || typeof value !== 'object') return empty;
  const raw = value as Record<string, unknown>;
  const remaining = Array.isArray(raw.remaining)
    ? raw.remaining.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    remaining,
    lastBossId: typeof raw.lastBossId === 'string' ? raw.lastBossId : null,
    lastAffinity: typeof raw.lastAffinity === 'string' ? (raw.lastAffinity as Affinity) : null,
    bagsCompleted: Number.isInteger(raw.bagsCompleted) ? (raw.bagsCompleted as number) : 0,
  };
}
