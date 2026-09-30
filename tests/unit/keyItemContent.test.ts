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

  it('makes every component a sellable key item and leaves the beacon unsellable', () => {
    const bySlug = new Map(SHIPPED.items.map((i) => [i.slug, i]));
    const sell = (slug: string) => bySlug.get(slug)!.sellValue;
    for (const slug of ['cracked_teleport_core', 'quantum_stabilizer', 'phase_coupler', 'astral_power_cell']) {
      const item = bySlug.get(slug)!;
      expect(item.category, slug).toBe('key');
      expect(item.explicitlySellable, slug).toBe(true);
      expect(item.sellValue, slug).toBeGreaterThan(0);
    }
    // Buyable < farmable < world-encounter < boss drop.
    expect(sell('phase_coupler')!).toBeLessThan(sell('quantum_stabilizer')!);
    expect(sell('quantum_stabilizer')!).toBeLessThan(sell('cracked_teleport_core')!);
    expect(sell('cracked_teleport_core')!).toBeLessThan(sell('astral_power_cell')!);

    const beacon = bySlug.get('transporter_beacon')!;
    expect(beacon.sellValue).toBeNull();
    expect(beacon.explicitlySellable).toBe(false);
    expect(beacon.buyPrice).toBeNull();
    expect(beacon.shopRegions).toEqual([]);
    expect(beacon.maxOwned).toBe(1);
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
    // Cracked Teleport Core — long Thirstlands expeditions, on the two long
    // missions the Stabilizer is *not* on, each as its own group so no other
    // drop's odds moved. Success tables only, like the Stabilizer.
    //
    // Interim home: the Core belongs to Base 80085 thematically, but Base 80085
    // ships no expedition content yet. When `content/expeditions/base-80085.json`
    // exists, reconsider moving the Core there (and update the recipe hint, the
    // item description and this test together).
    const coreGroups = SHIPPED.expeditionRewards.flatMap((table) =>
      table.groups
        .filter((g) => g.entries.some((e) => e.itemId === 'cracked_teleport_core'))
        .map((g) => ({ table: table.id, group: g })),
    );
    expect(coreGroups.map((c) => [c.table, c.group.chanceBasisPoints])).toEqual([
      ['thirst-unrefiled-claim-success-v1', 500],
      ['thirst-dune-road-success-v1', 2000],
    ]);
    for (const { group } of coreGroups) {
      expect(group.enabled).toBe(true);
      expect(group.rolls).toBe(1);
      expect(group.entries).toHaveLength(1);
      expect(group.entries[0]!.quantity).toBe(1);
    }
    const stabilizerIds = new Set(stabilizerTables.map((x) => x.id));
    for (const { table } of coreGroups) expect(stabilizerIds.has(table), table).toBe(false);
    // …and nowhere else: the Teleporter Wreck encounter that used to award it
    // is no longer seeded, and no seeded encounter hands out any component.
    expect(SEED_ENCOUNTERS.some((e) => e.slug === 'b8_teleporter_wreck')).toBe(false);
    const components = new Set(['cracked_teleport_core', 'quantum_stabilizer', 'phase_coupler', 'astral_power_cell']);
    for (const encounter of SEED_ENCOUNTERS) {
      for (const choice of encounter.choices) {
        for (const effect of [...choice.successEffects, ...(choice.failureEffects ?? [])]) {
          const awards = effect.type === 'give_item' && components.has(effect.slug);
          expect(awards, `${encounter.slug} awards a Beacon component`).toBe(false);
        }
      }
    }
  });

  it('shows the Core\'s missions a key-item reward, and points the recipe hint at them', () => {
    const missions = SHIPPED.expeditions.filter((e) =>
      ['thirst_still_shored_still_hung', 'thirst_dont_sing_back'].includes(e.key),
    );
    expect(missions.map((e) => [e.key, e.durationMinutes])).toEqual([
      ['thirst_still_shored_still_hung', 360],
      ['thirst_dont_sing_back', 1080],
    ]);
    for (const m of missions) expect(m.rewardPreview, m.key).toContain('key_item');
    const recipe = SHIPPED.tables.keyItemRecipes.find((r) => r.id === 'transporter_beacon')!;
    const hint = recipe.inputs.find((i) => i.item === 'cracked_teleport_core')!.hint;
    expect(hint).toMatch(/Thirstlands/);
    expect(hint).not.toMatch(/encounter|Base 80085/i);
    const core = SHIPPED.items.find((i) => i.slug === 'cracked_teleport_core')!;
    expect(core.description).toMatch(/Thirstlands/);
    expect(core.description).not.toMatch(/world encounter/i);
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
  it('reads an omitted gate level as no requirement, not level 1', () => {
    const r = TravelConfigSchema.parse({
      keyItemRoutes: [{ regionId: 'assteroid-belt', keyItem: 'transporter_beacon' }],
    });
    expect(r.keyItemRoutes[0]!.requiredLevel).toBeNull();
  });

  it('still accepts an explicit gate level, and refuses 0', () => {
    const gate = (requiredLevel: unknown) =>
      TravelConfigSchema.safeParse({
        keyItemRoutes: [{ regionId: 'assteroid-belt', keyItem: 'transporter_beacon', requiredLevel }],
      });
    const ok = gate(40);
    expect(ok.success && ok.data.keyItemRoutes[0]!.requiredLevel).toBe(40);
    expect(gate(null).success).toBe(true);
    expect(gate(0).success).toBe(false);
  });

  it('keeps pass and route levels numeric, defaulting to 1', () => {
    const r = TravelConfigSchema.parse({
      passes: [{ id: 'p', name: 'P', price: 1, grantsRoutes: [] }],
      routes: [{ regionId: 'twin-peeks', passId: 'p' }],
    });
    expect(r.passes[0]!.requiredLevel).toBe(1);
    expect(r.routes[0]!.requiredLevel).toBe(1);
  });

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

  it('opens with the key', () => {
    expect(evaluateDestination(belt(), ctx({ keyItems: new Set(['transporter_beacon']) })).state).toBe(
      'unlocked',
    );
  });

  it('has no level gate on top of the key', () => {
    for (const level of [1, 12, 34]) {
      const r = evaluateDestination(
        belt(),
        ctx({ level, keyItems: new Set(['transporter_beacon']) }),
      );
      expect(r, `level ${level}`).toEqual({ state: 'unlocked', requirements: [] });
    }
  });

  it('stays key_required without the key at any level, and names only the key', () => {
    for (const level of [1, 34, 35, 99]) {
      const r = evaluateDestination(belt(), ctx({ level }));
      expect(r.state, `level ${level}`).toBe('key_required');
      expect(r.requirements.join(' ')).not.toContain('Trainer Level');
    }
  });

  it('reads as current when the player is standing there, key or not', () => {
    expect(evaluateDestination(belt(), ctx({ currentRegion: 'assteroid-belt' })).state).toBe(
      'current',
    );
  });
});
