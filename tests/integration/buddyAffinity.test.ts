/**
 * Buddy Affinity capture bonuses (Milestone 5D) — real Postgres, real seeding.
 *
 * Shipped content is all `switch`, so these tests re-point two seeded species
 * at real affinities (the same move the manual verification checklist makes)
 * and assert the end-to-end effect: the modifier the CaptureService applies,
 * the audit metadata it records, and the affinity read the UI renders.
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureAttempts,
  encounters,
  playerCurrencies,
  playerInventory,
  playerProgressionEvents,
  playerWaifus,
  players,
  species,
  type Affinity,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createCaptureService } from '../../src/modules/capture/captureService';
import type { Rng } from '../../src/shared/random';
import {
  handleEncounterCharm,
  handleEncounterPick,
} from '../../src/discord/commands/waifumonHunt';
import { handleCollectionPickId } from '../../src/discord/commands/waifumonCollection';
import { handleProfile } from '../../src/discord/commands/waifumon';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { ASSETS_DIR, bootstrapApp, getItemBySlug, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

/** N-rarity buddy species → +1% strong bonus; SR → +3%. */
const BUDDY_SLUG = 'neko_barista'; // N
const RARE_BUDDY_SLUG = 'neon_kitsune'; // SR
const ENCOUNTER_SLUG = 'gym_oni'; // N
const SWITCH_ENCOUNTER_SLUG = 'cyber_neko'; // N, left on switch

let t: TestDb;
let app: App;
let ctx: AppContext;
let prov: Provisioned;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  prov = await provisionPlayer(app, 'g-affinity', 'u-1');
  ctx = {
    config: {
      assetsDir: ASSETS_DIR,
      contentDir: process.cwd(),
      dailyTimezone: 'UTC',
      discordToken: 'x',
      discordClientId: 'x',
      discordGuildId: undefined,
      databaseUrl: 'postgres://x',
      logLevel: 'info',
    },
    logger: t.logger,
    db: t.db,
    content: app.content,
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
      care: app.care,
      progression: app.progression,
      quests: app.quests,
      session: app.session,
    },
  } as unknown as AppContext;
});
afterAll(async () => {
  await t.cleanup();
});

function scriptedRng(nexts: number[]): Rng {
  let i = 0;
  return {
    next: () => {
      if (i >= nexts.length) throw new Error(`scriptedRng exhausted at ${i}`);
      return nexts[i++]!;
    },
    intInclusive(min, max) {
      const v = nexts[i++]!;
      return Math.floor(v * (max - min + 1)) + min;
    },
  };
}

function captureWith(rng?: Rng) {
  return createCaptureService({
    db: t.db,
    inventory: app.inventory,
    progression: app.progression,
    progressionConfig: app.content.tables.progression,
    captureConfig: app.content.tables.capture,
    buddyAffinityConfig: app.content.tables.buddyAffinity,
    collection: app.collection,
    quests: app.quests,
    logger: t.logger,
    ...(rng ? { rng } : {}),
  });
}

async function setAffinity(slug: string, affinity: Affinity): Promise<void> {
  await t.db.update(species).set({ affinity }).where(eq(species.slug, slug));
}

async function speciesBySlug(slug: string): Promise<SpeciesRow> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, slug));
  if (!row) throw new Error(`missing seeded species ${slug}`);
  return row;
}

/** Grants an owned copy of `slug` and makes it the active buddy. */
async function giveBuddy(slug: string): Promise<number> {
  const s = await speciesBySlug(slug);
  const [row] = await t.db
    .insert(playerWaifus)
    .values({ playerId: prov.playerId, speciesId: s.id })
    .returning();
  await app.collection.setBuddy(prov.playerId, row!.id);
  return row!.id;
}

async function grantItem(slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, prov.playerId, item.id, qty);
}

async function createEncounter(slug: string): Promise<EncounterRow> {
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, prov.playerId), eq(encounters.state, 'active')));
  const s = await speciesBySlug(slug);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId: prov.playerId,
      speciesId: s.id,
      channelId: 'c-affinity',
      state: 'active',
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return row!;
}

