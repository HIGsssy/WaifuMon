/**
 * Combat enemy content: the shipped starter file, the schema, the loader
 * hook-up, and artwork that is optional and never breaks a fight.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMBAT_ENEMY_FILE,
  CombatEnemyFileSchema,
  createCombatEnemyCatalogue,
  enemyCombatantInput,
} from '../../../src/modules/combat/enemyDefinitions';
import {
  conventionalCombatArtworkPath,
  locateCombatArtwork,
} from '../../../src/modules/combat/combatArtwork';
import { playerCombatantInput } from '../../../src/modules/combat/playerCombatant';
import { createCombatState } from '../../../src/modules/combat/combatState';
import { simulateCombat } from '../../../src/modules/combat/combatSimulator';
import { basicAttackController } from '../../../src/modules/combat/combatController';
import { readContentFiles } from '../../../src/modules/content/loader';
import { CombatStateInvalidError } from '../../../src/shared/errors';
import { seededRng } from '../../../src/shared/random';
import { ASSETS_DIR, CONTENT_DIR } from '../../helpers/fixtures';

const enemy = { key: 'test_slime', name: 'Test Slime', attack: 10, defense: 0, hp: 30, enabled: true };
const file = (enemies: unknown[]) => ({ format: 'waifumon-combat-enemies', version: 1, enemies });
const issues = (raw: unknown) => {
  const r = CombatEnemyFileSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('shipped starter enemies', () => {
  const shipped = CombatEnemyFileSchema.parse(
    JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, COMBAT_ENEMY_FILE), 'utf8')),
  );

  it('still ships the original enemies first, with the keys and stats everything references', () => {
    // The three starters, then the temporary dungeon boss (see content/dungeons/zones.json).
    // Enemies added since follow them; the file is the catalogue's shipped default.
    expect(shipped.enemies.slice(0, 4).map((e) => [e.key, e.attack, e.defense, e.hp])).toEqual([
      ['scrapyard_drone', 55, 30, 300],
      ['alley_bruiser', 100, 55, 520],
      ['security_automaton', 140, 90, 800],
      ['scrapheap_colossus', 170, 110, 1200],
    ]);
    for (const e of shipped.enemies.slice(0, 4)) {
      expect(e.enabled).toBe(true);
      expect(e.tags).toContain('initial_tuning');
    }
  });

  it('every shipped enemy has a unique key and fightable stats', () => {
    expect(new Set(shipped.enemies.map((e) => e.key)).size).toBe(shipped.enemies.length);
    for (const e of shipped.enemies) {
      expect(e.attack, e.key).toBeGreaterThanOrEqual(1);
      expect(e.defense, e.key).toBeGreaterThanOrEqual(0);
      expect(e.hp, e.key).toBeGreaterThanOrEqual(1);
      expect(e.description, e.key).toBe('');
    }
  });

  it('arrives through the content loader', () => {
    const content = readContentFiles(CONTENT_DIR);
    expect(content.combatEnemies?.map((e) => e.key)).toEqual(shipped.enemies.map((e) => e.key));
  });

  it('each starter enemy builds a valid combatant and fights to a result', () => {
    const catalogue = createCombatEnemyCatalogue(shipped.enemies);
    for (const def of catalogue.enabled()) {
      const state = createCombatState({
        player: playerCombatantInput({ buddy: { waifuId: 1, name: 'Mira' }, stats: { attack: 50, defense: 40, maxHp: 200 } }),
        enemy: enemyCombatantInput(def),
      });
      expect(state.enemy).toMatchObject({ id: `enemy:${def.key}`, maxHp: def.hp, attack: def.attack, defense: def.defense });
      const r = simulateCombat(state, { player: basicAttackController, enemy: basicAttackController }, { rng: seededRng(1) });
      expect(['player_victory', 'enemy_victory', 'draw']).toContain(r.result);
    }
    expect(catalogue.get('alley_bruiser')?.name).toBe('Alley Bruiser');
    expect(catalogue.get('nope')).toBeUndefined();
  });
});

describe('CombatEnemyFileSchema', () => {
  it('accepts a minimal valid enemy and defaults artwork and tags', () => {
    const parsed = CombatEnemyFileSchema.parse(file([enemy]));
    expect(parsed.enemies[0]).toEqual({ ...enemy, description: '', artworkPath: null, spriteArtworkPath: null, spritePlacement: null, tags: [] });
  });

  it('refuses duplicate keys', () => {
    expect(issues(file([enemy, { ...enemy, name: 'Other' }]))).toEqual([
      'enemies.1.key: duplicate enemy key "test_slime" (also enemies[0])',
    ]);
  });

  it.each([
    ['hp 0', { hp: 0 }],
    ['negative hp', { hp: -5 }],
    ['fractional hp', { hp: 1.5 }],
    ['attack 0', { attack: 0 }],
    ['negative defense', { defense: -1 }],
    ['string stat', { attack: '10' }],
    ['empty name', { name: '  ' }],
    ['bad key', { key: 'Test Slime' }],
    ['enabled not boolean', { enabled: 'yes' }],
    ['unknown field', { loot: [] }],
  ])('refuses %s', (_label, patch) => {
    expect(issues(file([{ ...enemy, ...patch }])).length).toBeGreaterThan(0);
  });

  it('allows zero defense', () => {
    expect(issues(file([{ ...enemy, defense: 0 }]))).toEqual([]);
  });

  it.each([
    '../secrets/drone.webp',
    '/etc/passwd.png',
    'combat\\enemies\\drone.webp',
    'https://example.com/drone.webp',
    'C:/drone.webp',
    'combat/enemies/drone.svg',
    'combat/enemies/drone',
  ])('refuses unsafe artwork path %s', (artworkPath) => {
    expect(issues(file([{ ...enemy, artworkPath }])).length).toBeGreaterThan(0);
  });

  it('allows null, absent and conventional artwork paths', () => {
    expect(issues(file([{ ...enemy, artworkPath: null }]))).toEqual([]);
    expect(issues(file([enemy]))).toEqual([]);
    expect(issues(file([{ ...enemy, artworkPath: 'combat/enemies/test_slime.webp' }]))).toEqual([]);
  });
});

describe('combat artwork', () => {
  it('follows the documented conventions', () => {
    expect(conventionalCombatArtworkPath('enemies', 'scrapyard_drone')).toBe('combat/enemies/scrapyard_drone.webp');
    expect(conventionalCombatArtworkPath('backgrounds', 'scrapyard')).toBe('combat/backgrounds/scrapyard.webp');
    expect(conventionalCombatArtworkPath('abilities', 'overclock')).toBe('combat/abilities/overclock.webp');
  });

  it('missing or absent art resolves to a text-only status, never a throw', () => {
    expect(locateCombatArtwork(ASSETS_DIR, null)).toEqual({ status: 'none' });
    expect(locateCombatArtwork(ASSETS_DIR, 'combat/enemies/does_not_exist.webp')).toEqual({ status: 'missing' });
    expect(locateCombatArtwork(ASSETS_DIR, '../outside.webp').status).toBe('unsafe');
  });

  it('finds art that exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'combat-art-'));
    try {
      fs.mkdirSync(path.join(dir, 'combat', 'enemies'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'combat', 'enemies', 'test_slime.webp'), 'x');
      expect(locateCombatArtwork(dir, 'combat/enemies/test_slime.webp')).toMatchObject({ status: 'available', contentType: 'image/webp' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('playerCombatantInput', () => {
  it('builds from already-calculated stats', () => {
    expect(playerCombatantInput({ buddy: { waifuId: 12, name: 'Mira' }, stats: { attack: 50, defense: 40, maxHp: 200 } }))
      .toEqual({ id: 'buddy:12', name: 'Mira', attack: 50, defense: 40, maxHp: 200 });
  });

  it('refuses a missing Buddy or an incomplete loadout', () => {
    expect(() => playerCombatantInput({ buddy: null, stats: { attack: 1, defense: 1, maxHp: 1 } })).toThrow(CombatStateInvalidError);
    expect(() => playerCombatantInput({ buddy: { waifuId: 1, name: 'M' }, stats: { attack: 1, defense: null, maxHp: 1 } })).toThrow(CombatStateInvalidError);
  });
});
