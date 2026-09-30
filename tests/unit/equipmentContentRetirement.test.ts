/**
 * The ordinary-item `equipment` category is retired as content.
 *
 * Equipment shipped as its own database-backed system, so an item authored
 * with that category is refused at load — disabled items included, because
 * anything in `items.json` can be named by a reward table. The value itself
 * stays in the item schema, the DB CHECK and the API enum for compatibility
 * (`itemSellability.test.ts` / `itemCategories.test.ts` still pin that).
 *
 * Also pins the shipped seed catalogue: Phase 1 ships it empty, and whatever
 * it holds must always parse as a valid package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateContentSet } from '../../src/modules/content/loader';
import { ContentValidationError } from '../../src/shared/errors';
import {
  EQUIPMENT_SEED_FILE,
  loadEquipmentSeedCatalogue,
} from '../../src/modules/equipment/seed';
import { parseEquipmentPackage } from '../../src/modules/equipment/equipmentPackage';
import { CONTENT_DIR, loadShippedContent } from '../helpers/fixtures';

const SHIPPED = loadShippedContent();

describe('retired equipment item category', () => {
  it('accepts the shipped content, which authors no equipment items', () => {
    expect(SHIPPED.items.some((i) => i.category === 'equipment')).toBe(false);
    expect(() => validateContentSet(SHIPPED)).not.toThrow();
  });

  it.each([true, false])('refuses an equipment-category item (enabled: %s)', (enabled) => {
    const content = {
      ...SHIPPED,
      items: [...SHIPPED.items, { ...SHIPPED.items[0]!, slug: 'old_sword', category: 'equipment' as const, enabled }],
    };
    expect(() => validateContentSet(content)).toThrow(ContentValidationError);
    expect(() => validateContentSet(content)).toThrow(/retired "equipment" item category: old_sword/);
  });

  it('is not offered as an inventory section in Discord', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'discord', 'commands', 'waifumon.ts'),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('const INVENTORY_CATEGORY_DISPLAY'),
      source.indexOf('};', source.indexOf('const INVENTORY_CATEGORY_DISPLAY')),
    );
    expect(block).not.toMatch(/^\s*equipment:/m);
  });
});

describe('shipped equipment seed catalogue', () => {
  it('exists, is a valid package, and ships empty in Phase 1', () => {
    const file = path.join(CONTENT_DIR, EQUIPMENT_SEED_FILE);
    expect(fs.existsSync(file)).toBe(true);
    const pkg = parseEquipmentPackage(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(pkg.definitions).toEqual([]);
    expect(loadEquipmentSeedCatalogue(CONTENT_DIR)).toEqual([]);
  });

  it('treats a missing seed file as an empty catalogue', () => {
    expect(loadEquipmentSeedCatalogue(path.join(CONTENT_DIR, 'no-such-dir'))).toEqual([]);
  });
});