beforeEach(async () => {
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, prov.playerId));
  await t.db
    .delete(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, prov.playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, prov.playerId));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, prov.playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, prov.playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 25, waifubux: 0, essence: 0 })
    .where(eq(playerCurrencies.playerId, prov.playerId));
  // Reset the species we re-point, so tests are order-independent.
  await setAffinity(BUDDY_SLUG, 'switch');
  await setAffinity(RARE_BUDDY_SLUG, 'switch');
  await setAffinity(ENCOUNTER_SLUG, 'switch');
  await setAffinity(SWITCH_ENCOUNTER_SLUG, 'switch');
});

describe('seeded affinity column', () => {
  it('every seeded species lands on switch from the shipped content', async () => {
    const rows = await t.db.select({ slug: species.slug, affinity: species.affinity }).from(species);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.affinity !== 'switch')).toEqual([]);
  });
});

describe('CaptureService — buddy affinity modifier', () => {
  it('a strong matchup adds the buddy-rarity bonus to the computed chance', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await giveBuddy(BUDDY_SLUG);
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    // gym_oni: N base 0.50 × Basic 1.0 = 0.50, + N buddy bonus 0.01 = 0.51.
    const result = await captureWith(scriptedRng([0.99])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.affinity.matchup).toBe('strong');
    expect(result.affinity.buddyAffinity).toBe('dominant');
    expect(result.affinity.encounterAffinity).toBe('submissive');
    expect(result.affinity.buddyAffinityModifier).toBeCloseTo(0.01, 10);
    expect(result.attempt.computedChance).toBeCloseTo(0.51, 5);
    expect(result.affinity.finalChance).toBeCloseTo(0.51, 5);
  });

  it('scales the bonus by the buddy rarity, not the encounter rarity', async () => {
    await setAffinity(RARE_BUDDY_SLUG, 'dominant'); // SR buddy → +3%
    await setAffinity(ENCOUNTER_SLUG, 'submissive'); // N encounter
    await giveBuddy(RARE_BUDDY_SLUG);
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const result = await captureWith(scriptedRng([0.99])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.affinity.buddyAffinityModifier).toBeCloseTo(0.03, 10);
    expect(result.attempt.computedChance).toBeCloseTo(0.53, 5);
  });

  it('a weak matchup applies no penalty in this milestone', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'primal'); // primal beats dominant
    await giveBuddy(BUDDY_SLUG);
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const result = await captureWith(scriptedRng([0.99])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.affinity.matchup).toBe('weak');
    expect(result.affinity.buddyAffinityModifier).toBe(0);
    expect(result.attempt.computedChance).toBeCloseTo(0.5, 5);
  });

  it('a switch buddy stays neutral with no modifier', async () => {
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await giveBuddy(BUDDY_SLUG); // left on switch
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const result = await captureWith(scriptedRng([0.99])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.affinity.matchup).toBe('neutral');
    expect(result.affinity.buddyAffinity).toBe('switch');
    expect(result.affinity.buddyAffinityModifier).toBe(0);
    expect(result.attempt.computedChance).toBeCloseTo(0.5, 5);
  });

  it('a switch encounter stays neutral with no modifier', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await giveBuddy(BUDDY_SLUG);
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(SWITCH_ENCOUNTER_SLUG); // left on switch

    const result = await captureWith(scriptedRng([0.99])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.affinity.matchup).toBe('neutral');
    expect(result.affinity.encounterAffinity).toBe('switch');
    expect(result.affinity.buddyAffinityModifier).toBe(0);
  });

  it('no buddy means no modifier', async () => {
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const result = await captureWith(scriptedRng([0.99])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.affinity.buddyWaifuId).toBeNull();
    expect(result.affinity.buddyAffinity).toBeNull();
    expect(result.affinity.matchup).toBe('neutral');
    expect(result.affinity.buddyAffinityModifier).toBe(0);
    expect(result.attempt.computedChance).toBeCloseTo(0.5, 5);
  });

  it('a released (stale) buddy grants no modifier and self-heals the pointer', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    const buddyId = await giveBuddy(BUDDY_SLUG);
    // Soft-release the buddy row behind the FK-less pointer.
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, buddyId));
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const result = await captureWith(scriptedRng([0.99])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.affinity.buddyWaifuId).toBeNull();
    expect(result.affinity.buddyAffinityModifier).toBe(0);
    expect(result.attempt.computedChance).toBeCloseTo(0.5, 5);
    const [player] = await t.db.select().from(players).where(eq(players.id, prov.playerId));
    expect(player?.buddyWaifuId).toBeNull();
  });

  it('the bonus can flip a roll that would otherwise fail', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await giveBuddy(BUDDY_SLUG);
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    // 0.505 sits above the base 0.50 but below the buddy-boosted 0.51.
    const result = await captureWith(scriptedRng([0.505])).attemptCapture(
      prov.playerId,
      enc.id,
      'basic_charm',
    );
    expect(result.outcome).toBe('success');
  });

  it('a guaranteed capture still bypasses the formula', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await giveBuddy(BUDDY_SLUG);
    await grantItem('mythic_contract', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const result = await captureWith().attemptCapture(prov.playerId, enc.id, 'mythic_contract');
    expect(result.outcome).toBe('success');
    expect(result.attempt.computedChance).toBe(1);
    // The read is still reported for the log/UI even though it wasn't applied.
    expect(result.affinity.matchup).toBe('strong');
  });

  it('records the affinity read in the capture progression-event metadata', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    const buddyId = await giveBuddy(BUDDY_SLUG);
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);
    await captureWith(scriptedRng([0.0])).attemptCapture(prov.playerId, enc.id, 'basic_charm');

    const [event] = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(
        and(
          eq(playerProgressionEvents.playerId, prov.playerId),
          eq(playerProgressionEvents.eventType, 'capture_success'),
        ),
      )
      .orderBy(desc(playerProgressionEvents.id))
      .limit(1);
    expect(event?.metadata).toMatchObject({
      buddyWaifuId: buddyId,
      buddyAffinity: 'dominant',
      encounterAffinity: 'submissive',
      affinityMatchup: 'strong',
      buddyAffinityModifier: 0.01,
    });
    expect((event?.metadata as { finalChance: number }).finalChance).toBeCloseTo(0.51, 5);
  });
});

