/**
 * Buddy Bonus feedback — what the player is actually told, and when.
 *
 * The rule under test throughout: **a screen reports a bonus exactly when a
 * service attached one to its result.** No test here asks the presentation
 * layer to decide whether a bonus was relevant, because the presentation layer
 * is not allowed to know — which is why every case below builds the result
 * model a service would have produced and asserts on the rendered text.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { EmbedBuilder } from 'discord.js';
import {
  appliedBuddyBonus,
  buddyBonusEffectSummary,
  buddyBonusLine,
  buddyBonusShortLine,
  type BuddyBonus,
} from '../../src/modules/buddyBonus/buddyBonusEffects';
import {
  buddyAwardFeedbackLines,
  buddyBonusFeedbackLine,
  buddyBonusFeedbackLines,
  buddyBonusValueLine,
} from '../../src/discord/buddyBonusFeedback';
import { buildEphemeralOutcomeMessage } from '../../src/discord/commands/waifumonHunt';
import { formatCareSummary } from '../../src/discord/commands/waifumon';
import { buildMyResult } from '../../src/discord/bossPresenter';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import { SpeciesFileSchema } from '../../src/modules/content/schemas';
import type { CareTickSummary } from '../../src/modules/care/careService';
import type { AppContext } from '../../src/discord/types';
import { silentLogger } from '../helpers/testDb';

const bonus = (over: Partial<BuddyBonus>): BuddyBonus => ({
  name: 'Test Bonus',
  flavorText: 'Test Bonus: a long authored sentence that belongs on the collection panel.',
  effectId: 'capture_chance',
  value: 10,
  ...over,
});

// ── the shared vocabulary ───────────────────────────────────────────────────

describe('effect summaries', () => {
  it('describes every effect mechanically, from effectId and value alone', () => {
    const cases: Array<[Partial<BuddyBonus>, string]> = [
      [{ effectId: 'capture_chance', value: 7 }, '+7% capture chance'],
      [
        { effectId: 'capture_chance', value: 15, target: { type: 'race', value: 'android' } },
        '+15% capture chance against android Waifumon',
      ],
      [
        { effectId: 'encounter_weight', value: 10, target: { type: 'race', value: 'demon' } },
        '+10% chance to encounter demon Waifumon',
      ],
      [{ effectId: 'energy_save_chance', value: 25 }, '25% chance Hunting costs no Energy'],
      [{ effectId: 'care_energy_gain', value: 100 }, '+100% Care Energy'],
      [{ effectId: 'player_xp_gain', value: 10 }, '+10% Trainer XP'],
      [{ effectId: 'buddy_xp_gain', value: 10 }, '+10% Buddy XP'],
      [{ effectId: 'essence_gain', value: 100 }, '+100% Essence'],
      [{ effectId: 'hunt_item_find_chance', value: 5 }, '+5% item-find chance'],
      [{ effectId: 'affection_gain', value: 100 }, '+100% Affection'],
      [{ effectId: 'boss_reward_gain', value: 50 }, '+50% Boss rewards'],
    ];
    for (const [over, expected] of cases) {
      expect(buddyBonusEffectSummary(appliedBuddyBonus(bonus(over)))).toBe(expected);
    }
  });

  it('never repeats the authored flavour text on a gameplay line', () => {
    const applied = appliedBuddyBonus(bonus({ name: 'Hijack', value: 15 }));
    expect(buddyBonusLine(applied)).toBe('✨ Buddy Bonus — Hijack: +15% capture chance');
    expect(buddyBonusLine(applied)).not.toContain('collection panel');
  });

  it('has a compact form for a line that already shows the number', () => {
    expect(buddyBonusShortLine(appliedBuddyBonus(bonus({ name: 'Soul Collector', effectId: 'essence_gain', value: 100 })))).toBe(
      '✨ Soul Collector: +100%',
    );
    expect(buddyBonusValueLine(null)).toBeNull();
  });

  it('reports a proc as an event once it has fired, not as a rate', () => {
    const applied = appliedBuddyBonus(bonus({ name: 'Free Play', effectId: 'energy_save_chance', value: 25 }));
    expect(buddyBonusFeedbackLine(applied)).toBe(
      '✨ **Free Play** activated! Your Buddy saved 1 Energy.',
    );
  });

  it('says nothing at all when no bonus applied', () => {
    expect(buddyBonusFeedbackLines([])).toEqual([]);
    expect(buddyBonusFeedbackLines(undefined)).toEqual([]);
    expect(buddyAwardFeedbackLines(null)).toEqual([]);
    expect(buddyAwardFeedbackLines({ xpGranted: 2, affectionGranted: 1, xpBonus: null, affectionBonus: null })).toEqual([]);
  });
});

describe('buddy award lines', () => {
  it('names the boosted Buddy XP and the bonus that raised it', () => {
    const lines = buddyAwardFeedbackLines({
      xpGranted: 12,
      affectionGranted: 1,
      xpBonus: appliedBuddyBonus(bonus({ name: 'Fast Learner', effectId: 'buddy_xp_gain', value: 10 }), {
        base: 11,
        final: 12,
      }),
      affectionBonus: null,
    });
    expect(lines).toEqual(['✨ Buddy XP: +12', '✨ Fast Learner: +10%']);
  });

  it('names boosted Affection, which is reported even when caring for another Waifumon', () => {
    const lines = buddyAwardFeedbackLines({
      xpGranted: 2,
      affectionGranted: 2,
      xpBonus: null,
      affectionBonus: appliedBuddyBonus(
        bonus({ name: 'Social Butterfly', effectId: 'affection_gain', value: 100 }),
        { base: 1, final: 2 },
      ),
    });
    expect(lines).toEqual(['❤️ Affection gained: +2', '✨ Social Butterfly: +100%']);
  });
});

// ── Care Mode ───────────────────────────────────────────────────────────────

const careSummary = (over: Partial<CareTickSummary> = {}): CareTickSummary =>
  ({
    active: true,
    stopped: false,
    ticksProcessed: 2,
    energyGained: 4,
    waifuXpGained: 4,
    affectionGained: 2,
    target: null,
    fromLevel: 3,
    toLevel: 3,
    leveledUp: false,
    newAppearances: [],
    lastTickAt: null,
    nextTickAt: null,
    energyBonus: null,
    xpBonus: null,
    affectionBonus: null,
    ...over,
  }) as CareTickSummary;

describe('Care Mode summary', () => {
  it('names the Care Energy bonus when it actually recovered more Energy', () => {
    const text = formatCareSummary(
      careSummary({
        energyBonus: appliedBuddyBonus(
          bonus({ name: 'Back Massage', effectId: 'care_energy_gain', value: 100 }),
          { base: 2, final: 4 },
        ),
      }),
    );
    expect(text).toContain('+4 ⚡');
    expect(text).toContain('✨ Back Massage: +100%');
  });

  it('names an Affection bonus earned while caring for a Waifumon who is not the Buddy', () => {
    const text = formatCareSummary(
      careSummary({
        affectionBonus: appliedBuddyBonus(
          bonus({ name: 'Social Butterfly', effectId: 'affection_gain', value: 100 }),
          { base: 1, final: 2 },
        ),
      }),
    );
    expect(text).toContain('✨ Social Butterfly: +100%');
  });

  it('names a Buddy XP bonus on a tick that earned one', () => {
    const text = formatCareSummary(
      careSummary({
        xpBonus: appliedBuddyBonus(bonus({ name: 'Fast Learner', effectId: 'buddy_xp_gain', value: 10 })),
      }),
    );
    expect(text).toContain('✨ Fast Learner: +10%');
  });

  it('stays quiet when no bonus moved any of the numbers', () => {
    const text = formatCareSummary(careSummary());
    expect(text).toBe('2 ticks applied · +4 ⚡ · +4 XP · +2 affection');
    expect(text).not.toContain('✨');
  });
});

// ── Boss Encounters ─────────────────────────────────────────────────────────

const bossEncounter = () =>
  ({ bossName: 'Oh Pwincess', bossId: 'oh_pwincess' }) as never;

const participation = (over: Record<string, unknown> = {}) =>
  ({
    waifuName: 'Ruby Succubus',
    level: 24,
    currentSp: 300,
    totalDamage: 2001,
    attackCount: 10,
    affinityBonus: 0,
    responseBonus: 0,
    xpAwarded: 105,
    rewardStatus: 'applied',
    ...over,
  }) as never;

describe('boss reward summary', () => {
  it('names the committed copy’s reward bonus alongside the payout', () => {
    const text = buildMyResult(bossEncounter(), {
      participation: participation(),
      rewards: [{ slug: 'basic_charm', name: 'Basic Charm', quantity: 3 }],
      rewardBonus: appliedBuddyBonus(
        bonus({ name: 'Spoils of War', effectId: 'boss_reward_gain', value: 50 }),
      ),
    });
    expect(text).toContain('3× Basic Charm');
    expect(text).toContain('**+105 XP**');
    expect(text).toContain('✨ Buddy Bonus — Spoils of War: +50% Boss rewards');
  });

  it('says nothing about a bonus when the committed copy granted none', () => {
    const text = buildMyResult(bossEncounter(), {
      participation: participation(),
      rewards: [{ slug: 'basic_charm', name: 'Basic Charm', quantity: 2 }],
      rewardBonus: null,
    });
    expect(text).not.toContain('Buddy Bonus');
  });
});

// ── the capture result screen ───────────────────────────────────────────────

const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'feedback_subject',
    name: 'Feedback Subject',
    rarity: 'SR',
    archetype: 'android',
    race: 'android',
    contentRating: 'suggestive',
    affinity: 'primal',
    description: 'Reports honestly.',
    imagePath: 'waifumon/feedback_subject/standard.png',
  },
]);

const speciesRow = {
  id: 1,
  slug: 'feedback_subject',
  name: 'Feedback Subject',
  rarity: 'SR',
  archetype: 'android',
  description: 'Reports honestly.',
  imagePath: 'waifumon/feedback_subject/standard.png',
  affinity: 'primal',
} as never;

let assetsDir: string;
let ctx: AppContext;

beforeAll(async () => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-bonus-feedback-'));
  const dir = path.join(assetsDir, 'waifumon', 'feedback_subject');
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({
    create: { width: 256, height: 374, channels: 3, background: { r: 60, g: 30, b: 90 } },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, 'standard.png'), png);
  const content = {
    items: [],
    species: SPECIES,
    tables: { duplicate: { essenceByRarity: { SR: 5 } } },
  } as never;
  ctx = {
    config: { assetsDir, platformApi: { cardRendererEnabled: false } },
    logger: silentLogger(),
    content,
    services: { appearance: createAppearanceService({ db: null as never, getContent: () => content }) },
  } as unknown as AppContext;
}, 60_000);

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

/** A resolved capture attempt, in the shape the outcome builder consumes. */
function captureResult(over: {
  buddyBonus?: ReturnType<typeof appliedBuddyBonus> | null;
  xpBonus?: ReturnType<typeof appliedBuddyBonus> | null;
  xpGranted?: number;
}) {
  return {
    outcome: 'failure',
    species: speciesRow,
    item: { id: 1, slug: 'basic_charm', name: 'Basic Charm', emoji: '💗' },
    isDuplicate: false,
    attempt: { attemptNumber: 1, guaranteed: false, roll: 0.9 },
    attemptsRemaining: 2,
    newWaifu: null,
    affinity: {
      buddyWaifuId: 42,
      buddyAffinity: 'switch',
      encounterAffinity: 'primal',
      matchup: 'neutral',
      buddyAffinityModifier: 0,
      finalChance: 0.25,
      buddyBonus: over.buddyBonus ?? null,
    },
    effect: null,
    xpGranted: over.xpGranted ?? 0,
    xpBonus: over.xpBonus ?? null,
    levelUps: [],
    isNewDex: false,
  } as never;
}

