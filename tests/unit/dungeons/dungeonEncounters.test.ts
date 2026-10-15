import { describe, expect, it } from 'vitest';
import {
  DungeonDefinitionSchema,
  DungeonSpeciesPoolSchema,
  DungeonSpeciesAccessSchema,
  type EncounterAction,
  type DungeonDefinition,
} from '../../../src/modules/dungeons/content/dungeonDefinition';
import {
  analyseSpeciesPool,
  selectDungeonEncounter,
  encounterInstanceKey,
} from '../../../src/modules/dungeons/engine/encounters';
import {
  startDungeonRun,
  stepDungeon,
} from '../../../src/modules/dungeons/engine/step';
import { dungeonRngSource } from '../../../src/modules/dungeons/engine/seeds';
import { describeDungeonRun } from '../../../src/modules/dungeons/engine/view';
import {
  createDungeonSandbox,
  autoPlayDungeonSandbox,
  sandboxEffectsPort,
} from '../../../src/modules/dungeons/engine/sandbox';
import { validateDungeonDefinition } from '../../../src/modules/dungeons/validation/dungeonValidation';
import {
  dungeonSpeciesUnavailableReason,
} from '../../../src/modules/dungeons/validation/dungeonEncounterValidation';
import {
  buildDungeonPackage,
  readDungeonPackage,
} from '../../../src/modules/dungeons/package/dungeonPackage';
import type {
  DungeonEngineContext,
  DungeonInput,
  DungeonRunState,
} from '../../../src/modules/dungeons/engine/types';
import { TEST_FIGHTER, testDungeon } from '../../helpers/dungeonFixtures';

const wild = (over: Record<string, unknown> = {}) => ({
  id: 'meet',
  type: 'wild_encounter',
  source: { kind: 'species', species: 'android' },
  intro: 'She appears.',
  capture: {},
  ...over,
});
const definition = (
  actions: unknown[] = [wild()],
  over: Record<string, unknown> = {},
): DungeonDefinition =>
  DungeonDefinitionSchema.parse({
    key: 'enc_test',
    name: 'Encounters',
    entranceRoomId: 'a',
    availableRegions: ['waifu-valley'],
    flags: [{ key: 'saved' }],
    rooms: [{ id: 'a', kind: 'exit', actions }],
    ...over,
  });
const ctx = (d = definition(), chance = 1): DungeonEngineContext => ({
  definition: d,
  dependencies: { enemies: {}, rewardTables: {} },
  fighter: TEST_FIGHTER,
  runKey: 'test-1',
  encounterFacts: {
    species: {
      android: {
        available: true,
        name: 'Android',
        rarity: 'N',
        directRescue: { available: true },
      },
      other: { available: true, name: 'Other', rarity: 'R' },
    },
    items: {
      charm: {
        owned: 5,
        eligible: true,
        permitted: true,
        guaranteed: false,
        chance,
        consumesMicrodose: true,
      },
    },
  },
});
const facts = { flags: {}, playerFlags: {}, rooms: {} };
const pool = DungeonSpeciesPoolSchema.parse({
  id: 'pool',
  name: 'Wild',
  entries: [
    { id: 'android', species: 'android', weight: 3 },
    { id: 'other', species: 'other', weight: 1 },
    { id: 'none', nothing: true, weight: 1, text: 'Quiet.' },
  ],
});
const encounter = (state: DungeonRunState) =>
  state.encounters![encounterInstanceKey('a', 'meet')]!;
function play(c: DungeonEngineContext, seed = 10) {
  let state = startDungeonRun(c, seed).state;
  return {
    get state() {
      return state;
    },
    input(input: DungeonInput) {
      const result = stepDungeon(
        state,
        { expectedStep: state.step, ...input },
        c,
      );
      if (result.status === 'applied') state = result.state;
      return result;
    },
  };
}

