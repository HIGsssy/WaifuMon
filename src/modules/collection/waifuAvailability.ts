/**
 * Whether an owned WaifuMon is free to be used for something, and if not, why.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * Before expeditions there were two reasons a copy might be off-limits, and
 * both were checked inline at each of the three places that care: release
 * reads `is_favorite` and the buddy pointer, buddy assignment reads nothing,
 * Care Mode reads nothing. Adding "she is away on an expedition" by the same
 * method would mean four features each importing the expedition module and
 * each writing their own `player_expeditions` query — and a fifth reason later
 * would mean touching all of them again.
 *
 * So the *reasons* are named here, centrally, and the features ask a question
 * instead of running a query. Adding a future state ("in the infirmary",
 * "loaned to a friend") means one new provider and one new reason string;
 * nothing in collection, care or release changes.
 *
 * ── Why this is not a boolean ──────────────────────────────────────────────
 *
 * There is no single "is she available" answer, because the operations
 * disagree about what disqualifies a copy:
 *
 *   - Release refuses a favourite, the buddy, *and* a deployed copy.
 *   - Buddy assignment refuses a deployed copy but obviously not the buddy,
 *     and has no opinion at all about favourites.
 *   - Deployment refuses the buddy, the Care target and an already-deployed
 *     copy — but a favourite is exactly who you would want to send.
 *
 * A boolean would force one of those to be wrong. So this returns the full set
 * of reasons that currently apply and each caller decides which of them it
 * cares about, which keeps the *policy* next to the operation that owns it and
 * only the *facts* here.
 *
 * ── Why providers are injected ─────────────────────────────────────────────
 *
 * The expedition service depends on the collection service (it awards XP to
 * the deployed copy through `awardWaifuXp`). If collection imported the
 * expedition service to ask about availability, that would be a cycle. So
 * expeditions *registers* a provider at composition time in `index.ts`,
 * exactly as `resolveRace` is injected rather than imported, and collection
 * depends only on this module's interface.
 *
 * Every consumer takes the checker as an **optional** dependency defaulting to
 * "nothing is unavailable", matching the precedent set by Buddy Bonuses: an
 * older fixture that wires a service by hand keeps working and simply sees a
 * world with no expeditions in it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { players, playerWaifus } from '../../db/schema';

/**
 * Why a copy is not free right now.
 *
 * Deliberately open to extension and closed to guessing: a new state adds a
 * member here and a provider that reports it, and every existing caller keeps
 * compiling because callers filter for the reasons they care about rather than
 * switching exhaustively over all of them.
 */
export const WAIFU_UNAVAILABILITY_REASONS = [
  /** Soft-released. She is gone; this is the terminal one. */
  'released',
  /** Marked ★ by the player. Only release cares. */
  'favorite',
  /** The active Buddy. */
  'buddy',
  /** The current Care Mode target. */
  'care_target',
  /** Deployed on an expedition that has not finished. */
  'on_expedition',
] as const;

export type WaifuUnavailabilityReason = (typeof WAIFU_UNAVAILABILITY_REASONS)[number];

/**
 * Player-facing wording for each reason.
 *
 * Here rather than in the Discord layer because the Platform API and any
 * future client need the same words, and because a reason whose explanation
 * lives somewhere else is a reason that gets rendered as a raw enum by the
 * second consumer.
 */
export const WAIFU_UNAVAILABILITY_LABELS: Readonly<
  Record<WaifuUnavailabilityReason, string>
> = {
  released: 'She has already been released.',
  favorite: 'She is a ★ favourite.',
  buddy: 'She is your active Buddy.',
  care_target: 'She is the focus of Care Mode.',
  on_expedition: 'She is away on an expedition.',
};

/** Short badge text for list and inspect screens — "Lv.24 Lilith · Away". */
export const WAIFU_UNAVAILABILITY_BADGES: Readonly<
  Record<WaifuUnavailabilityReason, string>
> = {
  released: 'Released',
  favorite: 'Favourite',
  buddy: 'Buddy',
  care_target: 'In Care',
  on_expedition: 'On Expedition',
};

/**
 * One source of unavailability.
 *
 * Runs inside the caller's transaction so its answer is consistent with the
 * row the caller has already locked — a provider that opened its own
 * connection could report "free" about a copy the caller is mid-way through
 * deploying.
 */
export type WaifuAvailabilityProvider = (
  tx: DbOrTx,
  playerId: number,
  waifuId: number,
) => Promise<WaifuUnavailabilityReason[]>;

/**
 * Asks every registered provider and returns the union of what they report.
 *
 * Deduplicated and returned in the canonical order of
 * {@link WAIFU_UNAVAILABILITY_REASONS} rather than in provider order, so an
 * error message reads the same way regardless of how the container happened to
 * be wired.
 */
export interface WaifuAvailabilityService {
  reasonsFor(
    tx: DbOrTx,
    playerId: number,
    waifuId: number,
  ): Promise<WaifuUnavailabilityReason[]>;
  /**
   * The same question for a whole list, in one pass per provider.
   *
   * Exists so a collection screen can badge fifty copies without fifty
   * round-trips — the N+1 that a per-copy check would otherwise guarantee the
   * moment the inspect UI lands in Phase 4.
   */
  reasonsForMany(
    tx: DbOrTx,
    playerId: number,
    waifuIds: readonly number[],
  ): Promise<Map<number, WaifuUnavailabilityReason[]>>;
}

