/**
 * Declining a Waifumon a World Encounter triggered — the lifecycle that used
 * to have no terminal state.
 *
 * A `trigger_waifumon_encounter` effect writes a real `encounters` row during
 * resolution and the resolution screen paints "💗 Meet her" beside whichever
 * button *leaves* the encounter. Accepting hands the row to the capture flow,
 * which always ends it. Leaving ended nothing: the row stayed `active`, and
 * because `encounters_active_player_uq` allows exactly one active encounter,
 * the player's next hunt threw `ActiveEncounterError` and the Hunt screen
 * re-painted the Waifumon they had just walked away from. From the outside she
 * had followed them home.
 *
 * These tests own both halves of that lifecycle:
 *
 *   - ACCEPTED stays exactly as it was (the spawn is still live and capturable
 *     the moment resolution commits — nothing dismisses her early);
 *   - DECLINED is now terminal, on every exit the screen offers: Back to
 *     Hunting, Continue Journey, and Continue → out of a chain;
 *   - and the dismissal is narrow enough that no unrelated encounter can be
 *     swept up by it, which is the part that would be wrong to fix by clearing
 *     pending state at the start of a hunt.
 *
 * Real Postgres, real transactions, real indexes, and the Discord button
 * handlers entered where `client.ts` enters them.
 *
 * Requires Docker/testcontainers (or `TEST_DATABASE_URL`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  activeWorldEncounters,
  encounters,
  players,
  playerCurrencies,
  species,
  worldEncounters,
} from '../../src/db/schema';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { handleHuntReturn } from '../../src/discord/commands/waifumonHunt';
import { handleContinueJourney } from '../../src/discord/commands/waifumonLocations';
import { handleWorldEncounterContinue } from '../../src/discord/commands/waifumonWorldEncounter';
import type { AppContext, Provisioned } from '../../src/discord/types';

/** The encounter that spawns her, and the one it chains into. */
const SIGHTING_SLUG = 'test_decline_sighting';
const AFTERMATH_SLUG = 'test_decline_aftermath';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;
/** Stands in for "Witchy Mechanic": a known, named species the effect asks for. */
let herSlug: string;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-decline', 'u-decline'));
  const [sp] = await t.db.select().from(species).where(eq(species.enabled, true)).limit(1);
  if (!sp) throw new Error('no enabled species seeded');
  herSlug = sp.slug;
  await seedEncounters();
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 5000, essence: 1000, huntEnergy: 20 })
    .where(eq(playerCurrencies.playerId, playerId));
  // The hunt cooldown is real and short; clearing it keeps "the next hunt"
  // about the encounter lifecycle rather than about timing.
  await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
});

/**
 * Two purpose-built encounters rather than shipped ones: the sighting's only
 * job is an auto-succeeding check plus the wild-Waifumon effect, so nothing
 * here depends on authored content that may be re-tuned.
 */
async function seedEncounters(): Promise<void> {
  await app.worldEncounterAdmin.upsert({
    slug: SIGHTING_SLUG,
    name: 'Decline Sighting',
    description: 'Someone is tinkering in the undergrowth.',
    type: 'discovery',
    rarity: 'common',
    weight: 1,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: true,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    metadata: {},
    choices: [
      {
        // Choice 0 — she appears, and the resolution is terminal.
        label: 'Look closer',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [{ type: 'trigger_waifumon_encounter', speciesSlug: herSlug }],
        failureEffects: [],
      },
      {
        // Choice 1 — she appears *and* the story chains, so the screen offers
        // Continue → instead of Back to Hunting.
        label: 'Call out',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [
          { type: 'trigger_waifumon_encounter', speciesSlug: herSlug },
          { type: 'trigger_encounter', encounterSlug: AFTERMATH_SLUG },
        ],
        failureEffects: [],
      },
    ],
  });
  // Seeded second: the validator refuses an encounter nothing can reach, and
  // the sighting above is what makes this one a chain target.
  await app.worldEncounterAdmin.upsert({
    slug: AFTERMATH_SLUG,
    name: 'Decline Aftermath',
    description: 'The clearing is quiet again.',
    type: 'discovery',
    rarity: 'common',
    weight: 1,
    lifecycle: 'active',
    // A pure chain target: reachable only from the sighting below.
    huntEligible: false,
    travelEligible: false,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    metadata: {},
    choices: [
      {
        label: 'Move on',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [],
        failureEffects: [],
      },
    ],
  });
}

