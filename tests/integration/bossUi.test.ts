/**
 * Boss encounter Discord surfaces — real handlers, real Postgres, fake
 * interactions.
 *
 * What this file is for, specifically: the handlers must contain no scheduling
 * and no reward logic, so what is worth testing here is the *routing* — that a
 * stale button is refused safely, that a preview writes nothing, that Confirm
 * is the only mutation, and that pagination reads back from stored rows rather
 * than from anything held in memory.
 *
 * The other half of this file exists because of a live-testing regression:
 * **Commit Buddy lives on a public message**, so answering it with
 * `interaction.update()` replaced the boss embed with one player's private
 * preview, publicly and permanently. Every assertion that says `update` was
 * *not* called is guarding that specific failure — the public encounter
 * message is history, and no player interaction may consume it.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bossEncounters,
  bossParticipations,
  guildBossState,
  playerInventory,
  playerWaifus,
  players,
  species,
  type BossEncounterRow,
} from '../../src/db/schema';
import {
  handleBossCancel,
  handleBossCommit,
  handleBossConfirm,
  handleBossMyResult,
  handleBossPage,
} from '../../src/discord/commands/waifumonBoss';
import { buildAnnouncement } from '../../src/discord/bossPresenter';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { seededRng } from '../../src/shared/random';
import {
  bootstrapApp,
  createEventHarness,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let otherProv: Provisioned;
let ctx: AppContext;

const MINUTE = 60_000;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { bossRng: seededRng(7) });
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-boss-ui', 'u-1');
  otherProv = await provisionPlayer(app, 'g-boss-ui', 'u-2');
  ctx = {
    config: {
      assetsDir: process.cwd(),
      contentDir: process.cwd(),
      dailyTimezone: 'UTC',
      discordToken: 'x',
      discordClientId: 'x',
      discordGuildId: undefined,
      databaseUrl: 'postgres://x',
      logLevel: 'info',
      adminWeb: { enabled: false, host: '127.0.0.1', port: 3111, token: '' },
      platformApi: { enabled: false, host: '127.0.0.1', port: 3120, token: '' },
    },
    logger: t.logger,
    db: t.db,
    content: app.content,
    events: harness.bus,
    huntSessions: harness.huntSessions,
    services: {
      guilds: app.guilds,
      players: app.players,
      currency: app.currency,
      inventory: app.inventory,
      daily: app.daily,
      shop: app.shop,
      hunt: app.hunt,
      capture: app.capture,
      collection: app.collection,
      appearance: app.appearance,
      care: app.care,
      progression: app.progression,
      quests: app.quests,
      effects: app.effects,
      itemUse: app.itemUse,
      gifts: app.gifts,
      session: app.session,
      bosses: app.bosses,
    },
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.delete(playerInventory);
  await t.db.update(players).set({ buddyWaifuId: null });
  await t.db.delete(playerWaifus);
  harness.reset();
});

// ───────────────────────────── fake interactions ─────────────────────────────

function fakeButton(userId = 'u-1', displayName = 'Whistler') {
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    message: { id: 'm-1' },
    channelId: 'c-boss',
    user: { id: userId, displayName, username: displayName },
    member: { displayName },
    guildId: 'g-boss-ui',
  };
}

/**
 * The payload passed to `reply()` — the ephemeral-only path.
 *
 * Separate from {@link painted} because two of these assertions care
 * specifically that the handler replied rather than updating: a private answer
 * must not repaint the public results message.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function replied(interaction: ReturnType<typeof fakeButton>): any {
  const calls = interaction.reply.mock.calls as unknown as unknown[][];
  if (calls.length === 0) throw new Error('handler did not reply');
  return calls[0]![0];
}

/** The last payload the handler painted, whichever method it used. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function painted(interaction: ReturnType<typeof fakeButton>): any {
  for (const method of [interaction.update, interaction.editReply, interaction.reply]) {
    const calls = method.mock.calls as unknown as unknown[][];
    if (calls.length > 0) return calls.at(-1)![0];
  }
  throw new Error('handler painted nothing');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buttons = (payload: any): any[] =>
  (payload.components ?? []).flatMap((row: { components?: unknown[] }) => row.components ?? []);

async function giveBuddy(target: number, level = 10): Promise<number> {
  const [sp] = await t.db.select({ id: species.id }).from(species).limit(1);
  const waifu = await insertOwnedWaifu(t.db, {
    playerId: target,
    speciesId: sp!.id,
    level,
    xp: 0,
    baseSp: 150,
  });
  await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, target));
  return waifu.id;
}

async function openEncounter(
  overrides: Partial<typeof bossEncounters.$inferInsert> = {},
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
      channelId: 'c-boss',
      messageId: 'm-1',
      status: 'scouting',
      scheduledAt: now,
      scoutingStartedAt: now,
      deadlineAt: new Date(now.getTime() + 30 * MINUTE),
      ...overrides,
    })
    .returning();
  return row!;
}

// ── Commit Buddy ────────────────────────────────────────────────────────────

describe('Commit Buddy', () => {
  it('explains how to pick a buddy when the player has none', async () => {
    const encounter = await openEncounter();
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);
    expect(painted(interaction).content).toContain('/wm buddy');
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
  });

  it('shows an ephemeral preview and writes nothing', async () => {
    const encounter = await openEncounter();
    await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);

    const payload = painted(interaction);
    expect(payload.content).toContain('Estimated Damage');
    expect(payload.content).toContain('Rewards are delivered only after the battle resolves');
    expect(buttons(payload).map((b) => b.data.label)).toEqual(['Confirm', 'Cancel']);
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
  });

  it('cancels without writing anything, and says how to switch buddies', async () => {
    const encounter = await openEncounter();
    await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossCancel(ctx, interaction as never);
    expect(painted(interaction).content).toContain('Nothing committed');
    expect(painted(interaction).content).toContain('/wm buddy');
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
    void encounter;
  });

  it('rejects a stale button safely rather than throwing', async () => {
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, ['999999']);
    expect(painted(interaction).content).toMatch(/long gone|already over/i);
  });

  it('rejects a malformed encounter id', async () => {
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, ['not-a-number']);
    expect(painted(interaction).content).toContain('over');
  });

  it('rejects a button whose encounter belongs to another guild', async () => {
    const other = await provisionPlayer(app, 'g-boss-ui-2', 'u-x');
    const encounter = await openEncounter();
    await giveBuddy(other.playerId);
    const interaction = fakeButton('u-x', 'Stranger');
    await handleBossCommit(ctx, interaction as never, other, [String(encounter.id)]);
    expect(painted(interaction).content).toMatch(/long gone/i);
  });

  it('refuses once the window has closed', async () => {
    const past = new Date(Date.now() - MINUTE);
    const encounter = await openEncounter({
      scoutingStartedAt: new Date(past.getTime() - 30 * MINUTE),
      deadlineAt: past,
    });
    await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);
    expect(painted(interaction).content).toContain('already over');
  });
});

// ── the public encounter message is never consumed ──────────────────────────

describe('Commit Buddy never replaces the public boss message', () => {
  it('replies with a NEW ephemeral rather than updating the message it sits on', async () => {
    const encounter = await openEncounter();
    await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);

    // The whole regression, in one assertion: `update()` here would edit the
    // public announcement.
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('marks that reply ephemeral so the preview stays private', async () => {
    const encounter = await openEncounter();
    await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);
    expect(replied(interaction).flags).toBeTruthy();
  });

  it('replies rather than updating when the player has no buddy', async () => {
    const encounter = await openEncounter();
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);
    // A refusal is still an answer to a public button.
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('replies rather than updating when the window has closed', async () => {
    const past = new Date(Date.now() - MINUTE);
    const encounter = await openEncounter({
      scoutingStartedAt: new Date(past.getTime() - 30 * MINUTE),
      deadlineAt: past,
    });
    await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('replies rather than updating for a stale encounter id', async () => {
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, ['999999']);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('offers the two-step confirmation, so the preview alone commits nothing', async () => {
    const encounter = await openEncounter();
    await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossCommit(ctx, interaction as never, prov, [String(encounter.id)]);

    const payload = replied(interaction);
    expect(buttons(payload).map((b) => b.data.label)).toEqual(['Confirm', 'Cancel']);
    expect(buttons(payload)[0].data.custom_id).toContain('boss|confirm');
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
  });

  it('updates the ephemeral preview on Confirm — that message IS the player\'s', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossConfirm(ctx, interaction as never, prov, [
      String(encounter.id),
      String(waifuId),
    ]);
    // Confirm's button lives on the private preview, so `update` is correct
    // here — the asymmetry with Commit is the point.
    expect(interaction.update).toHaveBeenCalledTimes(1);
  });

  it('updates the ephemeral preview on Cancel too', async () => {
    const interaction = fakeButton();
    await handleBossCancel(ctx, interaction as never);
    expect(interaction.update).toHaveBeenCalledTimes(1);
  });
});

// ── the participant-count edit ──────────────────────────────────────────────

describe('committing refreshes the public count without disturbing the message', () => {
  /** A recording announcer, standing in for the Discord half. */
  function recordingAnnouncer() {
    const refreshed: number[] = [];
    return {
      refreshed,
      announcer: {
        verifyChannel: vi.fn(async () => ({ missing: [] })),
        postAnnouncement: vi.fn(async () => 'm-new'),
        refreshAnnouncement: vi.fn(async (e: BossEncounterRow) => {
          refreshed.push(e.id);
        }),
        publishResults: vi.fn(async () => {}),
      },
    };
  }

  it('edits the announcement through the announcer, not through the interaction', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    const { refreshed, announcer } = recordingAnnouncer();
    const interaction = fakeButton();

    await handleBossConfirm(
      { ...ctx, bossAnnouncer: announcer } as never,
      interaction as never,
      prov,
      [String(encounter.id), String(waifuId)],
    );

    // An ordinary message edit of the announcement, keyed to this encounter.
    expect(refreshed).toEqual([encounter.id]);
    // And exactly one interaction paint — the private confirmation.
    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('re-renders the announcement with the boss embed and Commit Buddy intact', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await handleBossConfirm(ctx, fakeButton() as never, prov, [
      String(encounter.id),
      String(waifuId),
    ]);

    // The refresh renders `buildAnnouncement`, so assert on what that produces
    // for the now-committed count: the embed and the button both survive.
    const refreshedRow = (await app.bosses.getEncounter(encounter.id))!;
    const payload = buildAnnouncement({
      encounter: refreshedRow,
      boss: app.bosses.bossFor(refreshedRow),
      config: app.content.tables.bossEncounters,
      participantCount: await app.bosses.countParticipants(encounter.id),
      now: new Date(),
    });
    const fields = payload.embeds![0] as unknown as { data: { fields: { name: string; value: string }[] } };
    expect(fields.data.fields.find((f) => f.name === 'Trainers Committed')!.value).toBe('1');
    expect(buttons(payload).map((b) => b.data.label)).toEqual(['Commit Buddy']);
  });

  it('still commits when there is no announcer wired — the edit is best-effort', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await handleBossConfirm(ctx, fakeButton() as never, prov, [
      String(encounter.id),
      String(waifuId),
    ]);
    expect(await t.db.select().from(bossParticipations)).toHaveLength(1);
  });

  it('does not fail the commit when the announcement edit throws', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    const announcer = {
      verifyChannel: vi.fn(async () => ({ missing: [] })),
      postAnnouncement: vi.fn(async () => 'm-new'),
      refreshAnnouncement: vi.fn(async () => {
        throw new Error('discord is down');
      }),
      publishResults: vi.fn(async () => {}),
    };
    const interaction = fakeButton();
    await handleBossConfirm(
      { ...ctx, bossAnnouncer: announcer } as never,
      interaction as never,
      prov,
      [String(encounter.id), String(waifuId)],
    );
    // The participation is durable; only the count is momentarily stale.
    expect(await t.db.select().from(bossParticipations)).toHaveLength(1);
    expect(painted(interaction).content).toContain('is committed to');
  });

  it('never repaints a resolved encounter back into its live form', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await app.bosses.commit(encounter.id, prov.guildDbId, prov.playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });
    await app.bosses.resolve(encounter.id);

    const { refreshed, announcer } = recordingAnnouncer();
    // A late Confirm against a finished encounter must not reopen its message.
    await handleBossConfirm(
      { ...ctx, bossAnnouncer: announcer } as never,
      fakeButton() as never,
      prov,
      [String(encounter.id), String(waifuId)],
    );
    expect(refreshed).toEqual([]);
  });
});

