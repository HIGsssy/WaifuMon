/**
 * Authored outcome flavor text — real Postgres, real `resolveChoice`.
 *
 * Pins the runtime half of the feature:
 *   - the resolution carries the flavor for the outcome that actually happened;
 *   - flavor changes nothing else — check, effects, failure effects, chaining;
 *   - history snapshots the resolved line, so editing the encounter later
 *     cannot rewrite what a player was shown;
 *   - history rows written before the column existed still read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  activeWorldEncounters,
  worldEncounterHistory,
  worldEncounters,
} from '../../src/db/schema';
import { EncounterInputSchema, type LoadedEncounter } from '../../src/modules/worldEncounters/types';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const SUCCESS = 'You make it across just as the final plank gives way behind you.';
const FAILURE = 'The bridge snaps beneath your feet, forcing a frantic retreat.';
const GENERIC = 'You continue deeper into the ruins.';

/** First draw 0 → success; 0.999 → failure (the resolver clamps to 5–95 %). */
const WIN = { next: () => 0, intInclusive: (a: number) => a };
const LOSE = { next: () => 0.999, intInclusive: (a: number) => a };

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;

const effects = {
  successEffects: [
    { type: 'waifubux_gain', amount: 100 },
    { type: 'trigger_encounter', encounterSlug: 'tv_bandit_aftermath' },
  ],
  failureEffects: [{ type: 'waifubux_loss', amount: 10 }],
};
const checked = { type: 'sp', baseChance: 0.5, maxSpModifier: 0 };

function input(choiceText: { cross?: Record<string, string> } = {}) {
  return EncounterInputSchema.parse({
    slug: 'flavor_bridge',
    name: 'Crumbling Bridge',
    type: 'skill_check',
    rarity: 'common',
    huntEligible: true,
    choices: [
      {
        label: 'Cross',
        check: checked,
        ...effects,
        ...(choiceText.cross ?? { outcomeText: GENERIC, successText: SUCCESS, failureText: FAILURE }),
      },
      // Byte-identical to Cross except for the flavor: the control.
      { label: 'Cross (plain)', check: checked, ...effects },
      { label: 'Fallback', check: checked, ...effects, outcomeText: GENERIC },
      {
        label: 'Follow',
        check: { type: 'none' },
        outcomeText: 'You follow the strange footprints.',
        // Stored but unreachable: a no-check choice never reads branch text.
        successText: 'never shown',
      },
      { label: 'Silent', check: { type: 'none' } },
    ],
  });
}

let encounter: LoadedEncounter;
const choiceId = (label: string) => encounter.choices.find((c) => c.label === label)!.id;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-flavor', 'u-flavor'));
  encounter = await app.worldEncounterAdmin.upsert(input());
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
});

async function openActive(): Promise<number> {
  const [row] = await t.db
    .insert(activeWorldEncounters)
    .values({
      playerId,
      encounterId: encounter.id,
      source: 'hunt',
      regionId: 'waifu-valley',
      originRegionId: null,
      destinationRegionId: null,
      guildId: guildDbId,
      channelId: 'c-flavor',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  return row!.id;
}

async function resolve(label: string, rng: typeof WIN) {
  const activeId = await openActive();
  const resolution = await app.worldEncounter.resolveChoice({
    activeId,
    playerId,
    choiceId: choiceId(label),
    rng,
  });
  // The continuation (if any) is a new pending row; clear it for the next call.
  await t.db
    .delete(activeWorldEncounters)
    .where(and(eq(activeWorldEncounters.playerId, playerId), eq(activeWorldEncounters.status, 'pending')));
  return { activeId, resolution };
}

async function latestHistory() {
  const [row] = await t.db
    .select()
    .from(worldEncounterHistory)
    .where(eq(worldEncounterHistory.playerId, playerId))
    .orderBy(desc(worldEncounterHistory.id))
    .limit(1);
  return row!;
}

describe('resolution: flavor for the outcome that happened', () => {
  it('stores and hydrates the authored fields', () => {
    const cross = encounter.choices.find((c) => c.label === 'Cross')!;
    expect(cross).toMatchObject({ outcomeText: GENERIC, successText: SUCCESS, failureText: FAILURE });
    expect(encounter.choices.find((c) => c.label === 'Silent')).toMatchObject({
      outcomeText: null,
      successText: null,
      failureText: null,
    });
  });

  it('checked success resolves successText', async () => {
    const { resolution } = await resolve('Cross', WIN);
    expect(resolution.check.success).toBe(true);
    expect(resolution.resolvedOutcomeText).toBe(SUCCESS);
  });

  it('checked failure resolves failureText', async () => {
    const { resolution } = await resolve('Cross', LOSE);
    expect(resolution.check.success).toBe(false);
    expect(resolution.resolvedOutcomeText).toBe(FAILURE);
  });

  it('checked outcomes fall back to outcomeText', async () => {
    expect((await resolve('Fallback', WIN)).resolution.resolvedOutcomeText).toBe(GENERIC);
    expect((await resolve('Fallback', LOSE)).resolution.resolvedOutcomeText).toBe(GENERIC);
  });

  it('a no-check choice uses outcomeText and ignores stored branch text', async () => {
    expect((await resolve('Follow', WIN)).resolution.resolvedOutcomeText).toBe(
      'You follow the strange footprints.',
    );
  });

  it('no authored text resolves to null', async () => {
    expect((await resolve('Silent', WIN)).resolution.resolvedOutcomeText).toBeNull();
    expect((await resolve('Cross (plain)', LOSE)).resolution.resolvedOutcomeText).toBeNull();
  });

  it('writes the resolved line onto the active row resolution', async () => {
    const { activeId } = await resolve('Cross', LOSE);
    const [row] = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.id, activeId));
    expect(row!.resolutionJson).toMatchObject({ resolvedOutcomeText: FAILURE, success: false });
  });
});