async function insertActiveFor(
  slug: string,
  source: 'hunt' | 'travel' = 'hunt',
): Promise<number> {
  const [encounter] = await t.db
    .select()
    .from(worldEncounters)
    .where(eq(worldEncounters.slug, slug));
  if (!encounter) throw new Error(`unknown encounter slug ${slug}`);
  const [row] = await t.db
    .insert(activeWorldEncounters)
    .values({
      playerId,
      encounterId: encounter.id,
      source,
      regionId: 'waifu-valley',
      originRegionId: source === 'travel' ? 'starter-town' : null,
      destinationRegionId: source === 'travel' ? 'waifu-valley' : null,
      guildId: guildDbId,
      channelId: 'c-1',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  return row!.id;
}

interface Triggered {
  /** The `active_world_encounters` row the exit buttons carry. */
  activeId: number;
  /** The spawned `encounters` row — "Witchy Mechanic". */
  encounterId: number;
  /** Set when the choice also chained. */
  continuationActiveId: number | null;
}

/** Hunt (or travel) → encounter → successful choice → she appears. */
async function triggerHer(opts: {
  choiceIndex?: number;
  source?: 'hunt' | 'travel';
} = {}): Promise<Triggered> {
  const activeId = await insertActiveFor(SIGHTING_SLUG, opts.source ?? 'hunt');
  const activation = await app.worldEncounter.getActivationById(activeId, playerId);
  if (!activation) throw new Error('no pending activation');
  const choice = activation.encounter.choices[opts.choiceIndex ?? 0];
  if (!choice) throw new Error('sighting has no such choice');
  const resolution = await app.worldEncounter.resolveChoice({
    activeId,
    playerId,
    choiceId: choice.id,
  });
  expect(resolution.wildEncounter?.status).toBe('created');
  expect(resolution.wildEncounter?.speciesSlug).toBe(herSlug);
  return {
    activeId,
    encounterId: resolution.wildEncounter!.encounterId!,
    continuationActiveId: resolution.continuationActiveId,
  };
}

async function stateOf(encounterId: number): Promise<string | null> {
  const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounterId));
  return row?.state ?? null;
}

/* ───────────────────────── Discord entry points ───────────────────────── */

function makeInteraction() {
  const painted: unknown[] = [];
  const record = vi.fn(async (body: unknown) => {
    painted.push(body);
  });
  return {
    painted,
    interaction: {
      channelId: 'c-1',
      replied: false,
      deferred: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      update: record,
      reply: record,
      editReply: record,
      followUp: record,
    },
  };
}

function makeCtx(): AppContext {
  return {
    config: { assetsDir: './assets' },
    logger: t.logger,
    db: t.db,
    content: app.content,
    getContent: () => app.content,
    services: {
      worldEncounter: app.worldEncounter,
      worldEncounterVendor: app.worldEncounterVendor,
      worldEncounterSettings: app.worldEncounterSettings,
      wildEncounters: app.wildEncounters,
      travel: app.travel,
      currency: app.currency,
      hunt: app.hunt,
    },
  } as unknown as AppContext;
}

const prov = () => ({ playerId, guildDbId }) as unknown as Provisioned;

/** Click "🏹 Back to Hunting" on the resolution screen. */
async function clickBackToHunting(activeId: number): Promise<void> {
  const { interaction } = makeInteraction();
  await handleHuntReturn(makeCtx(), interaction as never, prov(), [String(activeId)]);
}

/** Click "🚶 Continue Journey" on the resolution screen. */
async function clickContinueJourney(activeId: number): Promise<void> {
  const { interaction } = makeInteraction();
  await handleContinueJourney(makeCtx(), interaction as never, prov(), [String(activeId)]);
}

/** Click "Continue →" on a chained resolution screen. */
async function clickContinue(continuationId: number): Promise<void> {
  const { interaction } = makeInteraction();
  await handleWorldEncounterContinue(makeCtx(), interaction as never, prov(), [
    String(continuationId),
  ]);
}

/* ─────────────────────────── ACCEPTED ─────────────────────────── */

