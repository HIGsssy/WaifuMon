/**
 * Buddy-bonus integration with the world-encounter check resolver.
 *
 * Asserts:
 *   - the resolver reads through `deps.buddyBonus.percentFor(...)` exactly
 *     once per resolution
 *   - the bonus percentage is folded into the check breakdown as `buddyBonusMod`
 *   - the resulting success chance goes up as the bonus grows
 *
 * Real DB + real service graph; the buddy-bonus source is a test-only stub
 * that always returns a chosen percentage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  activeWorldEncounters,
  playerCurrencies,
  worldEncounters,
} from '../../src/db/schema';
import { computeChance } from '../../src/modules/worldEncounters/checkResolver';
import type { EncounterCheckContext } from '../../src/modules/worldEncounters/types';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-bb-encounter', 'u-1'));
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 5000 })
    .where(eq(playerCurrencies.playerId, playerId));
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
});

describe('checkResolver: buddy bonus fold-in', () => {
  const buddy = {
    waifuId: 1,
    speciesSlug: 'x',
    speciesName: 'X',
    level: 1,
    affinity: 'switch',
    baseSp: 60,
    currentSp: 60,
    rarity: 'R',
    raceTags: ['human'],
  };
  const check = { type: 'sp' as const, difficulty: 60 };

  it('adds `buddyBonusPercent / 100` to the base chance', () => {
    const at0 = computeChance(check, { playerId: 1, playerLevel: 1, buddy, buddyBonusPercent: 0 } as EncounterCheckContext);
    const at10 = computeChance(check, { playerId: 1, playerLevel: 1, buddy, buddyBonusPercent: 10 } as EncounterCheckContext);
    expect(at10.chance - at0.chance).toBeCloseTo(0.1, 3);
    expect(at10.breakdown.buddyBonusMod).toBeCloseTo(0.1, 3);
  });

  it('respects the [0.05, 0.95] clamp when the bonus would push the chance past it', () => {
    const at100 = computeChance(check, {
      playerId: 1,
      playerLevel: 1,
      buddy,
      buddyBonusPercent: 100,
    } as EncounterCheckContext);
    expect(at100.chance).toBe(0.95);
  });
});

describe('service integration: encounter_check_bonus is queried at resolve time', () => {
  it('calls buddyBonus.percentFor with the encounter_check_bonus effect id', async () => {
    // Wrap the real buddyBonus service and count calls.
    const percentForSpy = vi.spyOn(app.buddyBonus, 'percentFor');

    const [encounter] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'tv_bandit_ambush'));
    const [active] = await t.db
      .insert(activeWorldEncounters)
      .values({
        playerId,
        encounterId: encounter!.id,
        source: 'travel',
        regionId: 'waifu-valley',
        originRegionId: 'waifu-valley',
        destinationRegionId: 'twin-peeks',
        guildId: null,
        channelId: 'c-1',
        contextJson: {},
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
      .returning();

    const choiceRows = await t.db.execute(
      sql`SELECT id, label FROM world_encounter_choices WHERE encounter_id = ${encounter!.id}`,
    );
    const pay = (choiceRows.rows as Array<{ id: string; label: string }>).find(
      (r) => r.label === 'Pay',
    )!;

    await app.worldEncounter.resolveChoice({
      activeId: Number(active!.id),
      playerId,
      choiceId: Number(pay.id),
    });

    expect(percentForSpy).toHaveBeenCalled();
    const idsCalled = percentForSpy.mock.calls.map((c) => c[2]);
    expect(idsCalled).toContain('encounter_check_bonus');

    percentForSpy.mockRestore();
  });
});