describe('flavor changes nothing else', () => {
  /** Everything a resolution decides, minus flavor and per-row ids. */
  const essence = (r: Awaited<ReturnType<typeof resolve>>['resolution']) => ({
    success: r.check.success,
    chance: r.check.chance,
    roll: r.check.roll,
    effects: r.effectsApplied.map((e) => ({ effect: e.effect, applied: e.applied, amount: e.amount })),
    followUps: r.followUps,
    chainedEncounterSlug: r.chainedEncounterSlug,
    continues: r.continuationActiveId != null,
  });

  it('success: same check, same effects, same chaining', async () => {
    const flavored = (await resolve('Cross', WIN)).resolution;
    const plain = (await resolve('Cross (plain)', WIN)).resolution;
    expect(essence(flavored)).toEqual(essence(plain));
    expect(flavored.continuationActiveId).not.toBeNull();
    expect(flavored.effectsApplied.some((e) => e.effect.type === 'waifubux_gain')).toBe(true);
  });

  it('failure: same check, same failureEffects, no continuation', async () => {
    const flavored = (await resolve('Cross', LOSE)).resolution;
    const plain = (await resolve('Cross (plain)', LOSE)).resolution;
    expect(essence(flavored)).toEqual(essence(plain));
    expect(flavored.continuationActiveId).toBeNull();
    expect(flavored.effectsApplied.map((e) => e.effect.type)).toEqual(['waifubux_loss']);
  });
});

describe('history stability', () => {
  it('snapshots the resolved flavor into world_encounter_history', async () => {
    await resolve('Cross', WIN);
    const row = await latestHistory();
    expect(row.resolvedOutcomeText).toBe(SUCCESS);
    expect(row.success).toBe(true);
  });

  it('stores null when no flavor was shown', async () => {
    await resolve('Silent', WIN);
    expect((await latestHistory()).resolvedOutcomeText).toBeNull();
  });

  it('editing the authored text later does not change a historical row', async () => {
    await resolve('Cross', LOSE);
    const before = await latestHistory();
    expect(before.resolvedOutcomeText).toBe(FAILURE);

    encounter = await app.worldEncounterAdmin.upsert(
      input({ cross: { outcomeText: 'Rewritten.', failureText: 'A rewritten failure.' } }),
    );

    const [after] = await t.db
      .select()
      .from(worldEncounterHistory)
      .where(eq(worldEncounterHistory.id, before.id));
    expect(after!.resolvedOutcomeText).toBe(FAILURE);

    // New resolutions pick up the new text; the old row keeps the old one.
    await resolve('Cross', LOSE);
    expect((await latestHistory()).resolvedOutcomeText).toBe('A rewritten failure.');

    encounter = await app.worldEncounterAdmin.upsert(input());
  });

  it('old history rows without flavor remain readable', async () => {
    // Shaped like a row written before the column existed: it is simply absent.
    const [inserted] = await t.db
      .insert(worldEncounterHistory)
      .values({
        playerId,
        encounterId: encounter.id,
        choiceId: null,
        source: 'hunt',
        regionId: 'waifu-valley',
        success: null,
        effectsAppliedJson: [],
        startedAt: new Date(),
      })
      .returning();
    const [row] = await t.db
      .select()
      .from(worldEncounterHistory)
      .where(eq(worldEncounterHistory.id, inserted!.id));
    expect(row!.resolvedOutcomeText).toBeNull();
  });
});

describe('admin write normalisation', () => {
  it('trims on save and drops blank fields', async () => {
    const saved = await app.worldEncounterAdmin.upsert(
      EncounterInputSchema.parse({
        slug: 'flavor_trim',
        name: 'Trim',
        type: 'decision',
        rarity: 'common',
        choices: [{ label: 'Go', outcomeText: '  Onward.\n\nAlways.  ', successText: '   ' }],
      }),
    );
    expect(saved.choices[0]).toMatchObject({
      outcomeText: 'Onward.\n\nAlways.',
      successText: null,
      failureText: null,
    });
    const [row] = await t.db.select().from(worldEncounters).where(eq(worldEncounters.slug, 'flavor_trim'));
    expect(row).toBeDefined();
  });
});