export interface WaifuAvailabilityDeps {
  providers?: readonly WaifuAvailabilityProvider[];
  /**
   * Optional bulk fast-path per provider. A provider that can answer for many
   * copies in one query supplies this; one that cannot is simply called once
   * per copy, which is correct if slower.
   */
  bulkProviders?: readonly ((
    tx: DbOrTx,
    playerId: number,
    waifuIds: readonly number[],
  ) => Promise<Map<number, WaifuUnavailabilityReason[]>>)[];
}

const ORDER = new Map(WAIFU_UNAVAILABILITY_REASONS.map((r, i) => [r, i]));

function canonical(reasons: Iterable<WaifuUnavailabilityReason>): WaifuUnavailabilityReason[] {
  return [...new Set(reasons)].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

export function createWaifuAvailabilityService(
  deps: WaifuAvailabilityDeps = {},
): WaifuAvailabilityService {
  const providers = deps.providers ?? [];
  const bulkProviders = deps.bulkProviders ?? [];

  return {
    async reasonsFor(tx, playerId, waifuId) {
      const found: WaifuUnavailabilityReason[] = [];
      for (const provider of providers) {
        found.push(...(await provider(tx, playerId, waifuId)));
      }
      for (const bulk of bulkProviders) {
        const map = await bulk(tx, playerId, [waifuId]);
        found.push(...(map.get(waifuId) ?? []));
      }
      return canonical(found);
    },

    async reasonsForMany(tx, playerId, waifuIds) {
      const result = new Map<number, WaifuUnavailabilityReason[]>();
      if (waifuIds.length === 0) return result;
      const accumulator = new Map<number, WaifuUnavailabilityReason[]>();
      const push = (id: number, reasons: readonly WaifuUnavailabilityReason[]) => {
        if (reasons.length === 0) return;
        const existing = accumulator.get(id) ?? [];
        existing.push(...reasons);
        accumulator.set(id, existing);
      };

      for (const bulk of bulkProviders) {
        const map = await bulk(tx, playerId, waifuIds);
        for (const [id, reasons] of map) push(id, reasons);
      }
      // Per-copy providers are the slow path, and only for providers with no
      // bulk form. Kept rather than forbidden so a new reason can ship as a
      // simple provider first and gain a bulk query when it needs one.
      for (const provider of providers) {
        for (const id of waifuIds) push(id, await provider(tx, playerId, id));
      }

      for (const id of waifuIds) {
        result.set(id, canonical(accumulator.get(id) ?? []));
      }
      return result;
    },
  };
}

/** The no-op service: every copy is free. The default for un-wired callers. */
export const ALWAYS_AVAILABLE: WaifuAvailabilityService = createWaifuAvailabilityService();

/**
 * The reasons that live in core tables: favourite, Buddy, Care target.
 *
 * Here rather than in a module of their own because all three are columns on
 * `players` / `player_waifus` that this repository has always owned — there is
 * no separate "buddy service" holding the fact, and inventing one to satisfy
 * the provider shape would be ceremony. Expeditions are the case that genuinely
 * needs injection, because that module depends on collection and cannot be
 * depended on by it.
 *
 * One query per call, covering every copy asked about, so a collection screen
 * badging a page of fifty costs two round-trips rather than a hundred.
 */
export function createCoreAvailabilityProvider(): (
  tx: DbOrTx,
  playerId: number,
  waifuIds: readonly number[],
) => Promise<Map<number, WaifuUnavailabilityReason[]>> {
  return async (tx, playerId, waifuIds) => {
    const result = new Map<number, WaifuUnavailabilityReason[]>();
    if (waifuIds.length === 0) return result;

    const push = (id: number, reason: WaifuUnavailabilityReason) => {
      const existing = result.get(id) ?? [];
      existing.push(reason);
      result.set(id, existing);
    };

    const [player] = await tx
      .select({
        buddyWaifuId: players.buddyWaifuId,
        careModeWaifuId: players.careModeWaifuId,
      })
      .from(players)
      .where(eq(players.id, playerId));
    if (player?.buddyWaifuId != null && waifuIds.includes(player.buddyWaifuId)) {
      push(player.buddyWaifuId, 'buddy');
    }
    if (player?.careModeWaifuId != null && waifuIds.includes(player.careModeWaifuId)) {
      push(player.careModeWaifuId, 'care_target');
    }

    const rows = await tx
      .select({
        id: playerWaifus.id,
        isFavorite: playerWaifus.isFavorite,
        releasedAt: playerWaifus.releasedAt,
      })
      .from(playerWaifus)
      .where(
        and(eq(playerWaifus.playerId, playerId), inArray(playerWaifus.id, [...waifuIds])),
      );
    for (const row of rows) {
      if (row.releasedAt != null) push(row.id, 'released');
      if (row.isFavorite) push(row.id, 'favorite');
    }

    return result;
  };
}
