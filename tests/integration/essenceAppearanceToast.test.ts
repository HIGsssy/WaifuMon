/**
 * Appearance unlock toasts from Essence investment — real Postgres.
 *
 * Essence investment is the main way a copy crosses a level milestone, but the
 * collection handler used to drop `newAppearances` on the floor: the toast
 * helper was imported and never called, so the reward the player just earned
 * was announced by every other flow except this one. These tests pin the fix.
 *
 * `alley_catgirl` carries authored milestones at levels 10/20/30/40/50, so the
 * copy's starting level decides exactly how many unlocks a spend crosses.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleWaifuInvest,
  handleWaifuInvestSubmit,
} from '../../src/discord/commands/waifumonCollection';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import { playerCurrencies, playerWaifus, species } from '../../src/db/schema';
import type { AppContext, Provisioned } from '../../src/discord/types';
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
let ctx: AppContext;
let costPer: number;
let xpPer: number;

const SLUG = 'alley_catgirl';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-essence-toast', 'u-1');
  const cfg = app.content.tables.waifuProgression;
  costPer = cfg.essenceInvestment.essenceCost;
  xpPer = cfg.essenceInvestment.xpGranted;
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
    collectionFilters: createCollectionFilterTracker(),
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
    },
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  await t.db
    .update(playerCurrencies)
    .set({ essence: costPer * 500 })
    .where(eq(playerCurrencies.playerId, prov.playerId));
  harness.reset();
});

/** XP a copy needs to sit exactly at `level`. */
function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += app.collection.waifuXpToNext(l);
  return total;
}

async function grantAt(level: number, xpOffset = 0): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, SLUG));
  const xp = xpForLevel(level) + xpOffset;
  const row = await insertOwnedWaifu(t.db, { playerId: prov.playerId, speciesId: sp!.id, level, xp });
  return row!.id;
}

function fakeButton() {
  const state = { replied: false, deferred: false };
  return {
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    reply: vi.fn(async () => {
      state.replied = true;
    }),
    editReply: vi.fn(async () => {
      state.replied = true;
    }),
    update: vi.fn(async () => {
      state.replied = true;
    }),
    followUp: vi.fn(async () => {
      if (!state.replied && !state.deferred) throw new Error('InteractionNotReplied');
    }),
    deferUpdate: vi.fn(async () => {
      state.deferred = true;
    }),
    showModal: vi.fn(async () => {}),
    message: { id: 'm-1' },
    channelId: 'c-1',
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-essence-toast',
  };
}

const fakeModal = (fields: Record<string, string>) => ({
  ...fakeButton(),
  isButton: () => false,
  isModalSubmit: () => true,
  fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
});

/** Every followUp payload that is an appearance-unlock toast. */
function toasts(interaction: { followUp: ReturnType<typeof vi.fn> }): any[] {
  const calls = interaction.followUp.mock.calls as unknown as any[][];
  return calls
    .map((c) => c[0])
    .filter((p) => p?.embeds?.[0]?.data?.title?.includes('New Appearance Unlocked'));
}

function toastAppearanceNames(interaction: { followUp: ReturnType<typeof vi.fn> }): string[] {
  return toasts(interaction).map((p) => p.embeds[0].data.description as string);
}

describe('1× investment', () => {
  it('posts an unlock toast when it crosses a milestone', async () => {
    // One application short of level 10, where the first alternate look sits.
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    const posted = toasts(i);
    expect(posted).toHaveLength(1);
    expect(posted[0].embeds[0].data.description).toContain('Level 10');
    // The toast offers the one-click apply the rest of the game uses.
    expect(posted[0].components[0].components[0].data.custom_id).toContain('appear|select');
  });

  it('posts no toast when the investment crosses no milestone', async () => {
    const waifuId = await grantAt(1);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    expect(toasts(i)).toHaveLength(0);
  });

  it('posts nothing at all when the spend does not complete a level', async () => {
    // One XP short of level 2 after the spend, whatever the shipped curve is.
    const waifuId = await grantAt(1, xpForLevel(2) - xpPer - 1);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    expect(i.followUp).not.toHaveBeenCalled();
    expect(toasts(i)).toHaveLength(0);
  });

  it('posts the level-up note but no toast when the new level has no artwork', async () => {
    // Lands exactly on level 2 — a real level-up, but nothing is authored
    // before level 10, so the note fires alone.
    const waifuId = await grantAt(1, xpForLevel(2) - xpPer);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    const levelNote = (i.followUp.mock.calls as unknown as any[][])
      .map((c) => c[0])
      .find((p) => typeof p?.content === 'string' && p.content.includes('advanced to Lv'));
    expect(levelNote).toBeDefined();
    expect(toasts(i)).toHaveLength(0);
  });
});

