/**
 * The travel-encounter trigger, through the path Discord actually calls.
 *
 * Written after a staging report that `travelChance = 1` produced "only one
 * encounter across repeated travels" and `forceTrigger = true` still "felt
 * random". Both turned out to be true reports of correct behaviour: the
 * settings are honoured at the dice, and the gates *after* the dice —
 * cooldowns, and the one-pending-encounter rule — then decline. Nothing in
 * the isolated settings tests could show that, because they call
 * `tryRollForTravel` directly and never build a second encounter on top of an
 * unresolved first.
 *
 * So these tests enter where Discord enters: `maybeTriggerTravelEncounter`,
 * the helper `handleLocationTravel` calls once travel has committed. Real
 * Postgres, real seeded encounters, real settings service.
 *
 * They also assert the structured `world-encounter/roll` line, because the
 * reason a roll produced nothing is now part of the contract — an operator
 * has to be able to tell these cases apart without a debugger.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activeWorldEncounters,
  worldEncounterCooldowns,
  worldEncounterSettings,
  worldEncounters,
} from '../../src/db/schema';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { maybeTriggerTravelEncounter } from '../../src/discord/commands/waifumonWorldEncounter';
import type { AppContext, Provisioned } from '../../src/discord/types';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;

/** Always loses a probability roll; only `forceTrigger` gets past it. */
const alwaysLoses = { next: () => 0.999, intInclusive: (a: number) => a };

beforeAll(async () => {
  t = await createTestDb();
  // The service's own rng always loses, so every encounter that fires below
  // fired because the configured chance or `forceTrigger` said so — never
  // because the dice happened to be kind.
  app = await bootstrapApp(t, { worldEncounterRng: alwaysLoses });
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-trigger', 'u-trigger'));
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db.delete(worldEncounterCooldowns).where(eq(worldEncounterCooldowns.playerId, playerId));
  await t.db.delete(worldEncounterSettings);
  app.worldEncounterSettings.invalidate();
  vi.restoreAllMocks();
});

const prov = () => ({ playerId, guildDbId }) as unknown as Provisioned;

const interaction = {
  channelId: 'c-1',
  replied: false,
  deferred: false,
  isButton: () => true,
  isStringSelectMenu: () => false,
  update: vi.fn(async () => {}),
  reply: vi.fn(async () => {}),
  editReply: vi.fn(async () => {}),
};

function makeCtx(): AppContext {
  return {
    config: { assetsDir: './assets' },
    logger: t.logger,
    db: t.db,
    content: app.content,
    services: {
      worldEncounter: app.worldEncounter,
      worldEncounterVendor: app.worldEncounterVendor,
      worldEncounterSettings: app.worldEncounterSettings,
      travel: app.travel,
    },
  } as unknown as AppContext;
}

/** One trip along the same edge, entered exactly where Discord enters. */
function travel(): Promise<boolean> {
  return maybeTriggerTravelEncounter(makeCtx(), interaction as never, prov(), {
    playerLevel: 10,
    originRegionId: 'waifu-valley',
    destinationRegionId: 'twin-peeks',
  });
}

/** Capture the structured roll lines emitted during one action. */
function captureRollLogs(): { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(t.logger, 'info').mockImplementation(((obj: unknown) => {
    const rec = obj as Record<string, unknown>;
    const tag = rec?.tag;
    if (tag === 'world-encounter/roll' || tag === 'world-encounter/roll-skipped') {
      lines.push(rec);
    }
  }) as never);
  return { lines };
}

/** Resolve whatever is pending, the way clicking the first choice would. */
async function resolvePending(): Promise<string | null> {
  const pending = await app.worldEncounter.repo.getPendingForPlayer(playerId);
  if (!pending) return null;
  const activation = await app.worldEncounter.getActivationById(pending.id, playerId);
  if (!activation) return null;
  await app.worldEncounter.resolveChoice({
    activeId: pending.id,
    playerId,
    choiceId: activation.encounter.choices[0]!.id,
  });
  return activation.encounter.slug;
}

