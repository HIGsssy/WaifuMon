/**
 * The 🎲 Check section on the world-encounter resolution screen.
 *
 * The contract under test is honesty, not layout: the chance and the roll a
 * player reads are the *same* numbers the server compared to decide the
 * outcome. So most of these tests run a real {@link rollCheck} against a
 * stubbed RNG and hand the resulting resolution — untouched — to the
 * presenter, rather than hand-writing a plausible-looking resolution. If the
 * Discord layer ever recomputed a probability of its own, the seam would show
 * up here as a mismatch.
 *
 * Pure rendering plus the pure resolver. No services, no DB.
 */
import { describe, expect, it } from 'vitest';
import { buildEncounterResolved } from '../../src/discord/worldEncounterPresenter';
import { rollCheck } from '../../src/modules/worldEncounters/checkResolver';
import type { Rng } from '../../src/shared/random';
import type { AppContext } from '../../src/discord/types';
import type {
  BuddyProfile,
  CheckResolution,
  CheckSpec,
  EncounterCheckContext,
} from '../../src/modules/worldEncounters/types';
import type {
  EncounterActivation,
  Resolution,
} from '../../src/modules/worldEncounters/worldEncounterService';

const ctx = { config: { assetsDir: './assets' } } as unknown as AppContext;

const activation = {
  activeId: 7,
  encounter: {
    id: 1,
    slug: 'test_sp_check',
    name: 'Rope Bridge',
    description: 'The planks look old.',
    rarity: 'common',
    artworkPath: null,
    choices: [],
  },
  buddy: null,
  buddyBonusPercent: 0,
  choiceViews: [],
} as unknown as EncounterActivation;

function buddy(overrides: Partial<BuddyProfile> = {}): BuddyProfile {
  return {
    waifuId: 1,
    speciesSlug: 'test',
    speciesName: 'Test',
    level: 10,
    affinity: 'switch',
    baseSp: 40,
    currentSp: 200,
    rarity: 'R',
    raceTags: ['human'],
    ...overrides,
  };
}

function checkCtx(overrides: Partial<EncounterCheckContext> = {}): EncounterCheckContext {
  return { playerId: 1, playerLevel: 20, buddy: buddy(), buddyBonusPercent: 0, ...overrides };
}

/** An RNG that hands back exactly the values given, in order. */
function fixedRng(...values: number[]): Rng {
  let i = 0;
  const next = (): number => values[Math.min(i++, values.length - 1)]!;
  return { next, intInclusive: (min, max) => Math.floor(next() * (max - min + 1)) + min };
}

function resolution(
  check: CheckResolution,
  spec: CheckSpec,
  overrides: Partial<Resolution> = {},
): Resolution {
  return {
    encounter: activation.encounter,
    choice: { id: 1, label: 'Cross carefully', check: spec },
    check,
    effectsApplied: [],
    followUps: [],
    chainedEncounterSlug: null,
    continuationActiveId: null,
    vendorInstance: null,
    wildEncounter: null,
    journey: null,
    huntReturn: null,
    ...overrides,
  } as unknown as Resolution;
}

/** The `🎲 Check` field's value, or null when the screen painted none. */
function checkField(view: { embeds?: readonly unknown[] | undefined }): string | null {
  const embeds = (view.embeds ?? []) as Array<{
    toJSON: () => { fields?: Array<{ name: string; value: string }> };
  }>;
  for (const embed of embeds) {
    const field = (embed.toJSON().fields ?? []).find((f) => f.name === '🎲 Check');
    if (field) return field.value;
  }
  return null;
}

/** Render a real roll end-to-end and return both halves for comparison. */
function render(spec: CheckSpec, rolls: number[], c: EncounterCheckContext = checkCtx()) {
  const check = rollCheck(spec, c, fixedRng(...rolls));
  const view = buildEncounterResolved(ctx, activation, resolution(check, spec));
  return { check, field: checkField(view), view };
}

describe('resolved view: SP check roll section', () => {
  it('shows the chance, the roll and a success result', () => {
    // base 0.40, neutral-SP buddy (200) contributes nothing → exactly 40 %.
    const { check, field } = render({ type: 'sp', baseChance: 0.4 }, [0.117]);

    expect(check.success).toBe(true);
    expect(field).toContain('Success Chance: **40%**');
    expect(field).toContain('🎲 Roll: **11.7**');
    expect(field).toContain('Result: **Success**');
  });

  it('shows the chance and the roll on a failure too', () => {
    const { check, field } = render({ type: 'sp', baseChance: 0.4 }, [0.812]);

    expect(check.success).toBe(false);
    expect(field).toContain('Success Chance: **40%**');
    expect(field).toContain('🎲 Roll: **81.2**');
    expect(field).toContain('Result: **Failure**');
  });

  it('displays the same roll the server resolved with', () => {
    const { check, field } = render({ type: 'sp', baseChance: 0.55 }, [0.5499999]);

    // Nothing in the presenter re-rolls or re-derives: the rendered numbers
    // are `check.roll` and `check.chance` formatted, and the result label
    // follows `check.success` rather than a comparison of its own.
    expect(field).toContain(`🎲 Roll: **${(check.roll * 100).toFixed(1)}**`);
    expect(field).toContain('Success Chance: **55%**');
    expect(field).toContain(`Result: **${check.success ? 'Success' : 'Failure'}**`);
  });

  it('formats a fractional chance to a single decimal', () => {
    // base 0.40 + SP term for a 275-SP buddy (+0.075) = 47.5 %.
    const { check, field } = render({ type: 'sp', baseChance: 0.4 }, [0.5], checkCtx({
      buddy: buddy({ currentSp: 275 }),
    }));

    expect(check.chance).toBeCloseTo(0.475, 6);
    expect(field).toContain('Success Chance: **47.5%**');
  });
});

