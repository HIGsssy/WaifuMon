/**
 * Chained follow-ups open only while `active` — real Postgres.
 *
 * Chains deliberately bypass the chance roll and the follow-up's own repeat
 * cooldown (the chain is already running). They must not bypass status: a
 * draft or disabled encounter never reaches a player. A skipped follow-up
 * ends the chain at the parent: the parent still resolves and records
 * history, no pending row is left behind, and the player is free to get the
 * next encounter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { activeWorldEncounters, worldEncounterHistory, worldEncounters } from '../../src/db/schema';
import type { EncounterInput } from '../../src/modules/worldEncounters/types';
import { followUpBlock } from '../../src/modules/worldEncounters/worldEncounterService';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;

function input(slug: string, over: Partial<EncounterInput> = {}): EncounterInput {
  return {
    slug,
    name: slug,
    description: '',
    type: 'decision',
    rarity: 'common',
    weight: 1,
    lifecycle: 'active',
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
        label: 'Go',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [],
        failureEffects: [],
      },
    ],
    ...over,
  };
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-inactive-follow', 'u-1'));

  // Parent (hunt-eligible) → child. The parent is written first, so the
  // chain-only child is reachable when it is saved.
  await app.worldEncounterAdmin.upsert(
    input('fu_parent', {
      huntEligible: true,
      lifecycle: 'draft',
      choices: [
        {
          label: 'Open it',
          emoji: null,
          requirements: {},
          check: { type: 'none' },
          successEffects: [
            { type: 'essence_gain', amount: 5 },
            { type: 'trigger_encounter', encounterSlug: 'fu_child' },
          ],
          failureEffects: [],
        },
      ],
    }),
  );
  await app.worldEncounterAdmin.upsert(input('fu_child'));
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
});

async function setChildLifecycle(lifecycle: 'active' | 'draft' | 'disabled') {
  await t.db.update(worldEncounters).set({ lifecycle }).where(eq(worldEncounters.slug, 'fu_child'));
}

async function resolveParent(source: 'hunt' | 'travel' = 'hunt') {
  const [parent] = await t.db.select().from(worldEncounters).where(eq(worldEncounters.slug, 'fu_parent'));
  const [row] = await t.db
    .insert(activeWorldEncounters)
    .values({
      playerId,
      encounterId: parent!.id,
      source,
      regionId: 'waifu-valley',
      originRegionId: source === 'travel' ? 'waifu-valley' : null,
      destinationRegionId: source === 'travel' ? 'twin-peeks' : null,
      guildId: guildDbId,
      channelId: 'c-1',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  const loaded = await app.worldEncounterAdmin.getBySlug('fu_parent');
  const resolution = await app.worldEncounter.resolveChoice({
    activeId: row!.id,
    playerId,
    choiceId: loaded!.choices[0]!.id,
  });
  return { activeId: row!.id, resolution };
}

async function pendingRows() {
  return t.db
    .select()
    .from(activeWorldEncounters)
    .where(and(eq(activeWorldEncounters.playerId, playerId), eq(activeWorldEncounters.status, 'pending')));
}

describe('chained follow-up lifecycle', () => {
  it('an active follow-up opens as a pending continuation', async () => {
    await setChildLifecycle('active');
    const { activeId, resolution } = await resolveParent();
    expect(resolution.skippedFollowUp).toBeNull();
    expect(resolution.continuationActiveId).not.toBeNull();
    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.continuationOfId).toBe(activeId);
  });

  it.each(['disabled', 'draft'] as const)('a %s follow-up does not open', async (lifecycle) => {
    await setChildLifecycle(lifecycle);
    const { resolution } = await resolveParent();
    expect(resolution.continuationActiveId).toBeNull();
    expect(resolution.skippedFollowUp).toEqual({
      encounterSlug: 'fu_child',
      reason: 'inactive',
      lifecycle,
    });
    expect(await pendingRows()).toHaveLength(0);
  });

  it('a skipped follow-up still completes the parent and returns control to the player', async () => {
    await setChildLifecycle('disabled');
    const { activeId, resolution } = await resolveParent('travel');

    // The parent resolved: its other effects applied, history written,
    // the skip recorded on the resolution for auditing.
    expect(resolution.effectsApplied.some((e) => e.effect.type === 'essence_gain')).toBe(true);
    const [row] = await t.db.select().from(activeWorldEncounters).where(eq(activeWorldEncounters.id, activeId));
    expect(row!.status).toBe('resolved');
    expect((row!.resolutionJson as { skippedFollowUp?: unknown }).skippedFollowUp).toMatchObject({
      reason: 'inactive',
    });
    const history = await t.db
      .select()
      .from(worldEncounterHistory)
      .where(eq(worldEncounterHistory.playerId, playerId));
    expect(history.length).toBeGreaterThan(0);

    // Terminal controls: the journey can continue, nothing is left pending,
    // so the one-open-encounter rule does not block the next encounter.
    expect(resolution.journey).toEqual({ destinationRegionId: 'twin-peeks' });
    expect(await pendingRows()).toHaveLength(0);
  });

  it('a follow-up that does not exist is reported as missing, the same clean way', async () => {
    await app.worldEncounterAdmin.upsert(
      input('fu_dangling', {
        huntEligible: true,
        choices: [
          {
            label: 'Go',
            emoji: null,
            requirements: {},
            check: { type: 'none' },
            successEffects: [{ type: 'trigger_encounter', encounterSlug: 'fu_nowhere' }],
            failureEffects: [],
          },
        ],
      }),
    );
    const loaded = await app.worldEncounterAdmin.getBySlug('fu_dangling');
    const [row] = await t.db
      .insert(activeWorldEncounters)
      .values({
        playerId,
        encounterId: loaded!.id,
        source: 'hunt',
        regionId: 'waifu-valley',
        guildId: guildDbId,
        channelId: 'c-1',
        contextJson: {},
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
      .returning();
    const resolution = await app.worldEncounter.resolveChoice({
      activeId: row!.id,
      playerId,
      choiceId: loaded!.choices[0]!.id,
    });
    expect(resolution.skippedFollowUp).toEqual({ encounterSlug: 'fu_nowhere', reason: 'missing', lifecycle: null });
    expect(resolution.huntReturn).toEqual({ regionId: 'waifu-valley' });
    expect(await pendingRows()).toHaveLength(0);
  });
});

/*
 * The same rule when the follow-up was queued while active, then changed
 * before the player clicked Continue. The Continue button calls
 * `openContinuation`, which re-checks status at the moment of opening.
 */
