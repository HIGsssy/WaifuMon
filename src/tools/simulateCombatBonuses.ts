#!/usr/bin/env tsx
/**
 * `npm run combat:simulate-bonuses` — what Equipment's secondary combat
 * bonuses do to Combat Trials and Delve, measured through the real engine.
 *
 * Reads the content directory only (enemies, Trials, the shipped Delve zone,
 * its reward tables and the combat-bonus catalogue), so it needs no database
 * and reports on the game as Git ships it. Nothing here re-implements a
 * rule: stats come from `deriveStat`, modifiers from `aggregateCombatBonuses`
 * (caps included), Trial fights from `simulateCombat`, Delve runs from
 * `simulateDungeonPlaythroughs`.
 *
 * A row is `Current SP × primary tier × bonus build`:
 *
 *  - **primary tier** — three multipliers, as real stats are derived;
 *  - **bonus build** — three items' bonus lists. `typical` builds use the
 *    middle of the shipped range for that rarity, `max` the top, so they move
 *    with the catalogue instead of pinning numbers here.
 *
 * Baseline builds are tied to their own tier (an N loadout has N bonuses);
 * stacking and synergy builds are R-typical and SR-max rolls on every tier.
 * Some stacking builds are deliberately impossible to drop (the shipped
 * eligibility puts Armor Pen and Crit Damage on two slots, not three): they
 * are here to find the ceiling, and are marked `*`.
 *
 * Usage:
 *   npm run combat:simulate-bonuses
 *   npm run combat:simulate-bonuses -- --sp 185,300 --fights 2000 --runs 2000
 *   npm run combat:simulate-bonuses -- --section srvsr
 *   npm run combat:simulate-bonuses -- --json
 */
import path from 'node:path';
import process from 'node:process';
import { basicAttackController } from '../modules/combat/combatController';
import { basicAttackDamage, effectiveDefense } from '../modules/combat/combatMath';
import { simulateCombat } from '../modules/combat/combatSimulator';
import { createCombatState } from '../modules/combat/combatState';
import type { CombatModifiers } from '../modules/combat/combatTypes';
import { createCombatEnemyCatalogue, enemyCombatantInput } from '../modules/combat/enemyDefinitions';
import { createCombatTrialCatalogue } from '../modules/combat/trialDefinitions';
import { readContentFiles } from '../modules/content/loader';
import {
  PLAYTHROUGH_POLICIES,
  simulateDungeonPlaythroughs,
  type PlaythroughSnapshot,
} from '../modules/dungeons/dungeonPlaythrough';
import { dungeonCatalogueFromContent, loadShippedDungeonZones } from '../modules/dungeons/dungeonZoneStore';
import {
  aggregateCombatBonuses,
  combatModifierRows,
  type CombatBonus,
  type CombatBonusCatalogue,
  type CombatBonusRarity,
  type CombatBonusStat,
} from '../modules/equipment/combatBonuses';
import { deriveStat } from '../modules/equipment/equipmentMath';
import { loadEquipmentSeedCatalogue } from '../modules/equipment/seed';
import { equipmentSelectorsOf, resolveEquipmentPools } from '../modules/rewardTables/rewardTableCore';
import { seededRng } from '../shared/random';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const contentDir = path.resolve(arg('content') ?? process.env.CONTENT_DIR ?? 'content');
const content = readContentFiles(contentDir);
const catalogue = content.equipmentCombatBonuses;
if (!catalogue) {
  console.error('content/equipment/combatBonuses.json is missing — nothing to simulate.');
  process.exit(1);
}

// ── builds ──────────────────────────────────────────────────────────────────

/** Multipliers in basis points: the onboarding starters, then typical rolls by tier. */
const TIERS = [
  { key: 'starter', rarity: null, attackBp: 4_500, defenseBp: 3_500, healthBp: 20_000 },
  { key: 'n', rarity: 'N', attackBp: 6_500, defenseBp: 5_500, healthBp: 22_000 },
  { key: 'r', rarity: 'R', attackBp: 8_500, defenseBp: 7_500, healthBp: 26_000 },
  { key: 'sr', rarity: 'SR', attackBp: 11_500, defenseBp: 10_000, healthBp: 26_000 },
] as const;
type Tier = (typeof TIERS)[number];