describe('batched investment', () => {
  /**
   * Seed `applications` short of `level` so one batch lands exactly on it.
   * A copy that has never had unlocks synced still has an empty
   * `seen_appearances`, so arriving at level 30 reports 10, 20 *and* 30 — the
   * detector reports every unlocked-but-unseen look, not just the last rung.
   * That keeps these tests inside the 100-per-batch ceiling, which the shipped
   * curve would otherwise blow past long before level 30.
   */
  async function seedShortOf(level: number, applications: number): Promise<number> {
    return grantAt(level - 1, xpForLevel(level) - xpForLevel(level - 1) - xpPer * applications);
  }

  it('announces every milestone the batch crossed', async () => {
    const waifuId = await seedShortOf(30, 5);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '5']);

    const descriptions = toastAppearanceNames(i);
    expect(descriptions).toHaveLength(3);
    expect(descriptions.join('\n')).toContain('Level 10');
    expect(descriptions.join('\n')).toContain('Level 20');
    expect(descriptions.join('\n')).toContain('Level 30');
  });

  it('caps the burst and says how many more are waiting', async () => {
    // Landing on 50 reports 10/20/30/40/50 — five, above the three-toast cap.
    const waifuId = await seedShortOf(50, 2);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '2']);

    expect(toasts(i)).toHaveLength(3);
    const overflow = (i.followUp.mock.calls as unknown as any[][])
      .map((c) => c[0])
      .find((p) => typeof p?.content === 'string' && p.content.includes('more new look'));
    expect(overflow).toBeDefined();
    expect(overflow.content).toContain('2');
  });

  it('still posts the level-up note alongside the toasts', async () => {
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '5']);

    const levelNote = (i.followUp.mock.calls as unknown as any[][])
      .map((c) => c[0])
      .find((p) => typeof p?.content === 'string' && p.content.includes('advanced to Lv'));
    expect(levelNote).toBeDefined();
    expect(levelNote.content).toContain('5× Essence');
  });
});

describe('no duplicate toasts', () => {
  it('does not re-announce a look the copy has already seen', async () => {
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);

    const first = fakeButton();
    await handleWaifuInvest(ctx, first as never, prov, [String(waifuId), '1']);
    expect(toasts(first)).toHaveLength(1);

    // Investing again from just past the same milestone must stay silent —
    // `syncUnlocks` diffs against `seen_appearances` inside the transaction.
    const second = fakeButton();
    await handleWaifuInvest(ctx, second as never, prov, [String(waifuId), '1']);
    expect(toasts(second)).toHaveLength(0);
  });

  it('a later batch announces only the milestone that is genuinely new', async () => {
    // Land on 20 first: reports 10 and 20 together.
    const waifuId = await grantAt(19, xpForLevel(20) - xpForLevel(19) - xpPer * 3);
    const first = fakeButton();
    await handleWaifuInvest(ctx, first as never, prov, [String(waifuId), '3']);
    expect(toasts(first)).toHaveLength(2);

    // Other XP sources (buddy hunts, Care Mode) carry her most of the way to
    // 30; the next spend should announce 30 alone, never 10 or 20 again.
    await t.db
      .update(playerWaifus)
      .set({ level: 29, xp: xpForLevel(30) - xpPer * 2 })
      .where(eq(playerWaifus.id, waifuId));

    const second = fakeButton();
    await handleWaifuInvest(ctx, second as never, prov, [String(waifuId), '2']);
    const descriptions = toastAppearanceNames(second);
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toContain('Level 30');
  });
});

/**
 * The public half: an unlock earned through Essence should reach the Waifumon
 * Log exactly as one earned by a capture or a buddy hunt does. An ordinary
 * spend must stay private — this is the one gameplay action a player can
 * repeat dozens of times in a sitting, so only the unlock itself is public.
 */