describe('queued follow-up re-checked at Continue', () => {
  async function queue(source: 'hunt' | 'travel' = 'travel') {
    await setChildLifecycle('active');
    const { resolution } = await resolveParent(source);
    expect(resolution.continuationActiveId).not.toBeNull();
    return resolution.continuationActiveId!;
  }

  async function childHistory() {
    const [child] = await t.db.select().from(worldEncounters).where(eq(worldEncounters.slug, 'fu_child'));
    return t.db
      .select()
      .from(worldEncounterHistory)
      .where(and(eq(worldEncounterHistory.playerId, playerId), eq(worldEncounterHistory.encounterId, child!.id)));
  }

  it('an Active queued follow-up still opens', async () => {
    const queuedId = await queue();
    const outcome = await app.worldEncounter.openContinuation(queuedId, playerId);
    expect(outcome?.status).toBe('opened');
    if (outcome?.status !== 'opened') throw new Error('expected opened');
    expect(outcome.activation.activeId).toBe(queuedId);
    expect(outcome.activation.encounter.slug).toBe('fu_child');
    // Opening presents it; it stays pending until the player chooses.
    expect((await pendingRows()).map((r) => r.id)).toEqual([queuedId]);
  });

  it.each(['disabled', 'draft'] as const)('a queued follow-up set to %s is skipped', async (lifecycle) => {
    const queuedId = await queue('travel');
    const before = (await childHistory()).length;
    await setChildLifecycle(lifecycle);

    const outcome = await app.worldEncounter.openContinuation(queuedId, playerId);
    expect(outcome).toEqual({
      status: 'skipped',
      activeId: queuedId,
      skippedFollowUp: { encounterSlug: 'fu_child', reason: 'inactive', lifecycle },
      // The trip the chain belonged to carries on.
      journey: { destinationRegionId: 'twin-peeks' },
      huntReturn: null,
    });

    // Closed, with the reason on record; nothing left pending.
    const [row] = await t.db.select().from(activeWorldEncounters).where(eq(activeWorldEncounters.id, queuedId));
    expect(row!.status).toBe('abandoned');
    expect(row!.resolvedAt).not.toBeNull();
    expect(row!.resolutionJson).toMatchObject({
      stage: 'continue',
      skippedFollowUp: { encounterSlug: 'fu_child', reason: 'inactive', lifecycle },
    });
    expect(await pendingRows()).toHaveLength(0);
    // None of the follow-up ran.
    expect((await childHistory()).length).toBe(before);
  });

  it('leaves no stale state: a second Continue finds nothing, and play moves on', async () => {
    const queuedId = await queue('hunt');
    await setChildLifecycle('disabled');
    const first = await app.worldEncounter.openContinuation(queuedId, playerId);
    expect(first).toMatchObject({ status: 'skipped', huntReturn: { regionId: 'waifu-valley' }, journey: null });

    expect(await app.worldEncounter.openContinuation(queuedId, playerId)).toBeNull();
    expect(await app.worldEncounter.getActivationById(queuedId, playerId)).toBeNull();
    // The one-open-encounter rule no longer sees anything: a fresh encounter
    // can be queued for this player straight away.
    await setChildLifecycle('active');
    const { resolution } = await resolveParent('hunt');
    expect(resolution.continuationActiveId).not.toBeNull();
  });

  it('never opens a queued continuation for another player', async () => {
    const queuedId = await queue();
    const other = await provisionPlayer(app, 'g-inactive-follow', 'u-2');
    expect(await app.worldEncounter.openContinuation(queuedId, other.playerId)).toBeNull();
    expect((await pendingRows()).map((r) => r.id)).toEqual([queuedId]);
  });

  it('a missing queued follow-up is skipped the same way (shared rule)', () => {
    // The database cannot hold a queued row for a deleted encounter (the
    // foreign key refuses the delete), so "missing" is pinned on the one rule
    // both stages share rather than by corrupting the schema.
    expect(followUpBlock('fu_gone', null)).toEqual({
      encounterSlug: 'fu_gone',
      reason: 'missing',
      lifecycle: null,
    });
    expect(followUpBlock('fu_child', { lifecycle: 'active' })).toBeNull();
  });
});
