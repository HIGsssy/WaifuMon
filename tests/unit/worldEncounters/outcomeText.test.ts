/**
 * Authored outcome flavor text — schema, precedence, preview, simulator and
 * package round trip. Pure: no DB, no services.
 *
 * The one rule every section below leans on: flavor is decided *after* the
 * outcome and feeds nothing back into it.
 */
import { describe, expect, it } from 'vitest';
import {
  OUTCOME_TEXT_MAX_LENGTH,
  outcomeKindOf,
  resolveOutcomeText,
} from '../../../src/modules/worldEncounters/outcomeText';
import {
  ChoiceInputSchema,
  type EncounterCheckContext,
  type LoadedEncounter,
} from '../../../src/modules/worldEncounters/types';
import {
  previewOutcomeFlavor,
  simulateChoice,
} from '../../../src/api/routes/v1/admin/encounters';
import {
  buildEncounterPackage,
  planImport,
  stableJson,
  toPackagedEncounter,
  type ImportTargetState,
} from '../../../src/modules/worldEncounters/encounterPackage';

type Choice = LoadedEncounter['choices'][number];

const SUCCESS = 'You make it across just as the final plank gives way behind you.';
const FAILURE = 'The bridge snaps beneath your feet, forcing a frantic retreat.';
const GENERIC = 'You continue deeper into the ruins.';

/* ─────────────────────── Schema / normalisation ─────────────────────── */

describe('choice flavor fields: schema', () => {
  const parse = (extra: Record<string, unknown>) =>
    ChoiceInputSchema.safeParse({ label: 'Cross the bridge', ...extra });

  it('accepts a choice with no flavor fields', () => {
    const r = parse({});
    expect(r.success).toBe(true);
    expect(r.data!.outcomeText).toBeUndefined();
    expect(r.data!.successText).toBeUndefined();
    expect(r.data!.failureText).toBeUndefined();
  });

  it.each([
    ['outcomeText', GENERIC],
    ['successText', SUCCESS],
    ['failureText', FAILURE],
  ])('accepts %s on its own', (field, text) => {
    const r = parse({ [field]: text });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>)[field]).toBe(text);
  });

  it('accepts all three together', () => {
    const r = parse({
      check: { type: 'sp', baseChance: 0.55 },
      outcomeText: GENERIC,
      successText: SUCCESS,
      failureText: FAILURE,
    });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ outcomeText: GENERIC, successText: SUCCESS, failureText: FAILURE });
  });

  it('does not require success/failure text just because a check exists', () => {
    expect(parse({ check: { type: 'sp', baseChance: 0.5 } }).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(parse({ outcomeText: `  \n ${GENERIC} \t\n` }).data!.outcomeText).toBe(GENERIC);
  });

  it('normalises whitespace-only and null to omitted', () => {
    const r = parse({ outcomeText: '   ', successText: '\n\t', failureText: null });
    expect(r.success).toBe(true);
    expect(r.data!.outcomeText).toBeUndefined();
    expect(r.data!.successText).toBeUndefined();
    expect(r.data!.failureText).toBeUndefined();
  });

  it('preserves intentional internal line breaks and folds CRLF', () => {
    expect(parse({ outcomeText: 'First beat.\r\n\r\nSecond beat.' }).data!.outcomeText).toBe(
      'First beat.\n\nSecond beat.',
    );
  });

  it.each([42, true, { text: 'x' }, ['x']])('rejects a non-string (%j)', (bad) => {
    expect(parse({ outcomeText: bad }).success).toBe(false);
    expect(parse({ successText: bad }).success).toBe(false);
    expect(parse({ failureText: bad }).success).toBe(false);
  });

  it(`enforces the ${OUTCOME_TEXT_MAX_LENGTH}-character limit after trimming`, () => {
    expect(parse({ outcomeText: 'a'.repeat(OUTCOME_TEXT_MAX_LENGTH) }).success).toBe(true);
    expect(parse({ outcomeText: `  ${'a'.repeat(OUTCOME_TEXT_MAX_LENGTH)}  ` }).success).toBe(true);
    expect(parse({ failureText: 'a'.repeat(OUTCOME_TEXT_MAX_LENGTH + 1) }).success).toBe(false);
  });
});

/* ─────────────────────── Precedence ─────────────────────── */