describe('accepting a triggered Waifumon', () => {
  it('leaves her live and capturable the moment resolution commits', async () => {
    const her = await triggerHer();

    // The "💗 Meet her" button's own lookup — nothing has closed her.
    const found = await app.wildEncounters.getPlayerEncounter(playerId, her.encounterId);
    expect(found).not.toBeNull();
    expect(found!.species.slug).toBe(herSlug);
    expect(found!.encounter.state).toBe('active');
    // And the ordinary capture flow still owns her: it answers for a spawned
    // encounter exactly as for a hunted one, with no spawn-specific path.
    await expect(
      app.capture.listEncounterItems(playerId, her.encounterId),
    ).resolves.toBeInstanceOf(Array);
  });

  it('ends her the way the capture flow always did — Let Her Go', async () => {
    const her = await triggerHer();
    await app.hunt.letHerGo(playerId, her.encounterId);
    expect(await stateOf(her.encounterId)).toBe('released');
  });
});

/* ─────────────────────────── DECLINED ─────────────────────────── */

describe('declining a triggered Waifumon', () => {
  it('consumes her when the player clicks Back to Hunting', async () => {
    const her = await triggerHer();
    expect(await stateOf(her.encounterId)).toBe('active');

    await clickBackToHunting(her.activeId);

    expect(await stateOf(her.encounterId)).toBe('released');
    // The player is no longer mid-encounter, which is the whole point.
    expect(await app.hunt.getActiveEncounter(playerId)).toBeNull();
  });

  it('consumes her when a travel encounter ends in Continue Journey', async () => {
    const her = await triggerHer({ source: 'travel' });

    await clickContinueJourney(her.activeId);

    expect(await stateOf(her.encounterId)).toBe('released');
  });

  it('consumes her when the player picks the story instead — Continue →', async () => {
    // The chain's spawn belongs to the *parent* activation while the button
    // carries the continuation's id, so this only passes if the service walks
    // `continuationOfId` to find her.
    const her = await triggerHer({ choiceIndex: 1 });
    expect(her.continuationActiveId).not.toBeNull();

    await clickContinue(her.continuationActiveId!);

    expect(await stateOf(her.encounterId)).toBe('released');
    // The continuation itself is untouched — the player is still in the story.
    const stillPending = await app.worldEncounter.getActivationById(
      her.continuationActiveId!,
      playerId,
    );
    expect(stillPending).not.toBeNull();
  });

  it('lets the next hunt be a normal hunt instead of replaying her', async () => {
    // The reported bug, end to end: decline, hunt, and she must not be the
    // answer. Before the fix this threw `ActiveEncounterError` and the Hunt
    // screen re-painted the declined Waifumon.
    const her = await triggerHer();
    await clickBackToHunting(her.activeId);

    const result = await app.hunt.hunt(playerId, 'c-1');

    // A real hunt ran: Energy was spent and a fresh result was rolled.
    const balances = await app.currency.getBalances(playerId);
    expect(balances.huntEnergy).toBe(19);
    if (result.kind === 'encounter') {
      expect(result.encounter.id).not.toBe(her.encounterId);
      // A hunted encounter, not a re-served spawn.
      expect(result.encounter.originKind).toBeNull();
    }
  });
});

/* ───────────────────── Scope: nothing else moves ───────────────────── */

