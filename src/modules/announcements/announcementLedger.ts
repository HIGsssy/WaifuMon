/**
 * Announcement ledger — which Discord message announced which event.
 *
 * Posters call {@link AnnouncementLedger.record} **after** Discord confirms a
 * send, with the message id `send()` returned. A read-only integration later
 * asks about a message it saw, and this is how that message resolves to an
 * authoritative player and event without anybody parsing a display name or an
 * embed title.
 *
 * Three rules:
 *   - **Best-effort.** `record` never rejects. A failed insert is logged and
 *     costs one message its context; it can never fail the capture or level-up
 *     the message announced, which has already committed by the time anyone
 *     posts about it.
 *   - **Only what was announced.** `payload` holds the facts the message itself
 *     made public. Nothing self-only (XP, SP, affection, release state) ever
 *     goes in.
 *   - **Short-lived.** Rows older than {@link LEDGER_RETENTION_DAYS} are pruned
 *     in bounded batches; an integration reacts within seconds.
 *
 * Boss messages are deliberately absent: `boss_encounters` already stores
 * their message ids.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  announcementLedger,
  type AnnouncementLedgerKind,
  type AnnouncementLedgerRow,
  type Rarity,
} from '../../db/schema';
import type { GameEvent } from '../events/gameEvents';
import type { Logger } from '../../shared/logger';

export const LEDGER_RETENTION_DAYS = 30;

/** How a rare capture came about. `hunt` covers every wild encounter capture. */
export type CaptureSource = 'hunt' | 'delve_recruit';

/** The immutable `announced` block per kind. */
export interface AnnouncedRareCapture {
  species: { slug: string; name: string; rarity: Rarity };
  source: CaptureSource;
  /** An *active* copy of this species already existed at capture time. */
  isDuplicate: boolean;
  /** The copy minted, when one was. */
  waifuId: number | null;
}

export interface AnnouncedAppearanceUnlock {
  waifuId: number;
  /** Nickname when set, species name otherwise — as the message showed it. */
  waifuName: string;
  speciesSlug: string;
  appearanceId: string;
  appearanceName: string;
  unlockLabel: string;
  cosmeticRarity: string;
}

export interface AnnouncedLevelUp {
  level: number;
}

export interface AnnouncedCollectionCompleted {
  distinctSpecies: number;
  totalSpecies: number;
}

export type LedgerEntry =
  | { kind: 'rare_capture'; payload: AnnouncedRareCapture }
  | { kind: 'appearance_unlock'; payload: AnnouncedAppearanceUnlock }
  | { kind: 'level_up'; payload: AnnouncedLevelUp }
  | { kind: 'collection_completed'; payload: AnnouncedCollectionCompleted };

export type AnnouncementRecord = LedgerEntry & {
  messageId: string;
  guildDbId: number;
  channelId: string;
  eventId: string;
  playerId: number | null;
  occurredAt: Date;
};

/**
 * The ledger entry for a feed event that was just posted, or null for the
 * kinds v1 does not record (item finds, care, gifts, expeditions, captures
 * below the rare-embed threshold…). Unrecorded is a normal 404 to the reader.
 */
export function ledgerEntryForEvent(event: GameEvent): LedgerEntry | null {
  switch (event.kind) {
    case 'PLAYER_LEVEL_UP':
      return { kind: 'level_up', payload: { level: event.payload.level } };
    case 'COLLECTION_COMPLETED':
      return {
        kind: 'collection_completed',
        payload: {
          distinctSpecies: event.payload.distinctSpecies,
          totalSpecies: event.payload.totalSpecies,
        },
      };
    case 'WAIFU_APPEARANCE_UNLOCKED':
      return {
        kind: 'appearance_unlock',
        payload: {
          waifuId: event.payload.waifuId,
          waifuName: event.payload.waifuName,
          speciesSlug: event.payload.speciesSlug,
          appearanceId: event.payload.appearanceId,
          appearanceName: event.payload.appearanceName,
          unlockLabel: event.payload.unlockLabel,
          cosmeticRarity: event.payload.cosmeticRarity,
        },
      };
    default:
      return null;
  }
}