describe('species pools', () => {
  it('uses integer weights and the same analysis for preview and draw', () => {
    const analysis = analyseSpeciesPool(pool, facts);
    expect(analysis.totalWeight).toBe(5);
    expect(analysis.entries.map((e) => e.probability)).toEqual([0.6, 0.2, 0.2]);
    expect(analysis.nothingProbability).toBe(0.2);
    const d = definition([wild({ source: { kind: 'pool', poolId: 'pool' } })], {
      speciesPools: [pool],
    });
    const state = startDungeonRun(ctx(definition()), 1).state;
    let counts = [0, 0, 0];
    for (let seed = 0; seed < 1000; seed++) {
      const selected = selectDungeonEncounter(
        d,
        d.rooms[0]!.actions[0] as EncounterAction,
        { roomId: 'a', actionId: 'meet' },
        { ...state, encounters: {} },
        facts,
        dungeonRngSource(seed),
      );
      counts[pool.entries.findIndex((e) => e.id === selected.pool!.entryId)]!++;
      expect(selected.pool!.eligible).toEqual(
        analysis.entries.map((e) => e.id),
      );
    }
    expect(counts[0]).toBeGreaterThan(540);
    expect(counts[0]).toBeLessThan(660);
    expect(counts[1]).toBeGreaterThan(150);
    expect(counts[2]).toBeGreaterThan(150);
  });
  it('filters conditions and seen species, including named encounters and other pools', () => {
    const conditional = DungeonSpeciesPoolSchema.parse({
      ...pool,
      entries: [
        {
          id: 'conditional',
          species: 'android',
          weight: 3,
          when: { type: 'flag', flag: 'saved' },
        },
        { id: 'repeat', species: 'other', weight: 1, oncePerRun: false },
      ],
    });
    expect(
      analyseSpeciesPool(conditional, facts, new Set(['other'])).entries.map(
        (e) => e.reason,
      ),
    ).toEqual(['condition', null]);
    expect(
      analyseSpeciesPool(
        conditional,
        { ...facts, flags: { saved: true } },
        new Set(['android']),
      ).entries.map((e) => e.reason),
    ).toEqual(['already_seen', null]);
    const d = definition(
      [
        wild(),
        wild({ id: 'second', source: { kind: 'pool', poolId: 'only' } }),
      ],
      {
        speciesPools: [
          {
            id: 'only',
            name: 'Only',
            entries: [{ id: 'one', weight: 1, species: 'android' }],
          },
        ],
      },
    );
    const p = play(ctx(d));
    p.input({ type: 'leave_encounter' });
    expect(p.state.encounters!['a:second']).toMatchObject({
      species: null,
      status: 'nothing',
      pool: { totalWeight: 0, roll: null, entryId: null },
    });
  });
  it('does not draw for skipped encounter conditions', () => {
    const p = play(
      ctx(definition([wild({ when: { type: 'flag', flag: 'saved' } })])),
    );
    expect(p.state.encounters).toBeUndefined();
  });
  it('draws Nothing with authored text and applies nothing-result flags', () => {
    const d = definition(
      [
        wild({
          source: { kind: 'pool', poolId: 'none' },
          results: { nothing: { flags: [{ flag: 'saved', value: true }] } },
        }),
      ],
      {
        speciesPools: [
          {
            id: 'none',
            name: 'None',
            entries: [{ id: 'no', weight: 1, nothing: true, text: 'No one.' }],
          },
        ],
      },
    );
    const state = startDungeonRun(ctx(d), 1).state;
    expect(encounter(state)).toMatchObject({
      status: 'nothing',
      resolvedStep: 0,
    });
    expect(state.flags.saved).toBe(true);
    expect(state.recent[0]).toMatchObject({
      kind: 'encounter',
      text: 'No one.',
    });
  });
  it('keeps live unavailable weight in the draw and resolves it without redistribution', () => {
    const d = definition([wild({ source: { kind: 'pool', poolId: 'pool' } })], {
      speciesPools: [pool],
    });
    for (let seed = 0; seed < 50; seed++) {
      const available = ctx(d),
        disabled = ctx(d);
      disabled.encounterFacts!.species.android!.available = false;
      disabled.encounterFacts!.species.android!.reason = 'player_limit';
      const before = startDungeonRun(available, seed).state,
        after = startDungeonRun(disabled, seed).state;
      expect(encounter(after).species).toBe(encounter(before).species);
      expect(encounter(after).pool).toEqual(encounter(before).pool);
      if (encounter(after).species === 'android')
        expect(encounter(after)).toMatchObject({
          status: 'unavailable',
          unavailableReason: 'player_limit',
        });
    }
  });
  it('isolates place streams from unrelated draws and persists selection across JSON replay and retry', () => {
    const c = ctx(
      definition([wild({ source: { kind: 'pool', poolId: 'pool' } })], {
        speciesPools: [pool],
      }),
    );
    const rng = dungeonRngSource(22);
    const first = startDungeonRun(c, 22, rng);
    rng.stream('combat', 'any', 12).next();
    rng.stream('event', 'elsewhere', 'pool').next();
    expect(startDungeonRun(c, 22, rng)).toEqual(first);
    const state = JSON.parse(JSON.stringify(first.state));
    expect(
      stepDungeon(state, { type: 'select_item', item: 'charm' }, c),
    ).toEqual(stepDungeon(state, { type: 'select_item', item: 'charm' }, c));
    expect(encounter(state)).toEqual(encounter(first.state));
  });
  it('supports two pools and several references independently', () => {
    const d = definition(
      [
        wild({ source: { kind: 'pool', poolId: 'first' } }),
        wild({ id: 'again', source: { kind: 'pool', poolId: 'first' } }),
        wild({ id: 'last', source: { kind: 'pool', poolId: 'last' } }),
      ],
      {
        speciesPools: [
          {
            id: 'first',
            name: 'First',
            entries: [
              { id: 'one', species: 'android', weight: 1, oncePerRun: false },
            ],
          },
          {
            id: 'last',
            name: 'Last',
            entries: [{ id: 'two', species: 'other', weight: 1 }],
          },
        ],
      },
    );
    const p = play(ctx(d));
    p.input({ type: 'leave_encounter' });
    p.input({ type: 'leave_encounter' });
    expect(p.state.encounters!['a:again']!.species).toBe('android');
    expect(p.state.encounters!['a:last']!.species).toBe('other');
  });
});