type Roll = 'min' | 'typical' | 'max';
/** One bonus at a point of the shipped range for `rarity`, snapped to the family's step. */
function bonus(cat: CombatBonusCatalogue, stat: CombatBonusStat, rarity: CombatBonusRarity, roll: Roll): CombatBonus {
  const family = cat.bonuses.find((b) => b.stat === stat)!;
  const { minBp, maxBp } = family.ranges[rarity];
  const steps = (maxBp - minBp) / family.stepBp;
  const step = roll === 'min' ? 0 : roll === 'max' ? steps : Math.round(steps / 2);
  return { stat, valueBp: minBp + step * family.stepBp };
}
const b = (stat: CombatBonusStat, rarity: CombatBonusRarity, roll: Roll = 'typical') => bonus(catalogue!, stat, rarity, roll);
const three = (stat: CombatBonusStat, rarity: CombatBonusRarity, roll: Roll): CombatBonus[][] => [[b(stat, rarity, roll)], [b(stat, rarity, roll)], [b(stat, rarity, roll)]];

interface Build {
  key: string;
  group: 'baseline' | 'stacking' | 'synergy';
  /** Baselines belong to one tier; the rest run on every tier. */
  tier?: Tier['key'];
  /** Cannot drop under the shipped slot eligibility. */
  impossible?: boolean;
  /** Per item: attack, defense, health. */
  items: CombatBonus[][];
}

