/**
 * The Trainer Profile shows the Waifumon being cared for.
 *
 * Entering Care Mode posts the one public message Waifumon writes on a
 * player's behalf, and the buddy it is about should be visible in it rather
 * than described in three lines of text. The picture comes from
 * `ownedCardImage` — the same helper the collection inspect card uses — so the
 * dashboard and the inspect screen can never disagree about which look a copy
 * is wearing.
 *
 * What is pinned here: the image is attached and the embed points at it, the
 * *equipped* appearance supplies it, every existing stat survives, and every
 * way the picture can fail degrades to exactly the text-only profile that
 * shipped before — never to a Care Mode that refuses to start.
 */
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import { handleCareStart } from '../../src/discord/commands/waifumon';
import { handleCollectionPickCopy } from '../../src/discord/commands/waifumonCollection';
import {
  createTrainerProfileService,
  type BuddyCardRenderer,
  type ProfileChannel,
  type TrainerProfileService,
} from '../../src/discord/trainerProfile';
import { ownedCardImage } from '../../src/discord/assets/attachRenderedCard';
import { CARD_FILENAME } from '../../src/discord/assets/resolveAppearanceAsset';
import { playerWaifus, species } from '../../src/db/schema';
import type { AppContext, PlayerInteraction, Provisioned } from '../../src/discord/types';
import {
  ASSETS_DIR,
  bootstrapApp,
  createEventHarness,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const GUILD_ID = 'g-profile-card';
const USER_ID = 'u-profile-card';
const CHANNEL_ID = 'c-profile-card';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;
let profile: TrainerProfileService;
let channel: {
  id: string;
  send: ReturnType<typeof vi.fn>;
  messages: { edit: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
};
let nextMessageId = 0;

/**
 * Swapped per test. Production binds this to `ownedCardImage`; the default
 * here is the same real call, so most cases exercise the genuine path.
 */
let renderBuddy: BuddyCardRenderer;

function makeChannel() {
  return {
    id: CHANNEL_ID,
    send: vi.fn(async () => ({ id: `m-profile-${++nextMessageId}` })),
    messages: {
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  };
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, GUILD_ID, USER_ID);
  channel = makeChannel();
  ctx = {
    config: {
      // The real assets root, so appearance artwork actually resolves and the
      // "which look?" assertions below are about real files on disk.
      assetsDir: ASSETS_DIR,
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
      session: app.session,
    },
  } as unknown as AppContext;

  profile = createTrainerProfileService({
    logger: t.logger,
    services: ctx.services,
    resolveChannel: async (id) => (id === CHANNEL_ID ? (channel as unknown as ProfileChannel) : null),
    // Indirection on purpose: the wiring is fixed at construction, the
    // behaviour is what each test varies.
    renderBuddyCard: (target) => renderBuddy(target),
  });
  profile.subscribe(harness.bus);
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  renderBuddy = (target) => ownedCardImage(ctx, target);
  await app.care.leave(prov.playerId).catch(() => undefined);
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  harness.reset();
  channel.send.mockClear();
  channel.messages.edit.mockClear();
  channel.messages.delete.mockClear();
  await app.session.setProfileMessageId(prov.guildDbId, prov.playerId, CHANNEL_ID, null);
});

/** An owned `alley_catgirl` — she has authored artwork at every milestone. */
async function grantBuddy(opts: { variant?: string; level?: number } = {}): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, 'alley_catgirl'));
  const [row] = await t.db
    .insert(playerWaifus)
    .values({
      playerId: prov.playerId,
      speciesId: sp!.id,
      level: opts.level ?? 20,
      ...(opts.variant === undefined ? {} : { variant: opts.variant }),
    })
    .returning();
  await app.collection.setBuddy(prov.playerId, row!.id);
  return row!.id;
}

function careInteraction(): PlayerInteraction {
  return {
    id: 'i-care',
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    followUp: vi.fn(async () => ({ id: 'm-care-note' })),
    deferUpdate: vi.fn(async () => {}),
    deleteReply: vi.fn(async () => undefined),
    options: { getString: () => null },
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    user: { id: USER_ID, username: 'Hunter' },
    member: { displayName: 'Whistler' },
  } as unknown as PlayerInteraction;
}

/** The minimum a profile paint reads off an event. */
function careEvent(kind: 'PLAYER_ENTERED_CARE' | 'CARE_TICK_APPLIED') {
  return {
    kind,
    playerId: prov.playerId,
    guildDbId: prov.guildDbId,
    channelId: CHANNEL_ID,
    playerName: 'Whistler',
  } as never;
}

interface SentPayload {
  embeds: EmbedBuilder[];
  files?: { attachment: unknown; name?: string | null }[];
}

/** The payload the profile was posted with. */
function posted(): SentPayload {
  expect(channel.send).toHaveBeenCalledTimes(1);
  return (channel.send.mock.calls as unknown as SentPayload[][])[0]![0]!;
}

function fieldNames(payload: SentPayload): string[] {
  return (payload.embeds[0]!.data.fields ?? []).map((f) => f.name);
}

