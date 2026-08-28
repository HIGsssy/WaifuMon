/**
 * The Discord half of an encounter's lifecycle — real Postgres, a fake client.
 *
 * This file exists to pin the shape of the channel's permanent history:
 *
 *   [Boss Encounter]   ← edited in place, live → ended, never replaced
 *   [Boss Results]     ← a SECOND message, posted beneath it
 *   [Boss Encounter]   ← the next one, a new message
 *   [Boss Results]
 *
 * Before this, `publishResults` edited the announcement *into* the results, so
 * a channel could only ever show the latest state of each encounter. The
 * assertions below are mostly about counting: how many messages were sent, how
 * many edits landed on which one, and — the important one — that a retry after
 * a crash publishes nothing a second time.
 */
import { DiscordAPIError } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bossEncounters,
  bossParticipations,
  guildBossState,
  playerWaifus,
  players,
  species,
  type BossEncounterRow,
} from '../../src/db/schema';
import { createBossAnnouncer } from '../../src/discord/bossAnnouncer';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { seededRng } from '../../src/shared/random';
import {
  bootstrapApp,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let prov: Provisioned;
let ctx: AppContext;

const MINUTE = 60_000;
const CHANNEL = 'c-boss';
const BOT_ID = 'bot-1';

// ───────────────────────────── the fake channel ──────────────────────────────

interface FakeMessage {
  id: string;
  authorId: string;
  embeds: { title?: string; footer?: { text: string } }[];
  components: unknown[];
  edits: number;
}

/**
 * A minimal Discord channel that records what actually happened to it.
 *
 * Deliberately keeps every message forever and never reorders: the assertions
 * are about *history*, so a double that quietly dropped or replaced a message
 * would hide the very regression this file guards.
 */
function fakeChannel() {
  const sent: FakeMessage[] = [];
  let nextId = 1;

  const makeMessage = (payload: {
    embeds?: unknown[];
    components?: unknown[];
  }): FakeMessage => {
    const message: FakeMessage = {
      id: `m-${nextId++}`,
      authorId: BOT_ID,
      embeds: (payload.embeds ?? []).map((e) => {
        const data = (e as { data?: Record<string, unknown> }).data ?? e;
        return data as { title?: string; footer?: { text: string } };
      }),
      components: payload.components ?? [],
      edits: 0,
    };
    return message;
  };

  const channel = {
    type: 0, // ChannelType.GuildText
    id: CHANNEL,
    guild: { members: { me: {} } },
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(async (payload: { embeds?: unknown[]; components?: unknown[] }) => {
      const message = makeMessage(payload);
      sent.push({ ...message, edits: 0 });
      const stored = sent.at(-1)!;
      return {
        ...stored,
        get id() {
          return stored.id;
        },
        edit: vi.fn(async (next: { embeds?: unknown[]; components?: unknown[] }) => {
          const replacement = makeMessage(next);
          stored.embeds = replacement.embeds;
          stored.components = replacement.components;
          stored.edits += 1;
        }),
      };
    }),
    messages: {
      fetch: vi.fn(async (arg: string | { limit: number }) => {
        if (typeof arg === 'object') {
          // Newest first, matching Discord.
          const page = [...sent].reverse().slice(0, arg.limit);
          return {
            values: () =>
              page.map((m) => ({
                id: m.id,
                author: { id: m.authorId },
                embeds: m.embeds,
              })),
          };
        }
        const stored = sent.find((m) => m.id === arg);
        if (!stored) {
          // A real `DiscordAPIError`, not a look-alike: `isGoneError` narrows
          // on the class, so a plain Error with `code = 10008` would escape
          // the handler and prove nothing about production behaviour.
          throw new DiscordAPIError(
            { code: 10008, message: 'Unknown Message' },
            10008,
            404,
            'GET',
            `/channels/${CHANNEL}/messages/${arg}`,
            {},
          );
        }
        return {
          id: stored.id,
          edit: vi.fn(async (next: { embeds?: unknown[]; components?: unknown[] }) => {
            const replacement = makeMessage(next);
            stored.embeds = replacement.embeds;
            stored.components = replacement.components;
            stored.edits += 1;
          }),
        };
      }),
    },
  };
  return { channel, sent };
}

function fakeClient(channel: unknown) {
  return {
    user: { id: BOT_ID },
    channels: { fetch: vi.fn(async () => channel) },
  };
}

function announcerFor(channel: unknown) {
  return createBossAnnouncer({
    ctx,
    client: fakeClient(channel) as never,
    encounters: app.bosses,
  });
}

// ─────────────────────────────── fixtures ────────────────────────────────────

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { bossRng: seededRng(11) });
  prov = await provisionPlayer(app, 'g-boss-ann', 'u-1');
  ctx = {
    config: { assetsDir: process.cwd(), contentDir: process.cwd() },
    logger: t.logger,
    db: t.db,
    content: app.content,
    services: { bosses: app.bosses },
  } as unknown as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.update(players).set({ buddyWaifuId: null });
  await t.db.delete(playerWaifus);
});