const BUILDS: Build[] = [
  { key: 'none', group: 'baseline', items: [[], [], []] },
  // N: each piece has a 65% chance of one bonus — "no bonus" is `none`; this is all three hitting.
  { key: 'n_one_bonus', group: 'baseline', tier: 'n', items: [[b('crit_chance_bp', 'N')], [b('armor_penetration_bp', 'N')], [b('lifesteal_bp', 'N')]] },
  { key: 'n_single_piece', group: 'baseline', tier: 'n', items: [[b('crit_chance_bp', 'N')], [], []] },
  { key: 'r_one_bonus', group: 'baseline', tier: 'r', items: [[b('crit_chance_bp', 'R')], [b('armor_penetration_bp', 'R')], [b('lifesteal_bp', 'R')]] },
  {
    key: 'sr_two_bonus',
    group: 'baseline',
    tier: 'sr',
    items: [
      [b('crit_chance_bp', 'SR'), b('crit_damage_bonus_bp', 'SR')],
      [b('double_attack_chance_bp', 'SR'), b('armor_penetration_bp', 'SR')],
      [b('crit_chance_bp', 'SR'), b('lifesteal_bp', 'SR')],
    ],
  },
  {
    key: 'sr_two_bonus_max',
    group: 'baseline',
    tier: 'sr',
    items: [
      [b('crit_chance_bp', 'SR', 'max'), b('crit_damage_bonus_bp', 'SR', 'max')],
      [b('double_attack_chance_bp', 'SR', 'max'), b('armor_penetration_bp', 'SR', 'max')],
      [b('crit_chance_bp', 'SR', 'max'), b('lifesteal_bp', 'SR', 'max')],
    ],
  },

  { key: '3x_crit_r', group: 'stacking', items: three('crit_chance_bp', 'R', 'typical') },
  { key: '3x_crit_sr_max', group: 'stacking', items: three('crit_chance_bp', 'SR', 'max') },
  { key: '3x_double_r', group: 'stacking', items: three('double_attack_chance_bp', 'R', 'typical') },
  { key: '3x_double_sr_max', group: 'stacking', items: three('double_attack_chance_bp', 'SR', 'max') },
  { key: '3x_armorpen_r', group: 'stacking', impossible: true, items: three('armor_penetration_bp', 'R', 'typical') },
  { key: '3x_armorpen_sr_max', group: 'stacking', impossible: true, items: three('armor_penetration_bp', 'SR', 'max') },
  { key: '3x_lifesteal_r', group: 'stacking', items: three('lifesteal_bp', 'R', 'typical') },
  { key: '3x_lifesteal_sr_max', group: 'stacking', items: three('lifesteal_bp', 'SR', 'max') },

  {
    key: 'crit+critdmg',
    group: 'synergy',
    items: [
      [b('crit_chance_bp', 'SR', 'max'), b('crit_damage_bonus_bp', 'SR', 'max')],
      [b('crit_chance_bp', 'SR', 'max')],
      [b('crit_chance_bp', 'SR', 'max'), b('crit_damage_bonus_bp', 'SR', 'max')],
    ],
  },
  {
    key: 'crit+double',
    group: 'synergy',
    items: [
      [b('crit_chance_bp', 'SR', 'max'), b('double_attack_chance_bp', 'SR', 'max')],
      [b('crit_chance_bp', 'SR', 'max'), b('double_attack_chance_bp', 'SR', 'max')],
      [b('crit_chance_bp', 'SR', 'max'), b('double_attack_chance_bp', 'SR', 'max')],
    ],
  },
  {
    key: 'double+lifesteal',
    group: 'synergy',
    items: [
      [b('double_attack_chance_bp', 'SR', 'max'), b('lifesteal_bp', 'SR', 'max')],
      [b('double_attack_chance_bp', 'SR', 'max'), b('lifesteal_bp', 'SR', 'max')],
      [b('double_attack_chance_bp', 'SR', 'max'), b('lifesteal_bp', 'SR', 'max')],
    ],
  },
  {
    key: 'armorpen+crit',
    group: 'synergy',
    items: [
      [b('armor_penetration_bp', 'SR', 'max'), b('crit_chance_bp', 'SR', 'max')],
      [b('armor_penetration_bp', 'SR', 'max'), b('crit_chance_bp', 'SR', 'max')],
      [b('crit_chance_bp', 'SR', 'max')],
    ],
  },
  {
    key: 'mixed_three_item',
    group: 'synergy',
    items: [
      [b('crit_chance_bp', 'SR'), b('armor_penetration_bp', 'SR')],
      [b('double_attack_chance_bp', 'R')],
      [b('lifesteal_bp', 'SR'), b('crit_damage_bonus_bp', 'SR')],
    ],
  },
];

// ── content ─────────────────────────────────────────────────────────────────

const enemies = createCombatEnemyCatalogue(content.combatEnemies ?? []);
const trials = createCombatTrialCatalogue(content.combatTrials ?? [], enemies).available();

const zones = loadShippedDungeonZones(contentDir);
const zoneKey = arg('zone') ?? zones.find((z) => z.definition.enabled)?.key ?? zones[0]?.key;
const zone = zones.find((z) => z.key === zoneKey)?.definition;
if (!zone) {
  console.error(`No shipped dungeon zone "${String(zoneKey)}".`);
  process.exit(1);
}
const definitions = loadEquipmentSeedCatalogue(contentDir).map((d) => ({ key: d.key, name: d.name, slot: d.slot, rarity: d.rarity, enabled: d.enabled ?? true }));
const tableIds = new Set(
  [...zone.rewards.bands.flatMap((band) => [band.rewardTable, band.equipmentRewardTable]), zone.rewards.completion.rewardTable, zone.rewards.extraction.rewardTable].filter(
    (id): id is string => id != null,
  ),
);
const rewardTables: PlaythroughSnapshot['rewardTables'] = {};
for (const id of tableIds) {
  const table = content.expeditionRewards.find((t) => t.id === id);
  rewardTables[id] = table?.enabled ? { table, equipmentPools: resolveEquipmentPools(equipmentSelectorsOf([table]), definitions) } : null;
}
const snapshot: PlaythroughSnapshot = {
  zone,
  enemies: Object.fromEntries((content.combatEnemies ?? []).map((e) => [e.key, e])),
  events: Object.fromEntries((content.dungeonEvents ?? []).map((e) => [e.key, e])),
  rewardTables,
};
const dungeonCatalogue = dungeonCatalogueFromContent(content);
const AGGRESSIVE = PLAYTHROUGH_POLICIES.find((p) => p.key === 'aggressive')!;
const CAUTIOUS = PLAYTHROUGH_POLICIES.find((p) => p.key === 'cautious')!;