// ── Confirm ─────────────────────────────────────────────────────────────────

describe('Confirm', () => {
  it('creates the participation and awards nothing', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    const interaction = fakeButton();
    await handleBossConfirm(ctx, interaction as never, prov, [
      String(encounter.id),
      String(waifuId),
    ]);

    expect(painted(interaction).content).toContain('is committed to');
    const rows = await t.db.select().from(bossParticipations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rewardStatus).toBe('pending');
    expect(rows[0]!.totalDamage).toBeNull();
    expect(await t.db.select().from(playerInventory)).toHaveLength(0);
  });

  it('snapshots the Discord display name rather than only the user id', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await handleBossConfirm(ctx, fakeButton('u-1', 'Whistler') as never, prov, [
      String(encounter.id),
      String(waifuId),
    ]);
    const [row] = await t.db.select().from(bossParticipations);
    // A public result rendered a month later must not depend on resolving a
    // member who may have left or been renamed.
    expect(row!.trainerName).toBe('Whistler');
    expect(row!.discordUserId).toBe('u-1');
  });

  it('emits the committed event carrying no private preview numbers', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await handleBossConfirm(ctx, fakeButton() as never, prov, [
      String(encounter.id),
      String(waifuId),
    ]);
    const event = harness.events.find((e) => e.kind === 'BOSS_BUDDY_COMMITTED');
    expect(event).toBeDefined();
    const payload = event!.payload as Record<string, unknown>;
    expect(payload.waifuId).toBe(waifuId);
    // The ephemeral read on the matchup must not leak onto a shared bus.
    expect(payload).not.toHaveProperty('estimate');
    expect(payload).not.toHaveProperty('affinityBonus');
    expect(payload).not.toHaveProperty('responseBonus');
  });

  it('refuses when the active buddy changed since the preview', async () => {
    const encounter = await openEncounter();
    const previewed = await giveBuddy(prov.playerId);
    // The player swapped buddies while the preview sat open.
    const swapped = await giveBuddy(prov.playerId, 30);
    const interaction = fakeButton();
    await handleBossConfirm(ctx, interaction as never, prov, [
      String(encounter.id),
      String(previewed),
    ]);

    expect(painted(interaction).content).toContain('active buddy changed');
    expect(await t.db.select().from(bossParticipations)).toHaveLength(0);
    void swapped;
  });

  it('rejects a second confirmation from the same player', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await handleBossConfirm(ctx, fakeButton() as never, prov, [
      String(encounter.id),
      String(waifuId),
    ]);
    const second = fakeButton();
    await handleBossConfirm(ctx, second as never, prov, [String(encounter.id), String(waifuId)]);

    expect(painted(second).content).toContain('already committed');
    expect(await t.db.select().from(bossParticipations)).toHaveLength(1);
  });

  it('produces exactly one participation under concurrent double-clicks', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        handleBossConfirm(ctx, fakeButton() as never, prov, [
          String(encounter.id),
          String(waifuId),
        ]),
      ),
    );
    expect(await t.db.select().from(bossParticipations)).toHaveLength(1);
  });
});

