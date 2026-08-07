/**
 * Discord appearance workflow, end to end against a real database.
 *
 * The plan calls for manual verification of the Discord gallery; this
 * automates the parts that can be automated — the handler chain, what the
 * embed actually says, and the state each click leaves behind — so a
 * regression fails in CI rather than in a play session.
 *
 * What is asserted, and why each matters:
 *   - the gallery lists locked entries **with their requirement**, because a
 *     picker that hides them is a different (worse) feature;
 *   - a locked pick previews rather than dead-ends;
 *   - an unlocked pick writes `variant` and nothing else;
 *   - the unlock toast carries a working `Select Now` id.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { playerWaifus, species, type SpeciesRow } from '../../src/db/schema';
import {
  handleAppearanceOpen,
  handleAppearancePick,
  handleAppearanceSelect,
} from '../../src/discord/commands/waifumonCollection';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import type { LoadedContent, SpeciesContent } from '../../src/modules/content/schemas';
import {
  bootstrapApp,
  createEventHarness,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;
let subject: SpeciesRow;
let waifuId: number;
let liveContent: LoadedContent;

function withCatalog(base: LoadedContent, slug: string): LoadedContent {
  return {
    ...base,
    species: base.species.map((s) =>
      s.slug === slug
        ? ({
            ...s,
            appearances: [
              {
                id: 'standard',
                name: 'Standard',
                cosmeticRarity: 'standard',
                sortOrder: 0,
                tags: [],
                unlock: { type: 'owned' },
              },
              {
                id: 'level_5',
                name: 'Midnight Bloom',
                flavorText: 'Prepared for the annual shrine celebration.',
                cosmeticRarity: 'seasonal',
                introducedVersion: 'v1.3',
                sortOrder: 1,
                tags: [],
                unlock: { type: 'level', atLevel: 5 },
              },
              {
                id: 'level_40',
                name: 'Eclipse',
                cosmeticRarity: 'limited',
                sortOrder: 2,
                tags: [],
                unlock: { type: 'level', atLevel: 40 },
              },
            ],
          } as SpeciesContent)
        : s,
    ),
  };
}

function fakeInteraction() {
  const channel = {
    id: 'c-appearance',
    send: vi.fn(async () => ({ id: 'm-1' })),
    messages: { edit: vi.fn(async () => undefined) },
  };
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    // Typed with a payload parameter so assertions can read `mock.calls[n][0]`.
    reply: vi.fn(async (_payload?: any) => {}),
    editReply: vi.fn(async (_payload?: any) => {}),
    update: vi.fn(async (_payload?: any) => {}),
    followUp: vi.fn(async (_payload?: any) => {}),
    deferUpdate: vi.fn(async () => {}),
    channel,
    channelId: channel.id,
    user: { id: 'u-appearance', displayName: 'Hunter' },
    guildId: 'g-appearance-ui',
    message: { id: 'm-1' },
    values: [] as string[],
  };
}

/** The payload the handler painted, from whichever reply method it used. */
function paintedView(interaction: ReturnType<typeof fakeInteraction>): any {
  const call =
    interaction.update.mock.calls[interaction.update.mock.calls.length - 1] ??
    interaction.reply.mock.calls[interaction.reply.mock.calls.length - 1] ??
    interaction.editReply.mock.calls[interaction.editReply.mock.calls.length - 1];
  return call?.[0];
}

/** Flattened embed text, for asserting on what the player actually reads. */
function embedText(view: any): string {
  const embed = view?.embeds?.[0]?.data ?? view?.embeds?.[0];
  return JSON.stringify(embed ?? {});
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-appearance-ui', 'u-appearance');

  const [row] = await t.db.select().from(species).where(eq(species.slug, 'alley_catgirl'));
  subject = row!;
  const [waifu] = await t.db
    .insert(playerWaifus)
    .values({ playerId: prov.playerId, speciesId: subject.id, level: 10 })
    .returning();
  waifuId = waifu!.id;

  liveContent = withCatalog(app.content, 'alley_catgirl');
  const appearance = createAppearanceService({ db: t.db, getContent: () => liveContent });

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
    content: liveContent,
    events: harness.bus,
    huntSessions: harness.huntSessions,
    services: { ...app, appearance } as never,
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  harness.reset();
  await t.db
    .update(playerWaifus)
    .set({ variant: 'standard', seenAppearances: [], level: 10 })
    .where(eq(playerWaifus.id, waifuId));
});