describe('resolved view: modifier breakdown', () => {
  it('names every modifier that contributed', () => {
    const spec: CheckSpec = {
      type: 'sp',
      baseChance: 0.4,
      affinityAdvantage: 'dominant',
      raceAdvantage: ['beast'],
    };
    const { field } = render(spec, [0.5], checkCtx({
      buddy: buddy({ currentSp: 350, affinity: 'dominant', raceTags: ['beast'] }),
      buddyBonusPercent: 5,
    }));

    // Affinity is named for the advantage the check grants, not labelled
    // generically — the player should recognise why their buddy helped.
    expect(field).toContain('Base 40% · SP +15% · Dominant +15% · Race +10% · Buddy Bonus +5%');
  });

  it('shows a negative SP contribution as a negative modifier', () => {
    const { field } = render({ type: 'sp', baseChance: 0.5 }, [0.5], checkCtx({
      buddy: buddy({ currentSp: 50 }),
    }));

    expect(field).toContain('Base 50% · SP −15%');
  });

  it('omits modifiers that did not apply', () => {
    // Affinity and race advantages are authored, but this buddy matches
    // neither, and there is no buddy bonus — so none of them appear.
    const spec: CheckSpec = {
      type: 'sp',
      baseChance: 0.4,
      affinityAdvantage: 'dominant',
      raceAdvantage: ['beast'],
    };
    const { field } = render(spec, [0.5], checkCtx({ buddy: buddy({ currentSp: 200 }) }));

    expect(field).toContain('Base 40%');
    expect(field).not.toContain('Dominant');
    expect(field).not.toContain('Affinity');
    expect(field).not.toContain('Race');
    expect(field).not.toContain('Buddy Bonus');
    // A zero SP term is a term with nothing to say, not a "+0%" row.
    expect(field).not.toContain('SP ');
    expect(field).not.toContain('Level');
  });

  it('says so when the clamp moved the chance off the sum of its parts', () => {
    // 0.90 + 0.15 = 1.05, clamped to the 95 % ceiling.
    const { check, field } = render({ type: 'sp', baseChance: 0.9 }, [0.5], checkCtx({
      buddy: buddy({ currentSp: 350 }),
    }));

    expect(check.chance).toBe(0.95);
    expect(field).toContain('Success Chance: **95%**');
    expect(field).toContain('capped');
  });
});

describe('resolved view: no check, no roll section', () => {
  it('paints nothing for a check of type "none"', () => {
    const { check, field, view } = render({ type: 'none' }, [0.5]);

    expect(check.rolled).toBe(false);
    expect(field).toBeNull();
    expect(JSON.stringify(view.embeds)).toContain('Auto-resolved');
  });

  it('paints nothing on a navigation-only continuation screen', () => {
    // A chained/travel encounter whose choice carried no check: the screen
    // exists to offer Continue Journey, and there is no roll to explain.
    const check = rollCheck({ type: 'none' }, checkCtx(), fixedRng(0.5));
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution(check, { type: 'none' }, {
        journey: { destinationRegionId: 'verdant_hollow' },
      } as Partial<Resolution>),
    );

    expect(checkField(view)).toBeNull();
    // The navigation button is still there — it is the roll section, and only
    // the roll section, that this case suppresses.
    expect(JSON.stringify(view.components)).toContain('loc');
  });

  it('paints nothing when the resolution was never rolled (preview-shaped)', () => {
    const unrolled = { ...rollCheck({ type: 'sp', baseChance: 0.4 }, checkCtx(), fixedRng(0.2)) };
    unrolled.rolled = false;
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution(unrolled, { type: 'sp', baseChance: 0.4 }),
    );

    expect(checkField(view)).toBeNull();
  });
});

describe('resolved view: legacy SP checks', () => {
  it('resolves on the legacy formula and displays its diagnostics', () => {
    const spec: CheckSpec = { type: 'sp', difficulty: 60, baseBias: 0.05 };
    const c = checkCtx({ buddy: buddy({ currentSp: 60, level: 11 }) });
    const { check, field } = render(spec, [0.4], c);

    // Legacy math, untouched: base 0.50 + sp (60−60)/200 = 0 + level
    // (11−1)/100 = 0.10 + bias 0.05 = 0.65.
    expect(check.model).toBe('legacy');
    expect(check.breakdown.base).toBe(0.5);
    expect(check.breakdown.spTerm).toBe(0);
    expect(check.breakdown.levelTerm).toBeCloseTo(0.1, 6);
    expect(check.chance).toBeCloseTo(0.65, 6);

    expect(field).toContain('Success Chance: **65%**');
    expect(field).toContain('🎲 Roll: **40.0**');
    expect(field).toContain('Result: **Success**');
    // The level term is a legacy-only contributor and shows up alongside the
    // legacy bias; the zero SP term stays hidden.
    expect(field).toContain('Base 50% · Level +10% · Bias +5%');
  });

  it('resolves identically with and without the presentation layer looking at it', () => {
    const spec: CheckSpec = { type: 'sp', difficulty: 120 };
    const c = checkCtx({ buddy: buddy({ currentSp: 200, level: 5 }) });
    const bare = rollCheck(spec, c, fixedRng(0.33));
    const { check } = render(spec, [0.33], c);

    expect(check.chance).toBe(bare.chance);
    expect(check.roll).toBe(bare.roll);
    expect(check.success).toBe(bare.success);
  });
});