describe('a dismissal reaches only the Waifumon that encounter spawned', () => {
  it('leaves a hunted encounter alone', async () => {
    // The exit button for a *resolved, unrelated* encounter must not close the
    // encounter the player is legitimately in. This is the case that a
    // "clear pending state when a hunt starts" fix would break.
    const activeId = await insertActiveFor(SIGHTING_SLUG);
    const activation = await app.worldEncounter.getActivationById(activeId, playerId);
    await app.worldEncounter.resolveChoice({
      activeId,
      playerId,
      // The choice whose spawn we then take away, so the dismissal below has
      // nothing of its own to find.
      choiceId: activation!.encounter.choices[0]!.id,
    });
    await t.db
      .update(encounters)
      .set({ state: 'released' })
      .where(eq(encounters.playerId, playerId));
    // Now the player hunts and meets someone the ordinary way.
    const hunted = await app.wildEncounters.createWildEncounter({
      playerId,
      speciesSlug: herSlug,
      channelId: 'c-1',
      regionId: 'waifu-valley',
      // A hunted row has no origin at all, which is what the dismissal's
      // guard excludes.
      origin: { kind: 'world_encounter', ref: null },
    });
    expect(hunted.status).toBe('created');
    if (hunted.status !== 'created') return;

    await clickBackToHunting(activeId);

    expect(await stateOf(hunted.encounter.id)).toBe('active');
  });

  it('leaves a spawn from another subsystem alone', async () => {
    const quest = await app.wildEncounters.createWildEncounter({
      playerId,
      speciesSlug: herSlug,
      channelId: 'c-1',
      regionId: 'waifu-valley',
      origin: { kind: 'quest', ref: 'quest-42' },
    });
    expect(quest.status).toBe('created');
    if (quest.status !== 'created') return;
    // A resolved world encounter whose own spawn was blocked by the quest one.
    const activeId = await insertActiveFor(SIGHTING_SLUG);
    const activation = await app.worldEncounter.getActivationById(activeId, playerId);
    const resolution = await app.worldEncounter.resolveChoice({
      activeId,
      playerId,
      choiceId: activation!.encounter.choices[0]!.id,
    });
    expect(resolution.wildEncounter?.status).toBe('blocked');

    await clickBackToHunting(activeId);

    expect(await stateOf(quest.encounter.id)).toBe('active');
  });

  it('leaves another player’s spawn, and a forged id, alone', async () => {
    const other = await provisionPlayer(app, 'g-decline', 'u-decline-2');
    const theirs = await app.wildEncounters.createWildEncounter({
      playerId: other.playerId,
      speciesSlug: herSlug,
      channelId: 'c-2',
      regionId: 'waifu-valley',
      origin: { kind: 'world_encounter', ref: 'someone-elses' },
    });
    expect(theirs.status).toBe('created');
    if (theirs.status !== 'created') return;

    // An id that is not this player's activation dismisses nothing at all.
    const dismissed = await app.worldEncounter.abandonTriggeredEncounter(999_999, playerId);
    expect(dismissed.status).toBe('nothing_to_dismiss');
    expect(await stateOf(theirs.encounter.id)).toBe('active');

    await t.db.delete(encounters).where(eq(encounters.playerId, other.playerId));
  });

  it('leaves an unrelated pending world encounter pending', async () => {
    const her = await triggerHer();
    // A second activation the player has not resolved yet — legitimate pending
    // state that the decline must not sweep.
    const pendingId = await insertActiveFor(AFTERMATH_SLUG);

    await clickBackToHunting(her.activeId);

    expect(await stateOf(her.encounterId)).toBe('released');
    const stillPending = await app.worldEncounter.getActivationById(pendingId, playerId);
    expect(stillPending).not.toBeNull();
  });
});

/* ───────────────────────── Idempotence ───────────────────────── */

describe('repeated exits cannot resurrect or re-close her', () => {
  it('is a no-op on the second click', async () => {
    const her = await triggerHer();

    await clickBackToHunting(her.activeId);
    const first = await t.db.select().from(encounters).where(eq(encounters.id, her.encounterId));
    await clickBackToHunting(her.activeId);
    await clickBackToHunting(her.activeId);
    const after = await t.db.select().from(encounters).where(eq(encounters.id, her.encounterId));

    expect(after[0]!.state).toBe('released');
    // Not even `resolved_at` moves, so the terminal state is genuinely written
    // once rather than re-written on every click.
    expect(after[0]!.resolvedAt?.getTime()).toBe(first[0]!.resolvedAt?.getTime());
    expect(await app.hunt.getActiveEncounter(playerId)).toBeNull();
  });

  it('reports nothing to dismiss, rather than failing, when she was captured', async () => {
    const her = await triggerHer();
    await t.db
      .update(encounters)
      .set({ state: 'captured', resolvedAt: new Date() })
      .where(eq(encounters.id, her.encounterId));

    const dismissed = await app.worldEncounter.abandonTriggeredEncounter(her.activeId, playerId);

    expect(dismissed.status).toBe('nothing_to_dismiss');
    // A capture is not downgraded to a release by a late exit click.
    expect(await stateOf(her.encounterId)).toBe('captured');
  });

  it('cannot bring her back after the exit — a hunt still rolls fresh', async () => {
    const her = await triggerHer();
    await clickBackToHunting(her.activeId);
    await clickBackToHunting(her.activeId);

    const result = await app.hunt.hunt(playerId, 'c-1');
    if (result.kind === 'encounter') {
      expect(result.encounter.id).not.toBe(her.encounterId);
    }
    expect(await stateOf(her.encounterId)).toBe('released');
  });
});

