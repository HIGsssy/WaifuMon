/**
 * Hunt-session boundaries — pure helpers, no Discord, no DB.
 *
 * A "hunt session" is not a stored entity. It represents *player intent to
 * hunt* and exists only so the Activity Feed can narrate "Whistler ventured
 * into the Whispering Forest…" once, instead of once per hunt.
 *
 * Lifecycle:
 *   opens  — `hunt()` runs while no session is open.
 *   closes — Care Mode starts, an explicit leave-hunting action (future), or
 *            housekeeping sweeps a session that went quiet for longer than
 *            `hunt.sessionIdleMinutes`.
 *
 * "Open" is derived from state we already persist (`players.last_hunt_at`
 * plus the Care Mode flags), so no migration is needed. A process restart
 * mid-session can cost one duplicate `PLAYER_STARTED_HUNT` line, which is
 * cosmetic.
 */

export interface HuntSessionBoundaryInput {
  /** `players.last_hunt_at` as read *before* this hunt stamped it. */
  lastHuntAt: Date | null;
  /** Whether Care Mode was active when this hunt began (it always exits it). */
  careModeActive: boolean;
  now: Date;
  /** Housekeeping window; a hunt after this much silence starts a new session. */
  idleMinutes: number;
}

export interface HuntSessionBoundary {
  /** True when this hunt opened a new session (emit `PLAYER_STARTED_HUNT`). */
  opened: boolean;
  /**
   * Set when a previously-open session was swept as abandoned before this one
   * opened (emit `PLAYER_COMPLETED_HUNT` first).
   */
  closedPreviousReason: 'inactivity' | null;
  /** The moment this hunt resolved — the session's open time when `opened`. */
  at: Date;
  /** `players.last_hunt_at` before this hunt, for fallback location hashing. */
  previousLastHuntAt: Date | null;
}

/**
 * Decide whether this hunt call crosses a session boundary.
 *
 * Care Mode is treated as a hard session terminator: entering it already
 * emitted `PLAYER_COMPLETED_HUNT`, so a hunt that exits Care Mode always
 * opens a fresh session and never re-closes the old one.
 */
export function resolveHuntSessionBoundary(
  input: HuntSessionBoundaryInput,
): HuntSessionBoundary {
  const { lastHuntAt, careModeActive, now, idleMinutes } = input;
  const base = { at: now, previousLastHuntAt: lastHuntAt };

  if (lastHuntAt == null) {
    return { ...base, opened: true, closedPreviousReason: null };
  }
  if (careModeActive) {
    // The session was already closed by `care.start`; this hunt opens a new one.
    return { ...base, opened: true, closedPreviousReason: null };
  }
  const idleMs = Math.max(0, idleMinutes) * 60 * 1000;
  const elapsed = now.getTime() - lastHuntAt.getTime();
  if (elapsed >= idleMs) {
    // Housekeeping: the previous session was abandoned. Close it, open a new one.
    return { ...base, opened: true, closedPreviousReason: 'inactivity' };
  }
  return { ...base, opened: false, closedPreviousReason: null };
}

/**
 * Deterministically pick one location flavor for a session. Same
 * `(playerId, openedAt)` always yields the same venue, so the opening and
 * closing lines reference the same place even if the in-memory tracker was
 * lost to a restart. Returns `null` for an empty pool (callers fall back to
 * plain wording).
 */
export function pickLocationFlavor(
  pool: readonly string[] | undefined,
  playerId: number,
  openedAt: Date,
): string | null {
  if (!pool || pool.length === 0) return null;
  // FNV-1a over "playerId:epochSeconds" — stable across processes, no deps.
  const key = `${playerId}:${Math.floor(openedAt.getTime() / 1000)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return pool[hash % pool.length] ?? null;
}

/** What the tracker remembers about one open session. */
export interface TrackedHuntSession {
  openedAt: Date;
  location: string | null;
}

/**
 * In-memory record of which players currently have an open hunt session and
 * which venue their session is set in.
 *
 * Deliberately *not* persisted: the open/close decision itself is derived
 * from the database (see {@link resolveHuntSessionBoundary}); this tracker
 * only carries the cosmetic location string between the paired open/close
 * narration lines, plus lets Care Mode learn "was a hunt in progress?"
 * without touching the hunt service.
 */
export interface HuntSessionTracker {
  /** Record an opened session and return its location flavor. */
  open(playerId: number, openedAt: Date): string | null;
  /** Forget a session, returning what was tracked (null when nothing was). */
  close(playerId: number): TrackedHuntSession | null;
  isOpen(playerId: number): boolean;
  peek(playerId: number): TrackedHuntSession | null;
  /**
   * Location for a session that opened before this process started — derived
   * from the same deterministic hash so wording stays plausible.
   */
  fallbackLocation(playerId: number, openedAt: Date): string | null;
}

export interface HuntSessionTrackerDeps {
  /** `content.tables.hunt.locationFlavors`. Empty pool disables venue wording. */
  locations: readonly string[];
}

export function createHuntSessionTracker(deps: HuntSessionTrackerDeps): HuntSessionTracker {
  const open = new Map<number, TrackedHuntSession>();
  const { locations } = deps;

  return {
    open(playerId, openedAt) {
      const location = pickLocationFlavor(locations, playerId, openedAt);
      open.set(playerId, { openedAt, location });
      return location;
    },
    close(playerId) {
      const tracked = open.get(playerId) ?? null;
      open.delete(playerId);
      return tracked;
    },
    isOpen(playerId) {
      return open.has(playerId);
    },
    peek(playerId) {
      return open.get(playerId) ?? null;
    },
    fallbackLocation(playerId, openedAt) {
      return pickLocationFlavor(locations, playerId, openedAt);
    },
  };
}
