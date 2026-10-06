/**
 * Delve and combat modifiers: a run freezes the aggregated modifiers with the
 * rest of its fighter, fights every node with that snapshot on the node's own
 * seed, carries Lifesteal-restored HP from room to room, ignores later gear
 * changes — and Dungeon gear drops get their secondary bonuses from the
 * shared grant path, not from anything Dungeon-specific.
 *
 * The world fights with the engine's **real** rules here (`combatRules: null`),
 * so variance, Crits and Double Attacks are all in play and all seeded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRuns, playerEquipment } from '../../src/db/schema';
import { buildRunScreen, buildZoneDetail } from '../../src/discord/dungeonPresenter';
import { ZERO_COMBAT_MODIFIERS } from '../../src/modules/combat/combatMath';
import type { CombatEvent, CombatModifiers } from '../../src/modules/combat/combatTypes';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonPlayService';
import { dungeonCombatSeed, fightEnemy, fighterModifiers, type DungeonFighter } from '../../src/modules/dungeons/dungeonRunState';
import {
  EQUIPMENT_COMBAT_BONUS_FILE,
  EquipmentCombatBonusFileSchema,
  combatBonusCatalogueFromFile,
  type CombatBonus,
  type CombatBonusCatalogue,
} from '../../src/modules/equipment/combatBonuses';
import { seededRng } from '../../src/shared/random';
import { GEAR_TABLE, TEST_ENEMIES, createDungeonWorld, walk, type DungeonWorld } from '../helpers/dungeonPlayFixtures';
import { grant } from '../helpers/equipmentFixtures';
import { CONTENT_DIR } from '../helpers/fixtures';

const SHIPPED: CombatBonusCatalogue = combatBonusCatalogueFromFile(
  EquipmentCombatBonusFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, EQUIPMENT_COMBAT_BONUS_FILE), 'utf8'))),
);
/** The shipped catalogue with N always rolling its bonus, so a drop's bonus is certain. */
const ALWAYS_N: CombatBonusCatalogue = { ...SHIPPED, rarityRules: { ...SHIPPED.rarityRules, N: { bonusChanceBp: 10_000, bonusCount: 1 } } };

const ZONE = 'mods_zone';
/** Fights only, so HP moves by combat alone. */
const BRAWL = 'mods_brawl';

let w: DungeonWorld;

beforeAll(async () => {
  w = await createDungeonWorld({ combatRules: null, equipment: { rng: seededRng(77), combatBonuses: () => ALWAYS_N } });
  await w.zone(ZONE);
  await w.zone(BRAWL, (z) => {
    z.generation.nodeWeights = { combat: 100, elite: 0, event: 0, reward: 0, rest: 0, miniboss: 0, exit: 0 };
    z.generation.required = [];
    z.generation.limits = [];
  });
});
afterAll(async () => {
  await w?.cleanup();
});

const MODS: CombatModifiers = { critChanceBp: 3_000, critDamageBonusBp: 2_000, doubleAttackChanceBp: 2_500, armorPenetrationBp: 1_000, lifestealBp: 1_500 };

/** Starters carrying explicit bonuses that add up to {@link MODS}. */
async function gearedPlayer() {
  const { playerId, buddyId } = await w.player({ starters: false });
  const give = async (slot: 'attack' | 'defense' | 'health', key: string, rolledMultiplierBp: number, combatBonuses: CombatBonus[]) => {
    const id = await grant(w.t.db, w.svc, playerId, key, { roll: { kind: 'fixed', rolledMultiplierBp, affixKey: null, combatBonuses } });
    await w.svc.equipment.equip(playerId, { slot, equipmentId: id });
    return id;
  };
  const attack = await give('attack', 'rusty_pipe', 4_500, [
    { stat: 'crit_chance_bp', valueBp: 3_000 },
    { stat: 'crit_damage_bonus_bp', valueBp: 2_000 },
  ]);
  const defense = await give('defense', 'scrap_plate', 3_500, [
    { stat: 'double_attack_chance_bp', valueBp: 2_500 },
    { stat: 'armor_penetration_bp', valueBp: 1_000 },
  ]);
  const health = await give('health', 'dented_lunchbox', 20_000, [{ stat: 'lifesteal_bp', valueBp: 1_500 }]);
  return { playerId, buddyId, attack, defense, health };
}

type CombatPayload = {
  enemy: { key: string };
  fighter: { attack: number; defense: number; maxHp: number; modifiers: CombatModifiers };
  hpBefore: number;
  hpAfter: number;
  rounds: number;
  result: string;
  combatSeed: number;
  lifestealHealed: number;
  playerCrits: number;
  playerBonusAttacks: number;
  events: CombatEvent[];
};
const fightsOf = async (runId: number) =>
  (await w.play.history(runId)).filter((e) => e.type === 'combat_resolved').map((e) => ({ nodeId: e.nodeId!, ...(e.payload as unknown as CombatPayload) }));