async function giveBuddy(): Promise<number> {
  const [sp] = await t.db.select({ id: species.id }).from(species).limit(1);
  const waifu = await insertOwnedWaifu(t.db, {
    playerId: prov.playerId,
    speciesId: sp!.id,
    level: 10,
    xp: 0,
    baseSp: 150,
  });
  await t.db
    .update(players)
    .set({ buddyWaifuId: waifu.id })
    .where(eq(players.id, prov.playerId));
  return waifu.id;
}

/** An announced, live encounter with `participants` committed buddies. */
async function liveEncounter(
  messageId: string,
  participants = 0,
): Promise<BossEncounterRow> {
  const boss = app.content.bosses[0]!;
  const now = new Date();
  const [row] = await t.db
    .insert(bossEncounters)
    .values({
      guildId: prov.guildDbId,
      region: 'waifu-valley',
      bossId: boss.id,
      bossName: boss.name,
      bossAffinity: boss.affinity,
      rewardTable: boss.rewardTable,
      rewardTableVersion: 'standard-scouting-v1',
      calcVersion: 1,
      affinityVersion: 1,
      channelId: CHANNEL,
      messageId,
      status: 'scouting',
      scheduledAt: now,
      scoutingStartedAt: now,
      deadlineAt: new Date(now.getTime() + 30 * MINUTE),
    })
    .returning();

  for (let i = 0; i < participants; i += 1) {
    const player = await provisionPlayer(app, 'g-boss-ann', `u-p-${i}`);
    const [sp] = await t.db.select({ id: species.id }).from(species).limit(1);
    const waifu = await insertOwnedWaifu(t.db, {
      playerId: player.playerId,
      speciesId: sp!.id,
      level: 10,
      xp: 0,
      baseSp: 150,
    });
    await t.db
      .update(players)
      .set({ buddyWaifuId: waifu.id })
      .where(eq(players.id, player.playerId));
    await app.bosses.commit(row!.id, prov.guildDbId, player.playerId, {
      discordUserId: `u-p-${i}`,
      trainerName: `Trainer ${i}`,
    });
  }
  return row!;
}

const titles = (sent: FakeMessage[]) => sent.map((m) => m.embeds[0]?.title);

// ── the announcement is posted once, and stays ──────────────────────────────

describe('the encounter announcement', () => {
  it('is posted as its own message carrying the Commit Buddy button', async () => {
    const { channel, sent } = fakeChannel();
    const encounter = await liveEncounter('placeholder');
    const messageId = await announcerFor(channel).postAnnouncement(encounter, CHANNEL);

    expect(sent).toHaveLength(1);
    expect(messageId).toBe(sent[0]!.id);
    expect(sent[0]!.embeds[0]!.title).toContain('is scouting');
    expect(sent[0]!.components).toHaveLength(1);
  });

  it('is edited, never re-posted, when the participant count changes', async () => {
    const { channel, sent } = fakeChannel();
    let encounter = await liveEncounter('placeholder');
    const announcer = announcerFor(channel);
    const messageId = await announcer.postAnnouncement(encounter, CHANNEL);
    encounter = await app.bosses.repairMessage(encounter.id, CHANNEL, messageId);

    await announcer.refreshAnnouncement(encounter);
    await announcer.refreshAnnouncement(encounter);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.edits).toBe(2);
    // Still the live announcement, button and all.
    expect(sent[0]!.embeds[0]!.title).toContain('is scouting');
    expect(sent[0]!.components).toHaveLength(1);
  });
});

// ── resolution produces two messages, in order ──────────────────────────────

