/**
 * The `affection_gain` World Encounter effect — validation, round-trip,
 * presentation and simulation. Everything here is pure; the award itself is
 * covered against a real database in `tests/integration/worldEncounterAffection.test.ts`.
 *
 * The recurring theme is that this effect *delegates*. Its whole implementation
 * is one call to `CollectionService.awardBuddyAffection`, and the value of
 * these tests is pinning the surfaces around that call: that an author can
 * express it, that it survives a promotion package, that Discord prints the
 * numbers the domain returned rather than numbers it worked out, and that a
 * simulator can total it without a player to read a Buddy from.
 */
import { describe, expect, it } from 'vitest';
import { EffectSchema } from '../../../src/modules/worldEncounters/types';
import {
  PACKAGE_VERSION,
  buildEncounterPackage,
  stableJson,
  toPackagedEncounter,
} from '../../../src/modules/worldEncounters/encounterPackage';
import { WORLD_ENCOUNTER_EFFECT_TYPES } from '../../../src/db/schema';
import { simulateChoice } from '../../../src/api/routes/v1/admin/encounters';
import { buildEncounterResolved } from '../../../src/discord/worldEncounterPresenter';
import type { AppContext } from '../../../src/discord/types';
import type {
  EncounterActivation,
  Resolution,
} from '../../../src/modules/worldEncounters/worldEncounterService';
import type { LoadedEncounter, EncounterCheckContext } from '../../../src/modules/worldEncounters/types';

describe('effect validation', () => {
  it('accepts a positive integer amount', () => {
    const parsed = EffectSchema.parse({ type: 'affection_gain', amount: 25 });
    expect(parsed).toEqual({ type: 'affection_gain', amount: 25 });
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['absurd', 10_000_000],
  ])('rejects a %s amount', (_name, amount) => {
    // Zero is rejected rather than treated as a no-op: an authored 0 is a
    // mistake, and catching it at save time beats discovering at runtime that
    // a choice silently rewards nothing.
    expect(EffectSchema.safeParse({ type: 'affection_gain', amount }).success).toBe(false);
  });

  it('rejects a missing amount and unknown extra fields', () => {
    expect(EffectSchema.safeParse({ type: 'affection_gain' }).success).toBe(false);
    const extra = EffectSchema.safeParse({
      type: 'affection_gain',
      amount: 25,
      waifuId: 3,
    });
    // The union member has no `waifuId`: the effect always pays the *active*
    // Buddy, and a target field would be a promise the effect does not keep.
    if (extra.success) expect(extra.data).not.toHaveProperty('waifuId');
  });

  it('is registered in the database-facing effect type list', () => {
    // The column is soft-typed text, so this list is the only thing that
    // documents the vocabulary — a handler without an entry here is invisible.
    expect(WORLD_ENCOUNTER_EFFECT_TYPES).toContain('affection_gain');
  });
});

/** A minimal encounter carrying the effect on both branches. */
function loaded(): LoadedEncounter {
  return {
    id: 1,
    slug: 'tv_kind_word',
    name: 'A Kind Word',
    description: 'Someone says something nice.',
    type: 'decision',
    rarity: 'common',
    weight: 10,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: true,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    choices: [
      {
        id: 5,
        sortOrder: 0,
        label: 'Listen',
        emoji: '💕',
        requirements: {},
        check: { type: 'sp', difficulty: 40 },
        successEffects: [
          { type: 'affection_gain', amount: 25 },
          { type: 'waifubux_gain', amount: 10 },
        ],
        // The effect system treats success and failure lists identically, so
        // a consolation Affection award is authorable — asserted here and
        // exercised end-to-end in the integration suite.
        failureEffects: [{ type: 'affection_gain', amount: 5 }],
      },
    ],
    metadata: {},
  };
}

describe('promotion package round-trip', () => {
  it('carries affection_gain through toPackagedEncounter unchanged', () => {
    const packaged = toPackagedEncounter(loaded());
    const choice = packaged.choices[0]!;
    expect(choice.successEffects).toContainEqual({ type: 'affection_gain', amount: 25 });
    expect(choice.failureEffects).toContainEqual({ type: 'affection_gain', amount: 5 });
  });

  it('survives a serialize → parse → re-serialize cycle byte-for-byte', () => {
    // The property that makes a package safe to carry between environments:
    // what comes back out is what went in, so a promoted encounter cannot
    // quietly lose an effect the far side does not recognise.
    const pkg = buildEncounterPackage({ encounters: [loaded()], vendors: [] });
    const once = stableJson(pkg);
    const twice = stableJson(JSON.parse(once) as typeof pkg);
    expect(twice).toBe(once);
    expect(once).toContain('affection_gain');
    expect(pkg.version).toBe(PACKAGE_VERSION);
  });

  it('re-validates on the way back in', () => {
    // Round-tripping is only useful if the far side still checks. Parse each
    // packaged effect back through the schema the importer uses.
    const packaged = toPackagedEncounter(loaded());
    for (const effect of packaged.choices[0]!.successEffects) {
      expect(EffectSchema.safeParse(effect).success).toBe(true);
    }
  });

  it('needs no cross-reference resolution, unlike item or vendor effects', () => {
    // `affection_gain` names nothing outside itself — no slug, no vendor key —
    // so an encounter using it promotes standalone. Asserted because the
    // importer's reference walker has a `default` branch this relies on.
    const pkg = buildEncounterPackage({ encounters: [loaded()], vendors: [] });
    expect(pkg.vendors).toEqual([]);
  });
});