const storedFighter = async (runId: number) =>
  (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!.fighter as unknown as DungeonFighter;

describe('the run snapshot', () => {
  it('freezes the aggregated modifiers and each item’s bonuses with ATK / DEF / HP', async () => {
    const { playerId } = await gearedPlayer();
    const run = await w.play.start(playerId, ZONE, { seed: 3 });
    expect(run.fighter).toMatchObject({ attack: 83, defense: 65, maxHp: 370, modifiers: MODS });
    expect(run.fighter.gear.attack.combatBonuses).toEqual([
      { stat: 'crit_chance_bp', valueBp: 3_000 },
      { stat: 'crit_damage_bonus_bp', valueBp: 2_000 },
    ]);
    expect(run.fighter.gear.health.combatBonuses).toEqual([{ stat: 'lifesteal_bp', valueBp: 1_500 }]);
    expect((await storedFighter(run.id)).modifiers).toEqual(MODS);
  });

  it('a bonus-free loadout snapshots all-zero modifiers', async () => {
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, ZONE, { seed: 3 });
    expect(run.fighter.modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
    expect(run.fighter.gear.attack.combatBonuses).toEqual([]);
  });

  it('a run stored before modifiers existed reads as none and stays playable', async () => {
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, BRAWL, { seed: 5 });
    const { modifiers: _dropped, ...legacy } = await storedFighter(run.id);
    await w.t.db.update(dungeonRuns).set({ fighter: legacy as unknown as Record<string, unknown> }).where(eq(dungeonRuns.id, run.id));
    expect(fighterModifiers((await w.play.run(playerId, run.id)).fighter)).toEqual(ZERO_COMBAT_MODIFIERS);
    const end = await walk(w.play, playerId, await w.play.run(playerId, run.id));
    expect(end.status).not.toBe('active');
    for (const fight of await fightsOf(run.id)) {
      expect(fight.fighter.modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
      expect(fight.playerCrits + fight.playerBonusAttacks + fight.lifestealHealed).toBe(0);
    }
  });

  it('the zone screen shows live totals and the run screen shows the snapshot', async () => {
    const { playerId } = await gearedPlayer();
    const opts = { itemName: (slug: string) => slug };
    const detail = JSON.stringify(buildZoneDetail(await w.play.zone(playerId, ZONE), opts).embeds);
    expect(detail).toContain('Crit 30% · Crit DMG 170% · Double 25% · Armor Pen 10% · Lifesteal 15%');
    const run = await w.play.start(playerId, ZONE, { seed: 3 });
    const screen = JSON.stringify(buildRunScreen(run, opts).embeds);
    expect(screen).toContain('Crit 30% · Crit DMG 170% · Double 25% · Armor Pen 10% · Lifesteal 15%');
  });
});

describe('fighting with the snapshot', () => {
  let playerId: number;
  let run: DungeonRunView;
  let end: DungeonRunView;
  let ids: { attack: number; defense: number; health: number };

  beforeAll(async () => {
    const made = await gearedPlayer();
    playerId = made.playerId;
    ids = made;
    run = await w.play.start(playerId, BRAWL, { seed: 9 });

    // Mid-run: every bonus-bearing piece is replaced by a plain one.
    for (const [slot, key, bp] of [['attack', 'rusty_pipe', 6_000], ['defense', 'scrap_plate', 5_000], ['health', 'dented_lunchbox', 26_000]] as const) {
      const plain = await grant(w.t.db, w.svc, playerId, key, { roll: { kind: 'fixed', rolledMultiplierBp: bp, affixKey: null } });
      await w.svc.equipment.equip(playerId, { slot, equipmentId: plain });
    }
    end = await walk(w.play, playerId, run);
  });

  it('the live loadout really did change', async () => {
    const live = await w.stats.calculateCombatStats(playerId);
    expect(live.combatModifiers).toEqual(ZERO_COMBAT_MODIFIERS);
    expect(live.stats.attack).not.toBe(83);
    expect(ids.attack).toBeGreaterThan(0);
  });

  it('later gear changes never reach the active run', async () => {
    expect(end.fighter).toMatchObject({ attack: 83, defense: 65, maxHp: 370, modifiers: MODS });
    expect((await storedFighter(run.id)).modifiers).toEqual(MODS);
    const fights = await fightsOf(run.id);
    expect(fights.length).toBeGreaterThan(2);
    for (const fight of fights) expect(fight.fighter).toEqual({ attack: 83, defense: 65, maxHp: 370, modifiers: MODS });
  });

  it('every node fight is the engine’s seeded result for the snapshot, and replays from the stored seed', async () => {
    const fighter = await storedFighter(run.id);
    const runSeed = (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id)))[0]!.seed;
    for (const fight of await fightsOf(run.id)) {
      expect(fight.combatSeed).toBe(dungeonCombatSeed(runSeed, fight.nodeId));
      const enemy = TEST_ENEMIES.find((e) => e.key === fight.enemy.key)!;
      const replay = fightEnemy(fighter, fight.hpBefore, enemy, fight.combatSeed);
      expect(replay.events).toEqual(fight.events);
      expect({ hpAfter: replay.hpAfter, rounds: replay.rounds, result: replay.result }).toEqual({
        hpAfter: fight.hpAfter,
        rounds: fight.rounds,
        result: fight.result,
      });
      // Asking again gives the same fight; a zero-modifier fighter does not.
      expect(fightEnemy(fighter, fight.hpBefore, enemy, fight.combatSeed).events).toEqual(fight.events);
      expect(fightEnemy({ ...fighter, modifiers: ZERO_COMBAT_MODIFIERS }, fight.hpBefore, enemy, fight.combatSeed).events).not.toEqual(fight.events);
    }
  });

  it('the modifiers fire: Armor Pen on every hit, Crits, Double Attacks and Lifesteal across the run', async () => {
    const fights = await fightsOf(run.id);
    const playerHits = fights.flatMap((f) => f.events.filter((e): e is Extract<CombatEvent, { type: 'damage' }> => e.type === 'damage' && e.actor === 'player'));
    expect(playerHits.every((h) => h.armorPenetrationBp === 1_000)).toBe(true);
    expect(playerHits.filter((h) => h.critical).every((h) => h.critMultiplierBp === 17_000)).toBe(true);
    expect(fights.reduce((n, f) => n + f.playerCrits, 0)).toBeGreaterThan(0);
    expect(fights.reduce((n, f) => n + f.playerBonusAttacks, 0)).toBeGreaterThan(0);
    expect(fights.reduce((n, f) => n + f.lifestealHealed, 0)).toBeGreaterThan(0);
    // The enemy has no modifiers.
    const enemyHits = fights.flatMap((f) => f.events.filter((e) => e.type === 'damage' && e.actor === 'enemy'));
    expect(enemyHits.every((h) => h.type === 'damage' && !h.critical && !h.bonusAttack && h.armorPenetrationBp === 0)).toBe(true);
  });

  it('current HP persists from fight to fight with Lifesteal already inside it', async () => {
    let hp = 370;
    for (const event of await w.play.history(run.id)) {
      const fight = event.payload as unknown as CombatPayload;
      // A rest or event between fights moves HP too; follow it.
      if (event.type === 'rest_resolved' || event.type === 'event_resolved') hp = fight.hpAfter;
      if (event.type !== 'combat_resolved') continue;
      // Each fight starts from exactly what the last node left — heals included.
      expect(fight.hpBefore).toBe(hp);
      const dealtToPlayer = fight.events.reduce((n, e) => (e.type === 'damage' && e.target === 'player' ? n + (e.targetHpBefore - e.targetHpAfter) : n), 0);
      const healed = fight.events.reduce((n, e) => (e.type === 'lifesteal_heal' && e.actor === 'player' ? n + e.amount : n), 0);
      expect(healed).toBe(fight.lifestealHealed);
      expect(fight.hpAfter).toBe(fight.hpBefore - dealtToPlayer + healed);
      expect(fight.hpAfter).toBeLessThanOrEqual(370);
      hp = fight.hpAfter;
    }
    expect(end.currentHp).toBe(hp);
  });

  it('the node resolution records what Lifesteal restored', async () => {
    const fights = await fightsOf(run.id);
    const view = await w.play.run(playerId, run.id);
    if (view.resolution?.kind === 'combat') {
      expect(view.resolution.lifestealHealed).toBe(fights[fights.length - 1]!.lifestealHealed);
    }
    expect(fights.some((f) => f.lifestealHealed > 0)).toBe(true);
  });
});

