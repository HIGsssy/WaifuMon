/**
 * Deterministic draws for expeditions.
 *
 * Every random quantity a resolution produces — the outcome roll, the
 * exceptional roll, and every reward group's gate, pick and amount — is
 * *derived* rather than rolled, from the expedition row's id plus a purpose
 * string and a versioned salt. This mirrors `bossRandom.ts` and exists for the
 * same reason, which matters more here than it does there: **an expedition
 * must never be re-rolled.**
 *
 * The conditional UPDATE in `expeditionService.resolve` is the primary
 * guarantee that a mission resolves once. This is the independent second one.
 * If two workers, two requests or a process and its own retry all reach
 * resolution at the same instant, they do not race to write *different*
 * outcomes — they each compute the *same* outcome, and the UPDATE decides
 * which of two identical writes lands. Two mechanisms, and the one operation
 * in this feature that must never double-pay is the one that gets both.
 *
 * `id` is the whole identity because an expedition row is a single player's
 * single mission; there is no second dimension (the boss path needs
 * `participationId` because one encounter pays many people). `purpose` keeps
 * independent quantities independent: `outcome` and `exceptional` are two
 * different questions about one mission, and a reward purpose carries its
 * group id and roll index so no two draws in one table are the same number
 * wearing different names.
 *
 * md5 is a distribution function here, not a security primitive.
 */
import { createHash } from 'node:crypto';

/**
 * Versioned salt for every expedition draw.
 *
 * Frozen. Changing it re-rolls every mission that has not yet resolved, which
 * would make a retry disagree with its first attempt — precisely the failure
 * this module exists to prevent. A future re-model introduces `v2` alongside
 * it rather than editing this string, and bumps `EXPEDITION_LOGIC_VERSION`.
 */
export const EXPEDITION_RANDOM_SALT = 'waifumon.expedition.roll.v1';

/**
 * Version of the resolution *derivation*.
 *
 * Bumped when the way an outcome or payout is computed changes — a different
 * independence structure, an extra draw, a new reward kind. The reward table's
 * own `version` covers retuning the numbers; this covers changing what the
 * numbers mean. Stamped onto every row as `logic_version`, so a historical
 * result says which derivation produced it rather than being reinterpreted
 * under whatever the code does today.
 */
export const EXPEDITION_LOGIC_VERSION = 1;

/**
 * What a draw is *for*.
 *
 * The reward variants are open-ended because reward groups are authored in
 * content: a table may declare any number of them, and each group's every roll
 * needs its own key. The template literal keeps the namespace closed at the
 * top level — a bare typo is still a type error — while letting the group id
 * and roll index vary.
 *
 * `success` and `bonus` are separate reward namespaces so that adding an
 * Exceptional bonus table to a mission cannot change what its ordinary success
 * table pays. The two tables draw independently, which is what makes
 * "Exceptional = success rewards **plus** bonus rewards" true in the arithmetic
 * and not just in the description.
 */
export type ExpeditionDrawPurpose =
  | 'outcome'
  | 'exceptional'
  | `success:${string}`
  | `bonus:${string}`
  | `failure:${string}`;

/** Hex digits taken from the digest — 8 = 32 bits. */
const HASH_HEX_DIGITS = 8;
const HASH_SPACE = 2 ** 32;

/**
 * The 32-bit unsigned integer for one draw. Exported so tests can pin the
 * derivation itself rather than only its consequences.
 */
export function expeditionDrawHash(
  expeditionId: number,
  purpose: ExpeditionDrawPurpose,
  salt: string = EXPEDITION_RANDOM_SALT,
): number {
  const digest = createHash('md5')
    .update(`${expeditionId}:${purpose}:${salt}`, 'utf8')
    .digest('hex');
  return Number.parseInt(digest.slice(0, HASH_HEX_DIGITS), 16);
}

/**
 * A uniform fraction in `[0, 1)` — the shape both a probability check and
 * `rollWeighted` want.
 */
export function expeditionDrawFraction(
  expeditionId: number,
  purpose: ExpeditionDrawPurpose,
  salt: string = EXPEDITION_RANDOM_SALT,
): number {
  return expeditionDrawHash(expeditionId, purpose, salt) / HASH_SPACE;
}

/**
 * A uniform integer in `[min, max]`, inclusive at both ends.
 *
 * Currency and Essence amounts are drawn this way rather than as a scaled
 * float, which is what keeps both endpoints exactly reachable: a float draw
 * would make the maximum a measure-zero event and the minimum an accident of
 * rounding.
 *
 * Modulo bias over any span a reward table would plausibly use is negligible
 * against 2^32 (a 500-wide range is off by about 1 part in 8.6 million).
 */
export function expeditionDrawInt(
  expeditionId: number,
  purpose: ExpeditionDrawPurpose,
  min: number,
  max: number,
  salt: string = EXPEDITION_RANDOM_SALT,
): number {
  if (max < min) throw new RangeError(`expeditionDrawInt: max ${max} < min ${min}`);
  const span = max - min + 1;
  return min + (expeditionDrawHash(expeditionId, purpose, salt) % span);
}

/**
 * An `Rng` pinned to one draw, so a deterministic value can be handed to
 * `rollWeighted` — the repository's one weighted-pick utility, which every
 * other loot table already goes through.
 *
 * The returned generator yields the *same* value every call rather than a
 * stream: one draw, one purpose. A caller needing a second independent value
 * asks for a second purpose instead, which is what keeps every quantity
 * traceable to a name.
 */
export function expeditionDrawRng(
  expeditionId: number,
  purpose: ExpeditionDrawPurpose,
  salt: string = EXPEDITION_RANDOM_SALT,
): { next(): number; intInclusive(min: number, max: number): number } {
  return {
    next: () => expeditionDrawFraction(expeditionId, purpose, salt),
    intInclusive: (min, max) => expeditionDrawInt(expeditionId, purpose, min, max, salt),
  };
}