// ── Results ─────────────────────────────────────────────────────────────────

describe('results and pagination', () => {
  /** Resolve an encounter with `count` committed trainers. */
  async function resolvedWith(count: number): Promise<BossEncounterRow> {
    const encounter = await openEncounter();
    for (let i = 0; i < count; i++) {
      const player = await provisionPlayer(app, 'g-boss-ui', `u-r-${i}`);
      await giveBuddy(player.playerId);
      await app.bosses.commit(encounter.id, prov.guildDbId, player.playerId, {
        discordUserId: `u-r-${i}`,
        trainerName: `Trainer ${i}`,
      });
    }
    await app.bosses.resolve(encounter.id);
    return (await app.bosses.getEncounter(encounter.id))!;
  }

  it('paginates from stored rows, with no in-memory cursor to lose', async () => {
    const encounter = await resolvedWith(14);
    const interaction = fakeButton();
    await handleBossPage(ctx, interaction as never, prov, [String(encounter.id), '2']);

    const payload = painted(interaction);
    expect(payload.embeds[0].data.footer.text).toContain('Page 2');
    // The header totals are encounter-level and must not change per page.
    expect(payload.embeds[0].data.description).toContain('**14** trainers');
    expect(payload.embeds[0].data.description).toContain('**140** attacks');
  });

  it('clamps a page number past the end rather than rendering nothing', async () => {
    const encounter = await resolvedWith(3);
    const interaction = fakeButton();
    await handleBossPage(ctx, interaction as never, prov, [String(encounter.id), '99']);
    expect(painted(interaction).embeds[0].data.fields.length).toBeGreaterThan(0);
  });

  it('edits the results message in place rather than posting a page', async () => {
    const encounter = await resolvedWith(12);
    const interaction = fakeButton();
    await handleBossPage(ctx, interaction as never, prov, [String(encounter.id), '2']);
    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('pages with the size the results were published at, not the current tuning', async () => {
    const encounter = await resolvedWith(14);
    // Someone retunes `resultsPageSize` after publication. The message on
    // Discord was built at the old size, so its page boundaries must not move.
    await t.db
      .update(bossEncounters)
      .set({ resultsPageSize: 5 })
      .where(eq(bossEncounters.id, encounter.id));

    const interaction = fakeButton();
    await handleBossPage(ctx, interaction as never, prov, [String(encounter.id), '1']);
    const payload = painted(interaction);
    expect(payload.embeds[0].data.fields.filter((f: { name: string }) => f.name === '\u200b'))
      .toHaveLength(5);
    expect(payload.embeds[0].data.footer.text).toContain('Page 1 of 3');
  });

  it('keeps My Result on the results message after a restart', async () => {
    const encounter = await resolvedWith(3);
    // A restart holds nothing in memory; the button renders from the row.
    const interaction = fakeButton();
    await handleBossPage(ctx, interaction as never, prov, [String(encounter.id), '1']);
    expect(buttons(painted(interaction)).map((b) => b.data.label)).toContain('My Result');
  });

  it('carries the encounter marker on every rendered page', async () => {
    const encounter = await resolvedWith(14);
    for (const page of ['1', '2']) {
      const interaction = fakeButton();
      await handleBossPage(ctx, interaction as never, prov, [String(encounter.id), page]);
      expect(painted(interaction).embeds[0].data.footer.text).toContain(
        `Boss Encounter #${encounter.id}`,
      );
    }
  });

  it('refuses pagination for another guild encounter', async () => {
    const other = await provisionPlayer(app, 'g-boss-ui-3', 'u-y');
    const encounter = await resolvedWith(2);
    const interaction = fakeButton('u-y', 'Stranger');
    await handleBossPage(ctx, interaction as never, other, [String(encounter.id), '1']);
    // Refused as a stale button rather than as an error — a copied custom id
    // from another server must be inert, not informative.
    expect(painted(interaction).content).toContain('over');
    expect(painted(interaction).embeds ?? []).toHaveLength(0);
  });

  it('returns My Result ephemerally without repainting the public message', async () => {
    const encounter = await openEncounter();
    const waifuId = await giveBuddy(prov.playerId);
    await app.bosses.commit(encounter.id, prov.guildDbId, prov.playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });
    await app.bosses.resolve(encounter.id);

    const interaction = fakeButton();
    await handleBossMyResult(ctx, interaction as never, prov, [String(encounter.id)]);
    // A private answer must not repaint the message everybody else is reading.
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = replied(interaction);
    expect(payload.content).toContain('damage');
    expect(payload.content).toContain('XP');
    // Ephemeral flag.
    expect(payload.flags).toBeTruthy();
    void waifuId;
  });

  it('tells a non-participant plainly that they did not join', async () => {
    const encounter = await resolvedWith(2);
    const interaction = fakeButton('u-2', 'Ian');
    await handleBossMyResult(ctx, interaction as never, otherProv, [String(encounter.id)]);
    const payload = replied(interaction);
    expect(payload.content).toContain('did not commit a buddy');
  });

  it('says rewards are pending for a still-open encounter', async () => {
    const encounter = await openEncounter();
    await giveBuddy(prov.playerId);
    await app.bosses.commit(encounter.id, prov.guildDbId, prov.playerId, {
      discordUserId: 'u-1',
      trainerName: 'Whistler',
    });
    const interaction = fakeButton();
    await handleBossMyResult(ctx, interaction as never, prov, [String(encounter.id)]);
    const payload = replied(interaction);
    expect(payload.content).toContain('when the battle resolves');
  });
});

// ── the feature switched off ────────────────────────────────────────────────

describe('a deployment without boss encounters', () => {
  it('treats every boss button as stale rather than crashing', async () => {
    const without = { ...ctx, services: { ...ctx.services, bosses: undefined } } as AppContext;
    const interaction = fakeButton();
    await handleBossCommit(without, interaction as never, prov, ['1']);
    expect(painted(interaction).content).toMatch(/over/i);
  });
});