describe('encounter steps', () => {
  it('selects a charm in its own step, exposes quoted odds, and emits deterministic capture and SP facts', () => {
    const c = ctx(),
      p = play(c);
    expect(p.input({ type: 'capture' }).refusal).toBe('capture_item_required');
    expect(p.input({ type: 'select_item', item: 'charm' }).effects).toEqual([]);
    expect(describeDungeonRun(p.state, c).action!.encounter).toMatchObject({
      selectedItem: 'charm',
      attemptsLeft: 3,
      items: [{ item: 'charm', chance: 1 }],
    });
    const selected = structuredClone(p.state);
    const result = p.input({ type: 'capture' });
    expect(result).toEqual(
      stepDungeon(
        selected,
        { type: 'capture', expectedStep: selected.step },
        c,
      ),
    );
    expect(result.effects[0]).toMatchObject({
      type: 'capture_attempt',
      key: 'run:test-1:a:meet:capture:1',
      grantKey: 'dungeon:test-1:a:meet',
      consumesMicrodose: true,
      attempt: { n: 1, success: true },
    });
    expect(result.effects[0]).toHaveProperty(
      'spRoll',
      dungeonRngSource(10).stream('encounter', 'a', 'meet', 'sp').next(),
    );
    expect(encounter(p.state)).toMatchObject({
      status: 'captured',
      grantKey: 'dungeon:test-1:a:meet',
    });
    expect(encounter(selected).attempts).toEqual([]);
  });
  it.each([1, 2, 3])(
    'fails without routing below %i attempts and then escapes',
    (maxAttempts) => {
      const p = play(ctx(definition([wild({ capture: { maxAttempts } })]), 0));
      p.input({ type: 'select_item', item: 'charm' });
      for (let n = 1; n <= maxAttempts; n++) {
        const result = p.input({ type: 'capture' });
        expect(result.effects[0]).toMatchObject({
          type: 'capture_attempt',
          attempt: { n, success: false },
        });
        expect(encounter(p.state).status).toBe(
          n === maxAttempts ? 'escaped' : 'offered',
        );
        if (n < maxAttempts)
          expect(p.state.recent[0]).toMatchObject({ outcome: 'failure' });
      }
      expect(p.input({ type: 'capture' }).effects).toEqual([]);
    },
  );
  it.each(['missing', 'disabled', 'not_permitted', 'player_limit'] as const)(
    'rechecks live %s at attempt and spends nothing',
    (reason) => {
      const c = ctx(),
        p = play(c);
      p.input({ type: 'select_item', item: 'charm' });
      c.encounterFacts!.species.android!.available = false;
      c.encounterFacts!.species.android!.reason = reason;
      const result = p.input({ type: 'capture' });
      expect(
        result.effects.filter((e) => e.type === 'capture_attempt'),
      ).toEqual([]);
      expect(encounter(p.state)).toMatchObject({
        status: 'unavailable',
        unavailableReason: reason,
        attempts: [],
      });
    },
  );
  it('fails closed with no facts and allows Leave after availability changes', () => {
    const c = ctx();
    delete c.encounterFacts;
    expect(encounter(startDungeonRun(c, 1).state).status).toBe('unavailable');
    const available = ctx(),
      p = play(available);
    available.encounterFacts!.species.android!.available = false;
    expect(
      p
        .input({ type: 'leave_encounter' })
        .effects.filter((e) => e.type === 'capture_attempt'),
    ).toEqual([]);
    expect(encounter(p.state).status).toBe('left');
  });
  it.each(['owned', 'eligible', 'permitted', 'chance'] as const)(
    'refuses invalid current item %s without mutating state',
    (field) => {
      const c = ctx(),
        p = play(c);
      p.input({ type: 'select_item', item: 'charm' });
      const item = c.encounterFacts!.items!.charm!;
      if (field === 'owned') item.owned = 0;
      else if (field === 'chance') item.chance = NaN;
      else item[field] = false;
      const state = p.state;
      expect(p.input({ type: 'capture' }).refusal).toBe(
        'capture_item_unavailable',
      );
      expect(p.state).toBe(state);
    },
  );
  it('narrows allowed and guaranteed items and never spends Microdose on a guaranteed attempt', () => {
    const c = ctx();
    c.encounterFacts!.items!.charm!.guaranteed = true;
    const p = play(c);
    p.input({ type: 'select_item', item: 'charm' });
    expect(p.input({ type: 'capture' }).effects[0]).toMatchObject({
      guaranteed: true,
      consumesMicrodose: false,
      attempt: { chance: 1, success: true },
    });
    for (const capture of [
      { allowGuaranteedItems: false },
      { allowedItems: ['other_charm'] },
    ]) {
      const blocked = { ...c, definition: definition([wild({ capture })]) };
      expect(
        play(blocked).input({ type: 'select_item', item: 'charm' }).refusal,
      ).toBe('capture_item_unavailable');
    }
  });
  it.each(['direct', 'capture'] as const)(
    'rescues in %s mode and refuses the wrong input',
    (mode) => {
      const c = ctx(
        definition([
          wild({
            type: 'rescue',
            mode,
            ...(mode === 'direct' ? { capture: undefined } : {}),
          }),
        ]),
      );
      const p = play(c);
      expect(
        p.input({ type: mode === 'direct' ? 'capture' : 'rescue' }).refusal,
      ).toBe('not_available');
      if (mode === 'capture') p.input({ type: 'select_item', item: 'charm' });
      const result = p.input({
        type: mode === 'direct' ? 'rescue' : 'capture',
      });
      expect(result.effects[0]!.type).toBe(
        mode === 'direct' ? 'rescue_grant' : 'capture_attempt',
      );
      expect(encounter(p.state).status).toBe('rescued');
    },
  );
  it('applies result flags once, follows next for left, and does not reapply on re-entry', () => {
    const d = definition([
      wild({
        next: { type: 'action', actionId: 'after' },
        results: {
          left: { text: 'Goodbye.', flags: [{ flag: 'saved', value: true }] },
        },
      }),
      { id: 'skip', type: 'set_flag', flag: 'saved', value: false },
      { id: 'after', type: 'rest' },
    ]);
    const c = ctx(d),
      p = play(c);
    p.input({ type: 'leave_encounter' });
    expect(p.state.cursor.actionId).toBe('after');
    expect(p.state.flags.saved).toBe(true);
    expect(
      stepDungeon(p.state, { type: 'leave_encounter', expectedStep: 0 }, c)
        .refusal,
    ).toBe('stale');
  });
  it.each([
    'captured',
    'rescued',
    'escaped',
    'left',
    'nothing',
    'unavailable',
  ] as const)(
    'routes %s through its explicit outcome route and applies its flags',
    (outcome) => {
      const direct = outcome === 'rescued';
      const action = wild({
        ...(direct
          ? { type: 'rescue', mode: 'direct', capture: undefined }
          : { capture: { maxAttempts: 1 } }),
        ...(outcome === 'nothing'
          ? { source: { kind: 'pool', poolId: 'none' } }
          : {}),
        outcomes: { [outcome]: { type: 'action', actionId: 'target' } },
        results: { [outcome]: { flags: [{ flag: 'saved', value: true }] } },
      });
      const d = definition(
        [
          action,
          { id: 'skip', type: 'set_flag', flag: 'saved', value: false },
          { id: 'target', type: 'rest' },
        ],
        {
          speciesPools:
            outcome === 'nothing'
              ? [
                  {
                    id: 'none',
                    name: 'None',
                    entries: [{ id: 'none', weight: 1, nothing: true }],
                  },
                ]
              : undefined,
        },
      );
      const c = ctx(d, outcome === 'escaped' ? 0 : 1);
      if (outcome === 'unavailable')
        c.encounterFacts!.species.android!.available = false;
      const p = play(c);
      if (outcome === 'captured' || outcome === 'escaped') {
        p.input({ type: 'select_item', item: 'charm' });
        p.input({ type: 'capture' });
      } else if (outcome === 'rescued') p.input({ type: 'rescue' });
      else if (outcome === 'left') p.input({ type: 'leave_encounter' });
      expect(encounter(p.state).status).toBe(outcome);
      expect(p.state.cursor.actionId).toBe('target');
      expect(p.state.flags.saved).toBe(true);
    },
  );
  it('requires separate direct rescue authorization at arrival and rechecks it at rescue', () => {
    const d = definition([
      wild({ type: 'rescue', mode: 'direct', capture: undefined }),
    ]);
    const c = ctx(d);
    delete c.encounterFacts!.species.android!.directRescue;
    expect(encounter(startDungeonRun(c, 1).state)).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'direct_not_permitted',
    });
    c.encounterFacts!.species.android!.directRescue = { available: true };
    const p = play(c);
    c.encounterFacts!.species.android!.directRescue = {
      available: false,
      reason: 'direct_limit_missing',
    };
    expect(
      p
        .input({ type: 'rescue' })
        .effects.filter((e) => e.type === 'rescue_grant'),
    ).toEqual([]);
    expect(encounter(p.state).unavailableReason).toBe('direct_limit_missing');
  });
  it('keeps an offered selection on re-entry despite changed condition facts', () => {
    const d = definition([], {
      entranceRoomId: 'entrance',
      rooms: [
        { id: 'entrance', actions: [] },
        {
          id: 'a',
          actions: [
            wild({
              when: { type: 'flag', flag: 'saved' },
              source: { kind: 'pool', poolId: 'pool' },
            }),
          ],
        },
      ],
      connections: [{ id: 'in', from: 'entrance', to: 'a' }],
      speciesPools: [
        {
          id: 'pool',
          name: 'Pool',
          entries: [{ id: 'one', weight: 1, species: 'android' }],
        },
      ],
    });
    const c = ctx(d);
    let state = startDungeonRun(c, 17).state;
    state.flags.saved = true;
    state = stepDungeon(state, { type: 'move', connectionId: 'in' }, c).state;
    const selected = structuredClone(encounter(state));
    // A persisted offered instance survives navigation independently of action records.
    state.cursor = {
      roomId: 'entrance',
      actionId: null,
      waveIndex: 0,
      cameFrom: null,
    };
    state.flags.saved = false;
    state.rooms.a!.actions = {};
    const result = stepDungeon(
      JSON.parse(JSON.stringify(state)),
      { type: 'move', connectionId: 'in' },
      c,
    );
    expect(encounter(result.state)).toEqual(selected);
    expect(result.state.cursor.actionId).toBe('meet');
  });
  it('restores a resolved encounter after a later gate retreat without reapplying flags or granting', () => {
    const d = definition([], {
      entranceRoomId: 'entrance',
      flags: [{ key: 'saved' }, { key: 'open' }],
      rooms: [
        { id: 'entrance', actions: [] },
        {
          id: 'a',
          actions: [
            wild({
              results: {
                captured: { flags: [{ flag: 'saved', value: true }] },
              },
            }),
            {
              id: 'door',
              type: 'gate',
              requires: { type: 'flag', flag: 'open' },
            },
          ],
        },
        { id: 'exit', kind: 'exit', actions: [] },
      ],
      connections: [
        { id: 'enter', from: 'entrance', to: 'a' },
        { id: 'out', from: 'a', to: 'exit' },
      ],
    });
    const c = ctx(d),
      p = play(c);
    p.input({ type: 'move', connectionId: 'enter' });
    p.input({ type: 'select_item', item: 'charm' });
    p.input({ type: 'capture' });
    expect(p.state.cursor.roomId).toBe('entrance');
    p.state.flags.saved = false;
    p.state.flags.open = true;
    const result = p.input({ type: 'move', connectionId: 'enter' });
    expect(result.effects).toEqual([]);
    expect(p.state.flags.saved).toBe(false);
    expect(encounter(p.state).attempts).toHaveLength(1);
  });
  it.each(['advance', 'decline', 'choose', 'move', 'extract'] as const)(
    'refuses incompatible %s while offered',
    (type) => {
      const c = ctx(),
        p = play(c),
        before = p.state;
      const input =
        type === 'move'
          ? { type, connectionId: 'out' }
          : type === 'choose'
            ? { type, choiceId: 'choice' }
            : { type };
      expect(p.input(input).status).toBe('refused');
      expect(p.state).toBe(before);
    },
  );
  it('abandons without granting, spends nothing on stale input, and preserves selection', () => {
    const p = play(ctx());
    expect(
      p.input({ type: 'select_item', item: 'charm', expectedStep: 9 }).refusal,
    ).toBe('stale');
    expect(p.input({ type: 'abandon' }).effects.map((e) => e.type)).toEqual([
      'settle_run',
    ]);
    expect(encounter(p.state).status).toBe('offered');
  });
});