const embedText = (payload: { embeds?: readonly unknown[] | undefined }): string => {
  const embed = payload.embeds?.[0] as EmbedBuilder | undefined;
  const fields = (embed?.data.fields ?? []).map((f) => `${f.name}\n${f.value}`);
  return [embed?.data.description ?? '', ...fields].join('\n');
};

describe('capture result screen', () => {
  it('shows a capture bonus the attempt actually used', async () => {
    const payload = await buildEphemeralOutcomeMessage(
      ctx,
      captureResult({
        buddyBonus: appliedBuddyBonus(
          bonus({ name: 'Hijack', value: 15, target: { type: 'race', value: 'android' } }),
        ),
      }),
    );
    expect(embedText(payload)).toContain(
      '✨ Buddy Bonus — Hijack: +15% capture chance against android Waifumon',
    );
  });

  it('shows no capture bonus when the buddy’s bonus did not apply to this species', async () => {
    // The service leaves `affinity.buddyBonus` null for a target this species
    // does not match — the screen has no second opinion about that.
    const payload = await buildEphemeralOutcomeMessage(ctx, captureResult({ buddyBonus: null }));
    const text = embedText(payload);
    expect(text).not.toContain('Hijack');
    expect(text).not.toContain('capture chance against');
  });

  it('names the Trainer XP bonus next to the XP it already printed', async () => {
    const payload = await buildEphemeralOutcomeMessage(
      ctx,
      captureResult({
        xpGranted: 11,
        xpBonus: appliedBuddyBonus(
          bonus({ name: 'Study Partner', effectId: 'player_xp_gain', value: 10 }),
          { base: 10, final: 11 },
        ),
      }),
    );
    const text = embedText(payload);
    expect(text).toContain('+11 XP');
    expect(text).toContain('✨ Study Partner: +10%');
  });

  it('prints no XP bonus line when none applied', async () => {
    const payload = await buildEphemeralOutcomeMessage(ctx, captureResult({ xpGranted: 10 }));
    expect(embedText(payload)).not.toContain('✨ ');
  });
});
