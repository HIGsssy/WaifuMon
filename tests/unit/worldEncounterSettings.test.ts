/**
 * Force Trigger's blast radius, and the settings validator.
 *
 * The engine's trigger decision is two steps: *should something happen here at
 * all* (the probability roll), and then *what is eligible* — cooldowns, the
 * one-pending-encounter rule, region and route filters, lifecycle. Force
 * Trigger replaces the first step and must not touch the second. These tests
 * drive `tryRollForHunt` / `tryRollForTravel` with an RNG that would always
 * lose the roll, so anything that fires did so because of the override, and a
 * repository double that records exactly what the eligibility layer was asked.
 *
 * No database: the service is constructed with doubles so the roll logic can
 * be examined in isolation. The DB-backed half — settings persisting, and the
 * engine reading them back — lives in
 * `tests/integration/worldEncounterSettings.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createWorldEncounterService } from '../../src/modules/worldEncounters/worldEncounterService';
import {
  validateSettingsPatch,
  WORLD_ENCOUNTER_SETTINGS_DEFAULTS,
} from '../../src/modules/worldEncounters/settingsService';

/** An RNG that always loses a probability roll — `0.999 >= chance` for any sane chance. */
const alwaysLoses = { next: () => 0.999, intInclusive: (a: number) => a };
/** An RNG that always wins one. */
const alwaysWins = { next: () => 0, intInclusive: (a: number) => a };

interface Harness {
  service: ReturnType<typeof createWorldEncounterService>;
  /** Every call the eligibility layer made, in order. */
  selectCalls: unknown[];
  cooldownCalls: number[];
}

/**
 * A service whose repository declines to select anything. That is enough for
 * these tests: they ask whether the eligibility layer was *reached*, not what
 * it returned, so nothing needs to be inserted.
 */
function harness(config: Record<string, unknown>): Harness {
  const selectCalls: unknown[] = [];
  const cooldownCalls: number[] = [];

  const service = createWorldEncounterService({
    db: {
      transaction: async () => {
        throw new Error('no encounter should be selected in these tests');
      },
    } as never,
    currency: {} as never,
    inventory: {} as never,
    progression: {} as never,
    collection: {} as never,
    buddyBonus: null,
    getConfig: () => ({ ...WORLD_ENCOUNTER_SETTINGS_DEFAULTS, ...config }),
    getMaxWaifuLevel: () => 50,
  });

  // Replace the two reads the eligibility layer performs. `listSelectable`
  // returning nothing makes `selectEncounter` answer null, so the transaction
  // above is never opened.
  service.repo.getCooldownEncounterIds = (async (playerId: number) => {
    cooldownCalls.push(playerId);
    return new Set<number>();
  }) as never;
  service.repo.listSelectable = (async (opts: unknown) => {
    selectCalls.push(opts);
    return [];
  }) as never;

  return { service, selectCalls, cooldownCalls };
}

/**
 * The minimum an encounter row needs to survive `selectEncounter`: a positive
 * weight, no region restriction, and a matching source.
 */
function eligibleRow(id: number) {
  return {
    encounter: {
      id,
      slug: `e_${id}`,
      name: 'Eligible',
      description: '',
      type: 'discovery',
      rarity: 'common',
      weight: 10,
      lifecycle: 'active',
      huntEligible: true,
      travelEligible: true,
      cooldownSeconds: 0,
      artworkPath: null,
      chainedEncounterSlug: null,
      choicesRequired: true,
      metadataJson: {},
    },
    regions: [],
    routes: [],
    choices: [],
  };
}

const HUNT = {
  playerId: 7,
  playerLevel: 10,
  guildId: 3,
  channelId: 'c-1',
  regionId: 'waifu-valley',
};
const TRAVEL = {
  ...HUNT,
  originRegionId: 'waifu-valley',
  destinationRegionId: 'twin-peeks',
};

describe('force trigger: replaces the probability roll', () => {
  it('does not reach eligibility when the roll is lost and force is off', async () => {
    const h = harness({ huntChance: 0.35, forceTrigger: false });
    await h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses });

    expect(h.selectCalls).toHaveLength(0);
  });

  it('reaches eligibility despite a lost roll when force is on', async () => {
    const h = harness({ huntChance: 0.35, forceTrigger: true });
    await h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses });

    expect(h.selectCalls).toHaveLength(1);
  });

  it('overrides a zero chance too', async () => {
    // A rate of 0 and Force Trigger on is contradictory config; the explicit
    // switch is the more specific statement of intent, so it wins.
    const h = harness({ huntChance: 0, forceTrigger: true });
    await h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses });

    expect(h.selectCalls).toHaveLength(1);
  });

  it('still declines a zero chance when force is off', async () => {
    const h = harness({ huntChance: 0, forceTrigger: false });
    await h.service.tryRollForHunt({ ...HUNT, rng: alwaysWins });

    expect(h.selectCalls).toHaveLength(0);
  });

  it('applies to travel on the same terms', async () => {
    const off = harness({ travelChance: 0.2, forceTrigger: false });
    await off.service.tryRollForTravel({ ...TRAVEL, rng: alwaysLoses });
    expect(off.selectCalls).toHaveLength(0);

    const on = harness({ travelChance: 0.2, forceTrigger: true });
    await on.service.tryRollForTravel({ ...TRAVEL, rng: alwaysLoses });
    expect(on.selectCalls).toHaveLength(1);
  });
});

