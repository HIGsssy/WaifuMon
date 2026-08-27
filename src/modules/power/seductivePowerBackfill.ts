/**
 * Deterministic Base SP for owned Waifumon that predate the column.
 *
 * The historical backfill cannot roll: a migration that re-ran — a replay, a
 * restored snapshot, a second deploy — would hand the same copy a different
 * permanent stat. So it *derives* instead, from data that never changes.
 *
 * The derivation, and why each piece is there:
 *
 *   md5(`<waifuId>:<salt>`) → take the first 8 hex digits → a 32-bit integer
 *   → `min + (n mod span)`
 *
 *   - **`waifuId`** is the stable identity. Two duplicate copies of the same
 *     species have different ids and therefore land on different values, which
 *     is the point — Base SP belongs to the copy, not the species.
 *   - **The salt** is versioned and frozen ({@link SP_BACKFILL_SALT}). Changing
 *     it is how a hypothetical future re-derivation would be expressed, and
 *     also why this one may never be edited.
 *   - **md5** because Postgres has it built in, which lets the migration do the
 *     backfill in one `UPDATE` with no application round-trip, while this
 *     module reproduces the identical result in TypeScript. A test asserts the
 *     two agree over a wide id sweep — that equivalence is the whole reason the
 *     algorithm is this plain. It is a *distribution* function, not a security
 *     primitive; md5's weaknesses are irrelevant to picking an integer in [90,
 *     100].
 *
 * **Uniformity.** `n` is uniform over 2^32 and the spans are 11 wide, so
 * `n mod 11` is biased by at most one part in ~390 million — every integer in
 * the range is reachable and, at any population this game will ever have, they
 * are equiprobable. Not the midpoint for everyone, and not a truncated range.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_SP_RANGES_BY_RARITY,
  rangeForRarity,
  SP_BACKFILL_SALT,
  type SeductivePowerRanges,
} from './seductivePower';

/** Hex digits taken from the digest — 8 = 32 bits, matching the SQL cast. */
const HASH_HEX_DIGITS = 8;

/**
 * The 32-bit unsigned integer the migration's
 * `('x' || substr(md5(...), 1, 8))::bit(32)::bigint` produces for the same
 * input. Exported so a test can compare the two implementations directly.
 */
export function backfillHash(waifuId: number, salt: string = SP_BACKFILL_SALT): number {
  const digest = createHash('md5').update(`${waifuId}:${salt}`, 'utf8').digest('hex');
  return Number.parseInt(digest.slice(0, HASH_HEX_DIGITS), 16);
}

/**
 * The Base SP the migration assigns to one pre-existing owned copy.
 *
 * Pure and total: the same `(waifuId, rarity, salt)` always yields the same
 * integer, on any machine, in any process, for as long as the salt stands.
 *
 * @throws {import('./seductivePower').UnknownRarityError} when the copy's
 * species carries a rarity the ladder does not define. Deliberately loud — the
 * migration raises on the same condition rather than writing a guessed value
 * into a permanent column.
 */
export function deterministicBaseSeductivePower(
  waifuId: number,
  rarity: string,
  ranges: SeductivePowerRanges = DEFAULT_SP_RANGES_BY_RARITY,
  salt: string = SP_BACKFILL_SALT,
): number {
  const { min, max } = rangeForRarity(rarity, ranges);
  const span = max - min + 1;
  return min + (backfillHash(waifuId, salt) % span);
}
