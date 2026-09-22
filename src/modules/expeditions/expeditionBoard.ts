/**
 * Which missions a player sees, and when the list changes — pure.
 *
 * The board is **derived, never stored**. There is no rotation table, no cron
 * job and no scheduled write: the visible set is a deterministic function of
 * `(playerId, regionId, which rotation window we are in)`. That is restart-
 * proof by construction rather than by recovery, and it means a board cannot
 * drift out of sync with a clock nobody is watching.
 *
 * The rotation is **per player**. Two players standing in the same region at
 * the same moment see different boards, which is the fairer default: a shared
 * board makes the good mission a race, and a race is won by whoever happened
 * to be online. It also means one player's board is never evidence about
 * another's, so there is nothing to co-ordinate around.
 *
 * Determinism has a second, quieter benefit. Because the same inputs always
 * produce the same board, a player who opens the screen, closes it and opens
 * it again sees the same missions — no reshuffle, no "wait, where did that
 * one go", and no incentive to reopen the screen hoping for a better draw.
 */
import { createHash } from 'node:crypto';
import type { RegionalExpedition } from '../content/schemas';

/** Versioned salt. Changing it reshuffles every board at once — deliberate. */
export const EXPEDITION_BOARD_SALT = 'waifumon.expedition.board.v1';

const HASH_HEX_DIGITS = 8;

/**
 * Which rotation window `now` falls in, counted from the epoch.
 *
 * An integer, so it is stable for everyone inside the window and changes for
 * everyone at the boundary. Windows are aligned to the epoch rather than to
 * each player's first visit, which is what makes "the board rotates at 00:00
 * and 12:00 UTC" a true statement rather than a per-player accident.
 */
export function rotationWindow(now: Date, rotationHours: number): number {
  const windowMs = rotationHours * 60 * 60 * 1000;
  return Math.floor(now.getTime() / windowMs);
}

/** When the current window ends — what the board footer counts down to. */
export function rotationEndsAt(now: Date, rotationHours: number): Date {
  const windowMs = rotationHours * 60 * 60 * 1000;
  return new Date((rotationWindow(now, rotationHours) + 1) * windowMs);
}

/** A stable 32-bit sort key for one mission on one player's board. */
function boardHash(
  playerId: number,
  regionId: string,
  window: number,
  expeditionKey: string,
  salt: string,
): number {
  const digest = createHash('md5')
    .update(`${playerId}:${regionId}:${window}:${expeditionKey}:${salt}`, 'utf8')
    .digest('hex');
  return Number.parseInt(digest.slice(0, HASH_HEX_DIGITS), 16);
}

/**
 * The missions visible to one player, in one region, in one rotation window.
 *
 * Implemented as a deterministic *sort* followed by a take, rather than as a
 * weighted draw without replacement. The sort cannot pick the same mission
 * twice, needs no bookkeeping, and — because the key is a hash of the mission
 * *and* the player — gives every mission a genuinely independent chance of
 * ranking highly for any given player.
 *
 * Ties break on the key so the result is total: two missions whose hashes
 * collide still order deterministically rather than depending on the order the
 * content files happened to be read in.
 *
 * A region with fewer missions than `boardSize` shows all of them. A region
 * with none shows none, which is an empty board and not an error — that is
 * what every region looks like until Phase 5 authors content.
 */
export function buildBoard(input: {
  playerId: number;
  regionId: string;
  expeditions: readonly RegionalExpedition[];
  boardSize: number;
  rotationHours: number;
  now: Date;
  salt?: string;
}): RegionalExpedition[] {
  const { playerId, regionId, expeditions, boardSize, rotationHours, now } = input;
  const salt = input.salt ?? EXPEDITION_BOARD_SALT;
  const window = rotationWindow(now, rotationHours);

  // A disabled mission is off the board entirely rather than shown greyed out:
  // the board is a list of things you can do, and content switches a mission
  // off precisely so nobody has to look at it.
  const candidates = expeditions.filter((e) => e.enabled && e.region === regionId);

  return [...candidates]
    .map((expedition) => ({
      expedition,
      key: boardHash(playerId, regionId, window, expedition.key, salt),
    }))
    .sort((a, b) => a.key - b.key || (a.expedition.key < b.expedition.key ? -1 : 1))
    .slice(0, boardSize)
    .map((entry) => entry.expedition);
}

/**
 * The order a board is *shown* in: shortest mission first, key as the
 * tie-break. Presentation only.
 *
 * Deliberately a separate step applied after {@link buildBoard}. The hash sort
 * inside `buildBoard` decides *which* missions a window shows, and its order
 * is meaningless to a player (it read as 2h → 12h → 6h in playtesting).
 * Re-sorting the selected set cannot change what was selected, so rotation
 * stays exactly as deterministic as it was.
 */
export function orderBoardForDisplay(
  expeditions: readonly RegionalExpedition[],
): RegionalExpedition[] {
  return [...expeditions].sort(
    (a, b) =>
      a.durationMinutes - b.durationMinutes || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
