/**
 * Which missions a player sees, and when the list changes — pure.
 *
 * The board is **derived, never stored**. There is no rotation table, no cron
 * job and no scheduled write: the visible set is a deterministic function of
 * `(playerId, regionId, which rotation window we are in)`. That is restart-
 * proof by construction rather than by recovery, and it means a board cannot
 * drift out of sync with a clock nobody is watching.
 *
 * The draw is **stratified by duration**: one slot per configured tier, filled
 * by ranking that tier's missions alone. A player looking for an overnight
 * mission finds one every window rather than 62% of them, which is what the
 * duration ladder was for. The ranking itself is unchanged.
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
import { ConfigError, IncompleteExpeditionPoolError } from '../../shared/errors';

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
 * Rank a set of missions for one player, in one window: best first.
 *
 * The whole of the original selection algorithm, factored out unchanged. The
 * key is a hash of the mission *and* the player *and* the window, so every
 * mission has a genuinely independent chance of ranking highly for any given
 * player, and a player's ranking is stable for as long as the window is.
 *
 * Ties break on the mission key so the order is **total**: two missions whose
 * hashes collide still rank deterministically rather than depending on the
 * order the content files happened to be read in.
 */
function rankForWindow(
  missions: readonly RegionalExpedition[],
  playerId: number,
  regionId: string,
  window: number,
  salt: string,
): RegionalExpedition[] {
  return [...missions]
    .map((expedition) => ({
      expedition,
      key: boardHash(playerId, regionId, window, expedition.key, salt),
    }))
    .sort((a, b) => a.key - b.key || (a.expedition.key < b.expedition.key ? -1 : 1))
    .map((entry) => entry.expedition);
}

/**
 * How many board slots each tier gets, shortest tier first.
 *
 * With the shipped `boardSize: 4` and the shipped four-tier ladder this is
 * simply one each, which is the case the feature is designed around. The
 * remainder is spread over the *shortest* tiers because a surplus slot is
 * worth most where a player cycles fastest — an extra 1h option gets used
 * several times a day, an extra overnight one at most once.
 */
function slotsPerTier(boardSize: number, tierCount: number): number[] {
  const base = Math.floor(boardSize / tierCount);
  const remainder = boardSize % tierCount;
  return Array.from({ length: tierCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * The missions visible to one player, in one region, in one rotation window.
 *
 * **Stratified by duration.** The board draws independently *within each
 * configured tier* rather than from the region's pool as a whole, and returns
 * the tiers shortest-first. That is the one behavioural change from the
 * original uniform draw, and it exists because the uniform draw treated the
 * duration ladder as decoration: with a pool of eleven and a board of four, a
 * player had a ~38% chance of opening the board before bed and finding no
 * overnight mission at all. A tier the content author wrote is a promise that
 * the commitment length is available, not that it might be.
 *
 * Everything else is deliberately untouched. Selection within a tier is the
 * same hash-sort over the same `(playerId, regionId, window, key, salt)` seed,
 * so rotation timing, per-player variation, restart-proofness and the
 * "reopening is not a reroll" property all hold exactly as before — the sort
 * is simply applied to four small groups instead of one large one.
 *
 * A region with **no** enabled missions returns an empty board, which is not
 * an error: that is what every unauthored region looks like. A region with
 * *some* missions but a gap in the ladder throws
 * {@link IncompleteExpeditionPoolError} rather than returning a short board —
 * see that error for why silence is the worse failure.
 */
export function buildBoard(input: {
  playerId: number;
  regionId: string;
  expeditions: readonly RegionalExpedition[];
  /** Every configured tier length, in minutes. From `expeditions.durations`. */
  durations: readonly number[];
  boardSize: number;
  rotationHours: number;
  now: Date;
  salt?: string;
}): RegionalExpedition[] {
  const { playerId, regionId, expeditions, durations, boardSize, rotationHours, now } = input;
  const salt = input.salt ?? EXPEDITION_BOARD_SALT;
  const window = rotationWindow(now, rotationHours);

  // Ascending, de-duplicated: the ladder is a set of lengths, and the board is
  // laid out shortest first. Sorting here rather than trusting the caller also
  // means `tables.json` may list the tiers in any order.
  const tiers = [...new Set(durations)].sort((a, b) => a - b);
  if (tiers.length === 0) {
    throw new ConfigError(
      'expeditions.durations is empty: a board cannot be stratified by a ladder with no tiers.',
    );
  }
  if (boardSize < tiers.length) {
    // Unreachable through content — `ExpeditionsConfigSchema` refuses it at
    // load — but asserted here so the guarantee is enforced by the function
    // that makes it rather than only by the file that configures it.
    throw new ConfigError(
      `expeditions.boardSize (${boardSize}) is below the number of duration tiers ` +
        `(${tiers.length}). The board shows one mission per tier, so a smaller board ` +
        'would silently drop the longest commitments.',
    );
  }

  // A disabled mission is off the board entirely rather than shown greyed out:
  // the board is a list of things you can do, and content switches a mission
  // off precisely so nobody has to look at it.
  const candidates = expeditions.filter((e) => e.enabled && e.region === regionId);
  if (candidates.length === 0) return [];

  const byTier = tiers.map((minutes) => candidates.filter((e) => e.durationMinutes === minutes));

  const missing = tiers.filter((_, i) => byTier[i]!.length === 0);
  if (missing.length > 0) throw new IncompleteExpeditionPoolError(regionId, missing);

  const slots = slotsPerTier(boardSize, tiers.length);
  return byTier.flatMap((missionsInTier, i) =>
    rankForWindow(missionsInTier, playerId, regionId, window, salt).slice(0, slots[i]!),
  );
}

/**
 * The order a board is *shown* in: shortest mission first, key as the
 * tie-break. Presentation only.
 *
 * Deliberately a separate step applied after {@link buildBoard}. Selection
 * decides *which* missions a window shows; this decides how they read. The
 * two stayed split when selection became duration-stratified: `buildBoard`
 * now happens to emit tiers shortest-first already, so this is usually a
 * no-op re-sort, but presentation must not become load-bearing. Re-sorting a
 * selected set cannot add or drop a mission, so rotation stays exactly as
 * deterministic as it was, and a future selection order — or a board with two
 * missions on one tier — still renders 1h → 3h → 6h → 18h.
 */
export function orderBoardForDisplay(
  expeditions: readonly RegionalExpedition[],
): RegionalExpedition[] {
  return [...expeditions].sort(
    (a, b) =>
      a.durationMinutes - b.durationMinutes || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