describe('resolution closes the encounter and posts results beneath it', () => {
  /** Announce, commit, resolve, publish — the whole happy path. */
  async function runEncounter(channel: unknown, participants: number) {
    let encounter = await liveEncounter('placeholder', participants);
    const announcer = announcerFor(channel);
    const messageId = await announcer.postAnnouncement(encounter, CHANNEL);
    encounter = await app.bosses.repairMessage(encounter.id, CHANNEL, messageId);
    await app.bosses.resolve(encounter.id);
    await announcer.publishResults(encounter.id);
    return { encounter: (await app.bosses.getEncounter(encounter.id))!, announcer };
  }

  it('leaves exactly two messages: the encounter, then its results', async () => {
    const { channel, sent } = fakeChannel();
    await runEncounter(channel, 2);

    expect(sent).toHaveLength(2);
    // Order is the whole point — the results sit *below* the encounter.
    expect(titles(sent)[0]).toContain('Was Driven Away');
    expect(titles(sent)[1]).toContain('Boss Results');
  });

  it('edits the original encounter message rather than deleting or replacing it', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter } = await runEncounter(channel, 1);
    // The same message id it was announced on.
    expect(sent[0]!.id).toBe(encounter.messageId);
    expect(sent[0]!.edits).toBe(1);
  });

  it('removes every participation control from the completed encounter', async () => {
    const { channel, sent } = fakeChannel();
    await runEncounter(channel, 1);
    // Removed, not disabled: a greyed-out button still invites a click.
    expect(sent[0]!.components).toEqual([]);
  });

  it('puts the result controls on the results message only', async () => {
    const { channel, sent } = fakeChannel();
    await runEncounter(channel, 3);
    expect(sent[0]!.components).toEqual([]);
    expect(sent[1]!.components.length).toBeGreaterThan(0);
  });

  it('records the two message ids and both delivery stamps separately', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter } = await runEncounter(channel, 1);
    expect(encounter.messageId).toBe(sent[0]!.id);
    expect(encounter.resultsMessageId).toBe(sent[1]!.id);
    expect(encounter.messageId).not.toBe(encounter.resultsMessageId);
    expect(encounter.completionEditedAt).not.toBeNull();
    expect(encounter.resultsPublishedAt).not.toBeNull();
    expect(encounter.resultsPageSize).toBe(app.content.tables.bossEncounters.resultsPageSize);
  });

  it('still posts a results message when nobody committed', async () => {
    const { channel, sent } = fakeChannel();
    await runEncounter(channel, 0);
    expect(sent).toHaveLength(2);
    expect(titles(sent)[0]).toContain('Left Unchallenged');
    expect(titles(sent)[1]).toContain('Boss Results');
    // No controls on a results message nobody can have a result in.
    expect(sent[1]!.components).toEqual([]);
  });

  it('starts a new message for the next encounter, beneath the previous results', async () => {
    const { channel, sent } = fakeChannel();
    const first = await runEncounter(channel, 1);
    const second = await runEncounter(channel, 1);

    expect(sent).toHaveLength(4);
    expect(titles(sent)).toEqual([
      expect.stringContaining('Was Driven Away'),
      expect.stringContaining('Boss Results'),
      expect.stringContaining('Was Driven Away'),
      expect.stringContaining('Boss Results'),
    ]);
    // No message id is reused across encounters.
    const ids = [
      first.encounter.messageId,
      first.encounter.resultsMessageId,
      second.encounter.messageId,
      second.encounter.resultsMessageId,
    ];
    expect(new Set(ids).size).toBe(4);
  });

  it('leaves the earlier encounter untouched while the next one runs', async () => {
    const { channel, sent } = fakeChannel();
    const first = await runEncounter(channel, 1);
    const editsAfterFirst = sent[0]!.edits;
    await runEncounter(channel, 1);

    expect(sent[0]!.edits).toBe(editsAfterFirst);
    expect(sent[0]!.components).toEqual([]);
    const reread = (await app.bosses.getEncounter(first.encounter.id))!;
    expect(reread.messageId).toBe(first.encounter.messageId);
    expect(reread.resultsMessageId).toBe(first.encounter.resultsMessageId);
  });
});

// ── recovery and idempotency ────────────────────────────────────────────────

