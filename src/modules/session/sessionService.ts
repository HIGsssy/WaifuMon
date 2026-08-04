/**
 * SessionService — per-(player, channel) bookkeeping.
 *
 * One `waifumon_sessions` row per (player, channel). Since the UX redesign it
 * carries exactly two things:
 *   - `profile_message_id`: the player's Care Mode Trainer Profile message,
 *     the only message the bot owns on their behalf (Discord plumbing lives
 *     in `src/discord/trainerProfile.ts`);
 *   - a per-day summary tally rendered on the menu embed, which auto-resets
 *     when the calendar date rolls over in the configured timezone.
 *
 * The public session board this table was originally built for is gone; its
 * leftover columns were dropped in migration 0013.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  playerDailySplashViews,
  waifumonSessions,
  type WaifumonSessionRow,
} from '../../db/schema';
import { claimDateInTimezone } from '../../shared/time';

/**
 * Notable-find record kept in the summary — small enough that even a whole
 * day of finds fits in a single Discord embed field.
 */
export interface NotableFind {
  kind: 'item' | 'waifubux' | 'essence';
  label: string; // pre-rendered, e.g. "Velvet Charm ×1" or "+50 WB"
}

/** Serialized daily-tally shape stored in `summary_json`. */
export interface SessionSummary {
  hunts: number;
  caught: number;
  escaped: number;
  srPlus: number;
  levelUps: number;
  caughtNames: string[]; // capped
  escapedNames: string[]; // capped
  notableFinds: NotableFind[]; // capped
  buddyXp: number;
  buddyAffection: number;
}

const NAME_CAP = 6;
const NOTABLE_CAP = 5;

function emptySummary(): SessionSummary {
  return {
    hunts: 0,
    caught: 0,
    escaped: 0,
    srPlus: 0,
    levelUps: 0,
    caughtNames: [],
    escapedNames: [],
    notableFinds: [],
    buddyXp: 0,
    buddyAffection: 0,
  };
}

/** Coerce whatever's on disk into a SessionSummary with sane defaults. */
function parseSummary(raw: unknown): SessionSummary {
  const empty = emptySummary();
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const strArr = (v: unknown, cap: number): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-cap) : [];
  const notable = (v: unknown, cap: number): NotableFind[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
          .map((x) => ({
            kind: (x.kind === 'waifubux' || x.kind === 'essence' ? x.kind : 'item') as
              | 'item'
              | 'waifubux'
              | 'essence',
            label: typeof x.label === 'string' ? x.label : '',
          }))
          .filter((x) => x.label.length > 0)
          .slice(-cap)
      : [];
  return {
    hunts: num(r.hunts),
    caught: num(r.caught),
    escaped: num(r.escaped),
    srPlus: num(r.srPlus),
    levelUps: num(r.levelUps),
    caughtNames: strArr(r.caughtNames, NAME_CAP),
    escapedNames: strArr(r.escapedNames, NAME_CAP),
    notableFinds: notable(r.notableFinds, NOTABLE_CAP),
    buddyXp: num(r.buddyXp),
    buddyAffection: num(r.buddyAffection),
  };
}

export type SessionEvent =
  | { type: 'hunt' }
  | { type: 'daily' }
  | { type: 'capture'; speciesName: string; rarity: string }
  | { type: 'escape'; speciesName: string }
  | { type: 'levelup'; toLevel: number }
  | { type: 'find'; find: NotableFind }
  | { type: 'buddy'; xp: number; affection: number };

const RARITY_SR_PLUS = new Set(['SR', 'SSR', 'UR', 'LR', 'EX']);

function applyEvent(summary: SessionSummary, event: SessionEvent): SessionSummary {
  const next = { ...summary };
  switch (event.type) {
    case 'hunt':
      next.hunts += 1;
      break;
    case 'daily':
      break;
    case 'capture':
      next.caught += 1;
      next.caughtNames = [...summary.caughtNames, event.speciesName].slice(-NAME_CAP);
      if (RARITY_SR_PLUS.has(event.rarity)) next.srPlus += 1;
      break;
    case 'escape':
      next.escaped += 1;
      next.escapedNames = [...summary.escapedNames, event.speciesName].slice(-NAME_CAP);
      break;
    case 'levelup':
      next.levelUps += 1;
      break;
    case 'find':
      next.notableFinds = [...summary.notableFinds, event.find].slice(-NOTABLE_CAP);
      break;
    case 'buddy':
      next.buddyXp += event.xp;
      next.buddyAffection += event.affection;
      break;
  }
  return next;
}