describe('travelChance = 1 fires on every fresh, eligible travel', () => {
  it('fires, and keeps firing as long as the player resolves and candidates remain', async () => {
    await app.worldEncounterSettings.update({ travelChance: 1 }, null);

    // Two travel-eligible definitions ship, so two consecutive resolved trips
    // are the most a fresh player can see before cooldowns bite. Both fire.
    const first = await travel();
    expect(first).toBe(true);
    const firstSlug = await resolvePending();

    const second = await travel();
    expect(second).toBe(true);
    const secondSlug = await resolvePending();

    // Different encounters: the first one's cooldown removed it from the pool.
    expect(firstSlug).not.toBeNull();
    expect(secondSlug).not.toBeNull();
    expect(secondSlug).not.toBe(firstSlug);
  });

  it('reports the encounter it picked on the roll line', async () => {
    await app.worldEncounterSettings.update({ travelChance: 1 }, null);
    const { lines } = captureRollLogs();

    expect(await travel()).toBe(true);

    const line = lines.at(-1)!;
    expect(line.source).toBe('travel');
    expect(line.configuredChance).toBe(1);
    expect(line.probabilityPassed).toBe(true);
    expect(line.finalReason).toBe('selected');
    expect(line.selectedEncounterSlug).toEqual(expect.any(String));
    expect(line.candidateCountBeforeCooldown).toBe(2);
    expect(line.candidateCountAfterCooldown).toBe(2);
    expect(line.activeEncounterBlocked).toBe(false);
  });
});

describe('forceTrigger overrides the dice, and only the dice', () => {
  it('fires with a chance of zero and an rng that always loses', async () => {
    await app.worldEncounterSettings.update({ travelChance: 0, forceTrigger: true }, null);

    expect(await travel()).toBe(true);
  });

  it('does not fire with a chance of zero once force trigger is off again', async () => {
    await app.worldEncounterSettings.update({ travelChance: 0, forceTrigger: false }, null);

    expect(await travel()).toBe(false);
  });

  it('still declines when every candidate is on cooldown', async () => {
    // The point of the staging report: force trigger replaces the roll, not
    // the eligibility rules underneath it.
    await app.worldEncounterSettings.update({ travelChance: 1, forceTrigger: true }, null);
    await travel();
    await resolvePending();
    await travel();
    await resolvePending();

    const { lines } = captureRollLogs();
    expect(await travel()).toBe(false);

    const line = lines.at(-1)!;
    expect(line.forceTrigger).toBe(true);
    expect(line.probabilityPassed).toBe(true);
    expect(line.finalReason).toBe('all_on_cooldown');
    expect(line.candidateCountBeforeCooldown).toBe(2);
    expect(line.candidateCountAfterCooldown).toBe(0);
    expect(line.selectedEncounterSlug).toBeNull();
  });
});

