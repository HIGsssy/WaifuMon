/**
 * What the event and pool editors are told about a draft. The numbers must be
 * the engine's: the same eligibility a real draw uses, the same check curve,
 * the same reading of a choice a run's screen is built from.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { DUNGEON_EVENT_LIMITS, DungeonEventSchema, DEFAULT_EVENT_SP_MODIFIER_BASIS_POINTS } from '../../../src/modules/dungeons/content/dungeonEvents';
import { eventPoolOf } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { CONSUMED_EVEN_IF_CHECK_FAILS, CONSUMED_WHEN_SELECTED } from '../../../src/discord/dungeonPresenter';
import {
  defaultEventAuthoringScenario,
  describeEventAuthoring,
  type EventAuthoringPreview,
  type EventAuthoringScenario,
  type EventPoolAuthoringView,
} from '../../../src/modules/dungeons/engine/eventAuthoring';
import { describeOfferedEvent } from '../../../src/modules/dungeons/engine/events';
import { startDungeonRun, stepDungeon } from '../../../src/modules/dungeons/engine/step';
import type { DungeonEventPoolAnalysis, DungeonEventPreview, DungeonEventScenario } from '../../../portal/src/api/dungeonEventTypes';
import { eventContext, eventDungeon } from '../../helpers/dungeonEventFixtures';

const scenario = (over: Partial<EventAuthoringScenario> = {}): EventAuthoringScenario => ({ ...defaultEventAuthoringScenario(), ...over });
const pool = (view: ReturnType<typeof describeEventAuthoring>) => view.eventPools.find((p) => p.poolId === 'scrapheap_finds')!;
const odds = (analysis: EventPoolAuthoringView['base']) => Object.fromEntries(analysis.entries.map((e) => [e.id, e.eligible ? Number(e.probability.toFixed(4)) : e.reason]));
const vault = (view: ReturnType<typeof describeEventAuthoring>) => Object.fromEntries(view.eventPreviews.find((e) => e.eventId === 'sealed_vault')!.choices.map((c) => [c.id, c]));

describe('pool odds for an author', () => {
  const definition = eventDungeon();

  it('gives base odds with every entry in the draw, whatever its rule', () => {
    // The alarm is raised and everything has been met: the base odds do not move.
    for (const s of [scenario(), scenario({ flags: ['alarm_triggered'], seenEvents: ['buried_crate', 'sparking_drone'] })]) {
      const base = pool(describeEventAuthoring(definition, s)).base;
      expect(base.totalWeight).toBe(100);
      expect(odds(base)).toEqual({ e_crate: 0.3, e_drone: 0.2, e_trader: 0.1, e_nothing: 0.4 });
      expect(base.nothingProbability).toBeCloseTo(0.4);
    }
  });

  it('takes conditional and already-met entries out of the draw for a situation', () => {
    // The design's worked example: crate found, alarm triggered → drone 20 and nothing 40.
    const view = pool(describeEventAuthoring(definition, scenario({ flags: ['alarm_triggered'], seenEvents: ['buried_crate'] }))).scenario;
    expect(view.totalWeight).toBe(60);
    expect(odds(view)).toEqual({ e_crate: 'already_seen', e_drone: 0.3333, e_trader: 'condition', e_nothing: 0.6667 });
    expect(view.nothingProbability).toBeCloseTo(2 / 3);
    // Met only matters for a once-per-run entry.
    const repeatable = eventDungeon((d) => { (d.eventPools![0]!.entries[0] as { oncePerRun?: boolean }).oncePerRun = false; });
    expect(odds(pool(describeEventAuthoring(repeatable, scenario({ seenEvents: ['buried_crate'] }))).scenario).e_crate).toBe(0.3);
  });

  it('reports a pool with nothing left in the draw as certain to present nothing', () => {
    const noNothing = eventDungeon((d) => { d.eventPools![0]!.entries.pop(); });
    const view = pool(describeEventAuthoring(noNothing, scenario({ flags: ['alarm_triggered'], seenEvents: ['buried_crate', 'sparking_drone'] }))).scenario;
    expect(view.totalWeight).toBe(0);
    expect(view.entries.every((e) => !e.eligible && e.probability === 0)).toBe(true);
    expect(view.nothingProbability).toBe(1);
    // With every entry in the draw the same pool never comes up empty.
    expect(pool(describeEventAuthoring(noNothing)).base.nothingProbability).toBe(0);
  });

  it('agrees with a real run: what a run draws is always in the scenario’s draw, and a run that met the crate cannot draw it again', () => {
    const ctx = eventContext(definition);
    for (let seed = 0; seed < 300; seed++) {
      const started = startDungeonRun(ctx, seed);
      const first = started.state.events!['hall:find']!;
      // An empty run: every unconditional entry and the trader are in the draw.
      const before = pool(describeEventAuthoring(definition)).scenario;
      expect(before.entries.filter((e) => e.eligible).map((e) => e.id)).toEqual(first.pool!.eligible);
      expect(before.totalWeight).toBe(first.pool!.totalWeight);
      if (first.eventId !== 'buried_crate') continue;
      // Carry on to the second room that draws from the same pool, by way of the vault.
      let state = started.state;
      const press = (input: Parameters<typeof stepDungeon>[1]) => {
        const result = stepDungeon(state, input, ctx);
        expect(result.status, JSON.stringify(input)).toBe('applied');
        state = result.state;
      };
      press({ type: 'choose', choiceId: 'dig' });
      press({ type: 'move', connectionId: 'c_vault' });
      press({ type: 'choose', choiceId: 'force' });
      // The breather that only exists once the vault is open.
      press({ type: 'advance' });
      press({ type: 'move', connectionId: 'c_heap' });
      const second = state.events!['heap:find']!;
      const told = pool(describeEventAuthoring(definition, scenario({ flags: Object.keys(state.flags).filter((f) => state.flags[f]), seenEvents: ['buried_crate', 'sealed_vault'] }))).scenario;
      expect(told.entries.filter((e) => e.eligible).map((e) => e.id)).toEqual(second.pool!.eligible);
      expect(told.totalWeight).toBe(second.pool!.totalWeight);
      expect(second.pool!.eligible).not.toContain('e_crate');
      return;
    }
    throw new Error('no seed drew the crate first');
  });

  it('answers for every pool and event, used or not, and for none when there are none', () => {
    const view = describeEventAuthoring(definition);
    expect(view.eventPools.map((p) => p.poolId)).toEqual(['scrapheap_finds']);
    expect(view.eventPreviews.map((e) => e.eventId)).toEqual(definition.events!.map((e) => e.id));
    expect(describeEventAuthoring({})).toEqual({ eventPools: [], eventPreviews: [] });
    expect(eventPoolOf(definition, 'scrapheap_finds')!.entries).toHaveLength(4);
  });
});

describe('an event’s choices for an author', () => {
  const definition = eventDungeon();

  it('reads each choice as the run’s own screen would, and marks the hidden one instead of dropping it', () => {
    const choices = vault(describeEventAuthoring(definition));
    expect(Object.keys(choices)).toEqual(['use_key', 'pick_lock', 'force', 'secret', 'leave']);
    expect(choices.use_key).toMatchObject({ available: false, unavailableReason: 'items', unavailableText: 'You have no Vault Key.', consumesOnSelect: true, hidden: false, items: [{ item: 'vault_key', quantity: 1, consume: true, owned: 0 }] });
    expect(choices.secret).toMatchObject({ available: false, unavailableReason: 'requires', hidden: true });
    expect(choices.leave).toMatchObject({ available: true, walksAway: true, hidden: false });
    expect(choices.force).toMatchObject({ available: true, check: null, chances: null });

    const held = vault(describeEventAuthoring(definition, scenario({ inventory: { vault_key: 1 }, flags: ['alarm_triggered'], canTurnBack: false })));
    expect(held.use_key).toMatchObject({ available: true, unavailableReason: null, items: [{ owned: 1 }] });
    expect(held.secret).toMatchObject({ available: true, hidden: false });
    expect(held.leave).toMatchObject({ available: false, unavailableReason: 'no_way_back' });
  });

  it('gives a check’s chance for the situation’s Buddy and for the weakest, average and strongest', () => {
    // The design's worked example: 55% for an average Buddy, 70% at SP 350, 44% at SP 90.
    expect(vault(describeEventAuthoring(definition)).pick_lock).toMatchObject({ check: { chanceBasisPoints: 5500, sp: 200 }, chances: { weakest: 4000, average: 5500, strongest: 7000 } });
    expect(vault(describeEventAuthoring(definition, scenario({ currentSp: 350 }))).pick_lock!.check).toEqual({ chanceBasisPoints: 7000, sp: 350 });
    expect(vault(describeEventAuthoring(definition, scenario({ currentSp: 90 }))).pick_lock!.check).toEqual({ chanceBasisPoints: 4400, sp: 90 });
    // Never certain, and Buddy strength can be made not to matter.
    const flat = eventDungeon((d) => { d.events![0]!.choices[1]!.check = { type: 'sp', baseChanceBasisPoints: 10_000, maxSpModifierBasisPoints: 0 }; });
    expect(vault(describeEventAuthoring(flat)).pick_lock!.chances).toEqual({ weakest: 9500, average: 9500, strongest: 9500 });
  });

  it('shows the same choices a run standing on the event is offered', () => {
    const ctx = eventContext(definition, { inventory: { vault_key: 2 } });
    let state = startDungeonRun(ctx, 3).state;
    const offered = () => describeOfferedEvent(state, ctx);
    // Get past whatever the hall drew, then walk to the vault.
    for (let guard = 0; guard < 4 && offered(); guard++) {
      const way = offered()!.choices.find((c) => c.available && !c.walksAway)!;
      const result = stepDungeon(state, { type: 'choose', choiceId: way.id }, ctx);
      state = result.state;
      if (state.status !== 'active') return;
    }
    state = stepDungeon(state, { type: 'move', connectionId: 'c_vault' }, ctx).state;
    const shown = offered()!;
    expect(shown.eventId).toBe('sealed_vault');
    const told = describeEventAuthoring(definition, scenario({ inventory: { vault_key: 2 }, flags: Object.keys(state.flags).filter((f) => state.flags[f]) }));
    const visible = told.eventPreviews.find((e) => e.eventId === 'sealed_vault')!.choices.filter((c) => !c.hidden).map(({ hidden: _hidden, chances: _chances, ...view }) => view);
    expect(visible).toEqual(shown.choices);
  });
});

describe('the Portal’s copies', () => {
  it('keeps the frontend-local event wire types compatible with the engine’s', () => {
    expectTypeOf<EventAuthoringScenario>().toMatchTypeOf<DungeonEventScenario>();
    expectTypeOf<DungeonEventScenario>().toMatchTypeOf<EventAuthoringScenario>();
    expectTypeOf<EventPoolAuthoringView>().toMatchTypeOf<DungeonEventPoolAnalysis>();
    expectTypeOf<DungeonEventPoolAnalysis>().toMatchTypeOf<EventPoolAuthoringView>();
    expectTypeOf<EventAuthoringPreview>().toMatchTypeOf<DungeonEventPreview>();
    expectTypeOf<DungeonEventPreview>().toMatchTypeOf<EventAuthoringPreview>();
  });

  // The Portal may not import bot source, so its mirrored numbers and wording are read as text.
  const portal = (file: string) => readFileSync(join(process.cwd(), 'portal/src/features/adminDungeons', file), 'utf8');
  const numbers = (source: string, name: string) => {
    const body = new RegExp(`export const ${name} = \\{([^}]*)\\}`).exec(source)?.[1];
    if (!body) throw new Error(`${name} not found`);
    return Object.fromEntries([...body.matchAll(/(\w+):\s*([\d_]+)/g)].map((m) => [m[1]!, Number(m[2]!.replaceAll('_', ''))]));
  };

  it('mirrors the event limits the schema enforces', () => {
    const model = portal('dungeonEventModel.ts');
    const limits = numbers(model, 'EVENT_LIMITS');
    const { maxSpModifierBasisPoints, ...shared } = DUNGEON_EVENT_LIMITS;
    expect(limits).toMatchObject(shared);
    expect(model).toContain(`MAX_SP_INFLUENCE_BASIS_POINTS = ${maxSpModifierBasisPoints}`);
    expect(model).toContain(`DEFAULT_SP_INFLUENCE_BASIS_POINTS = ${DEFAULT_EVENT_SP_MODIFIER_BASIS_POINTS}`);
    // Text lengths: exactly at the mirrored limit parses, one more does not.
    const event = (over: object, choice: object = {}) => ({ id: 'e', title: 'T', text: 'S', choices: [{ id: 'c', label: 'L', outcome: { text: '' }, ...choice }], ...over });
    const fits = (build: (n: number) => unknown, max: number, what: string) => {
      expect(DungeonEventSchema.safeParse(build(max)).success, `${what} at ${max}`).toBe(true);
      expect(DungeonEventSchema.safeParse(build(max + 1)).success, `${what} at ${max + 1}`).toBe(false);
    };
    fits((n) => event({ title: 'x'.repeat(n) }), limits.title!, 'title');
    fits((n) => event({ text: 'x'.repeat(n) }), limits.text!, 'text');
    fits((n) => event({}, { label: 'x'.repeat(n) }), limits.label!, 'label');
    fits((n) => event({}, { description: 'x'.repeat(n) }), limits.description!, 'description');
    fits((n) => event({}, { unavailableText: 'x'.repeat(n) }), limits.unavailableText!, 'unavailableText');
    fits((n) => event({}, { outcome: { text: 'x'.repeat(n) } }), limits.outcomeText!, 'outcome text');
  });

  it('previews with the Discord screen’s own lengths and item-cost wording', () => {
    const preview = portal('eventPreviewModel.ts');
    expect(numbers(preview, 'DISCORD_EVENT_LIMITS')).toEqual({ title: 80, text: 1500, choiceLabel: 60, description: 200, unavailableText: 120, outcomeText: 800, button: 80, fieldValue: 1024, choices: 5 });
    expect(preview).toContain(`'${CONSUMED_WHEN_SELECTED}'`);
    expect(preview).toContain(`'${CONSUMED_EVEN_IF_CHECK_FAILS}'`);
  });
});
