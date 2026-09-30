/**
 * Key-item content rules — the Transporter Beacon's recipe and travel gate.
 *
 * Each rule protects one of two promises: the beacon can always be obtained,
 * and it can never be obtained twice. Tests start from shipped content and
 * break exactly one thing. No database.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { EncounterPackageSchema } from '../../src/modules/worldEncounters/encounterPackage';
import { loadShippedContent } from '../helpers/fixtures';

const SHIPPED = loadShippedContent();

/**
 * Every World Encounter package committed under `content/encounters/`. The
 * DB is authoritative for encounters, so these files are how content reaches
 * it. `full` is a whole-catalogue export (`world-encounters-all-*`); the
 * newest of those is picked by `exportedAt`, not filename, because a `-v2`
 * suffix sorts before `.json`.
 */
function encounterPackages() {
  const dir = join(__dirname, '..', '..', 'content', 'encounters');
  const packages = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      full: file.startsWith('world-encounters-all-'),
      pkg: EncounterPackageSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))),
    }));
  const newest = packages
    .filter((p) => p.full)
    .sort((a, b) => Date.parse(a.pkg.exportedAt) - Date.parse(b.pkg.exportedAt))
    .at(-1);
  return packages.map((p) => ({ ...p, newestFull: p === newest }));
}
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
    // Quantum Stabilizer — Thirstlands and Waifu Valley expedition rewards
    // (the spread is pinned in its own test below).
    const stabilizerTables = SHIPPED.expeditionRewards.filter((table) =>
      table.groups.some((g) => g.entries.some((e) => e.itemId === 'quantum_stabilizer')),
    );
    expect(stabilizerTables.map((x) => x.id).sort()).toEqual([
      'thirst-procession-wake-success-v1',
      'thirst-rig-recovery-success-v1',
      'thirst-wreck-field-success-v1',
      'valley-substation-success-v2',
      'valley-undercity-dive-success-v4',
    ]);
    // Phase Coupler — the Base 80085 shop.
    const coupler = SHIPPED.items.find((i) => i.slug === 'phase_coupler')!;
    expect(coupler.shopRegions).toEqual(['base-80085']);
    expect(coupler.buyPrice).toBeGreaterThan(0);
    // Cracked Teleport Core — long Thirstlands expeditions, on the two long
    // missions the Stabilizer is *not* on, plus a rare Twin Peeks pair. Each
    // is its own group so no other drop's odds moved. Success tables only,
    // like the Stabilizer.
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
      ['peeks-bathhouse-turnover-success-v1', 40],
      ['peeks-avalanche-shed-success-v1', 500],
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

  /**
   * The recipe needs two Stabilizers, so it drops across every duration a
   * player might run — a short mission, two 6h ones and two overnights — each
   * as its own single-entry group so no existing drop's odds moved. Success
   * tables only. Thirstlands' 6h and 18h slots are left alone: that region's
   * typical day already sits at the top of its WBe band.
   */
  it('spreads the Stabilizer across mission lengths as independent groups', () => {
    const missions = new Map(SHIPPED.expeditions.map((e) => [e.rewardTable, e]));
    const drops = SHIPPED.expeditionRewards.flatMap((table) =>
      table.groups
        .filter((g) => g.entries.some((e) => e.itemId === 'quantum_stabilizer'))
        .map((group) => ({ mission: missions.get(table.id)!, group })),
    );
    expect(
      drops.map((d) => [d.mission.key, d.mission.durationMinutes, d.group.chanceBasisPoints]),
    ).toEqual([
      ['valley_hum_job', 360, 1500],
      ['valley_going_down', 1080, 3000],
      ['thirst_dig_it_out', 180, 1000],
      ['thirst_stripped_to_the_frame', 360, 1500],
      ['thirst_headfirst', 1080, 2500],
    ]);
    for (const { mission, group } of drops) {
      expect(mission.enabled, mission.key).toBe(true);
      expect(group.enabled, mission.key).toBe(true);
      expect(group.rolls, mission.key).toBe(1);
      expect(group.entries, mission.key).toHaveLength(1);
      expect(group.entries[0]!.quantity, mission.key).toBe(1);
      expect(mission.rewardPreview, mission.key).toContain('key_item');
    }
  });

  /**
   * World encounters are the Stabilizer's rare secondary source: a long-shot
   * choice on two salvage encounters in regions a player reaches *before*
   * the Beacon, resolved through the ordinary SP check. No affinity or race
   * advantage, which would add 10–15 points and turn a long shot into a
   * farm. The DB is authoritative for encounters; this reads the newest
   * full export committed alongside the content.
   */
  it('awards the Stabilizer from only two encounters, as a long-shot SP check', () => {
    const pkg = encounterPackages().find((p) => p.newestFull)!.pkg;
    const awarding = pkg.encounters.flatMap((encounter) =>
      encounter.choices
        .filter((c) =>
          [...c.successEffects, ...c.failureEffects].some(
            (e) => e.type === 'give_item' && e.slug === 'quantum_stabilizer',
          ),
        )
        .map((choice) => ({ encounter, choice })),
    );
    expect(awarding.map((a) => a.encounter.slug).sort()).toEqual([
      'b8_salvage_row',
      'th_merchants_lost_cargo',
    ]);
    for (const { encounter, choice } of awarding) {
      expect(encounter.lifecycle, encounter.slug).toBe('active');
      expect(encounter.regions.some((r) => r === 'assteroid-belt'), encounter.slug).toBe(false);
      expect(choice.failureEffects, encounter.slug).toEqual([]);
      const check = choice.check;
      expect(check.type, encounter.slug).toBe('sp');
      if (check.type !== 'sp') continue;
      expect(check.affinityAdvantage, encounter.slug).toBeUndefined();
      expect(check.raceAdvantage, encounter.slug).toBeUndefined();
      // Best case before a Buddy Bonus stays at or under 11%.
      expect(check.baseChance! + check.maxSpModifier!, encounter.slug).toBeLessThanOrEqual(0.11);
    }
  });

  /**
   * Migration 0044 disables the Teleporter Wreck, but an encounter import is
   * an upsert by slug: importing any package that still carries it as
   * `active` would quietly re-enable a second Core source. So the newest
   * full export and every partial package must carry it disabled (not absent
   * — the row still exists, and a package that lists it disabled is a no-op
   * once 0044 has run), and no active encounter in them may award the Core.
   *
   * Older full exports are kept as dated snapshots of what a server held at
   * the time, and are exempt: they are records, not import candidates.
   */
  /**
   * Import writes `artworkPath` verbatim, so a full package is also the art
   * wiring for every encounter it carries. The newest one must not drop or
   * repoint a path an older snapshot already had, every active encounter
   * must have art, and every path must resolve under `assets/`.
   */
  it('keeps encounter art wired in the newest full export', () => {
    const packages = encounterPackages();
    const newest = packages.find((p) => p.newestFull)!.pkg;
    const assets = join(__dirname, '..', '..', 'assets');
    for (const e of newest.encounters) {
      if (e.lifecycle === 'active') expect(e.artworkPath, e.slug).not.toBeNull();
      if (e.artworkPath) expect(existsSync(join(assets, e.artworkPath)), e.artworkPath).toBe(true);
    }
    const current = new Map(newest.encounters.map((e) => [e.slug, e.artworkPath]));
    for (const { file, pkg } of packages.filter((p) => p.full && !p.newestFull)) {
      for (const e of pkg.encounters) {
        if (e.artworkPath) expect(current.get(e.slug), `${file} / ${e.slug}`).toBe(e.artworkPath);
      }
    }
  });

  it('keeps the Teleporter Wreck retired in every importable encounter package', () => {
    const importable = encounterPackages().filter((p) => p.newestFull || !p.full);
    expect(importable.some((p) => p.newestFull)).toBe(true);
    for (const { file, pkg } of importable) {
      const wreck = pkg.encounters.find((e) => e.slug === 'b8_teleporter_wreck');
      if (wreck) expect(wreck.lifecycle, file).toBe('disabled');
      for (const encounter of pkg.encounters.filter((e) => e.lifecycle === 'active')) {
        for (const choice of encounter.choices) {
          for (const effect of [...choice.successEffects, ...choice.failureEffects]) {
            const awardsCore = effect.type === 'give_item' && effect.slug === 'cracked_teleport_core';
            expect(awardsCore, `${file} / ${encounter.slug}`).toBe(false);
          }
        }
      }
    }
  });

  it('shows the Core\'s missions a key-item reward, and points the recipe hint at them', () => {
    const coreTables = new Set(
      SHIPPED.expeditionRewards
        .filter((t) => t.groups.some((g) => g.entries.some((e) => e.itemId === 'cracked_teleport_core')))
        .map((t) => t.id),
    );
    const missions = SHIPPED.expeditions.filter((e) => coreTables.has(e.rewardTable));
    expect(missions.map((e) => [e.key, e.durationMinutes])).toEqual([
      ['thirst_still_shored_still_hung', 360],
      ['thirst_dont_sing_back', 1080],
      ['peeks_on_her_knees', 60],
      ['peeks_down_until_told_otherwise', 1080],
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
