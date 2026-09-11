/**
 * `buildEncounterResolved` — authored outcome flavor on the Discord result.
 *
 * The presenter shows `resolution.resolvedOutcomeText` verbatim, under the
 * Result heading and above the 🎲 Check block. It never looks at the authored
 * success/failure/outcome fields itself — the domain already chose.
 *
 * Pure rendering. No services, no DB.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCheckRollField,
  buildEncounterResolved,
} from '../../src/discord/worldEncounterPresenter';
import type { AppContext } from '../../src/discord/types';
import type {
  EncounterActivation,
  Resolution,
} from '../../src/modules/worldEncounters/worldEncounterService';
import type { CheckResolution } from '../../src/modules/worldEncounters/types';

const ctx = { config: { assetsDir: './assets' } } as unknown as AppContext;

const activation = {
  activeId: 42,
  encounter: {
    id: 1,
    slug: 'crumbling_bridge',
    name: 'Crumbling Bridge',
    description: 'Old planks over a long drop.',
    rarity: 'common',
    artworkPath: null,
    choices: [],
  },
  buddy: null,
  buddyBonusPercent: 0,
  choiceViews: [],
} as unknown as EncounterActivation;

const rolled = (success: boolean): CheckResolution => ({
  chance: 0.55,
  roll: success ? 0.21 : 0.8,
  success,
  checkType: 'sp',
  model: 'new',
  rolled: true,
  breakdown: {
    base: 0.55,
    spTerm: 0,
    levelTerm: 0,
    affinityMod: 0,
    raceMod: 0,
    buddyBonusMod: 0,
    baseBias: 0,
  },
});

const auto: CheckResolution = { ...rolled(true), chance: 1, roll: 0, checkType: 'none', model: 'none', rolled: false };

function resolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    encounter: activation.encounter,
    // Authored fields deliberately disagree with the resolved value: the
    // presenter must print what the domain resolved, not re-pick.
    choice: {
      id: 1,
      label: 'Cross the bridge',
      check: { type: 'sp', baseChance: 0.55 },
      successText: 'AUTHORED SUCCESS — must not be read by the presenter',
      failureText: 'AUTHORED FAILURE — must not be read by the presenter',
      outcomeText: 'AUTHORED OUTCOME — must not be read by the presenter',
    },
    check: rolled(true),
    resolvedOutcomeText: null,
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

type Field = { name: string; value: string };
function fields(res: Resolution): Field[] {
  const view = buildEncounterResolved(ctx, activation, res);
  const embed = (view.embeds![0] as unknown as { toJSON(): { fields?: Field[] } }).toJSON();
  return embed.fields ?? [];
}
const field = (res: Resolution, name: string) => fields(res).find((f) => f.name === name);

const SUCCESS = 'You make it across just as the final plank gives way behind you.';
const FAILURE = 'The bridge snaps beneath your feet, forcing a frantic retreat.';
const GENERIC = 'You follow the strange footprints deeper into the ruins.';

describe('Discord result: authored flavor', () => {
  it('renders success flavor under the result heading', () => {
    const value = field(resolution({ resolvedOutcomeText: SUCCESS }), 'Result')!.value;
    expect(value).toBe(
      `**Chose:** Cross the bridge\n**Outcome:** ✅ Success (55% chance)\n\n${SUCCESS}`,
    );
  });

  it('renders failure flavor', () => {
    const value = field(
      resolution({ check: rolled(false), resolvedOutcomeText: FAILURE }),
      'Result',
    )!.value;
    expect(value).toContain('❌ Failure');
    expect(value.endsWith(`\n\n${FAILURE}`)).toBe(true);
  });

  it('renders generic flavor on an auto-resolved choice', () => {
    const res = resolution({
      check: auto,
      choice: { id: 2, label: 'Follow the tracks', check: { type: 'none' } } as Resolution['choice'],
      resolvedOutcomeText: GENERIC,
    });
    expect(field(res, 'Result')!.value).toBe(
      `**Chose:** Follow the tracks\n**Outcome:** Auto-resolved\n\n${GENERIC}`,
    );
    expect(field(res, '🎲 Check')).toBeUndefined();
  });

  it('keeps line breaks the author wrote', () => {
    const value = field(resolution({ resolvedOutcomeText: 'One.\n\nTwo.' }), 'Result')!.value;
    expect(value.endsWith('\n\nOne.\n\nTwo.')).toBe(true);
  });

  it('never reads the authored fields directly', () => {
    const text = JSON.stringify(fields(resolution({ resolvedOutcomeText: null })));
    expect(text).not.toContain('AUTHORED');
  });

  it('preserves the current output exactly when there is no flavor', () => {
    expect(field(resolution(), 'Result')!.value).toBe(
      '**Chose:** Cross the bridge\n**Outcome:** ✅ Success (55% chance)',
    );
    expect(fields(resolution()).map((f) => f.name)).toEqual(['Result', '🎲 Check']);
  });

  it('leaves the 🎲 Check block unchanged and places flavor before it', () => {
    const withFlavor = fields(resolution({ resolvedOutcomeText: SUCCESS }));
    const without = fields(resolution());
    const check = (fs: Field[]) => fs.find((f) => f.name === '🎲 Check');

    expect(check(withFlavor)).toEqual(check(without));
    expect(check(withFlavor)!.value).toBe(
      buildCheckRollField(rolled(true), { type: 'sp', baseChance: 0.55 })!.value,
    );
    expect(withFlavor.map((f) => f.name)).toEqual(['Result', '🎲 Check']);
  });
});