describe('recovery never duplicates and never loses', () => {
  async function announced(channel: unknown) {
    let encounter = await liveEncounter('placeholder', 1);
    const announcer = announcerFor(channel);
    const messageId = await announcer.postAnnouncement(encounter, CHANNEL);
    encounter = await app.bosses.repairMessage(encounter.id, CHANNEL, messageId);
    await app.bosses.resolve(encounter.id);
    return { encounter, announcer };
  }

  it('is a no-op when called again on a fully published encounter', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    await announcer.publishResults(encounter.id);
    const afterFirst = { count: sent.length, edits: sent[0]!.edits };

    for (let i = 0; i < 3; i += 1) await announcer.publishResults(encounter.id);

    expect(sent).toHaveLength(afterFirst.count);
    expect(sent[0]!.edits).toBe(afterFirst.edits);
  });

  it('repairs a completion edit that never landed, without re-publishing', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    await announcer.publishResults(encounter.id);
    // Simulate a crash that lost only the completion edit's stamp *and* its
    // effect: put the row back to "edit still owed".
    await t.db
      .update(bossEncounters)
      .set({ completionEditedAt: null })
      .where(eq(bossEncounters.id, encounter.id));
    const editsBefore = sent[0]!.edits;
    const messagesBefore = sent.length;

    await announcer.publishResults(encounter.id);

    expect(sent[0]!.edits).toBe(editsBefore + 1);
    // The results message already exists and is not sent again.
    expect(sent).toHaveLength(messagesBefore);
  });

  it('publishes a missing results message on a later attempt', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    // A crash between the completion edit and the results send.
    await app.bosses.markCompletionEdited(encounter.id);
    expect(sent).toHaveLength(1);

    await announcer.publishResults(encounter.id);
    expect(sent).toHaveLength(2);
    expect(titles(sent)[1]).toContain('Boss Results');
    // The encounter message was not edited a second time.
    expect(sent[0]!.edits).toBe(0);
  });

  it('adopts an orphaned results message rather than posting a second', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    await announcer.publishResults(encounter.id);
    const orphanId = sent[1]!.id;

    // The crash this guards: Discord accepted the send, the UPDATE never
    // landed. The row forgets the message; the channel still has it.
    await t.db
      .update(bossEncounters)
      .set({ resultsMessageId: null, resultsPublishedAt: null })
      .where(eq(bossEncounters.id, encounter.id));

    await announcer.publishResults(encounter.id);

    expect(sent).toHaveLength(2);
    const reread = (await app.bosses.getEncounter(encounter.id))!;
    expect(reread.resultsMessageId).toBe(orphanId);
  });

  it('does not mistake another encounter\'s results for its own', async () => {
    const { channel, sent } = fakeChannel();
    const first = await announced(channel);
    await first.announcer.publishResults(first.encounter.id);
    const second = await announced(channel);

    await second.announcer.publishResults(second.encounter.id);

    // Four messages: two encounters, two results. The marker scan must not
    // have adopted the first encounter's results for the second.
    expect(sent).toHaveLength(4);
    const firstRow = (await app.bosses.getEncounter(first.encounter.id))!;
    const secondRow = (await app.bosses.getEncounter(second.encounter.id))!;
    expect(secondRow.resultsMessageId).not.toBe(firstRow.resultsMessageId);
  });

  it('does not mistake the encounter announcement for a results message', async () => {
    // Both carry the same `Boss Encounter #id` marker; only the title differs.
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    await announcer.publishResults(encounter.id);
    expect(sent).toHaveLength(2);
    expect((await app.bosses.getEncounter(encounter.id))!.resultsMessageId).toBe(sent[1]!.id);
  });

  it('does not re-post results for an encounter that predates the split', async () => {
    // Migration 0018 stamps historical rows with `results_published_at` and no
    // message id, because their results were published by overwriting the
    // announcement. Re-posting now would append a stray result to old history.
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    await t.db
      .update(bossEncounters)
      .set({
        completionEditedAt: new Date(),
        resultsPublishedAt: new Date(),
        resultsMessageId: null,
      })
      .where(eq(bossEncounters.id, encounter.id));

    await announcer.publishResults(encounter.id);
    expect(sent).toHaveLength(1);
  });

  it('publishes results even when the announcement was deleted', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    // Point the row at a message the channel does not have.
    await t.db
      .update(bossEncounters)
      .set({ messageId: 'm-deleted' })
      .where(eq(bossEncounters.id, encounter.id));

    await announcer.publishResults(encounter.id);

    // Rewards were already applied; the results readout still reaches players.
    expect(sent).toHaveLength(2);
    expect(titles(sent)[1]).toContain('Boss Results');
    // And the completion edit is stamped anyway, so later passes stop retrying
    // a fetch that can only fail.
    expect((await app.bosses.getEncounter(encounter.id))!.completionEditedAt).not.toBeNull();
  });

  it('never reactivates components on a resolved encounter', async () => {
    const { channel, sent } = fakeChannel();
    const { encounter, announcer } = await announced(channel);
    await announcer.publishResults(encounter.id);
    expect(sent[0]!.components).toEqual([]);

    // A refresh aimed at a resolved encounter would be the way this could go
    // wrong; the scheduler only refreshes `scouting` rows, and the row is not.
    const resolved = (await app.bosses.getEncounter(encounter.id))!;
    expect(resolved.status).toBe('resolved');
    expect((await app.bosses.findScouting()).map((e) => e.id)).not.toContain(encounter.id);
  });
});