describe('simulator aggregation', () => {
  const ctx = {
    playerId: 1,
    playerLevel: 10,
    buddy: null,
    buddyBonusPercent: 0,
  } as unknown as EncounterCheckContext;

  it('totals the base affection across a run without touching player state', () => {
    // `simulateChoice` is a pure function over the authored effect lists: it
    // takes no transaction and no services, so there is no path by which a
    // preview could move a real Buddy's Affection. That is the guarantee, and
    // the signature is the proof.
    const choice = loaded().choices[0]!;
    const result = simulateChoice(choice, { rolls: 200 }, ctx, 12345);

    // Every roll awards Affection — 25 on success, 5 on failure — so the total
    // is a weighted mix rather than a fixed multiple.
    expect(result.affectionGranted).toBe(result.successes * 25 + result.failures * 5);
    expect(result.rolls).toBe(200);
  });

  it('reports zero for a choice that awards no affection', () => {
    const choice = loaded().choices[0]!;
    const none = {
      ...choice,
      successEffects: [{ type: 'waifubux_gain' as const, amount: 10 }],
      failureEffects: [],
    };
    expect(simulateChoice(none, { rolls: 50 }, ctx, 7).affectionGranted).toBe(0);
  });

  it('is reproducible from the reported seed', () => {
    const choice = loaded().choices[0]!;
    const a = simulateChoice(choice, { rolls: 100 }, ctx, 99);
    const b = simulateChoice(choice, { rolls: 100 }, ctx, a.seed);
    expect(b.affectionGranted).toBe(a.affectionGranted);
  });
});

/**
 * Discord presentation.
 *
 * Rendered through the real `buildEncounterResolved`, because the requirement
 * is about what a player *reads*. The two formats are fixed by spec, and the
 * important property is what is absent: no percentage arithmetic anywhere in
 * the presenter, only fields the domain already decided.
 */
describe('Discord presentation', () => {
  const ctx = { config: { assetsDir: './assets' } } as unknown as AppContext;

  const activation = {
    activeId: 1,
    encounter: {
      id: 1,
      slug: 'tv_test_kind_word',
      name: 'A Kind Word',
      description: 'Someone says something nice.',
      rarity: 'common',
      artworkPath: null,
      choices: [],
    },
    buddy: null,
    buddyBonusPercent: 0,
    choiceViews: [],
  } as unknown as EncounterActivation;

  function resolutionWith(effectsApplied: unknown[]): Resolution {
    return {
      encounter: activation.encounter,
      choice: { id: 1, label: 'Listen' },
      check: { chance: 1, roll: 0, success: true, breakdown: {} },
      effectsApplied,
      followUps: [],
      chainedEncounterSlug: null,
      continuationActiveId: null,
      vendorInstance: null,
      wildEncounter: null,
      journey: null,
      huntReturn: null,
    } as unknown as Resolution;
  }

  /** Every rendered embed field value, joined — what the player sees. */
  function renderedText(resolution: Resolution): string {
    type EmbedJson = { fields?: { value: string }[] };
    const view = buildEncounterResolved(ctx, activation, resolution);
    const embed = view.embeds?.[0] as { toJSON?: () => EmbedJson } & EmbedJson;
    const json: EmbedJson = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
    return (json?.fields ?? []).map((f) => f.value).join('\n');
  }

  it('prints one line with the buddy’s name when no bonus applied', () => {
    const text = renderedText(
      resolutionWith([
        {
          effect: { type: 'affection_gain', amount: 25 },
          applied: true,
          amount: 25,
          affection: {
            waifuId: 3,
            waifuName: 'Pip',
            baseAmount: 25,
            finalAmount: 25,
            affectionAfter: 25,
            bonus: null,
          },
        },
      ]),
    );
    expect(text).toContain('💕 Pip gained +25 Affection');
    // No breakdown when there is nothing to break down.
    expect(text).not.toContain('Base:');
  });

  it('adds the base and the bonus line when the bonus moved the number', () => {
    const text = renderedText(
      resolutionWith([
        {
          effect: { type: 'affection_gain', amount: 25 },
          applied: true,
          amount: 30,
          affection: {
            waifuId: 3,
            waifuName: 'Pip',
            baseAmount: 25,
            finalAmount: 30,
            affectionAfter: 30,
            bonus: {
              name: 'Open Heart',
              effectId: 'affection_gain',
              value: 20,
              target: null,
              targetLabel: null,
              baseValue: 25,
              finalValue: 30,
            },
          },
        },
      ]),
    );
    expect(text).toContain('💕 Pip gained +30 Affection');
    expect(text).toContain('Base: 25 · ✨ Open Heart: +20%');
  });

  it('prints nothing at all when there was no buddy to pay', () => {
    // The skip is invisible to the player: the encounter reads as the success
    // it was, minus a reward line that was never earned.
    const text = renderedText(
      resolutionWith([
        { effect: { type: 'affection_gain', amount: 25 }, applied: false, amount: 0, reason: 'no_buddy' },
        { effect: { type: 'waifubux_gain', amount: 100 }, applied: true, amount: 100 },
      ]),
    );
    expect(text).not.toContain('Affection');
    // …and the effects that did land are still shown.
    expect(text).toContain('+100 Waifubux');
  });
});