// ── measurement ─────────────────────────────────────────────────────────────

const fights = Number(arg('fights') ?? 1000);
const runs = Number(arg('runs') ?? 1000);
const spValues = (arg('sp') ?? '185,240,300,380').split(',').map((v) => Number(v.trim()));
const section = arg('section') ?? 'all';
const auto = { player: basicAttackController, enemy: basicAttackController };

interface Fighter {
  attack: number;
  defense: number;
  maxHp: number;
  modifiers: CombatModifiers;
}

function fighterOf(sp: number, tier: Tier, build: Build): Fighter {
  return {
    attack: deriveStat(sp, tier.attackBp),
    defense: deriveStat(sp, tier.defenseBp),
    maxHp: deriveStat(sp, tier.healthBp),
    modifiers: aggregateCombatBonuses(build.items.map((combatBonuses) => ({ combatBonuses }))).modifiers,
  };
}

function trialReport(fighter: Fighter, trialIndex: number) {
  const { enemy } = trials[trialIndex]!;
  let wins = 0;
  let hpShareOnWin = 0;
  let rounds = 0;
  let strikes = 0;
  let normalStrikes = 0;
  let crits = 0;
  let bonusAttacks = 0;
  let healed = 0;
  for (let seed = 1; seed <= fights; seed += 1) {
    const state = createCombatState({ player: { id: 'buddy:1', name: 'Buddy', ...fighter }, enemy: enemyCombatantInput(enemy) });
    const result = simulateCombat(state, auto, { rng: seededRng(seed) });
    rounds += result.rounds;
    if (result.result === 'player_victory') {
      wins += 1;
      hpShareOnWin += result.finalState.player.currentHp / fighter.maxHp;
    }
    for (const e of result.events) {
      if (e.type === 'damage' && e.actor === 'player') {
        strikes += 1;
        if (!e.bonusAttack) normalStrikes += 1;
        if (e.critical) crits += 1;
      } else if (e.type === 'bonus_attack_triggered' && e.actor === 'player') bonusAttacks += 1;
      else if (e.type === 'lifesteal_heal' && e.actor === 'player') healed += e.amount;
    }
  }
  return {
    winRate: wins / fights,
    hpShareOnWin: wins ? hpShareOnWin / wins : null,
    rounds: rounds / fights,
    critRate: strikes ? crits / strikes : 0,
    doubleRate: normalStrikes ? bonusAttacks / normalStrikes : 0,
    bonusAttacksPerFight: bonusAttacks / fights,
    lifestealPerFight: healed / fights,
  };
}

function delveReport(fighter: Fighter) {
  const aggressive = simulateDungeonPlaythroughs(snapshot, dungeonCatalogue, fighter, { runs, policy: AGGRESSIVE });
  const cautious = simulateDungeonPlaythroughs(snapshot, dungeonCatalogue, fighter, { runs, policy: CAUTIOUS });
  return {
    firstExtractionReach: aggressive.firstExtractionReachRate,
    completion: aggressive.completionRate,
    averageDepth: aggressive.averageDepth,
    hpShareAtExit: aggressive.averageHpShareAtExit,
    roundsPerFight: aggressive.averageRoundsPerFight,
    lifestealPerFight: aggressive.averageLifestealPerFight,
    lifestealPerRun: aggressive.averageLifestealPerRun,
    cautiousExtraction: cautious.extractionRate,
    cautiousHpShareAtExit: cautious.averageHpShareAtExit,
    cautiousBanked: cautious.averageBanked,
  };
}

