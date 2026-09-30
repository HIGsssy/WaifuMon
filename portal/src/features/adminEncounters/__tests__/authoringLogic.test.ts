/**
 * The pure halves of the authoring redesign: durations, chain relationships,
 * list filters, plain-language summaries, follow-up storage and validation.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { describeCheck, describeEffect, describeEffects, describeRequirements } from '../describe';
import { formatDuration, formatDurationShort, splitDuration, toSeconds } from '../duration';
import { draftFrom } from '../encounterDraft';
import {
  DEFAULT_FILTERS,
  filterEncounters,
  loadFilters,
  saveFilters,
  summaryBadges,
} from '../encounterFilters';
import { buildChainTree, buildEncounterGraph, chainRoots, linksOf } from '../encounterGraph';
import { validateDraft } from '../encounterValidation';
import { describeFollowUps, followUpOf, setChoiceFollowUp, withFollowUp } from '../followUps';
import { slugify, uniqueSlug } from '../slugs';
import { vendorFormErrors, vendorFormWarnings, EMPTY_VENDOR_FORM } from '../vendorForm';
import {
  ALARM,
  ALL,
  BRIDGE,
  DOOR,
  EMPTY_SHOP,
  LAB,
  MERCHANT,
  ORPHAN,
  OVERRIDE,
  STALL,
  choice,
  enc,
} from './authoringFixtures';

const graph = buildEncounterGraph(ALL);
const names = {
  encounter: (s: string) => graph.encounters.get(s)?.name,
  item: (s: string) => ({ basic_charm: 'Basic Charm' })[s],
};

describe('durations', () => {
  it('splits seconds into the largest exact unit', () => {
    expect(splitDuration(900)).toEqual({ value: 15, unit: 'minutes' });
    expect(splitDuration(6 * 3600)).toEqual({ value: 6, unit: 'hours' });
    expect(splitDuration(86_400)).toEqual({ value: 1, unit: 'days' });
    expect(splitDuration(0)).toEqual({ value: 0, unit: 'minutes' });
    // Legacy odd values survive a round trip rather than being rounded.
    expect(splitDuration(90)).toEqual({ value: 1.5, unit: 'minutes' });
    expect(toSeconds(1.5, 'minutes')).toBe(90);
  });

  it('converts friendly values back to whole seconds', () => {
    expect(toSeconds(15, 'minutes')).toBe(900);
    expect(toSeconds(6, 'hours')).toBe(21_600);
    expect(toSeconds(1, 'days')).toBe(86_400);
    expect(toSeconds(-3, 'hours')).toBe(0);
    expect(toSeconds(Number.NaN, 'hours')).toBe(0);
  });

  it('formats for reading', () => {
    expect(formatDuration(900)).toBe('15 minutes');
    expect(formatDuration(21_600)).toBe('6 hours');
    expect(formatDuration(86_400)).toBe('1 day');
    expect(formatDuration(86_400 + 6 * 3600)).toBe('1 day 6 hours');
    expect(formatDuration(45)).toBe('45 seconds');
    expect(formatDurationShort(900)).toBe('15M');
    expect(formatDurationShort(86_400 + 6 * 3600)).toBe('1D 6H');
  });
});

describe('chain graph', () => {
  it('reads success/failure/outcome links the way the engine does', () => {
    expect(linksOf(DOOR).map((l) => [l.choiceLabel, l.branch, l.to, l.live])).toEqual([
      ['Open it', 'success', 'security_override', true],
      ['Open it', 'failure', 'alarm_triggered', true],
    ]);
    expect(linksOf(OVERRIDE)[0]).toMatchObject({ branch: 'outcome', to: 'hidden_laboratory' });
  });

  it('classifies roots, children and chain-only encounters', () => {
    expect(graph.roleOf('a_strange_door')).toMatchObject({ primary: 'root', parents: [] });
    expect(graph.roleOf('security_override')).toMatchObject({
      primary: 'chain-only',
      parents: ['a_strange_door'],
      children: ['hidden_laboratory'],
    });
    expect(graph.roleOf('alarm_triggered').primary).toBe('child');
    expect(graph.roleOf('market_stall').primary).toBe('standalone');
  });

  it('records every parent when several encounters lead to one', () => {
    const other = enc({
      id: 99,
      slug: 'side_door',
      name: 'Side Door',
      choices: [
        choice(990, 'Sneak', { type: 'none' }, [
          { type: 'trigger_encounter', encounterSlug: 'security_override' },
        ]),
      ],
    });
    const g = buildEncounterGraph([...ALL, other]);
    expect(g.roleOf('security_override').parents.sort()).toEqual(['a_strange_door', 'side_door']);
  });

  it('flags orphans, missing and inactive targets, and children that also spawn', () => {
    const codes = graph.issues.map((i) => `${i.code}:${i.slug}`);
    expect(codes).toContain('orphan:lonely_room');
    expect(codes).toContain('missing_target:broken_bridge');
    expect(codes).toContain('inactive_target:a_strange_door'); // Security Override is a draft
    expect(codes).toContain('also_spawns:alarm_triggered');
    expect(graph.issues.find((i) => i.code === 'inactive_target')!.message).toMatch(
      /Follow-ups only open while Active/,
    );
  });

  it('marks follow-ups the engine never uses', () => {
    const twice = enc({
      id: 50,
      slug: 'twice',
      name: 'Twice',
      chainedEncounterSlug: 'hidden_laboratory',
      choices: [
        choice(
          500,
          'Go',
          { type: 'none' },
          [
            { type: 'trigger_encounter', encounterSlug: 'alarm_triggered' },
            { type: 'trigger_encounter', encounterSlug: 'hidden_laboratory' },
          ],
          [{ type: 'trigger_encounter', encounterSlug: 'alarm_triggered' }],
        ),
      ],
    });
    const links = linksOf(twice);
    expect(links.map((l) => l.deadReason ?? 'live')).toEqual([
      'live',
      'shadowed',
      'failure_never_runs',
      // Every outcome has its own follow-up, so "after any choice" never fires.
      'shadowed',
    ]);
  });

  it('detects loops once and still draws a finite tree', () => {
    const a = enc({
      id: 60,
      slug: 'loop_a',
      name: 'Loop A',
      choices: [
        choice(600, 'On', { type: 'none' }, [
          { type: 'trigger_encounter', encounterSlug: 'loop_b' },
        ]),
      ],
    });
    const b = enc({
      id: 61,
      slug: 'loop_b',
      name: 'Loop B',
      huntEligible: false,
      choices: [
        choice(610, 'Back', { type: 'none' }, [
          { type: 'trigger_encounter', encounterSlug: 'loop_a' },
        ]),
      ],
    });
    const g = buildEncounterGraph([a, b]);
    expect(g.issues.filter((i) => i.code === 'cycle')).toHaveLength(1);
    const tree = buildChainTree(g, 'loop_a');
    const back = tree.choices[0]!.branches[0]!.node.choices[0]!.branches[0]!.node;
    expect(back).toMatchObject({ slug: 'loop_a', repeat: true });
    expect(chainRoots(g)).toEqual(['loop_a']);
  });

  it('builds the chain tree from the root with branches per choice', () => {
    expect(chainRoots(graph)).toEqual(['a_strange_door', 'broken_bridge']);
    const tree = buildChainTree(graph, 'a_strange_door');
    expect(tree.choices).toHaveLength(1); // only “Open it” leads anywhere
    const [success, failure] = tree.choices[0]!.branches;
    expect(success!.link.branch).toBe('success');
    expect(success!.node.slug).toBe('security_override');
    expect(success!.node.choices[0]!.branches[0]!.node.slug).toBe('hidden_laboratory');
    expect(failure!.node.slug).toBe('alarm_triggered');
    expect(
      buildChainTree(graph, 'broken_bridge').choices[0]!.branches[0]!.node.encounter,
    ).toBeNull();
  });
});

describe('list filters and row summaries', () => {
  const f = (over: Partial<typeof DEFAULT_FILTERS>) =>
    filterEncounters(ALL, { ...DEFAULT_FILTERS, ...over }, graph)
      .map((e) => e.slug)
      .sort();

  it('filters by chain role', () => {
    expect(f({ role: 'root' })).toEqual(['a_strange_door', 'broken_bridge']);
    expect(f({ role: 'child' })).toEqual([
      'alarm_triggered',
      'hidden_laboratory',
      'security_override',
    ]);
    expect(f({ role: 'chain-only' })).toEqual([
      'hidden_laboratory',
      'lonely_room',
      'security_override',
    ]);
    expect(f({ role: 'standalone' })).toEqual(['market_stall']);
  });

  it('filters by status, source, region, type, artwork and vendor', () => {
    expect(f({ status: 'draft' })).toEqual(['lonely_room', 'security_override']);
    expect(f({ source: 'travel' })).toEqual(['a_strange_door']);
    expect(f({ source: 'both' })).toEqual([]);
    // Global encounters (no region) match every region filter.
    expect(f({ region: 'waifu-valley' })).not.toContain('market_stall');
    expect(f({ region: 'twin-peeks' })).toContain('market_stall');
    expect(f({ type: 'vendor' })).toEqual(['market_stall']);
    expect(f({ artwork: 'has' })).toEqual(['a_strange_door', 'market_stall']);
    expect(f({ artwork: 'missing' })).not.toContain('a_strange_door');
    expect(f({ vendor: 'opens' })).toEqual(['market_stall']);
  });

  it('search matches names, slugs and linked encounters', () => {
    expect(f({ q: 'hidden_lab' })).toEqual(['hidden_laboratory', 'security_override']);
    // Searching the door finds the door and everything it leads to.
    expect(f({ q: 'strange door' })).toEqual([
      'a_strange_door',
      'alarm_triggered',
      'security_override',
    ]);
  });

  it('summarises how each encounter takes part', () => {
    expect(summaryBadges(DOOR, graph).join(' · ')).toBe(
      'TRAVEL · CHAIN ROOT · 3 CHOICES · 15M REPEAT',
    );
    expect(summaryBadges(OVERRIDE, graph).join(' · ')).toBe(
      'CHAIN ONLY · CHILD OF: A Strange Door · LEADS TO 1 · 1 CHOICE',
    );
    expect(summaryBadges(STALL, graph)).toContain('OPENS VENDOR');
  });

  afterEach(() => sessionStorage.clear());
  it('persists filters for the tab', () => {
    saveFilters({ ...DEFAULT_FILTERS, role: 'child', q: 'door' });
    expect(loadFilters()).toMatchObject({ role: 'child', q: 'door', status: '' });
    sessionStorage.setItem('wm.admin.encounterFilters', '{not json');
    expect(loadFilters()).toEqual(DEFAULT_FILTERS);
  });
});

describe('plain-language summaries', () => {
  it('describes effects by what they do', () => {
    expect(describeEffect({ type: 'energy_gain', amount: 3 })).toBe('Gain 3 Energy');
    expect(describeEffect({ type: 'consume_item', slug: 'basic_charm', quantity: 1 }, names)).toBe(
      'Consume 1 × Basic Charm',
    );
    expect(describeEffect({ type: 'waifubux_loss_percent', percent: 0.1, maxAmount: 500 })).toBe(
      'Lose 10% of Waifubux (at most 500)',
    );
    expect(describeEffect({ type: 'temp_buff', key: 'lucky', durationSeconds: 3600 })).toBe(
      'Buff “lucky” for 1 hour',
    );
    expect(
      describeEffect(
        { type: 'open_vendor', vendorKey: 'x' },
        { vendor: () => 'Wandering Merchant' },
      ),
    ).toBe('Open vendor: Wandering Merchant');
    expect(describeEffect({ type: 'give_item', quantity: 1 })).toBe('Give 1 × (no item picked)');
    expect(
      describeEffects([
        { type: 'energy_gain', amount: 3 },
        { type: 'player_xp', amount: 10 },
      ]),
    ).toBe('Gain 3 Energy, +10 Player XP');
    expect(describeEffects([])).toBe('Nothing');
  });

  it('describes requirements and resolution', () => {
    expect(describeRequirements({})).toBe('None');
    expect(
      describeRequirements(
        { requiresItem: 'basic_charm', minPlayerLevel: 10, raceAny: ['demon'] },
        names,
      ),
    ).toBe('Owns Basic Charm · Player level 10+ · Demon buddy');
    expect(describeCheck({ type: 'none' })).toBe('Automatic');
    expect(describeCheck({ type: 'sp', baseChance: 0.4, maxSpModifier: 0.15 })).toBe(
      'Skill check · 40% base, ±15% from Buddy SP',
    );
    expect(describeCheck({ type: 'sp', difficulty: 50 })).toBe(
      'Skill check (legacy) · difficulty 50',
    );
  });

  it('summarises follow-ups per branch', () => {
    const d = draftFrom(DOOR);
    expect(describeFollowUps(d.choices[0]!, names)).toBe(
      'On success → Security Override · On failure → Alarm Triggered',
    );
    expect(describeFollowUps(d.choices[1]!, names)).toBe('None');
  });
});

describe('follow-up storage', () => {
  it('replaces the first follow-up in place, so effect order never shifts', () => {
    const effects = [
      { type: 'energy_gain', amount: 3 },
      { type: 'trigger_encounter', encounterSlug: 'a' },
      { type: 'player_xp', amount: 1 },
    ];
    expect(withFollowUp(effects, 'b')).toEqual([
      { type: 'energy_gain', amount: 3 },
      { type: 'trigger_encounter', encounterSlug: 'b' },
      { type: 'player_xp', amount: 1 },
    ]);
    expect(withFollowUp(effects, null)).toHaveLength(2);
    expect(followUpOf(withFollowUp([], 'c'))).toBe('c');
  });

  it('links a choice branch by slug', () => {
    const d = setChoiceFollowUp(draftFrom(DOOR), 1, 'success', 'hidden_laboratory');
    expect(d.choices[1]!.successEffects).toEqual([
      { type: 'trigger_encounter', encounterSlug: 'hidden_laboratory' },
    ]);
    expect(d.choices[0]).toEqual(draftFrom(DOOR).choices[0]);
  });
});

describe('slugs', () => {
  it('derives unique slugs from names', () => {
    expect(slugify('A Strange Door!')).toBe('a_strange_door');
    expect(slugify('Café  Ünder')).toBe('cafe_under');
    expect(slugify('!!!')).toBe('encounter');
    expect(uniqueSlug('a_strange_door', new Set(['a_strange_door', 'a_strange_door_2']))).toBe(
      'a_strange_door_3',
    );
  });
});

describe('draft validation', () => {
  const ctx = (over: Partial<Parameters<typeof validateDraft>[1]> = {}) => ({
    isNew: false,
    otherSlugs: new Set(ALL.map((e) => e.slug)),
    graph,
    vendors: [MERCHANT, EMPTY_SHOP],
    enabledRegions: ['waifu-valley', 'twin-peeks'],
    ...over,
  });

  it('accepts the shipped-style door with only warnings', () => {
    const v = validateDraft(draftFrom(DOOR), ctx());
    expect(v.errors).toEqual([]);
    expect(v.warnings.join('\n')).toMatch(/Security Override”, which is draft/);
  });

  it('blocks a chain-only encounter nothing reaches, but not a reached one', () => {
    expect(validateDraft(draftFrom(ORPHAN), ctx()).errors.join()).toMatch(/can never appear/);
    expect(validateDraft(draftFrom(LAB), ctx()).errors).toEqual([]);
    // Without the list there is nothing to judge reachability by — no guess.
    expect(validateDraft(draftFrom(ORPHAN), ctx({ graph: null })).errors).toEqual([]);
  });

  it('refuses a new slug that would overwrite another encounter', () => {
    const d = { ...draftFrom(DOOR), slug: 'market_stall' };
    expect(validateDraft(d, ctx({ isNew: true })).errors.join()).toMatch(/already uses the slug/);
  });

  it('warns about consuming an item the choice does not require, and fixes with the requirement', () => {
    const e = enc({
      id: 80,
      slug: 'eat',
      name: 'Eat',
      choices: [
        choice(800, 'Take a bite', { type: 'none' }, [
          { type: 'consume_item', slug: 'basic_charm', quantity: 1 },
        ]),
      ],
    });
    const g = buildEncounterGraph([...ALL, e]);
    expect(validateDraft(draftFrom(e), ctx({ graph: g })).warnings.join()).toMatch(
      /does not require the player to own it/,
    );
    const fixed = draftFrom({
      ...e,
      choices: [{ ...e.choices[0]!, requirements: { requiresItem: 'basic_charm' } }],
    });
    expect(validateDraft(fixed, ctx({ graph: g })).warnings.join()).not.toMatch(/own it/);
  });

  it('warns about a vendor with no inventory and blocks an unpicked vendor', () => {
    const e = enc({
      id: 81,
      slug: 'shop',
      name: 'Shop',
      choices: [
        choice(810, 'Browse', { type: 'none' }, [{ type: 'open_vendor', vendorKey: 'empty_shop' }]),
      ],
    });
    expect(validateDraft(draftFrom(e), ctx()).warnings.join()).toMatch(
      /Empty Shop” has no inventory/,
    );
    const unpicked = draftFrom({
      ...e,
      choices: [{ ...e.choices[0]!, successEffects: [{ type: 'open_vendor' }] }],
    });
    expect(validateDraft(unpicked, ctx()).errors.join()).toMatch(/pick a vendor/);
  });

  it('distinguishes errors from warnings for choices', () => {
    const none = { ...draftFrom(STALL), choices: [] };
    expect(validateDraft(none, ctx()).errors).toContain('Add at least one choice.');
    expect(validateDraft({ ...none, choicesRequired: false }, ctx()).warnings).toContain(
      'This encounter has no choices.',
    );
    const deadFailure = draftFrom({
      ...ALARM,
      choices: [choice(1, 'Run', { type: 'none' }, [], [{ type: 'energy_loss', amount: 1 }])],
    });
    expect(validateDraft(deadFailure, ctx()).warnings.join()).toMatch(/failure effects never run/);
  });

  it('reports the broken link as a warning, not a save blocker', () => {
    const v = validateDraft(draftFrom(BRIDGE), ctx());
    expect(v.errors).toEqual([]);
    expect(v.warnings.join()).toMatch(/does not exist/);
  });
});

describe('vendor form', () => {
  it('requires a name, a unique key and sane lines; warns when empty', () => {
    const taken = new Set(['wandering_merchant']);
    expect(vendorFormErrors({ ...EMPTY_VENDOR_FORM }, { isNew: true, takenKeys: taken })).toEqual([
      'Give the vendor a name.',
      'The key must be 1–64 lowercase letters, numbers or underscores.',
    ]);
    const dup = { ...EMPTY_VENDOR_FORM, name: 'X', vendorKey: 'wandering_merchant' };
    expect(vendorFormErrors(dup, { isNew: true, takenKeys: taken }).join()).toMatch(/already uses/);
    const lines = {
      ...EMPTY_VENDOR_FORM,
      name: 'X',
      vendorKey: 'x',
      stock: [
        { itemSlug: 'basic_charm', quantity: 0, price: 10, currency: 'waifubux' as const },
        { itemSlug: 'basic_charm', quantity: 1, price: 0, currency: 'waifubux' as const },
      ],
    };
    const errors = vendorFormErrors(lines, { isNew: true, takenKeys: taken });
    expect(errors.join('\n')).toMatch(/Line 1: stock per visit/);
    expect(errors.join('\n')).toMatch(/Line 2: this item is already stocked/);
    expect(errors.join('\n')).toMatch(/Line 2: price/);
    expect(vendorFormWarnings({ ...EMPTY_VENDOR_FORM })).toHaveLength(1);
  });
});