describe('force trigger: bypasses nothing else', () => {
  it('still consults cooldowns', async () => {
    const h = harness({ huntChance: 0, forceTrigger: true });
    await h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses });

    // The cooldown read happens before selection and its result feeds the
    // selector's filter — a forced roll does not skip it.
    expect(h.cooldownCalls).toEqual([HUNT.playerId]);
  });

  it('still filters out an encounter that is on cooldown', async () => {
    // The sharpest version of the claim: the *only* eligible encounter is on
    // cooldown, force trigger is on, and the answer is still nothing.
    const h = harness({ huntChance: 0, forceTrigger: true });
    const row = eligibleRow(99);
    h.service.repo.listSelectable = (async () => [row]) as never;
    h.service.repo.getCooldownEncounterIds = (async () => new Set([99])) as never;

    await expect(h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses })).resolves.toBeNull();

    // And with the cooldown lifted the same setup would have produced one, so
    // the null above is the cooldown talking and not a broken fixture.
    h.service.repo.getCooldownEncounterIds = (async () => new Set<number>()) as never;
    await expect(
      h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses }),
    ).rejects.toThrow('no encounter should be selected in these tests');
  });

  it('still scopes selection to the region and source', async () => {
    const h = harness({ huntChance: 0, forceTrigger: true });
    await h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses });

    expect(h.selectCalls[0]).toMatchObject({
      source: 'hunt',
      regionId: 'waifu-valley',
    });
  });

  it('still scopes travel selection to the route', async () => {
    const h = harness({ travelChance: 0, forceTrigger: true });
    await h.service.tryRollForTravel({ ...TRAVEL, rng: alwaysLoses });

    expect(h.selectCalls[0]).toMatchObject({
      source: 'travel',
      fromRegion: 'waifu-valley',
      toRegion: 'twin-peeks',
    });
  });

  it('produces nothing when no encounter is eligible, however forced', async () => {
    // The repository double selects nothing, so a forced roll still yields
    // null rather than inventing an encounter.
    const h = harness({ huntChance: 0, forceTrigger: true });
    await expect(h.service.tryRollForHunt({ ...HUNT, rng: alwaysLoses })).resolves.toBeNull();
  });
});

describe('settings validation', () => {
  it('accepts values inside the documented bounds', () => {
    expect(
      validateSettingsPatch({
        huntChance: 0.5,
        travelChance: 0,
        defaultExpirySeconds: 600,
        forceTrigger: true,
      }),
    ).toEqual([]);
  });

  it('accepts both ends of each range', () => {
    expect(validateSettingsPatch({ huntChance: 0, travelChance: 1 })).toEqual([]);
    expect(validateSettingsPatch({ defaultExpirySeconds: 30 })).toEqual([]);
    expect(validateSettingsPatch({ defaultExpirySeconds: 86_400 })).toEqual([]);
  });

  it('rejects a chance outside 0–1', () => {
    expect(validateSettingsPatch({ huntChance: -0.1 })).toHaveLength(1);
    expect(validateSettingsPatch({ huntChance: 1.5 })).toHaveLength(1);
    expect(validateSettingsPatch({ travelChance: 2 })).toHaveLength(1);
  });

  it('rejects a non-finite chance', () => {
    expect(validateSettingsPatch({ huntChance: Number.NaN })).toHaveLength(1);
  });

  it('rejects an expiry outside the sensible range, or fractional', () => {
    expect(validateSettingsPatch({ defaultExpirySeconds: 29 })).toHaveLength(1);
    expect(validateSettingsPatch({ defaultExpirySeconds: 86_401 })).toHaveLength(1);
    expect(validateSettingsPatch({ defaultExpirySeconds: 60.5 })).toHaveLength(1);
  });

  it('reports every problem at once rather than the first', () => {
    expect(
      validateSettingsPatch({ huntChance: 5, travelChance: -1, defaultExpirySeconds: 1 }),
    ).toHaveLength(3);
  });

  it('ignores fields the patch does not mention', () => {
    // Partial by design: the panel sends only what changed.
    expect(validateSettingsPatch({ forceTrigger: true })).toEqual([]);
    expect(validateSettingsPatch({})).toEqual([]);
  });
});

describe('shipped defaults', () => {
  it('match the behaviour that shipped before the settings table existed', () => {
    expect(WORLD_ENCOUNTER_SETTINGS_DEFAULTS).toEqual({
      huntChance: 0.35,
      travelChance: 0.2,
      defaultExpirySeconds: 600,
      forceTrigger: false,
    });
  });

  it('agrees with content/tables.json, which these values replaced', async () => {
    const tables = (await import('../../content/tables.json')) as unknown as {
      default: { worldEncounter: Record<string, number> };
    };
    const shipped = tables.default.worldEncounter;
    expect(WORLD_ENCOUNTER_SETTINGS_DEFAULTS.huntChance).toBe(shipped.huntChance);
    expect(WORLD_ENCOUNTER_SETTINGS_DEFAULTS.travelChance).toBe(shipped.travelChance);
    expect(WORLD_ENCOUNTER_SETTINGS_DEFAULTS.defaultExpirySeconds).toBe(
      shipped.defaultExpirySeconds,
    );
  });
});