describe('the gates after the dice are observable', () => {
  it('an unresolved encounter suppresses every later travel, and says so', async () => {
    // This is the exact staging scenario: chance of 1, one encounter fires,
    // the tester never picks a choice, and every later trip is silent.
    await app.worldEncounterSettings.update({ travelChance: 1 }, null);
    expect(await travel()).toBe(true);

    const { lines } = captureRollLogs();
    expect(await travel()).toBe(false);
    expect(await travel()).toBe(false);

    // The service names the blocked activation; the Discord helper says it
    // swallowed the error rather than failing.
    const skipped = lines.filter((l) => l.finalReason === 'active_encounter_open');
    expect(skipped.length).toBeGreaterThanOrEqual(2);
    expect(skipped.some((l) => l.activeEncounterBlocked === true)).toBe(true);
    expect(skipped.some((l) => l.tag === 'world-encounter/roll-skipped')).toBe(true);

    // And no second row was written — the protection still holds.
    const rows = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  it('a cooldown that has expired lets the same encounter fire again', async () => {
    await app.worldEncounterSettings.update({ travelChance: 1, forceTrigger: true }, null);
    await travel();
    await resolvePending();
    await travel();
    await resolvePending();
    expect(await travel()).toBe(false); // both on cooldown

    // Expire the cooldowns the way the clock would, and the pool refills.
    await t.db
      .update(worldEncounterCooldowns)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(worldEncounterCooldowns.playerId, playerId));

    expect(await travel()).toBe(true);
  });

  it('names an empty definition pool distinctly from a cooldown', async () => {
    await app.worldEncounterSettings.update({ travelChance: 1 }, null);
    // Disable both travel definitions: a different cause, a different reason.
    await t.db.update(worldEncounters).set({ lifecycle: 'disabled' });

    const { lines } = captureRollLogs();
    expect(await travel()).toBe(false);
    expect(lines.at(-1)!.finalReason).toBe('no_eligible_definitions');
    expect(lines.at(-1)!.candidateCountBeforeCooldown).toBe(0);

    await t.db.update(worldEncounters).set({ lifecycle: 'active' });
  });

  it('names a lost probability roll distinctly from every downstream gate', async () => {
    await app.worldEncounterSettings.update({ travelChance: 0.2, forceTrigger: false }, null);

    const { lines } = captureRollLogs();
    expect(await travel()).toBe(false);

    const line = lines.at(-1)!;
    expect(line.finalReason).toBe('probability_roll_lost');
    expect(line.probabilityPassed).toBe(false);
    // Nothing downstream was even consulted.
    expect(line.candidateCountBeforeCooldown).toBeNull();
  });
});

describe('settings reach the Discord path without a restart', () => {
  it('follows a change made between two travels', async () => {
    await app.worldEncounterSettings.update({ travelChance: 0 }, null);
    expect(await travel()).toBe(false);

    await app.worldEncounterSettings.update({ travelChance: 1 }, null);
    expect(await travel()).toBe(true);
  });

  it('logs the chance the operator actually saved', async () => {
    await app.worldEncounterSettings.update({ travelChance: 0.5, forceTrigger: true }, null);
    const { lines } = captureRollLogs();

    await travel();

    expect(lines.at(-1)!.configuredChance).toBeCloseTo(0.5, 5);
    expect(lines.at(-1)!.forceTrigger).toBe(true);
  });
});

describe('an abandoned encounter does not block the player forever', () => {
  it('retires a pending encounter that is past its expiry and rolls again', async () => {
    // The defect behind "only one encounter fired". Nothing swept
    // `active_world_encounters`: `hunt.expireStale()` covers the wild-Waifumon
    // table, and `resolveChoice` only notices an expiry when the player clicks
    // a choice — on an ephemeral they have very likely dismissed. A tester who
    // looked at one encounter and travelled on was blocked permanently.
    await app.worldEncounterSettings.update({ travelChance: 1 }, null);
    expect(await travel()).toBe(true);

    // Age it a day, the way an abandoned encounter ages.
    await t.db
      .update(activeWorldEncounters)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(activeWorldEncounters.playerId, playerId));

    expect(await travel()).toBe(true);

    const rows = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, playerId));
    // The stale one is closed, exactly one is live.
    expect(rows.filter((r) => r.status === 'expired')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('still refuses while the pending encounter is genuinely live', async () => {
    // The other half of the fix: the sweep is guarded on `expiresAt`, so it
    // retires abandoned encounters without weakening the one-pending rule.
    await app.worldEncounterSettings.update({ travelChance: 1 }, null);
    expect(await travel()).toBe(true);

    // Well inside its expiry window — untouched by the sweep.
    expect(await travel()).toBe(false);

    const rows = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });

  it('does not touch another player\u2019s expired encounter', async () => {
    const other = await provisionPlayer(app, 'g-trigger', 'u-other');
    await app.worldEncounterSettings.update({ travelChance: 1, forceTrigger: true }, null);

    // Give the other player a pending encounter, then age it.
    await maybeTriggerTravelEncounter(
      makeCtx(),
      interaction as never,
      { playerId: other.playerId, guildDbId } as unknown as Provisioned,
      { playerLevel: 10, originRegionId: 'waifu-valley', destinationRegionId: 'twin-peeks' },
    );
    await t.db
      .update(activeWorldEncounters)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(activeWorldEncounters.playerId, other.playerId));

    // Our player rolls; the sweep is player-scoped, so the other row stands.
    await travel();

    const [theirs] = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, other.playerId));
    expect(theirs!.status).toBe('pending');

    await t.db
      .delete(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, other.playerId));
  });
});

describe('the shipped travel pool is small enough to explain the report', () => {
  it('ships exactly two travel-eligible encounters, with long cooldowns', async () => {
    const rows = await t.db.select().from(worldEncounters);
    const travelPool = rows.filter((r) => r.travelEligible && r.lifecycle === 'active');

    // Not an assertion about what the pool *should* be — a guard so that the
    // next person to read the staging report can see the arithmetic that
    // makes "only one encounter" the expected outcome.
    expect(travelPool).toHaveLength(2);
    expect(travelPool.map((r) => r.cooldownSeconds).sort((a, b) => a - b)).toEqual([1800, 21600]);
  });
});