describe('the buddy is visible', () => {
  it('attaches her picture and points the embed at it', async () => {
    await grantBuddy();

    await handleCareStart(ctx, careInteraction(), prov);

    const payload = posted();
    expect(payload.files).toHaveLength(1);
    expect(payload.files![0]!.name).toBe(CARD_FILENAME);
    expect(payload.embeds[0]!.data.image?.url).toBe(`attachment://${CARD_FILENAME}`);
  });

  it('uses the appearance she is equipped with', async () => {
    await grantBuddy({ variant: 'level_20', level: 20 });

    await handleCareStart(ctx, careInteraction(), prov);

    // The whole point: an unlocked, selected look must not be replaced by the
    // species default just because this is the profile rather than inspect.
    const file = String(posted().files![0]!.attachment);
    expect(path.basename(file)).toBe('level_20.png');
    expect(file).not.toContain('standard.png');
  });

  it('shows the default look for a copy wearing nothing else', async () => {
    await grantBuddy({ variant: 'standard', level: 3 });

    await handleCareStart(ctx, careInteraction(), prov);

    expect(path.basename(String(posted().files![0]!.attachment))).toBe('standard.png');
  });

  it('keeps every stat the profile already showed', async () => {
    await grantBuddy({ variant: 'level_10', level: 12 });

    await handleCareStart(ctx, careInteraction(), prov);

    const payload = posted();
    expect(fieldNames(payload)).toEqual(['👤 Trainer', '⭐ Buddy', '🎒 Collection', '💗 Activity']);
    const buddy = payload.embeds[0]!.data.fields!.find((f) => f.name === '⭐ Buddy')!;
    expect(buddy.value).toContain('Lv 12');
    expect(buddy.value).toContain('affection');
    expect(payload.embeds[0]!.data.title).toContain('Trainer Profile');
  });
});

describe('when the picture cannot be made', () => {
  it('falls back to the text-only profile', async () => {
    await grantBuddy();
    renderBuddy = async () => null;

    await handleCareStart(ctx, careInteraction(), prov);

    const payload = posted();
    expect(payload.files).toEqual([]);
    expect(payload.embeds[0]!.data.image).toBeUndefined();
    // The dashboard is unchanged otherwise — this is the profile that shipped
    // before cards, not a degraded one.
    expect(fieldNames(payload)).toEqual(['👤 Trainer', '⭐ Buddy', '🎒 Collection', '💗 Activity']);
  });

  it('starts Care Mode anyway when the renderer throws', async () => {
    await grantBuddy();
    renderBuddy = async () => {
      throw new Error('rasterizer unavailable');
    };

    await handleCareStart(ctx, careInteraction(), prov);

    expect((await app.care.getState(prov.playerId)).active).toBe(true);
    const payload = posted();
    expect(payload.files).toEqual([]);
    expect(fieldNames(payload)).toContain('💗 Activity');
    // And the profile pointer is stored, so ticks can still edit it.
    expect(await app.session.getProfileMessageId(prov.playerId, CHANNEL_ID)).not.toBeNull();
  });

  it('starts Care Mode when no renderer is wired at all', async () => {
    await grantBuddy();
    const textOnly = createTrainerProfileService({
      logger: t.logger,
      services: ctx.services,
      resolveChannel: async () => channel as unknown as ProfileChannel,
    });

    await textOnly.create(careEvent('PLAYER_ENTERED_CARE'));

    const payload = posted();
    expect(payload.files).toEqual([]);
    expect(payload.embeds[0]!.data.image).toBeUndefined();
  });
});

describe('the inspect card is unchanged', () => {
  /**
   * Inspect and the profile now share one image helper, extracted from what
   * inspect already did. This pins the half that must not have moved: the same
   * equipped-appearance artwork, under the same filename, alongside the same
   * detail fields.
   */
  it('still shows the equipped look with its full detail panel', async () => {
    const waifuId = await grantBuddy({ variant: 'level_30', level: 30 });
    const pick = {
      ...careInteraction(),
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      values: [String(waifuId)],
      message: { id: 'm-1' },
    } as unknown as PlayerInteraction;

    await handleCollectionPickCopy(ctx, pick, prov);

    // A select menu is a component interaction, so the screen is painted with
    // `update` rather than `reply`.
    const calls = (pick.update as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const payload = calls.at(-1)![0] as SentPayload;
    expect(path.basename(String(payload.files![0]!.attachment))).toBe('level_30.png');
    expect(payload.embeds[0]!.data.image?.url).toBe(`attachment://${CARD_FILENAME}`);
    expect(fieldNames(payload)).toEqual(
      expect.arrayContaining(['Rarity', 'Appearance', 'Level', 'XP', 'Affection', 'Essence']),
    );
  });
});

describe('refreshing the profile in place', () => {
  it('re-attaches the picture and clears the previous upload', async () => {
    const waifuId = await grantBuddy({ variant: 'level_20', level: 20 });
    await handleCareStart(ctx, careInteraction(), prov);
    const messageId = await app.session.getProfileMessageId(prov.playerId, CHANNEL_ID);

    // Her look changes; the dashboard edit must follow it.
    await t.db
      .update(playerWaifus)
      .set({ variant: 'level_10' })
      .where(eq(playerWaifus.id, waifuId));
    await profile.edit(careEvent('CARE_TICK_APPLIED'));

    expect(channel.messages.edit).toHaveBeenCalledTimes(1);
    const [editedId, payload] = channel.messages.edit.mock.calls[0] as unknown as [
      string,
      SentPayload & { attachments: unknown[] },
    ];
    expect(editedId).toBe(messageId);
    expect(path.basename(String(payload.files![0]!.attachment))).toBe('level_10.png');
    // Without this, discord.js keeps the old upload alongside the new one.
    expect(payload.attachments).toEqual([]);
  });
});
