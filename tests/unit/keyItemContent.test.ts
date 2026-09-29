/**
 * Key-item content rules — the Transporter Beacon's recipe and travel gate.
 *
 * Each rule protects one of two promises: the beacon can always be obtained,
 * and it can never be obtained twice. Tests start from shipped content and
 * break exactly one thing. No database.
 */
import { describe, expect, it } from 'vitest';
import {
  validateContentSet,
  validateKeyItemContent,
} from '../../src/modules/content/loader';
import {
  ItemContentSchema,
  KeyItemRecipeSchema,
  TravelConfigSchema,
  type LoadedContent,
} from '../../src/modules/content/schemas';
import { buildTravelCatalog } from '../../src/modules/travel/travelCatalog';
import {
  evaluateDestination,
  type EligibilityContext,
} from '../../src/modules/travel/travelService';
import { describeMissing, evaluateRecipe } from '../../src/modules/keyItems/keyItemService';
import { SEED_ENCOUNTERS } from '../../src/modules/worldEncounters/seed';
import { loadShippedContent } from '../helpers/fixtures';

const SHIPPED = loadShippedContent();
const shipped = (): LoadedContent => structuredClone(SHIPPED);

describe('shipped content', () => {
  it('passes every key-item rule', () => {
    expect(() => validateContentSet(shipped())).not.toThrow();
  });

  it('builds the beacon from the four components and 1,500 WaifuBux', () => {
    const recipe = SHIPPED.tables.keyItemRecipes.find((r) => r.id === 'transporter_beacon')!;
    expect(recipe.output).toBe('transporter_beacon');
    expect(recipe.waifubux).toBe(1500);
    expect(recipe.inputs.map((i) => [i.item, i.quantity])).toEqual([
      ['cracked_teleport_core', 1],
      ['quantum_stabilizer', 2],
      ['phase_coupler', 1],
      ['astral_power_cell', 1],
    ]);
  });

  it('gives every component a real source', () => {
    const t = SHIPPED.tables;
    // Astral Power Cell — its own independent boss-reward group, so adding it
    // changed no existing drop's odds. Deliberately *not* in the global
    // rare-find table, where it would dilute every other rare reward.
    expect(t.hunt.rareItemFind.sub.some((s) => s.slug === 'astral_power_cell')).toBe(false);
    const bossGroups = SHIPPED.bossRewards.flatMap((table) => table.groups);
    const astral = bossGroups.filter((g) =>
      g.entries.some((e) => e.itemId === 'astral_power_cell'),
    );
    expect(astral.map((g) => g.id)).toEqual(['astral-salvage']);
    expect(astral[0]!.entries).toHaveLength(1);
    expect(astral[0]!.enabled).toBe(true);
    // Quantum Stabilizer — Thirstlands expedition rewards.
    const stabilizerTables = SHIPPED.expeditionRewards.filter((table) =>
      table.groups.some((g) => g.entries.some((e) => e.itemId === 'quantum_stabilizer')),
    );
    expect(stabilizerTables.map((x) => x.id).sort()).toEqual([
      'thirst-procession-wake-success-v1',
      'thirst-wreck-field-success-v1',
    ]);
    // Phase Coupler — the Base 80085 shop.
    const coupler = SHIPPED.items.find((i) => i.slug === 'phase_coupler')!;
    expect(coupler.shopRegions).toEqual(['base-80085']);
    expect(coupler.buyPrice).toBeGreaterThan(0);
    // Cracked Teleport Core — a seeded Base 80085 world encounter.
    const wreck = SEED_ENCOUNTERS.find((e) => e.slug === 'b8_teleporter_wreck')!;
    expect(wreck.regions).toEqual(['base-80085']);
    expect(wreck.lifecycle).toBe('active');
    expect(
      wreck.choices.some((c) =>
        c.successEffects.some(
          (e) => e.type === 'give_item' && e.slug === 'cracked_teleport_core',
        ),
      ),
    ).toBe(true);
  });
});

describe('item schema', () => {
  const base = { slug: 'x', name: 'X', category: 'key', captureModifier: null };

  it('accepts maxOwned on an unstocked item', () => {
    expect(ItemContentSchema.safeParse({ ...base, maxOwned: 1 }).success).toBe(true);
  });

  it('accepts maxOwned on shop stock — the shop refuses a copy past the cap', () => {
    const r = ItemContentSchema.safeParse({
      ...base,
      maxOwned: 1,
      shopRegions: ['waifu-valley'],
      buyPrice: 10,
    });
    expect(r.success).toBe(true);
  });

  it('ships the Phase Coupler capped at one', () => {
    const coupler = SHIPPED.items.find((i) => i.slug === 'phase_coupler')!;
    expect(coupler.maxOwned).toBe(1);
  });

  it('lets a key item be shop stock — the Phase Coupler', () => {
    const r = ItemContentSchema.safeParse({ ...base, shopRegions: ['base-80085'], buyPrice: 900 });
    expect(r.success).toBe(true);
  });

  it('refuses 0 as a cap — null is the only spelling of unlimited', () => {
    expect(ItemContentSchema.safeParse({ ...base, maxOwned: 0 }).success).toBe(false);
  });
});

