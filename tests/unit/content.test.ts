import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadContent,
  resolveAssetPath,
  validateSpeciesAssets,
} from '../../src/modules/content/loader';
import { ItemContentSchema, SpeciesContentSchema } from '../../src/modules/content/schemas';
import { ContentValidationError } from '../../src/shared/errors';
import { ASSETS_DIR, CONTENT_DIR, loadShippedContent } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

describe('shipped content', () => {
  it('loads and validates, with every referenced image present', () => {
    const content = loadShippedContent();
    expect(content.items.length).toBe(5);
    expect(content.species.length).toBeGreaterThanOrEqual(5);
    // No shipped species may be auto-disabled by a missing image.
    expect(content.species.filter((s) => !s.enabled)).toEqual([]);
  });

  it('ships Prismatic Charm listed but not purchasable, and Mythic Contract guaranteed + never sold', () => {
    const content = loadShippedContent();
    const prismatic = content.items.find((i) => i.slug === 'prismatic_charm');
    expect(prismatic?.enabled).toBe(true);
    expect(prismatic?.purchasable).toBe(false);
    const mythic = content.items.find((i) => i.slug === 'mythic_contract');
    expect(mythic?.isGuaranteedCapture).toBe(true);
    expect(mythic?.purchasable).toBe(false);
    expect(mythic?.buyPrice).toBeNull();
  });

  it('ships Basic/Silk/Velvet purchasable at the launch prices', () => {
    const content = loadShippedContent();
    const prices = Object.fromEntries(
      content.items.filter((i) => i.purchasable).map((i) => [i.slug, i.buyPrice]),
    );
    expect(prices).toEqual({ basic_charm: 25, silk_charm: 75, velvet_charm: 200 });
  });
});

describe('schema invariants', () => {
  const baseItem = {
    slug: 'test_item',
    name: 'Test',
    category: 'capture',
    captureModifier: 1,
  };

  it('rejects guaranteed-capture items marked purchasable', () => {
    const result = ItemContentSchema.safeParse({
      ...baseItem,
      isGuaranteedCapture: true,
      purchasable: true,
      buyPrice: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects purchasable items without a buy price', () => {
    const result = ItemContentSchema.safeParse({ ...baseItem, purchasable: true });
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
    const result = validateSpeciesAssets([species('waifumon/nope/standard.png')], ASSETS_DIR, silentLogger());
    expect(result[0]?.enabled).toBe(false);
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

  it('fails startup loudly on a dailyPackage slug that is not an item', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-content-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'species'));
    fs.copyFileSync(path.join(CONTENT_DIR, 'items.json'), path.join(dir, 'items.json'));
    fs.copyFileSync(
      path.join(CONTENT_DIR, 'species', 'placeholders.json'),
      path.join(dir, 'species', 'placeholders.json'),
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