describe('resolveOutcomeText precedence', () => {
  const all = { outcomeText: GENERIC, successText: SUCCESS, failureText: FAILURE };

  it('no-check choice uses outcomeText', () => {
    expect(resolveOutcomeText(all, 'auto')).toBe(GENERIC);
  });

  it('no-check choice ignores stored branch text', () => {
    expect(resolveOutcomeText({ successText: SUCCESS, failureText: FAILURE }, 'auto')).toBeNull();
  });

  it('checked success uses successText', () => {
    expect(resolveOutcomeText(all, 'success')).toBe(SUCCESS);
  });

  it('checked success falls back to outcomeText', () => {
    expect(resolveOutcomeText({ outcomeText: GENERIC, failureText: FAILURE }, 'success')).toBe(GENERIC);
  });

  it('checked failure uses failureText', () => {
    expect(resolveOutcomeText(all, 'failure')).toBe(FAILURE);
  });

  it('checked failure falls back to outcomeText', () => {
    expect(resolveOutcomeText({ outcomeText: GENERIC, successText: SUCCESS }, 'failure')).toBe(GENERIC);
  });

  it('produces no flavor when nothing matches', () => {
    expect(resolveOutcomeText({}, 'auto')).toBeNull();
    expect(resolveOutcomeText({ failureText: FAILURE }, 'success')).toBeNull();
    expect(resolveOutcomeText({ successText: SUCCESS }, 'failure')).toBeNull();
    expect(resolveOutcomeText({ outcomeText: null, successText: '  ' }, 'success')).toBeNull();
  });

  it('maps check facts onto outcome kinds', () => {
    expect(outcomeKindOf(false, true)).toBe('auto');
    expect(outcomeKindOf(false, false)).toBe('auto');
    expect(outcomeKindOf(true, true)).toBe('success');
    expect(outcomeKindOf(true, false)).toBe('failure');
  });
});

/* ─────────────────────── Preview + simulator ─────────────────────── */

function choice(overrides: Partial<Choice> = {}): Choice {
  return {
    id: 1,
    sortOrder: 0,
    label: 'Cross',
    emoji: null,
    requirements: {},
    check: { type: 'sp', baseChance: 0.5, maxSpModifier: 0 },
    successEffects: [
      { type: 'waifubux_gain', amount: 100 },
      { type: 'trigger_encounter', encounterSlug: 'far_side' },
    ],
    failureEffects: [{ type: 'waifubux_loss', amount: 50 }],
    ...overrides,
  } as Choice;
}

const ctx: EncounterCheckContext = { playerId: 0, playerLevel: 20, buddy: null, buddyBonusPercent: 0 };

describe('preview flavor (server-resolved, per outcome)', () => {
  it('reports success and failure for a checked choice', () => {
    expect(previewOutcomeFlavor(choice({ successText: SUCCESS, failureText: FAILURE }))).toEqual([
      { outcome: 'success', resolvedOutcomeText: SUCCESS },
      { outcome: 'failure', resolvedOutcomeText: FAILURE },
    ]);
  });

  it('falls back to outcomeText for each branch', () => {
    expect(previewOutcomeFlavor(choice({ outcomeText: GENERIC }))).toEqual([
      { outcome: 'success', resolvedOutcomeText: GENERIC },
      { outcome: 'failure', resolvedOutcomeText: GENERIC },
    ]);
  });

  it('reports one auto outcome for a no-check choice', () => {
    expect(
      previewOutcomeFlavor(choice({ check: { type: 'none' }, outcomeText: GENERIC, successText: SUCCESS })),
    ).toEqual([{ outcome: 'auto', resolvedOutcomeText: GENERIC }]);
  });

  it('reports nulls when nothing is authored', () => {
    expect(previewOutcomeFlavor(choice()).every((f) => f.resolvedOutcomeText === null)).toBe(true);
  });
});

describe('simulator flavor follows the actual rolls', () => {
  const flavored = choice({ outcomeText: GENERIC, successText: SUCCESS, failureText: FAILURE });

  it('pairs each observed outcome with its flavor and roll count', () => {
    const r = simulateChoice(flavored, { rolls: 1000 }, ctx, 42);
    expect(r.outcomeTexts).toEqual([
      { outcome: 'success', count: r.successes, resolvedOutcomeText: SUCCESS },
      { outcome: 'failure', count: r.failures, resolvedOutcomeText: FAILURE },
    ]);
  });

  it('lists only outcomes the run produced — never a fabricated one', () => {
    const r = simulateChoice(
      choice({ check: { type: 'sp', baseChance: 1, maxSpModifier: 0 }, successText: SUCCESS, failureText: FAILURE }),
      { rolls: 50 },
      ctx,
      1,
    );
    // The resolver clamps to 95 %, so allow the odd failure, but every
    // listed entry must correspond to rolls that actually happened.
    for (const entry of r.outcomeTexts) expect(entry.count).toBeGreaterThan(0);
    expect(r.outcomeTexts.reduce((n, e) => n + e.count, 0)).toBe(50);
  });

  it('falls back to outcomeText', () => {
    const r = simulateChoice(choice({ outcomeText: GENERIC }), { rolls: 500 }, ctx, 3);
    expect(r.outcomeTexts.map((o) => o.resolvedOutcomeText)).toEqual([GENERIC, GENERIC]);
  });

  it('reports auto for a no-check choice', () => {
    const r = simulateChoice(choice({ check: { type: 'none' }, outcomeText: GENERIC }), { rolls: 10 }, ctx, 3);
    expect(r.outcomeTexts).toEqual([{ outcome: 'auto', count: 10, resolvedOutcomeText: GENERIC }]);
  });

  it('reports null flavor when nothing is authored', () => {
    const r = simulateChoice(choice(), { rolls: 200 }, ctx, 9);
    expect(r.outcomeTexts.every((o) => o.resolvedOutcomeText === null)).toBe(true);
  });

  it('changes nothing else about the run: same seed, same rolls, same effects', () => {
    const { outcomeTexts: _a, ...withFlavor } = simulateChoice(flavored, { rolls: 2000 }, ctx, 77);
    const { outcomeTexts: _b, ...without } = simulateChoice(choice(), { rolls: 2000 }, ctx, 77);
    expect(withFlavor).toEqual(without);
  });
});