describe('Dungeon gear drops', () => {
  it('a dropped item gets its secondary bonus from the shared grant, and the run records it', async () => {
    const { playerId } = await w.player();
    const seed = await w.seedFor(ZONE, (g) => g.nodes.some((n) => n.type === 'reward'));
    const run = await w.play.start(playerId, ZONE, { seed });
    const end = await walk(w.play, playerId, run);
    const drops = end.secured.filter((s) => s.kind === 'equipment');
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) {
      if (drop.kind !== 'equipment') continue;
      const [row] = await w.t.db.select().from(playerEquipment).where(eq(playerEquipment.id, drop.equipmentId));
      expect(row!.sourceType).toBe('dungeon');
      // N gear under a catalogue where N always rolls: exactly one bonus, in the N range for its slot.
      expect(row!.combatBonuses).toHaveLength(1);
      expect(drop.combatBonuses).toEqual(row!.combatBonuses);
      const bonus = row!.combatBonuses[0]!;
      const family = ALWAYS_N.bonuses.find((b) => b.stat === bonus.stat)!;
      expect(ALWAYS_N.eligibility[drop.slot]).toContain(bonus.stat);
      expect(bonus.valueBp).toBeGreaterThanOrEqual(family.ranges.N.minBp);
      expect(bonus.valueBp).toBeLessThanOrEqual(family.ranges.N.maxBp);
    }
    // The reward table used here is the gear table; nothing Dungeon-side rolled anything.
    expect(GEAR_TABLE).toBe('test-dungeon-gear');
  });
});