/* ───────────────────────────── Expiry ───────────────────────────── */

describe('expiry cannot leak a triggered Waifumon into a later hunt', () => {
  it('a hunt past her expiry retires her and rolls its own result', async () => {
    const her = await triggerHer();
    // She is spawned with the hunt's own encounter expiry; walk the clock past
    // it the only way a test can.
    await t.db
      .update(encounters)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(encounters.id, her.encounterId));

    const result = await app.hunt.hunt(playerId, 'c-1');

    expect(await stateOf(her.encounterId)).toBe('expired');
    if (result.kind === 'encounter') {
      expect(result.encounter.id).not.toBe(her.encounterId);
    }
  });

  it('an exit clicked after she expired leaves her expired', async () => {
    const her = await triggerHer();
    await t.db
      .update(encounters)
      .set({ state: 'expired', resolvedAt: new Date() })
      .where(eq(encounters.id, her.encounterId));

    await clickBackToHunting(her.activeId);

    expect(await stateOf(her.encounterId)).toBe('expired');
  });

  it('she is not reachable through the Meet button once she is gone', async () => {
    const her = await triggerHer();
    await clickBackToHunting(her.activeId);
    await expect(
      app.wildEncounters.getPlayerEncounter(playerId, her.encounterId),
    ).resolves.toBeNull();
  });
});

/* ─────────────── Chain traversal: cycles and other players ─────────────── */

describe('the continuation walk is safe on data it should never see', () => {
  it('terminates on a cyclic chain and still dismisses the right Waifumon', async () => {
    // `continuation_of_id` carries no cycle constraint, so a future bug could
    // write one. The 16-hop cap must turn that into an ordinary dismissal
    // rather than a button click that never returns.
    const her = await triggerHer({ choiceIndex: 1 });
    const parentId = her.activeId;
    const childId = her.continuationActiveId!;
    // Close the loop: parent → child → parent.
    await t.db
      .update(activeWorldEncounters)
      .set({ continuationOfId: childId })
      .where(eq(activeWorldEncounters.id, parentId));

    const dismissed = await app.worldEncounter.abandonTriggeredEncounter(childId, playerId);

    expect(dismissed.status).toBe('released');
    expect(await stateOf(her.encounterId)).toBe('released');
  });

  it('is a self-cycle-proof no-op when the loop owns no spawn', async () => {
    const activeId = await insertActiveFor(AFTERMATH_SLUG);
    await t.db
      .update(activeWorldEncounters)
      .set({ continuationOfId: activeId })
      .where(eq(activeWorldEncounters.id, activeId));

    const dismissed = await app.worldEncounter.abandonTriggeredEncounter(activeId, playerId);

    expect(dismissed.status).toBe('nothing_to_dismiss');
  });

  it('stops at a link belonging to another player', async () => {
    // A chain doctored to point into someone else's activation. The walk ends
    // at the ownership check, and the dismissal's own `player_id` guard is the
    // second rail behind it — neither may be the only one holding.
    const other = await provisionPlayer(app, 'g-decline', 'u-decline-3');
    const theirActiveId = await (async () => {
      const [encounter] = await t.db
        .select()
        .from(worldEncounters)
        .where(eq(worldEncounters.slug, SIGHTING_SLUG));
      const [row] = await t.db
        .insert(activeWorldEncounters)
        .values({
          playerId: other.playerId,
          encounterId: encounter!.id,
          source: 'hunt',
          regionId: 'waifu-valley',
          guildId: other.guildDbId,
          channelId: 'c-2',
          contextJson: {},
          expiresAt: new Date(Date.now() + 10 * 60_000),
        })
        .returning();
      return row!.id;
    })();
    const theirs = await app.wildEncounters.createWildEncounter({
      playerId: other.playerId,
      speciesSlug: herSlug,
      channelId: 'c-2',
      regionId: 'waifu-valley',
      origin: { kind: 'world_encounter', ref: String(theirActiveId) },
    });
    expect(theirs.status).toBe('created');
    if (theirs.status !== 'created') return;

    const mine = await insertActiveFor(AFTERMATH_SLUG);
    await t.db
      .update(activeWorldEncounters)
      .set({ continuationOfId: theirActiveId })
      .where(eq(activeWorldEncounters.id, mine));

    const dismissed = await app.worldEncounter.abandonTriggeredEncounter(mine, playerId);

    expect(dismissed.status).toBe('nothing_to_dismiss');
    expect(await stateOf(theirs.encounter.id)).toBe('active');

    await t.db.delete(encounters).where(eq(encounters.playerId, other.playerId));
    await t.db
      .delete(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, other.playerId));
  });
});