function row(sp: number, tier: Tier, build: Build) {
  const fighter = fighterOf(sp, tier, build);
  return {
    sp,
    tier: tier.key,
    build: build.key,
    group: build.group,
    impossible: build.impossible === true,
    fighter,
    modifiers: combatModifierRows(fighter.modifiers).map((r) => `${r.label} ${r.value}`).join(', ') || '—',
    trials: trials.map((_, i) => trialReport(fighter, i)),
    delve: delveReport(fighter),
  };
}

const tierOf = (key: Tier['key']) => TIERS.find((t) => t.key === key)!;
const buildOf = (key: string) => BUILDS.find((x) => x.key === key)!;

/** Baselines on their own tier (plus `none` on every tier); stacking and synergy on R and SR. */
function matrix(group: Build['group']) {
  const out = [];
  for (const sp of spValues) {
    for (const build of BUILDS.filter((x) => x.group === group)) {
      const tiers = group === 'baseline' ? (build.tier ? [tierOf(build.tier)] : TIERS) : [tierOf('r'), tierOf('sr')];
      for (const tier of tiers) out.push(row(sp, tier, build));
    }
  }
  return out;
}

/** The R → SR step, split into its primary and its bonus halves. */
function srVsR() {
  return spValues.flatMap((sp) => [
    { label: 'R primary, no bonus', ...row(sp, tierOf('r'), buildOf('none')) },
    { label: 'R primary + R bonuses', ...row(sp, tierOf('r'), buildOf('r_one_bonus')) },
    { label: 'SR primary, no bonus', ...row(sp, tierOf('sr'), buildOf('none')) },
    { label: 'SR primary + R bonuses', ...row(sp, tierOf('sr'), buildOf('r_one_bonus')) },
    { label: 'SR primary + SR typical', ...row(sp, tierOf('sr'), buildOf('sr_two_bonus')) },
    { label: 'SR primary + SR max', ...row(sp, tierOf('sr'), buildOf('sr_two_bonus_max')) },
  ]);
}

/** Armor Penetration's damage gain against shipped enemies at low, median and high DEF. */
function armorPenReport() {
  const byDef = [...(content.combatEnemies ?? [])].filter((e) => e.enabled).sort((x, y) => x.defense - y.defense);
  const picks = [byDef[0]!, byDef[Math.floor(byDef.length / 2)]!, byDef[byDef.length - 1]!];
  const attack = deriveStat(300, tierOf('r').attackBp);
  const pens = [
    b('armor_penetration_bp', 'N').valueBp,
    b('armor_penetration_bp', 'R').valueBp,
    b('armor_penetration_bp', 'SR', 'max').valueBp,
    2 * b('armor_penetration_bp', 'SR', 'max').valueBp,
    5_000,
  ];
  return picks.map((enemy) => ({
    enemy: enemy.key,
    defense: enemy.defense,
    base: basicAttackDamage(attack, enemy.defense),
    byPenetration: pens.map((pen) => {
      const eff = effectiveDefense(enemy.defense, pen);
      const damage = basicAttackDamage(attack, eff);
      return { penBp: pen, effectiveDefense: eff, damage, gain: damage / basicAttackDamage(attack, enemy.defense) - 1 };
    }),
  }));
}

// ── output ──────────────────────────────────────────────────────────────────