// ─────────────────────────────── UI surfaces ───────────────────────────────

interface FakeChannel {
  id: string;
  send: ReturnType<typeof vi.fn>;
  messages: { edit: ReturnType<typeof vi.fn> };
}

function fakeChannel(id = 'c-affinity'): FakeChannel {
  return {
    id,
    send: vi.fn(async () => ({ id: `m-${id}` })),
    messages: { edit: vi.fn(async () => undefined) },
  };
}

function fakeButton(channel = fakeChannel()) {
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
    channel,
    channelId: channel.id,
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-affinity',
  };
}

/** Pulls every rendered embed out of whichever paint path the handler took. */
function renderedEmbeds(btn: ReturnType<typeof fakeButton>): Record<string, unknown>[] {
  const payloads = [
    ...btn.update.mock.calls,
    ...btn.editReply.mock.calls,
    ...btn.reply.mock.calls,
    ...btn.channel.send.mock.calls,
    ...btn.channel.messages.edit.mock.calls,
  ].map((c) => c[c.length - 1]) as Array<{ embeds?: Array<{ toJSON?: () => unknown }> }>;
  return payloads.flatMap((p) =>
    (p?.embeds ?? []).map((e) =>
      (typeof e?.toJSON === 'function' ? e.toJSON() : e) as Record<string, unknown>,
    ),
  );
}

function fieldValues(embeds: Record<string, unknown>[]): string {
  return embeds
    .flatMap((e) => (e.fields ?? []) as Array<{ name: string; value: string }>)
    .map((f) => `${f.name}: ${f.value}`)
    .join('\n');
}