export interface SessionService {
  /**
   * Ensure a session row exists for (player, channel). Never creates
   * duplicates thanks to the (player_id, channel_id) unique index — safe under
   * concurrent `/waifumon` invocations.
   */
  ensureSession(
    guildDbId: number,
    playerId: number,
    channelId: string,
  ): Promise<WaifumonSessionRow>;

  /** Look up the session row for (player, channel) without mutating anything. */
  findByPlayerAndChannel(
    playerId: number,
    channelId: string,
  ): Promise<WaifumonSessionRow | null>;

  /** Read a specific session row by id (used by paint after ensure). */
  getById(sessionId: number): Promise<WaifumonSessionRow | null>;

  /**
   * Record (or clear) the player's Care Mode Trainer Profile message for this
   * channel. Creates the session row on first touch so entering Care Mode
   * before any other interaction still works. `null` clears the pointer, which
   * is what leaving Care Mode does.
   */
  setProfileMessageId(
    guildDbId: number,
    playerId: number,
    channelId: string,
    messageId: string | null,
  ): Promise<void>;

  /** The player's stored Trainer Profile message id for this channel, if any. */
  getProfileMessageId(playerId: number, channelId: string): Promise<string | null>;

  /**
   * Apply an in-day event to the summary tally, resetting the tally when the
   * summary_date rolls over in the configured timezone. Returns the updated
   * summary for immediate rendering.
   */
  recordEvent(sessionId: number, event: SessionEvent): Promise<SessionSummary>;

  /** Parse-only accessor for rendering the summary (does not update the row). */
  readSummary(session: WaifumonSessionRow): SessionSummary;

  /** Whether the row's summary_date matches today in the configured timezone. */
  isSummaryFresh(session: WaifumonSessionRow, now?: Date): boolean;

  /**
   * Returns true if the player already has a splash-view row for today
   * (configured timezone). Used to decide whether `/waifumon` shows the
   * daily launch splash or goes straight to the main menu.
   */
  hasSeenSplashToday(playerId: number, now?: Date): Promise<boolean>;

  /**
   * Idempotently records that the player was shown today's splash. Returns
   * true when a new row was inserted, false when today's row already
   * existed. Only called *after* the splash was rendered successfully so a
   * render failure never leaves a stale "seen" marker behind.
   */
  markSplashShown(playerId: number, now?: Date): Promise<boolean>;
}

export interface SessionServiceDeps {
  db: Db;
  timezone: string;
  now?: () => Date;
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const now = () => (deps.now ? deps.now() : new Date());
  const today = () => claimDateInTimezone(now(), deps.timezone);

  const readSummary: SessionService['readSummary'] = (session) =>
    parseSummary(session.summaryJson);

