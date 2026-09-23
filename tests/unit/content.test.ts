import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadContent,
  resolveAssetPath,
  validateSpeciesAssets,
} from '../../src/modules/content/loader';
import {
  BuddyAffinityConfigSchema,
  CareModeConfigSchema,
  ItemContentSchema,
  SpeciesContentSchema,
  TablesFileSchema,
} from '../../src/modules/content/schemas';
import {
  AFFINITIES,
  ITEM_CATEGORIES,
  ITEM_EFFECT_TYPES,
  PRICE_CURRENCIES,
  SHOP_ITEM_CATEGORIES,
} from '../../src/db/schema';
import { RACE_CODES, archetypeToRace, isRaceCode } from '../../src/modules/cards/race';
import { ContentValidationError } from '../../src/shared/errors';
import { ASSETS_DIR, CONTENT_DIR, loadShippedContent } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

describe('shipped content', () => {
  /**
   * The load smoke test.
   *
   * Deliberately asserts **no global item count**. It used to pin
   * `items.length` to 12, which meant every content addition — a region's
   * salvage set, a new consumable — failed a test that was not about that
   * addition, and told the author nothing about what was wrong. A total is not
   * an invariant: nothing breaks when it changes, and nothing is protected
   * while it holds.
   *
   * What *is* invariant is the shape of the catalogue: every item has a
   * canonical category, a unique slug, and a coherent price/sell model. Those
   * are the rules the rest of the game reads.
   */
  it('loads and validates, with every referenced image present', () => {
    const content = loadShippedContent();
    expect(content.items.length).toBeGreaterThan(0);
    expect(content.species.length).toBeGreaterThanOrEqual(5);
    // No shipped species may be auto-disabled by a missing image.
    expect(content.species.filter((s) => !s.enabled)).toEqual([]);

    const slugs = content.items.map((i) => i.slug);
    expect(new Set(slugs).size, 'duplicate item slug').toBe(slugs.length);
    for (const item of content.items) {
      expect(ITEM_CATEGORIES, item.slug).toContain(item.category);
      expect(PRICE_CURRENCIES, item.slug).toContain(item.priceCurrency);
      // A shelf price only ever appears on a category a shop actually lists.
      if (item.shopRegions.length > 0) {
        expect(SHOP_ITEM_CATEGORIES, item.slug).toContain(item.category);
        expect(item.buyPrice, item.slug).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Salvage is the one category whose whole purpose is being sold back, so its
   * model is a contract rather than a tuning value: every salvage item is
   * vendorable through `sellValue` and stocked by no shop. This is what lets
   * Expedition reward tables price a mission by summing sell values.
   */
  it('gives every salvage item a sell value and no shelf', () => {
    const content = loadShippedContent();
    const salvage = content.items.filter((i) => i.category === 'salvage');
    expect(salvage.length).toBeGreaterThan(0);
    for (const item of salvage) {
      expect(item.sellValue, item.slug).toBeGreaterThan(0);
      expect(item.shopRegions, item.slug).toEqual([]);
      expect(item.buyPrice, item.slug).toBeNull();
      expect(item.effectType, item.slug).toBeNull();
    }
  });

  /**
   * Two capture items with real gameplay contracts attached.
   *
   * The Prismatic Charm is **the** repeatable Essence sink: it is what gives
   * Essence somewhere to go, and pricing it in WaifuBux would strand the
   * currency. Which regions stock it is a merchandising decision and is no
   * longer pinned — it used to assert `['waifu-valley']` and broke the moment
   * the charm went on sale in every region, which was the intended change.
   *
   * The Mythic Contract's contract is the opposite and genuinely exact:
   * guaranteed capture, never purchasable at any price, in any region. That is
   * why it may only ever be found or granted.
   */
  it('prices Prismatic Charm in Essence, and never sells Mythic Contract anywhere', () => {
    const content = loadShippedContent();
    const prismatic = content.items.find((i) => i.slug === 'prismatic_charm');
    expect(prismatic?.enabled).toBe(true);
    expect(prismatic?.priceCurrency).toBe('essence');
    expect(prismatic?.buyPrice).toBeGreaterThan(0);
    expect(prismatic?.shopRegions.length).toBeGreaterThan(0);

    const mythic = content.items.find((i) => i.slug === 'mythic_contract');
    expect(mythic?.isGuaranteedCapture).toBe(true);
    expect(mythic?.shopRegions).toEqual([]);
    expect(mythic?.buyPrice).toBeNull();
    // Nothing else in the catalogue may guarantee a capture.
    expect(
      content.items.filter((i) => i.isGuaranteedCapture).map((i) => i.slug),
    ).toEqual(['mythic_contract']);
  });

  /**
   * The charm **ladder**, not the launch price list.
   *
   * The exact numbers are tuning and have moved twice (25/75/200 → 75/150/325);
   * pinning them made a deliberate re-price look like a regression. What must
   * never invert is the relationship the player reads: a charm that costs more
   * catches better, every tier is stocked everywhere the cheaper ones are, and
   * the ladder tops out in the Essence-priced Prismatic.
   */
  it('keeps the capture-charm ladder monotonic in both price and power', () => {
    const content = loadShippedContent();
    const ladder = ['basic_charm', 'silk_charm', 'velvet_charm'].map((slug) => {
      const item = content.items.find((i) => i.slug === slug);
      expect(item, slug).toBeDefined();
      return item!;
    });
    for (const charm of ladder) {
      expect(charm.category).toBe('capture');
      expect(charm.priceCurrency, charm.slug).toBe('waifubux');
      expect(charm.shopRegions, charm.slug).toContain('waifu-valley');
      expect(charm.buyPrice, charm.slug).toBeGreaterThan(0);
    }
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i]!.buyPrice!, ladder[i]!.slug).toBeGreaterThan(ladder[i - 1]!.buyPrice!);
      expect(ladder[i]!.captureModifier!, ladder[i]!.slug).toBeGreaterThanOrEqual(
        ladder[i - 1]!.captureModifier!,
      );
    }
    // The Prismatic sits above the WaifuBux ladder, priced in the other currency.
    const prismatic = content.items.find((i) => i.slug === 'prismatic_charm')!;
    expect(prismatic.captureModifier!).toBeGreaterThan(ladder.at(-1)!.captureModifier!);
  });

  it('sells Shibari Rope only in Twin Peeks', () => {
    const content = loadShippedContent();
    const rope = content.items.find((i) => i.slug === 'shibari_rope');
    expect(rope?.shopRegions).toEqual(['twin-peeks']);
    expect(rope?.buyPrice).toBe(750);
  });

  /**
   * Effect items, asserted as a **model** rather than a snapshot.
   *
   * This used to pin Energy Drink to `restore_energy_full` with
   * `{ restoreToMax: true }`. It was retuned to `restore_energy_amount` with a
   * fixed 5 — a deliberate change, since a full refill for a flat 500 WaifuBux
   * scaled badly against a rising energy cap — and the test then failed for a
   * year describing content that no longer existed.
   *
   * What holds regardless of tuning: every effect item names an effect from
   * the canonical enum, carries a config the schema validated, and any energy
   * restore drops the player out of Care Mode (otherwise the tick that granted
   * the energy immediately re-caps it).
   */
  it('gives every effect item a canonical effect and a validated config', () => {
    const content = loadShippedContent();
    const effectItems = content.items.filter((i) => i.effectType !== null);
    expect(effectItems.length).toBeGreaterThan(0);
    for (const item of effectItems) {
      expect(ITEM_EFFECT_TYPES, item.slug).toContain(item.effectType!);
      expect(item.effectConfig, item.slug).not.toBeNull();
      expect(item.category, item.slug).toBe('consumable');
      if (item.effectType!.startsWith('restore_energy')) {
        expect(
          (item.effectConfig as { exitCareMode?: boolean }).exitCareMode,
          item.slug,
        ).toBe(true);
      }
    }

    // Microdose is the small Essence sink that sits under the Prismatic Charm.
    // Its *currency* is the contract; its charge count and bonus are tuning.
    const microdose = content.items.find((i) => i.slug === 'microdose');
    expect(microdose?.priceCurrency).toBe('essence');
    expect(microdose?.effectType).toBe('capture_bonus_charges');
    expect(microdose?.buyPrice).toBeGreaterThan(0);

    // Energy Drink is the WaifuBux-priced energy restore on the Valley shelf.
    const drink = content.items.find((i) => i.slug === 'energy_drink');
    expect(drink?.priceCurrency).toBe('waifubux');
    expect(drink?.effectType).toMatch(/^restore_energy_/);
    expect(drink?.shopRegions).toContain('waifu-valley');
  });

  /**
   * Capture items carry **no** active effect.
   *
   * That is the real rule, and it is load-bearing: a charm's power lives in
   * `captureModifier` / `captureBonus`, which the capture roll reads, and an
   * `effectType` on the same row would make it usable from the inventory
   * screen as well — the same item spending itself down two different paths.
   *
   * The currency half of the old assertion ("…and WaifuBux pricing") was not a
   * rule at all, and the Prismatic Charm disproved it the day it was priced in
   * Essence. Pricing is now checked against the canonical currency set.
   */
  it('leaves every capture item effect-free, in either canonical currency', () => {
    const content = loadShippedContent();
    const capture = content.items.filter((i) => i.category === 'capture');
    expect(capture.length).toBeGreaterThan(0);
    for (const charm of capture) {
      expect(charm.effectType, charm.slug).toBeNull();
      expect(charm.effectConfig, charm.slug).toBeNull();
      expect(PRICE_CURRENCIES, charm.slug).toContain(charm.priceCurrency);
    }
    // And the converse: an item with no effect never carries a stray config.
    for (const item of content.items.filter((i) => i.effectType === null)) {
      expect(item.effectConfig, item.slug).toBeNull();
    }
  });
});

describe('schema invariants', () => {
  const baseItem = {
    slug: 'test_item',
    name: 'Test',
    category: 'capture',
    captureModifier: 1,
  };

  it('rejects guaranteed-capture items sold in a region', () => {
    const result = ItemContentSchema.safeParse({
      ...baseItem,
      isGuaranteedCapture: true,
      shopRegions: ['waifu-valley'],
      buyPrice: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects items sold in a region without a buy price', () => {
    const result = ItemContentSchema.safeParse({
      ...baseItem,
      shopRegions: ['waifu-valley'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects shop_regions on a non-shop category', () => {
    const result = ItemContentSchema.safeParse({
      ...baseItem,
      category: 'material',
      captureModifier: null,
      shopRegions: ['waifu-valley'],
      buyPrice: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects shop_regions naming an unknown region', () => {
    const result = ItemContentSchema.safeParse({
      ...baseItem,
      shopRegions: ['not-a-region'],
      buyPrice: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown content ratings', () => {
    const result = SpeciesContentSchema.safeParse({
      slug: 'x',
      name: 'X',
      rarity: 'N',
      archetype: 'test',
      contentRating: 'wholesome',
      imagePath: 'waifumon/x/standard.png',
    });
    expect(result.success).toBe(false);
  });

  it('defaults an item with no effect to null config and WaifuBux pricing', () => {
    const parsed = ItemContentSchema.parse(baseItem);
    expect(parsed.effectType).toBeNull();
    expect(parsed.effectConfig).toBeNull();
    expect(parsed.priceCurrency).toBe('waifubux');
  });

  it('fills restore_energy_full defaults and rejects capture-only fields on it', () => {
    const ok = ItemContentSchema.parse({
      ...baseItem,
      category: 'consumable',
      captureModifier: null,
      effectType: 'restore_energy_full',
      effectConfig: { restoreToMax: true },
    });
    expect(ok.effectConfig).toEqual({ restoreToMax: true, exitCareMode: true });

    const mixed = ItemContentSchema.safeParse({
      ...baseItem,
      category: 'consumable',
      captureModifier: null,
      effectType: 'restore_energy_full',
      effectConfig: { restoreToMax: true, captureBonus: 0.03 },
    });
    expect(mixed.success).toBe(false);
  });

  it('requires capture-bonus fields and bounds them', () => {
    const ok = ItemContentSchema.parse({
      ...baseItem,
      category: 'consumable',
      captureModifier: null,
      effectType: 'capture_bonus_charges',
      effectConfig: { captureBonus: 0.03, charges: 5 },
    });
    expect(ok.effectConfig).toEqual({
      captureBonus: 0.03,
      charges: 5,
      refreshBehavior: 'refresh',
    });

    const invalid = [
      {},
      { captureBonus: 0.03 },
      { charges: 5 },
      { captureBonus: 0.5, charges: 5 },
      { captureBonus: -0.01, charges: 5 },
      { captureBonus: 0.03, charges: 0 },
      { captureBonus: 0.03, charges: 1.5 },
      { captureBonus: 0.03, charges: 5, restoreToMax: true },
    ];
    for (const effectConfig of invalid) {
      const result = ItemContentSchema.safeParse({
        ...baseItem,
        category: 'consumable',
        captureModifier: null,
        effectType: 'capture_bonus_charges',
        effectConfig,
      });
      expect(result.success, JSON.stringify(effectConfig)).toBe(false);
    }
  });

  it('rejects an unknown effect type, an effect config with no type, and a bad currency', () => {
    expect(
      ItemContentSchema.safeParse({ ...baseItem, effectType: 'mind_control' }).success,
    ).toBe(false);
    expect(
      ItemContentSchema.safeParse({ ...baseItem, effectConfig: { captureBonus: 0.03 } }).success,
    ).toBe(false);
    expect(
      ItemContentSchema.safeParse({ ...baseItem, priceCurrency: 'doubloons' }).success,
    ).toBe(false);
  });
});

describe('species affinity (5D)', () => {
  const baseSpecies = {
    slug: 'affinity_probe',
    name: 'Affinity Probe',
    rarity: 'N',
    archetype: 'test',
    contentRating: 'suggestive',
    imagePath: 'waifumon/x/standard.png',
  };

  it('accepts every valid affinity value', () => {
    for (const affinity of AFFINITIES) {
      const parsed = SpeciesContentSchema.safeParse({ ...baseSpecies, affinity });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.affinity).toBe(affinity);
    }
  });

  it('rejects an invalid affinity value', () => {
    expect(SpeciesContentSchema.safeParse({ ...baseSpecies, affinity: 'brat' }).success).toBe(
      false,
    );
    expect(SpeciesContentSchema.safeParse({ ...baseSpecies, affinity: '' }).success).toBe(false);
    expect(SpeciesContentSchema.safeParse({ ...baseSpecies, affinity: null }).success).toBe(false);
  });

  it('defaults a missing affinity to switch (backward compatibility)', () => {
    const parsed = SpeciesContentSchema.parse(baseSpecies);
    expect(parsed.affinity).toBe('switch');
  });

  it('does not confuse affinity with archetype', () => {
    const parsed = SpeciesContentSchema.parse({
      ...baseSpecies,
      archetype: 'kitsune',
      affinity: 'dominant',
    });
    expect(parsed.archetype).toBe('kitsune');
    expect(parsed.affinity).toBe('dominant');
  });

  /**
   * ── What replaced "every species is affinity switch" ─────────────────────
   *
   * That assertion described a *migration*, not a design rule. When the 5D
   * affinity system landed, every species was parked on the neutral default
   * until the corpus could be authored; the test pinned that transitional
   * state. Authoring then happened — 160 species now carry real affinities —
   * and the test failed listing 126 slugs, which read like a content
   * catastrophe and was in fact the work being finished.
   *
   * It is deleted rather than inverted. What follows are the invariants that
   * actually protect something, and none of them constrains the *distribution*
   * of affinities: how many Dominants the game ships is a design decision that
   * changes with every expansion, and a test that pinned it would be the same
   * mistake in a new coat.
   */
  it('gives every shipped species a canonical affinity', () => {
    const content = loadShippedContent();
    expect(content.species.length).toBeGreaterThan(0);
    for (const species of content.species) {
      expect(AFFINITIES, species.slug).toContain(species.affinity);
    }
  });

  /**
   * Race is *derived* content — an explicit `race`, else a normalized
   * `archetype`, else a warned fallback to `human`. A fallback is not an
   * error, so nothing fails at load: the species renders and plays as a human.
   * That silence is exactly the problem. A mistyped archetype costs the
   * species its Expedition race matches and its card frame, and the only
   * evidence is a warning in a log nobody reads.
   *
   * Asserted against the real resolver's inputs, so a species is only allowed
   * to *be* human by saying so, never by accident.
   */
  it('resolves every species race from its own content, never by fallback', () => {
    const content = loadShippedContent();
    const fallbacks = content.species
      .filter((s) => !isRaceCode(s.race) && !archetypeToRace(s.archetype))
      .map((s) => `${s.slug} (race=${s.race ?? 'null'}, archetype=${s.archetype ?? 'null'})`);
    expect(fallbacks).toEqual([]);
    for (const species of content.species) {
      const resolved = isRaceCode(species.race)
        ? species.race
        : archetypeToRace(species.archetype);
      expect(RACE_CODES, species.slug).toContain(resolved!);
    }
  });

  it('ships unique species slugs across every pack', () => {
    const slugs = loadShippedContent().species.map((s) => s.slug);
    const duplicates = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
    expect(duplicates).toEqual([]);
  });

  /**
   * Every **enabled** expansion contributes its species.
   *
   * A pack that silently fails to load is invisible: the region still exists,
   * its encounter pool still names the species, and the wild-encounter roll
   * simply never produces them. Named per pack so the failure says which one.
   *
   * `assteroid_belt` is deliberately absent — its `expansion.json` ships
   * `enabled: false`, and a disabled pack contributing nothing is the feature.
   */
  it('loads the species of every enabled expansion pack', () => {
    const content = loadShippedContent();
    for (const pack of ['twin_peeks', 'thirstlands', 'flaccid_foothills', 'base_80085']) {
      const members = content.species.filter((s) => (s.tags ?? []).includes(pack));
      expect(members.length, pack).toBeGreaterThan(0);
      for (const species of members) {
        expect(species.enabled, species.slug).toBe(true);
        expect(AFFINITIES, species.slug).toContain(species.affinity);
      }
    }
    expect(
      content.species.filter((s) => (s.tags ?? []).includes('assteroid_belt')),
    ).toEqual([]);
  });
});

describe('buddyAffinity config schema (5D)', () => {
  const base = {
    styles: [...AFFINITIES],
    wheel: {
      dominant: 'submissive',
      submissive: 'caregiver',
      caregiver: 'primal',
      primal: 'dominant',
    },
    neutralStyles: ['switch'],
    strongBonusByRarity: { N: 0.01, R: 0.02, SR: 0.03, SSR: 0.04, UR: 0.05, LR: 0.06, EX: 0.06 },
    weakPenaltyByRarity: { N: 0, R: 0, SR: 0, SSR: 0, UR: 0, LR: 0, EX: 0 },
  };

  it('accepts the shipped shape', () => {
    expect(BuddyAffinityConfigSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unknown affinity anywhere in the block', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({ ...base, styles: [...AFFINITIES, 'brat'] }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, dominant: 'brat' },
      }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({ ...base, wheel: { brat: 'submissive' } }).success,
    ).toBe(false);
  });

  it('rejects a wheel edge that gives a neutral style a strength or weakness', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, switch: 'dominant' },
      }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, dominant: 'switch' },
      }).success,
    ).toBe(false);
  });

  it('rejects a style that beats itself', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        wheel: { ...base.wheel, dominant: 'dominant' },
      }).success,
    ).toBe(false);
  });

  it('rejects negative bonuses and penalties', () => {
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        strongBonusByRarity: { ...base.strongBonusByRarity, N: -0.01 },
      }).success,
    ).toBe(false);
    expect(
      BuddyAffinityConfigSchema.safeParse({
        ...base,
        weakPenaltyByRarity: { ...base.weakPenaltyByRarity, N: -0.01 },
      }).success,
    ).toBe(false);
  });

  it('requires a complete rarity ladder for both maps', () => {
    const { EX: _dropped, ...partial } = base.strongBonusByRarity;
    expect(
      BuddyAffinityConfigSchema.safeParse({ ...base, strongBonusByRarity: partial }).success,
    ).toBe(false);
  });

  it('tables.json omitting the block falls back to an all-neutral default', () => {
    const parsed = TablesFileSchema.parse({
      ...loadShippedContent().tables,
      buddyAffinity: undefined,
    });
    expect(parsed.buddyAffinity.wheel).toEqual({});
    expect(parsed.buddyAffinity.neutralStyles).toEqual(['switch']);
    expect(Object.values(parsed.buddyAffinity.strongBonusByRarity).every((v) => v === 0)).toBe(
      true,
    );
  });
});