const want = (name: string) => section === 'all' || section === name;
const report = {
  zone: zone.key,
  fights,
  runs,
  trials: trials.map((t) => ({ key: t.trial.key, enemy: t.enemy.key, attack: t.enemy.attack, defense: t.enemy.defense, hp: t.enemy.hp })),
  baseline: want('baseline') ? matrix('baseline') : [],
  stacking: want('stacking') ? matrix('stacking') : [],
  synergy: want('synergy') ? matrix('synergy') : [],
  srVsR: want('srvsr') ? srVsR() : [],
  armorPenetration: want('armorpen') ? armorPenReport() : [],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (n: number | null, digits = 0) => (n == null ? '—' : `${(n * 100).toFixed(digits)}%`);
  type Row = ReturnType<typeof row> & { label?: string };
  const print = (title: string, rows: Row[]) => {
    if (rows.length === 0) return;
    console.log(`\n== ${title} ==`);
    console.log(
      `${'SP'.padStart(4)} ${'tier'.padEnd(8)}${'build'.padEnd(26)}${'ATK'.padStart(5)}${'DEF'.padStart(5)}${'HP'.padStart(6)}  ` +
        `${trials.map((_, i) => `T${i + 1} win`.padStart(7)).join('')}${`T${trials.length} hp`.padStart(7)}${'rnds'.padStart(6)}${'crit'.padStart(7)}${'dbl'.padStart(7)}${'ls/f'.padStart(7)}  ` +
        `${'reach'.padStart(6)}${'done'.padStart(6)}${'depth'.padStart(6)}${'hp@x'.padStart(6)}${'ls/f'.padStart(7)}${'ls/run'.padStart(8)}${'c.extr'.padStart(7)}${'c.hp'.padStart(6)}  modifiers`,
    );
    for (const r of rows) {
      const last = r.trials[r.trials.length - 1]!;
      console.log(
        `${String(r.sp).padStart(4)} ${r.tier.padEnd(8)}${`${r.label ?? r.build}${r.impossible ? '*' : ''}`.padEnd(26)}` +
          `${String(r.fighter.attack).padStart(5)}${String(r.fighter.defense).padStart(5)}${String(r.fighter.maxHp).padStart(6)}  ` +
          `${r.trials.map((t) => pct(t.winRate).padStart(7)).join('')}${pct(last.hpShareOnWin).padStart(7)}${last.rounds.toFixed(1).padStart(6)}` +
          `${pct(last.critRate, 1).padStart(7)}${pct(last.doubleRate, 1).padStart(7)}${last.lifestealPerFight.toFixed(1).padStart(7)}  ` +
          `${pct(r.delve.firstExtractionReach).padStart(6)}${pct(r.delve.completion).padStart(6)}${r.delve.averageDepth.toFixed(1).padStart(6)}${pct(r.delve.hpShareAtExit).padStart(6)}` +
          `${r.delve.lifestealPerFight.toFixed(1).padStart(7)}${r.delve.lifestealPerRun.toFixed(1).padStart(8)}${pct(r.delve.cautiousExtraction).padStart(7)}${pct(r.delve.cautiousHpShareAtExit).padStart(6)}  ${r.modifiers}`,
      );
    }
  };
  console.log(`Combat bonus simulation — ${fights} seeded fights per Trial cell, ${runs} Delve runs per cell (${zone.key})`);
  console.log(`Trials: ${report.trials.map((t, i) => `T${i + 1} ${t.enemy} (ATK ${t.attack} DEF ${t.defense} HP ${t.hp})`).join(' · ')}`);
  console.log('Trial columns: win rate per Trial; then for the last Trial — HP left on a win, rounds, observed Crit and Double Attack rate, Lifesteal HP per fight.');
  console.log('Delve columns (never extracts): first-extraction reach, completion, depth, HP at exit, Lifesteal HP per fight and per run; then "extracts at ≤50% HP": extraction rate and HP at exit.');
  console.log('* = cannot drop under the shipped slot eligibility; simulated to find the ceiling.');
  print('Baselines', report.baseline);
  print('Stacking (three items, one family)', report.stacking);
  print('Synergy', report.synergy);
  print('R → SR: primary vs bonus', report.srVsR);
  if (report.armorPenetration.length > 0) {
    console.log('\n== Armor Penetration by enemy DEF (ATK = SP 300 on R gear) ==');
    for (const e of report.armorPenetration) {
      console.log(
        `${e.enemy.padEnd(26)} DEF ${String(e.defense).padStart(4)}  base ${String(e.base).padStart(4)}  ` +
          e.byPenetration.map((p) => `${(p.penBp / 100).toFixed(1)}% → effDEF ${p.effectiveDefense}, ${p.damage} (+${(p.gain * 100).toFixed(1)}%)`).join(' | '),
      );
    }
  }
}