describe('validation, policy, sandbox and gates', () => {
  const codes = (d: unknown) =>
    validateDungeonDefinition(d).issues.map((i) => i.code);
  it('accepts valid pools, captures, placement and run result flags', () => {
    const d = definition(
      [
        wild({
          placement: {},
          mirror: true,
          results: { captured: { flags: [{ flag: 'saved', value: true }] } },
        }),
      ],
      { speciesPools: [pool] },
    );
    expect(
      validateDungeonDefinition(d).issues.filter((i) => i.severity === 'error'),
    ).toEqual([]);
    expect(d.rooms[0]!.actions[0]).toHaveProperty('capture.maxAttempts', 3);
  });
  it.each([
    [wild({ optional: true }), 'encounter_optional'],
    [wild({ next: { type: 'retreat' } }), 'encounter_route_retreat'],
    [
      wild({
        results: { captured: { flags: [{ flag: 'unknown', value: true }] } },
      }),
      'encounter_flag_undeclared',
    ],
    [wild({ results: { rescued: {} } }), 'unknown_outcome'],
    [
      wild({ source: { kind: 'pool', poolId: 'missing' } }),
      'species_pool_missing',
    ],
    [
      wild({ type: 'rescue', mode: 'capture', capture: undefined }),
      'capture_settings_invalid',
    ],
    [wild({ type: 'rescue', mode: 'direct' }), 'capture_settings_invalid'],
    [wild({ capture: { maxAttempts: 4 } }), 'capture_settings_invalid'],
  ])('reports structural activity configuration %s', (action, code) => {
    expect(
      codes({
        key: 'test',
        name: 'Test',
        entranceRoomId: 'a',
        rooms: [{ id: 'a', kind: 'exit', actions: [action] }],
      }),
    ).toContain(code);
  });
  it('checks duplicate species/entry ids, weights, pool references, conditions and limits', () => {
    expect(codes(definition([], { speciesPools: [pool, pool] }))).toContain(
      'species_pool_duplicate_entry',
    );
    expect(
      codes(
        definition([], {
          speciesPools: [
            { ...pool, entries: [pool.entries[0], pool.entries[0]] },
          ],
        }),
      ),
    ).toContain('species_pool_duplicate_entry');
    expect(
      codes({
        ...definition(),
        speciesPools: [
          { ...pool, entries: [{ id: 'bad', species: 'android', weight: 0 }] },
        ],
      }),
    ).toContain('species_pool_weight_invalid');
    expect(
      codes(
        definition([], {
          speciesPools: [
            { ...pool, entries: [{ id: 'none', weight: 1, nothing: true }] },
          ],
        }),
      ),
    ).toContain('species_pool_empty');
    expect(
      codes(
        definition(Array.from({ length: 41 }, (_, i) => wild({ id: `e${i}` }))),
      ),
    ).toContain('encounter_too_many');
    expect(
      codes(
        definition(
          Array.from({ length: 4 }, (_, i) =>
            wild({
              id: `e${i}`,
              type: 'rescue',
              mode: 'direct',
              capture: undefined,
            }),
          ),
        ),
      ),
    ).toContain('rescue_direct_too_many');
    const impossible = {
      type: 'all',
      conditions: [
        { type: 'flag', flag: 'saved' },
        { type: 'not', condition: { type: 'flag', flag: 'saved' } },
      ],
    };
    expect(codes(definition([wild({ when: impossible })]))).toContain(
      'encounter_condition_impossible',
    );
    expect(
      codes(
        definition([], {
          speciesPools: [
            {
              ...pool,
              entries: [
                { id: 'one', weight: 1, species: 'android', when: impossible },
              ],
            },
          ],
        }),
      ),
    ).toContain('species_pool_always_nothing');
  });
  it.each([0, -1, 1.1, null, '1', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid acquisition limit %s',
    (perPlayerLimit) => {
      expect(
        DungeonSpeciesAccessSchema.safeParse({
          dungeon: 'test',
          perPlayerLimit,
        }).success,
      ).toBe(false);
    },
  );
  it('supports unlimited and finite cross-run policy counts; direct rescue requires explicit finite authorization', () => {
    for (const perPlayerLimit of [undefined, 'unlimited', 1, 5]) {
      const access = DungeonSpeciesAccessSchema.parse({
        dungeon: 'test',
        perPlayerLimit,
        directRescue: true,
      });
      const p = { enabled: true, restricted: true, access: [access] };
      expect(dungeonSpeciesUnavailableReason(p, 'test', false, 0)).toBeNull();
      expect(dungeonSpeciesUnavailableReason(p, 'test', false, 5)).toBe(
        typeof perPlayerLimit === 'number' ? 'player_limit' : null,
      );
      expect(dungeonSpeciesUnavailableReason(p, 'test', true)).toBe(
        typeof perPlayerLimit === 'number' ? null : 'direct_limit_missing',
      );
      expect(dungeonSpeciesUnavailableReason(p, 'another', false)).toBe(
        'not_permitted',
      );
    }
    expect(
      dungeonSpeciesUnavailableReason(
        { enabled: true, restricted: false },
        'any',
        true,
      ),
    ).toBe('direct_not_permitted');
    expect(
      dungeonSpeciesUnavailableReason(
        { enabled: true, restricted: false },
        'any',
        false,
        1000,
      ),
    ).toBeNull();
  });
  it('accepts live validation facts through the adapter without any database access', () => {
    const d = definition([
      wild({ capture: { allowedItems: ['bad', 'disabled', 'missing'] } }),
    ]);
    const source = {
      species: () => ({ enabled: false, restricted: false }),
      item: (s: string) =>
        s === 'missing'
          ? undefined
          : { enabled: s !== 'disabled', capture: s !== 'bad' },
      hasUsableCaptureItem: () => false,
    };
    const issues = validateDungeonDefinition(d, {
      encounterSource: source,
    }).issues.map((i) => i.code);
    expect(issues).toEqual(
      expect.arrayContaining([
        'species_disabled',
        'capture_item_not_capture',
        'capture_item_disabled',
        'capture_item_missing',
        'capture_no_usable_item',
      ]),
    );
  });
  it.each(['wild_encounter', 'rescue'] as const)(
    'records simulated %s effects and changes no injected inventory, ownership, XP or quests',
    async (type) => {
      const d = definition([
        wild({
          type,
          ...(type === 'rescue' ? { mode: 'direct', capture: undefined } : {}),
        }),
      ]);
      const c = ctx(d),
        before = structuredClone(c),
        inventory = { charm: 5 };
      const sandbox = createDungeonSandbox({
        definition: d,
        dependencies: c.dependencies,
        fighter: c.fighter,
        seed: 10,
        encounterFacts: c.encounterFacts,
        inventory,
      });
      const result = await autoPlayDungeonSandbox(sandbox);
      expect(result.stoppedBy).toBe('ended');
      expect(c).toEqual(before);
      expect(inventory).toEqual({ charm: 5 });
      const effect = sandbox.effects[0]!;
      const receipt = await sandboxEffectsPort().apply(effect);
      expect(receipt).toMatchObject({ simulated: true });
      expect(sandbox.effects.map((e) => e.type)).toContain(
        type === 'rescue' ? 'rescue_grant' : 'capture_attempt',
      );
    },
  );
  it('allows structural preview while explicitly blocking package v1/v2/v3', () => {
    const d = definition();
    expect(validateDungeonDefinition(d).definition).toEqual(d);
    const source = {
      environment: 'test',
      origin: 'draft' as const,
      draftRevision: 1,
      publishedRevision: null,
    };
    expect(() => buildDungeonPackage({ definition: d, source })).toThrow(
      /source catalogue evidence/,
    );
    const pkg = buildDungeonPackage({ definition: testDungeon(), source });
    for (const schemaVersion of [1, 2, 3]) {
      const read = readDungeonPackage({ ...pkg, schemaVersion, dungeon: d });
      expect(read.ok).toBe(false);
      expect(
        read.issues.some((i) => i.code === 'package_schema_version'),
      ).toBe(true);
    }
  });
});

describe('dismissing an encounter that can no longer be had', () => {
  const unavailable = (c: DungeonEngineContext) => {
    Object.assign(c.encounterFacts!.species.android!, { available: false, reason: 'disabled' });
  };
  /** What would spend or grant: a dismissal emits none of these (an exit room may still settle the run). */
  const spending = (effects: { type: string }[]) =>
    effects.filter((e) => ['capture_attempt', 'rescue_grant', 'consume_items', 'grant_rewards'].includes(e.type));
  const withResult = (over: Record<string, unknown> = {}) =>
    definition([wild({ results: { unavailable: { text: 'She is gone.', flags: [{ flag: 'saved', value: true }] } }, ...over })]);

  it('resolves it unavailable with the authored text and flags, and no effect at all', () => {
    const c = ctx(withResult()),
      p = play(c);
    p.input({ type: 'select_item', item: 'charm' });
    unavailable(c);
    const result = p.input({ type: 'dismiss_encounter' });
    expect(result).toMatchObject({ status: 'applied', refusal: null });
    expect(spending(result.effects)).toEqual([]);
    expect(encounter(p.state)).toMatchObject({ species: 'android', status: 'unavailable', unavailableReason: 'disabled', attempts: [] });
    expect(p.state.flags.saved).toBe(true);
    expect(p.state.recent).toContainEqual(expect.objectContaining({ kind: 'encounter', outcome: 'unavailable', text: 'She is gone.' }));
    expect(result.log.map((l) => l.type)).not.toContain('capture_attempted');
  });

  it('is refused, changing nothing, while she can still be had — then resolves once she cannot', () => {
    const c = ctx(withResult()),
      p = play(c);
    p.input({ type: 'select_item', item: 'charm' });
    const before = p.state;
    const refused = p.input({ type: 'dismiss_encounter' });
    expect(refused).toMatchObject({ status: 'refused', refusal: 'encounter_available', effects: [] });
    expect(p.state).toBe(before);
    expect(encounter(p.state)).toMatchObject({ status: 'offered', selectedItem: 'charm' });
    unavailable(c);
    expect(p.input({ type: 'dismiss_encounter' }).status).toBe('applied');
    expect(encounter(p.state).status).toBe('unavailable');
  });

  it('never grants a direct rescue, whichever way the facts move', () => {
    const c = ctx(definition([wild({ type: 'rescue', mode: 'direct', capture: undefined })])),
      p = play(c);
    // Obtainable: refused, nothing granted.
    expect(p.input({ type: 'dismiss_encounter' })).toMatchObject({ status: 'refused', refusal: 'encounter_available', effects: [] });
    // Rescue no longer authorised: resolved unavailable, still nothing granted.
    c.encounterFacts!.species.android!.directRescue = { available: false, reason: 'direct_not_permitted' };
    const result = p.input({ type: 'dismiss_encounter' });
    expect(spending(result.effects)).toEqual([]);
    expect(encounter(p.state)).toMatchObject({ status: 'unavailable', unavailableReason: 'direct_not_permitted' });
    expect(encounter(p.state).grantKey).toBeUndefined();
  });

  it('a repeated press is stale or refused, never rerolls her, and never repeats the encounter', () => {
    const c = ctx(withResult()),
      p = play(c);
    unavailable(c);
    const step = p.state.step;
    p.input({ type: 'dismiss_encounter' });
    const resolved = p.state;
    expect(stepDungeon(resolved, { type: 'dismiss_encounter', expectedStep: step }, c).refusal).toBe('stale');
    // Even at the current step the encounter is over: the resolved instance is never offered again.
    c.encounterFacts!.species.android!.available = true;
    expect(stepDungeon(resolved, { type: 'dismiss_encounter', expectedStep: resolved.step }, c).status).toBe('refused');
    expect(encounter(resolved)).toMatchObject({ species: 'android', status: 'unavailable' });
  });
});