describe('careMode config schema', () => {
  const base = {
    enabled: true,
    intervalMinutes: 30,
    energyPerTick: 1,
    recoveryCap: 20,
    waifuXpPerTick: 2,
    affectionPerTick: 1,
  };
  it('accepts the shipped shape', () => {
    expect(CareModeConfigSchema.safeParse(base).success).toBe(true);
  });
  it('rejects a non-positive intervalMinutes', () => {
    expect(CareModeConfigSchema.safeParse({ ...base, intervalMinutes: 0 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, intervalMinutes: -5 }).success).toBe(false);
  });
  it('rejects negative per-tick fields', () => {
    expect(CareModeConfigSchema.safeParse({ ...base, energyPerTick: -1 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, waifuXpPerTick: -1 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, affectionPerTick: -1 }).success).toBe(false);
    expect(CareModeConfigSchema.safeParse({ ...base, recoveryCap: -1 }).success).toBe(false);
  });
  it('requires all fields (no defaults except enabled)', () => {
    expect(CareModeConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe('asset validation', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const species = (imagePath: string) =>
    SpeciesContentSchema.parse({
      slug: 'ghost',
      name: 'Ghost',
      rarity: 'N',
      archetype: 'spirit',
      contentRating: 'suggestive',
      imagePath,
    });

  it('disables species whose image is missing (never renders a broken card)', () => {
    const logger = { ...silentLogger(), warn: vi.fn() };
    const result = validateSpeciesAssets(
      [species('waifumon/nope/standard.png')],
      ASSETS_DIR,
      logger,
    );
    expect(result[0]?.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { slug: 'ghost', imagePath: 'waifumon/nope/standard.png' },
      'species image missing — disabling',
    );
  });

  it('keeps species whose image exists enabled', () => {
    const result = validateSpeciesAssets(
      [species('waifumon/neon_kitsune/standard.png')],
      ASSETS_DIR,
      silentLogger(),
    );
    expect(result[0]?.enabled).toBe(true);
  });

  it('rejects image paths escaping the assets directory', () => {
    expect(() => resolveAssetPath(ASSETS_DIR, '../secrets.txt')).toThrow(ContentValidationError);
  });

  it('keeps an expansion species enabled through the canonical waifumon imagePath', () => {
    const relative = 'waifumon/starfall_street_dancer/standard.png';
    expect(resolveAssetPath(ASSETS_DIR, relative)).toBe(path.join(ASSETS_DIR, relative));
    const result = validateSpeciesAssets([species(relative)], ASSETS_DIR, silentLogger());
    expect(result[0]?.enabled).toBe(true);
  });

  it('disables a species when imagePath double-prefixes "assets/"', () => {
    const result = validateSpeciesAssets(
      [species('assets/waifumon/starfall_street_dancer/standard.png')],
      ASSETS_DIR,
      silentLogger(),
    );
    expect(result[0]?.enabled).toBe(false);
  });

  it('keeps expansion milestone appearances from the canonical global artwork tree', () => {
    const packSpecies = SpeciesContentSchema.parse({
      slug: 'onsen_maid',
      name: 'Onsen Maid',
      rarity: 'R',
      archetype: 'spirit',
      contentRating: 'suggestive',
      imagePath: 'waifumon/onsen_maid/standard.png',
      appearances: [
        { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
        { id: 'level_20', name: 'Level 20', sortOrder: 20, unlock: { type: 'level', atLevel: 20 } },
      ],
    });
    const result = validateSpeciesAssets([packSpecies], ASSETS_DIR, silentLogger());
    expect(result[0]?.enabled).toBe(true);
    expect(result[0]?.appearances?.map((a) => a.id)).toEqual(['standard', 'level_20']);
  });

  it('drops an expansion appearance whose art is absent, leaving the species enabled', () => {
    const packSpecies = SpeciesContentSchema.parse({
      slug: 'onsen_maid',
      name: 'Onsen Maid',
      rarity: 'R',
      archetype: 'spirit',
      contentRating: 'suggestive',
      imagePath: 'waifumon/onsen_maid/standard.png',
      appearances: [
        { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
        {
          id: 'never_authored',
          name: 'Missing',
          sortOrder: 99,
          unlock: { type: 'level', atLevel: 20 },
        },
      ],
    });
    const result = validateSpeciesAssets([packSpecies], ASSETS_DIR, silentLogger());
    expect(result[0]?.enabled).toBe(true);
    expect(result[0]?.appearances?.map((a) => a.id)).toEqual(['standard']);
  });

  /**
   * Built from a **fixture** species pack rather than by copying a shipped
   * one.
   *
   * This test used to copy `content/species/placeholders.json`, which was
   * retired to `placeholders.old` when `starter.json` superseded it. The
   * loader only reads `*.json`, so the rename was the whole retirement — and
   * this test was the only thing left referring to the file, failing with
   * `ENOENT` on a path production had correctly stopped caring about.
   *
   * Writing the pack inline also makes the test say what it needs: a loadable
   * content set, so that the `dailyPackage` cross-reference is the only thing
   * that can fail.
   */
  it('fails startup loudly on a dailyPackage slug that is not an item', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-content-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'species'));
    fs.copyFileSync(path.join(CONTENT_DIR, 'items.json'), path.join(dir, 'items.json'));
    fs.writeFileSync(
      path.join(dir, 'species', 'fixture.json'),
      JSON.stringify([species('waifumon/neon_kitsune/standard.png')]),
    );
    fs.writeFileSync(
      path.join(dir, 'tables.json'),
      JSON.stringify({
        energy: { baseMax: 25 },
        inventory: { captureCapacity: 50 },
        dailyPackage: { waifubux: 100, items: { nonexistent_charm: 1 } },
      }),
    );
    expect(() => loadContent(dir, ASSETS_DIR, silentLogger())).toThrow(ContentValidationError);
  });
});