describe('public Waifumon Log announcements', () => {
  const unlockEvents = () => harness.ofKind('WAIFU_APPEARANCE_UNLOCKED');

  /** Feed lines that narrate an appearance unlock. */
  const unlockLines = () => harness.lines.filter((l) => l.text.includes('unlocked a new look'));

  it('emits one public event when a 1× spend crosses a threshold', async () => {
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    const events = unlockEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.appearanceName).toContain('Level 10');
    expect(events[0]!.payload.speciesSlug).toBe(SLUG);
    expect(unlockLines()).toHaveLength(1);
  });

  it('emits one public event per unlock a batch produced', async () => {
    // Landing on 30 reports 10, 20 and 30 — three separate log entries.
    const waifuId = await grantAt(29, xpForLevel(30) - xpForLevel(29) - xpPer * 5);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '5']);

    const names = unlockEvents().map((e) => e.payload.appearanceName);
    expect(names).toHaveLength(3);
    expect(names.join('\n')).toContain('Level 10');
    expect(names.join('\n')).toContain('Level 20');
    expect(names.join('\n')).toContain('Level 30');
    // The 3-toast cap is an ephemeral nicety; the public record is complete.
    expect(unlockLines()).toHaveLength(3);
  });

  it('stays silent when a spend unlocks nothing', async () => {
    const waifuId = await grantAt(1, xpForLevel(2) - xpPer);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    expect(unlockEvents()).toHaveLength(0);
    expect(unlockLines()).toHaveLength(0);
  });

  it('never re-announces a look the copy has already seen', async () => {
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);

    await handleWaifuInvest(ctx, fakeButton() as never, prov, [String(waifuId), '1']);
    expect(unlockEvents()).toHaveLength(1);

    harness.reset();
    await handleWaifuInvest(ctx, fakeButton() as never, prov, [String(waifuId), '1']);
    expect(unlockEvents()).toHaveLength(0);
    expect(unlockLines()).toHaveLength(0);
  });

  it('names the player in the public line', async () => {
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    const [line] = unlockLines();
    expect(line!.text).toContain('<@u-1>');
    expect(line!.text).toContain('Level 10');
  });

  it('names the copy the way other public producers do', async () => {
    // Public narration uses the bare nickname, not the collection UI's
    // "Nickname (Species)" form.
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);
    await t.db.update(playerWaifus).set({ nickname: 'Mochi' }).where(eq(playerWaifus.id, waifuId));

    await handleWaifuInvest(ctx, fakeButton() as never, prov, [String(waifuId), '1']);

    const [sp] = await t.db.select().from(species).where(eq(species.slug, SLUG));
    const [event] = unlockEvents();
    expect(event!.payload.waifuName).toBe('Mochi');
    // The species name is not appended in parentheses the way the collection
    // list renders it — the log says "Mochi", not "Mochi (Alley Catgirl)".
    expect(unlockLines()[0]!.text).not.toContain(`(${sp!.name})`);
  });

  it('posts the public line and the private toast together', async () => {
    const waifuId = await grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);
    const i = fakeButton();

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    // Both halves fire; neither replaces the other.
    expect(toasts(i)).toHaveLength(1);
    expect(unlockLines()).toHaveLength(1);
  });

  it('announces unlocks from the custom modal too', async () => {
    const waifuId = await grantAt(19, xpForLevel(20) - xpForLevel(19) - xpPer * 4);
    const modal = fakeModal({ applications: '4' });

    await handleWaifuInvestSubmit(ctx, modal as never, prov, [String(waifuId)]);

    expect(unlockEvents()).toHaveLength(2);
  });
});

describe('custom-amount modal', () => {
  it('announces unlocks from a custom spend too', async () => {
    const waifuId = await grantAt(19, xpForLevel(20) - xpForLevel(19) - xpPer * 4);

    const modal = fakeModal({ applications: '4' });
    await handleWaifuInvestSubmit(ctx, modal as never, prov, [String(waifuId)]);

    const descriptions = toastAppearanceNames(modal);
    expect(descriptions).toHaveLength(2);
    expect(descriptions.join('\n')).toContain('Level 10');
    expect(descriptions.join('\n')).toContain('Level 20');
  });

  it('posts nothing extra when a custom spend crosses no milestone', async () => {
    const waifuId = await grantAt(1);
    const modal = fakeModal({ applications: '1' });

    await handleWaifuInvestSubmit(ctx, modal as never, prov, [String(waifuId)]);

    expect(toasts(modal)).toHaveLength(0);
  });
});