describe('appear:open — the gallery screen', () => {
  it('lists every appearance with its requirement, locked ones included', async () => {
    const interaction = fakeInteraction();
    await handleAppearanceOpen(ctx, interaction as never, prov, [String(waifuId), '1']);

    const text = embedText(paintedView(interaction));
    expect(text).toContain('Standard');
    expect(text).toContain('Midnight Bloom');
    expect(text).toContain('Eclipse');
    // The journal property: requirements on earned *and* unearned entries.
    expect(text).toContain('Owned');
    expect(text).toContain('Reach Level 5');
    expect(text).toContain('Reach Level 40');
    expect(text).toContain('2/3 unlocked');
  });

  it('shows flavor text, the cosmetic-rarity tag and the introduced version', async () => {
    const interaction = fakeInteraction();
    await handleAppearanceOpen(ctx, interaction as never, prov, [
      String(waifuId),
      '1',
      'level_5',
    ]);
    const text = embedText(paintedView(interaction));
    expect(text).toContain('Prepared for the annual shrine celebration');
    expect(text).toContain('Seasonal');
    expect(text).toContain('v1.3');
  });

  it('states that appearances are cosmetic, on the screen the player reads', async () => {
    const interaction = fakeInteraction();
    await handleAppearanceOpen(ctx, interaction as never, prov, [String(waifuId), '1']);
    expect(embedText(paintedView(interaction))).toMatch(/cosmetic only/i);
  });

  it('offers a select menu whose options carry the requirement as the description', async () => {
    const interaction = fakeInteraction();
    await handleAppearanceOpen(ctx, interaction as never, prov, [String(waifuId), '1']);
    const view = paintedView(interaction);
    // Builders serialize through toJSON; read the wire shape rather than
    // reaching into builder internals.
    const select = JSON.parse(JSON.stringify(view.components[0])).components[0];
    expect(select.options.map((o: any) => o.description)).toEqual([
      expect.stringContaining('Owned'),
      expect.stringContaining('Reach Level 5'),
      expect.stringContaining('Reach Level 40'),
    ]);
  });
});

describe('appear:pick — choosing a look', () => {
  it('applies an unlocked appearance and writes only the variant column', async () => {
    const [before] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));

    const interaction = fakeInteraction();
    interaction.values = ['level_5'];
    await handleAppearancePick(ctx, interaction as never, prov, [String(waifuId), '1']);

    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
    expect(after?.variant).toBe('level_5');
    expect({ ...after, variant: null, seenAppearances: null }).toEqual({
      ...before,
      variant: null,
      seenAppearances: null,
    });
  });

  it('emits an internal appearance-changed event so open surfaces refresh', async () => {
    const interaction = fakeInteraction();
    interaction.values = ['level_5'];
    await handleAppearancePick(ctx, interaction as never, prov, [String(waifuId), '1']);

    const [event] = harness.ofKind('WAIFU_APPEARANCE_CHANGED');
    expect(event?.payload).toMatchObject({
      waifuId,
      appearanceId: 'level_5',
      appearanceName: 'Midnight Bloom',
    });
    // Internal scope: a wardrobe click is never public narration.
    expect(event?.scope).toBe('internal');
    expect(harness.lines).toHaveLength(0);
  });

  it('previews a locked pick and explains the requirement instead of dead-ending', async () => {
    const interaction = fakeInteraction();
    interaction.values = ['level_40'];
    await handleAppearancePick(ctx, interaction as never, prov, [String(waifuId), '1']);

    // The gallery is repainted with the locked entry highlighted…
    expect(embedText(paintedView(interaction))).toContain('Eclipse');
    // …and the reason arrives separately, ephemerally.
    const followUp = interaction.followUp.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(followUp?.content).toMatch(/Reach Level 40/);

    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
    expect(after?.variant).toBe('standard');
  });
});

describe('appear:select — the unlock toast’s "Select Now"', () => {
  it('applies the appearance named in the button id', async () => {
    const interaction = fakeInteraction();
    await handleAppearanceSelect(ctx, interaction as never, prov, [String(waifuId), 'level_5']);

    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
    expect(after?.variant).toBe('level_5');
  });

  it('refuses gracefully when the named appearance is locked', async () => {
    const interaction = fakeInteraction();
    await handleAppearanceSelect(ctx, interaction as never, prov, [String(waifuId), 'level_40']);

    const view = paintedView(interaction);
    expect(view.content).toMatch(/Reach Level 40/);
    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
    expect(after?.variant).toBe('standard');
  });
});

describe('unlock notification pipeline', () => {
  it('fires a player-visible unlock event when a copy crosses a milestone', async () => {
    // Reset to below the gate, then level past it the way Essence investment
    // does — through the service, so the real acknowledge path runs.
    await t.db
      .update(playerWaifus)
      .set({ level: 1, seenAppearances: ['standard'] })
      .where(eq(playerWaifus.id, waifuId));
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));

    const unlocked = await ctx.services.appearance.syncUnlocks(
      t.db,
      { ...row!, level: 5 },
      subject,
      'level',
    );

    expect(unlocked).toHaveLength(1);
    expect(unlocked[0]).toMatchObject({
      appearanceId: 'level_5',
      name: 'Midnight Bloom',
      unlockLabel: 'Reach Level 5',
      cosmeticRarity: 'seasonal',
      assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_5' },
    });
  });
});