describe('recipe and gate schema', () => {
  it('refuses a recipe that lists an input twice or consumes its own output', () => {
    const inputs = [{ item: 'a', quantity: 1 }];
    expect(
      KeyItemRecipeSchema.safeParse({ id: 'r', output: 'o', inputs: [...inputs, ...inputs] })
        .success,
    ).toBe(false);
    expect(
      KeyItemRecipeSchema.safeParse({ id: 'r', output: 'a', inputs }).success,
    ).toBe(false);
  });

  it('refuses a region that is both a route and a key-item gate', () => {
    const r = TravelConfigSchema.safeParse({
      passes: [{ id: 'p', name: 'P', price: 1 }],
      routes: [{ regionId: 'assteroid-belt', passId: 'p' }],
      keyItemRoutes: [{ regionId: 'assteroid-belt', keyItem: 'transporter_beacon' }],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a key-item gate on the starting region', () => {
    const r = TravelConfigSchema.safeParse({
      keyItemRoutes: [{ regionId: 'waifu-valley', keyItem: 'transporter_beacon' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('cross-file rules', () => {
  it('refuses a capped item handed out by a reward table', () => {
    const c = shipped();
    c.tables.hunt.rareItemFind.sub.push({ slug: 'transporter_beacon', weight: 1, minQty: 1, maxQty: 1 });
    expect(() => validateKeyItemContent(c)).toThrow(/maxOwned.*hunt\.rareItemFind/);
  });

  it('refuses a capped item in a boss reward table', () => {
    const c = shipped();
    c.bossRewards[0]!.groups[0]!.entries.push({
      itemId: 'phase_coupler',
      weight: 1,
      quantity: 1,
      enabled: true,
    });
    expect(() => validateKeyItemContent(c)).toThrow(/phase_coupler.*maxOwned.*bossRewards/);
  });

  it('refuses a capped item in an expedition reward table', () => {
    const c = shipped();
    c.expeditionRewards[0]!.groups[0]!.entries.push({
      itemId: 'transporter_beacon',
      weight: 1,
      quantity: 1,
      enabled: true,
    });
    expect(() => validateKeyItemContent(c)).toThrow(/maxOwned/);
  });

  it('refuses a recipe whose output is not a key item capped at one', () => {
    const c = shipped();
    c.items.find((i) => i.slug === 'transporter_beacon')!.maxOwned = null;
    expect(() => validateKeyItemContent(c)).toThrow(/maxOwned: 1/);
  });

  it('refuses a recipe that consumes an item nobody defined', () => {
    const c = shipped();
    c.tables.keyItemRecipes[0]!.inputs[0]!.item = 'unobtainium';
    expect(() => validateKeyItemContent(c)).toThrow(/unknown item "unobtainium"/);
  });

  it('refuses a gate whose key no recipe builds — the region would be unreachable', () => {
    const c = shipped();
    c.tables.keyItemRecipes = [];
    expect(() => validateKeyItemContent(c)).toThrow(/unreachable/);
  });
});

describe('evaluateRecipe', () => {
  const recipe = SHIPPED.tables.keyItemRecipes[0]!;
  const ref = (slug: string) => ({ slug, name: slug, emoji: null });

  it('is ready only with every component, the WaifuBux, and no beacon yet', () => {
    const all = new Map(recipe.inputs.map((i) => [i.item, i.quantity]));
    expect(evaluateRecipe(recipe, ref, all, 1500).ready).toBe(true);
    expect(evaluateRecipe(recipe, ref, all, 1499).ready).toBe(false);
    expect(
      evaluateRecipe(recipe, ref, new Map([...all, ['transporter_beacon', 1]]), 9999).ready,
    ).toBe(false);
    const short = new Map([...all, ['quantum_stabilizer', 1]]);
    const p = evaluateRecipe(recipe, ref, short, 9999);
    expect(p.ready).toBe(false);
    expect(describeMissing(p)).toBe('quantum_stabilizer 1/2');
  });
});

describe('evaluateDestination for a key-item gate', () => {
  const belt = () => buildTravelCatalog(SHIPPED).get('assteroid-belt')!;
  const ctx = (over: Partial<EligibilityContext> = {}): EligibilityContext => ({
    level: 35,
    currentRegion: 'waifu-valley',
    passIds: new Set(['caravan_pass']),
    unlocked: new Set(['assteroid-belt']),
    keyItems: new Set(),
    ...over,
  });

  it('needs the key, whatever route rows say', () => {
    const r = evaluateDestination(belt(), ctx());
    expect(r.state).toBe('key_required');
    expect(r.requirements.join(' ')).toContain('Transporter Beacon');
  });

  it('opens with the key at the level gate', () => {
    expect(evaluateDestination(belt(), ctx({ keyItems: new Set(['transporter_beacon']) })).state).toBe(
      'unlocked',
    );
  });

  it('holds the level gate even with the key', () => {
    const r = evaluateDestination(
      belt(),
      ctx({ level: 34, keyItems: new Set(['transporter_beacon']) }),
    );
    expect(r.state).toBe('ineligible');
    expect(r.requirements.join(' ')).toContain('35');
  });

  it('reads as current when the player is standing there, key or not', () => {
    expect(evaluateDestination(belt(), ctx({ currentRegion: 'assteroid-belt' })).state).toBe(
      'current',
    );
  });
});