/* ───────────────────── Concurrency: Meet her vs exit ───────────────────── */

describe('a decline racing a capture cannot overwrite the capture', () => {
  it('loses the race and dismisses nothing when the capture commits first', async () => {
    // The scenario worth proving rather than reasoning about: the player mashes
    // "Meet her" and the exit button, and the capture transaction wins the row
    // lock. Both capture entry points take `SELECT … FOR UPDATE` on the
    // encounter and re-check `state` under that lock, and the dismissal's own
    // `state = 'active'` guard is re-evaluated against the committed row
    // version (Read Committed, which this deployment never overrides), so the
    // dismissal must find nothing left to close.
    const her = await triggerHer();

    let dismissal!: Promise<{ status: string }>;
    await t.db.transaction(async (tx) => {
      // Stand in for the capture commit: take the lock, then reach a terminal
      // state, exactly as `attemptCapture` does.
      await tx
        .select()
        .from(encounters)
        .where(eq(encounters.id, her.encounterId))
        .for('update');
      await tx
        .update(encounters)
        .set({ state: 'captured', resolvedAt: new Date() })
        .where(eq(encounters.id, her.encounterId));
      // Fire the exit click on its own connection while the lock is held, and
      // give it time to actually reach the lock before this transaction
      // commits — otherwise the test would prove nothing about ordering.
      dismissal = app.wildEncounters.dismissWildEncounter({
        playerId,
        origin: { kind: 'world_encounter', refs: [String(her.activeId)] },
      }) as Promise<{ status: string }>;
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    await expect(dismissal).resolves.toMatchObject({ status: 'nothing_to_dismiss' });
    expect(await stateOf(her.encounterId)).toBe('captured');
  });

  it('is refused by the capture path when the decline commits first', async () => {
    // The mirror ordering. The dismissal wins, and the capture attempt then
    // reads `released` under its own lock and refuses — the player is told she
    // is gone rather than capturing an encounter they had walked away from.
    const her = await triggerHer();
    await clickBackToHunting(her.activeId);

    await expect(
      app.capture.attemptCapture(playerId, her.encounterId),
    ).rejects.toThrow();
    expect(await stateOf(her.encounterId)).toBe('released');
  });
});

/* ─────────────────── The spawner's own contract ─────────────────── */

describe('dismissWildEncounter', () => {
  it('matches on any ref in the chain it is given', async () => {
    const spawn = await app.wildEncounters.createWildEncounter({
      playerId,
      speciesSlug: herSlug,
      channelId: 'c-1',
      regionId: 'waifu-valley',
      origin: { kind: 'world_encounter', ref: '7' },
    });
    expect(spawn.status).toBe('created');

    const dismissed = await app.wildEncounters.dismissWildEncounter({
      playerId,
      origin: { kind: 'world_encounter', refs: ['5', '6', '7'] },
    });

    expect(dismissed.status).toBe('released');
  });

  it('dismisses nothing when handed no refs', async () => {
    await app.wildEncounters.createWildEncounter({
      playerId,
      speciesSlug: herSlug,
      channelId: 'c-1',
      regionId: 'waifu-valley',
      origin: { kind: 'world_encounter', ref: '7' },
    });

    const dismissed = await app.wildEncounters.dismissWildEncounter({
      playerId,
      origin: { kind: 'world_encounter', refs: [] },
    });

    expect(dismissed.status).toBe('nothing_to_dismiss');
    const [row] = await t.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
    expect(row).toBeTruthy();
  });
});