describe('UI — affinity read on the encounter reveal', () => {
  it('shows the strong read with the buddy bonus', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await giveBuddy(BUDDY_SLUG);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterPick(ctx, btn as any, prov, [String(enc.id)]);
    const text = fieldValues(renderedEmbeds(btn));
    expect(text).toContain('Affinity Read: Dominant beats Submissive. Buddy bonus: +1%.');
    expect(text).toContain('Affinity: Submissive');
  });

  it('explains a switch buddy', async () => {
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await giveBuddy(BUDDY_SLUG); // switch
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterPick(ctx, btn as any, prov, [String(enc.id)]);
    expect(fieldValues(renderedEmbeds(btn))).toContain(
      'Affinity Read: Your buddy is Switch, so this matchup stays neutral.',
    );
  });

  it('explains a switch encounter', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await giveBuddy(BUDDY_SLUG);
    const enc = await createEncounter(SWITCH_ENCOUNTER_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterPick(ctx, btn as any, prov, [String(enc.id)]);
    expect(fieldValues(renderedEmbeds(btn))).toContain(
      'Affinity Read: This Waifumon is Switch, making the matchup neutral.',
    );
  });

  it('flags an unfavorable matchup without promising a penalty', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'primal');
    await giveBuddy(BUDDY_SLUG);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterPick(ctx, btn as any, prov, [String(enc.id)]);
    expect(fieldValues(renderedEmbeds(btn))).toContain(
      'Affinity Read: This matchup is unfavorable. No buddy bonus.',
    );
  });

  it('omits the buddy read entirely when no buddy is set', async () => {
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterPick(ctx, btn as any, prov, [String(enc.id)]);
    const text = fieldValues(renderedEmbeds(btn));
    expect(text).not.toContain('Affinity Read:');
    // The encounter's own affinity still renders.
    expect(text).toContain('Affinity: Submissive');
  });
});

describe('UI — buddy bonus on the capture result', () => {
  it('shows the applied bonus and the resulting capture chance', async () => {
    await setAffinity(BUDDY_SLUG, 'dominant');
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await giveBuddy(BUDDY_SLUG);
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterCharm(ctx, btn as any, prov, [String(enc.id), 'basic_charm']);
    const text = fieldValues(renderedEmbeds(btn));
    expect(text).toContain('🤝 Buddy Bonus');
    expect(text).toContain('+1% — Dominant beats Submissive');
    expect(text).toContain('Capture chance: **51%**');
  });

  it('omits the bonus block when the player has no buddy', async () => {
    await setAffinity(ENCOUNTER_SLUG, 'submissive');
    await grantItem('basic_charm', 1);
    const enc = await createEncounter(ENCOUNTER_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterCharm(ctx, btn as any, prov, [String(enc.id), 'basic_charm']);
    expect(fieldValues(renderedEmbeds(btn))).not.toContain('Buddy Bonus');
  });
});

describe('UI — affinity on inspect and profile', () => {
  it('inspect shows the owned Waifumon affinity', async () => {
    await setAffinity(BUDDY_SLUG, 'caregiver');
    const waifuId = await giveBuddy(BUDDY_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleCollectionPickId(ctx, btn as any, prov, [String(waifuId)]);
    expect(fieldValues(renderedEmbeds(btn))).toContain('Affinity: Caregiver');
  });

  it('inspect shows Switch for un-tuned species', async () => {
    const waifuId = await giveBuddy(BUDDY_SLUG); // still switch

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleCollectionPickId(ctx, btn as any, prov, [String(waifuId)]);
    expect(fieldValues(renderedEmbeds(btn))).toContain('Affinity: Switch');
  });

  it('profile shows the active buddy affinity', async () => {
    await setAffinity(BUDDY_SLUG, 'primal');
    await giveBuddy(BUDDY_SLUG);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, btn as any, prov);
    expect(fieldValues(renderedEmbeds(btn))).toContain('Primal');
  });
});
