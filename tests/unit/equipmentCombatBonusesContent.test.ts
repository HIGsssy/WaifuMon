/**
 * Combat-bonus catalogue is required content, fail-closed.
 *
 * The rarity contracts (N 0–1, R exactly 1, SR exactly 2 distinct) are gameplay
 * rules, so wherever random gear can be generated the catalogue must load. "Can
 * roll" is exactly "the affix catalogue is deployed" (an affix-less pool refuses
 * the grant), so the catalogue is required iff `equipment/affixes.json` is
 * present. These cases run against a throwaway copy of the real content tree so
 * they exercise the shipped loader without ever writing to `content/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readContentFiles } from '../../src/modules/content/loader';
import { ContentValidationError } from '../../src/shared/errors';
import { EQUIPMENT_AFFIX_FILE } from '../../src/modules/equipment/affixCatalogue';
import { EQUIPMENT_COMBAT_BONUS_FILE } from '../../src/modules/equipment/combatBonuses';
import { CONTENT_DIR } from '../helpers/fixtures';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A writable, full copy of the real content tree. */
function contentCopy(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-combat-bonus-'));
  tempRoots.push(root);
  const contentDir = path.join(root, 'content');
  fs.cpSync(CONTENT_DIR, contentDir, { recursive: true });
  return contentDir;
}

const bonusPath = (dir: string) => path.join(dir, ...EQUIPMENT_COMBAT_BONUS_FILE.split('/'));
const affixPath = (dir: string) => path.join(dir, ...EQUIPMENT_AFFIX_FILE.split('/'));

describe('combat-bonus catalogue is required content', () => {
  it('loads the shipped tree with the catalogue present', () => {
    const content = readContentFiles(contentCopy());
    expect(content.equipmentCombatBonuses).not.toBeNull();
    expect(content.equipmentCombatBonuses!.bonuses.map((b) => b.stat)).toContain('lifesteal_bp');
  });

  it('refuses startup when the catalogue is missing but gear can still roll', () => {
    const dir = contentCopy();
    fs.rmSync(bonusPath(dir));
    expect(fs.existsSync(affixPath(dir))).toBe(true); // the feature is deployed…
    expect(() => readContentFiles(dir)).toThrow(ContentValidationError);
    expect(() => readContentFiles(dir)).toThrow(/combatBonuses\.json/);
  });

  it('refuses startup when the catalogue is structurally invalid', () => {
    const dir = contentCopy();
    const file = JSON.parse(fs.readFileSync(bonusPath(dir), 'utf8'));
    // An SR pool that can no longer supply two distinct families is a content error.
    file.eligibility.health = ['lifesteal_bp'];
    fs.writeFileSync(bonusPath(dir), JSON.stringify(file));
    expect(() => readContentFiles(dir)).toThrow(ContentValidationError);
  });

  it('refuses startup when the catalogue JSON is malformed', () => {
    const dir = contentCopy();
    fs.writeFileSync(bonusPath(dir), '{ not valid json');
    expect(() => readContentFiles(dir)).toThrow(ContentValidationError);
  });

  it('stays optional for a content set without the equipment feature (no affixes)', () => {
    const dir = contentCopy();
    fs.rmSync(affixPath(dir));
    fs.rmSync(bonusPath(dir));
    // No affixes means no pool can roll, so the catalogue is not required.
    const content = readContentFiles(dir);
    expect(content.equipmentAffixes).toEqual([]);
    expect(content.equipmentCombatBonuses).toBeNull();
  });
});