  const isSummaryFresh: SessionService['isSummaryFresh'] = (session, at) => {
    if (!session.summaryDate) return false;
    const day = claimDateInTimezone(at ?? now(), deps.timezone);
    // `date` columns come back as a string ('YYYY-MM-DD') from node-postgres.
    const raw = session.summaryDate as unknown;
    const stored =
      raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10);
    return stored === day;
  };

  const service: SessionService = {
    async ensureSession(guildDbId, playerId, channelId) {
      const at = now();
      // Upsert on the (player, channel) unique index.
      const [row] = await deps.db
        .insert(waifumonSessions)
        .values({
          guildId: guildDbId,
          playerId,
          channelId,
          summaryJson: emptySummary() as unknown as Record<string, unknown>,
          summaryDate: today(),
          createdAt: at,
          updatedAt: at,
          lastActivityAt: at,
        })
        .onConflictDoUpdate({
          target: [waifumonSessions.playerId, waifumonSessions.channelId],
          set: { lastActivityAt: at, updatedAt: at },
        })
        .returning();
      if (!row) {
        // onConflictDoUpdate must return the row; this is a defensive fallback.
        const [existing] = await deps.db
          .select()
          .from(waifumonSessions)
          .where(
            and(
              eq(waifumonSessions.playerId, playerId),
              eq(waifumonSessions.channelId, channelId),
            ),
          )
          .limit(1);
        return existing!;
      }
      return row;
    },

    async findByPlayerAndChannel(playerId, channelId) {
      const [row] = await deps.db
        .select()
        .from(waifumonSessions)
        .where(
          and(
            eq(waifumonSessions.playerId, playerId),
            eq(waifumonSessions.channelId, channelId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getById(sessionId) {
      const [row] = await deps.db
        .select()
        .from(waifumonSessions)
        .where(eq(waifumonSessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },

    async setProfileMessageId(guildDbId, playerId, channelId, messageId) {
      const session = await service.ensureSession(guildDbId, playerId, channelId);
      const at = now();
      await deps.db
        .update(waifumonSessions)
        .set({ profileMessageId: messageId, updatedAt: at, lastActivityAt: at })
        .where(eq(waifumonSessions.id, session.id));
    },

    async getProfileMessageId(playerId, channelId) {
      const row = await service.findByPlayerAndChannel(playerId, channelId);
      return row?.profileMessageId ?? null;
    },

    async recordEvent(sessionId, event) {
      // Load current row, roll the summary forward (resetting if the day
      // changed), and write it back. Single-writer per player + Discord's
      // interaction serialization make this safe without an explicit lock.
      const [row] = await deps.db
        .select()
        .from(waifumonSessions)
        .where(eq(waifumonSessions.id, sessionId))
        .limit(1);
      if (!row) return emptySummary();
      const day = today();
      const current = isSummaryFresh(row) ? parseSummary(row.summaryJson) : emptySummary();
      const nextSummary = applyEvent(current, event);
      const at = now();
      await deps.db
        .update(waifumonSessions)
        .set({
          summaryJson: nextSummary as unknown as Record<string, unknown>,
          summaryDate: day,
          updatedAt: at,
          lastActivityAt: at,
        })
        .where(eq(waifumonSessions.id, sessionId));
      return nextSummary;
    },

    readSummary,
    isSummaryFresh,

    async hasSeenSplashToday(playerId, at) {
      const day = claimDateInTimezone(at ?? now(), deps.timezone);
      const [row] = await deps.db
        .select({ id: playerDailySplashViews.id })
        .from(playerDailySplashViews)
        .where(
          and(
            eq(playerDailySplashViews.playerId, playerId),
            eq(playerDailySplashViews.splashDate, day),
          ),
        )
        .limit(1);
      return !!row;
    },

    async markSplashShown(playerId, at) {
      const day = claimDateInTimezone(at ?? now(), deps.timezone);
      // Idempotent — the unique (player_id, splash_date) index makes double
      // calls on the same guild-day a no-op. `returning` on a conflict-do-
      // nothing insert returns an empty array; that's how we know whether we
      // were the first writer today.
      const inserted = await deps.db
        .insert(playerDailySplashViews)
        .values({ playerId, splashDate: day, shownAt: at ?? now() })
        .onConflictDoNothing({
          target: [playerDailySplashViews.playerId, playerDailySplashViews.splashDate],
        })
        .returning({ id: playerDailySplashViews.id });
      return inserted.length > 0;
    },
  };

  return service;
}

/**
 * Renders the "Today" summary line(s) shown on the main-menu embed.
 * Concise by design so we don't blow embed character limits.
 */
export function renderSummaryLines(summary: SessionSummary): string[] {
  const lines: string[] = [];
  const anyActivity =
    summary.hunts > 0 ||
    summary.caught > 0 ||
    summary.escaped > 0 ||
    summary.levelUps > 0 ||
    summary.notableFinds.length > 0 ||
    summary.buddyXp > 0;
  if (!anyActivity) {
    lines.push('_No activity today yet — try a hunt!_');
    return lines;
  }
  const bits: string[] = [];
  bits.push(`${summary.hunts} hunt${summary.hunts === 1 ? '' : 's'}`);
  if (summary.caught > 0) bits.push(`${summary.caught} caught`);
  if (summary.escaped > 0) bits.push(`${summary.escaped} escaped`);
  if (summary.srPlus > 0) bits.push(`${summary.srPlus} SR+`);
  if (summary.levelUps > 0) bits.push(`⬆️ ${summary.levelUps}`);
  lines.push(bits.join(' · '));
  if (summary.caughtNames.length > 0) {
    lines.push(`💖 Caught: ${summary.caughtNames.join(', ')}`);
  }
  if (summary.escapedNames.length > 0) {
    lines.push(`💨 Escaped: ${summary.escapedNames.join(', ')}`);
  }
  if (summary.notableFinds.length > 0) {
    lines.push(`✨ Finds: ${summary.notableFinds.map((f) => f.label).join(', ')}`);
  }
  if (summary.buddyXp > 0 || summary.buddyAffection > 0) {
    lines.push(`★ Buddy: +${summary.buddyXp} XP · +${summary.buddyAffection} affection`);
  }
  return lines;
}