/* ─────────────────────── Package ─────────────────────── */

function loaded(choiceOverrides: Partial<Choice> = {}): LoadedEncounter {
  return {
    id: 1,
    slug: 'crumbling_bridge',
    name: 'Crumbling Bridge',
    description: 'Old planks over a long drop.',
    type: 'skill_check',
    rarity: 'common',
    weight: 10,
    lifecycle: 'draft',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    choices: [
      {
        id: 10,
        sortOrder: 0,
        label: 'Cross',
        emoji: null,
        requirements: {},
        check: { type: 'sp', baseChance: 0.55 },
        successEffects: [{ type: 'waifubux_gain', amount: 50 }],
        failureEffects: [],
        outcomeText: null,
        successText: null,
        failureText: null,
        ...choiceOverrides,
      },
    ],
    metadata: {},
  };
}

function target(existing: LoadedEncounter[] = []): ImportTargetState {
  return {
    existingEncounters: new Map(existing.map((e) => [e.slug, e])),
    existingVendors: new Map(),
    itemSlugs: new Set(),
    speciesSlugs: new Set(),
  };
}

const pkgOf = (e: LoadedEncounter) =>
  buildEncounterPackage({ encounters: [e], vendors: [], exportedAt: new Date('2026-09-11T00:00:00Z') });

describe('package: flavor text', () => {
  it('a legacy encounter exports no flavor keys and round-trips unchanged', () => {
    const legacy = loaded();
    const pkg = pkgOf(legacy);
    const packagedChoice = pkg.encounters[0]!.choices[0]!;
    expect(Object.keys(packagedChoice)).not.toEqual(
      expect.arrayContaining(['outcomeText']),
    );
    expect(JSON.stringify(pkg)).not.toMatch(/outcomeText|successText|failureText/);

    const plan = planImport(JSON.parse(JSON.stringify(pkg)), target([legacy]));
    expect(plan.ok).toBe(true);
    expect(plan.encounters[0]!.status).toBe('unchanged');
  });

  it('a legacy package file without the fields imports cleanly', () => {
    const raw = JSON.parse(JSON.stringify(pkgOf(loaded())));
    const plan = planImport(raw, target());
    expect(plan.ok).toBe(true);
    expect(plan.encounters[0]!.status).toBe('create');
  });

  it('exports all three fields and round-trips them', () => {
    const authored = loaded({ outcomeText: GENERIC, successText: SUCCESS, failureText: FAILURE });
    const pkg = pkgOf(authored);
    expect(pkg.encounters[0]!.choices[0]).toMatchObject({
      outcomeText: GENERIC,
      successText: SUCCESS,
      failureText: FAILURE,
    });

    const plan = planImport(JSON.parse(JSON.stringify(pkg)), target([authored]));
    expect(plan.ok).toBe(true);
    expect(plan.encounters[0]!.status).toBe('unchanged');
  });

  it('detects a flavor-only change as an update', () => {
    const before = loaded({ successText: SUCCESS });
    const after = pkgOf(loaded({ successText: 'A different ending.' }));
    const plan = planImport(JSON.parse(JSON.stringify(after)), target([before]));
    expect(plan.encounters[0]!.status).toBe('update');
  });

  it('normalises on import and re-exports the normalised form stably', () => {
    const raw = JSON.parse(JSON.stringify(pkgOf(loaded())));
    raw.encounters[0].choices[0].outcomeText = `   ${GENERIC}   `;
    raw.encounters[0].choices[0].failureText = '   ';
    const plan = planImport(raw, target());
    expect(plan.ok).toBe(true);

    // What apply would store, re-exported: trimmed, blank field gone.
    const stored = loaded({ outcomeText: GENERIC });
    const reexported = toPackagedEncounter(stored);
    expect(reexported.choices[0]!.outcomeText).toBe(GENERIC);
    expect('failureText' in reexported.choices[0]!).toBe(false);
    expect(stableJson(pkgOf(stored))).toBe(stableJson(pkgOf(stored)));
    // And the normalised import matches what is stored, so a second import is a no-op.
    expect(planImport(raw, target([stored])).encounters[0]!.status).toBe('unchanged');
  });

  it('rejects an invalid flavor type in import preview', () => {
    const raw = JSON.parse(JSON.stringify(pkgOf(loaded())));
    raw.encounters[0].choices[0].successText = 12;
    const plan = planImport(raw, target());
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => i.code === 'schema' && i.message.includes('successText'))).toBe(true);
  });

  it('rejects over-long flavor in import preview', () => {
    const raw = JSON.parse(JSON.stringify(pkgOf(loaded())));
    raw.encounters[0].choices[0].outcomeText = 'x'.repeat(OUTCOME_TEXT_MAX_LENGTH + 1);
    expect(planImport(raw, target()).ok).toBe(false);
  });
});