export interface AnnouncementLedger {
  /** Never rejects. Idempotent on `messageId`. */
  record(entry: AnnouncementRecord): Promise<void>;
  /** Records a feed event's message when its kind is recorded. Never rejects. */
  recordEvent(event: GameEvent, message: { id: string; channelId: string }): Promise<void>;
  findByMessageId(messageId: string): Promise<AnnouncementLedgerRow | null>;
  /**
   * Deletes rows created before `cutoff`, at most `batchSize × maxBatches`
   * per call so one pass can never hold the table for long. Returns the count.
   */
  prune(cutoff: Date, options?: { batchSize?: number; maxBatches?: number }): Promise<number>;
}

export interface AnnouncementLedgerDeps {
  db: Db;
  logger: Logger;
}

export function createAnnouncementLedger(deps: AnnouncementLedgerDeps): AnnouncementLedger {
  const { db, logger } = deps;

  async function record(entry: AnnouncementRecord): Promise<void> {
    try {
      await db
        .insert(announcementLedger)
        .values({
          messageId: entry.messageId,
          guildId: entry.guildDbId,
          channelId: entry.channelId,
          kind: entry.kind as AnnouncementLedgerKind,
          eventId: entry.eventId,
          playerId: entry.playerId,
          payload: entry.payload as unknown as Record<string, unknown>,
          occurredAt: entry.occurredAt,
        })
        .onConflictDoNothing({ target: announcementLedger.messageId });
    } catch (err) {
      logger.warn(
        { err, tag: 'announcement-ledger/record-failed', kind: entry.kind, messageId: entry.messageId },
        'announcement ledger insert failed; this message will have no commentary context',
      );
    }
  }

  return {
    record,

    async recordEvent(event, message) {
      const entry = ledgerEntryForEvent(event);
      if (!entry) return;
      await record({
        ...entry,
        messageId: message.id,
        channelId: message.channelId,
        guildDbId: event.guildDbId,
        eventId: event.eventId,
        playerId: event.playerId,
        occurredAt: event.occurredAt,
      });
    },

    async findByMessageId(messageId) {
      const [row] = await db
        .select()
        .from(announcementLedger)
        .where(eq(announcementLedger.messageId, messageId))
        .limit(1);
      return row ?? null;
    },

    async prune(cutoff, options = {}) {
      const batchSize = options.batchSize ?? 1000;
      const maxBatches = options.maxBatches ?? 10;
      let total = 0;
      for (let i = 0; i < maxBatches; i += 1) {
        const doomed = db
          .select({ messageId: announcementLedger.messageId })
          .from(announcementLedger)
          .where(lt(announcementLedger.createdAt, cutoff))
          .limit(batchSize);
        const deleted = await db
          .delete(announcementLedger)
          .where(inArray(announcementLedger.messageId, doomed))
          .returning({ messageId: announcementLedger.messageId });
        total += deleted.length;
        if (deleted.length < batchSize) break;
      }
      return total;
    },
  };
}

/** A fresh event id for announcements that are not minted from a `GameEvent`. */
export function newAnnouncementEventId(): string {
  return randomUUID();
}

/**
 * Hourly pruning. The first pass runs shortly after start so a restart after
 * a long outage catches up; a failed pass is logged and the next one retries.
 */
export function startLedgerRetention(
  ledger: AnnouncementLedger,
  logger: Logger,
  options: { intervalMs?: number; retentionDays?: number; now?: () => Date } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 60 * 60_000;
  const days = options.retentionDays ?? LEDGER_RETENTION_DAYS;
  const now = options.now ?? (() => new Date());
  const run = async (): Promise<void> => {
    try {
      const cutoff = new Date(now().getTime() - days * 86_400_000);
      const removed = await ledger.prune(cutoff);
      if (removed > 0) logger.info({ tag: 'announcement-ledger/pruned', removed }, 'pruned announcement ledger');
    } catch (err) {
      logger.warn({ err, tag: 'announcement-ledger/prune-failed' }, 'announcement ledger prune failed');
    }
  };
  const first = setTimeout(() => void run(), 60_000);
  const timer = setInterval(() => void run(), intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
