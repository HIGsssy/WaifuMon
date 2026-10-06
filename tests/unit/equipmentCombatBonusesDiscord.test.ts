/**
 * Combat bonuses on Discord — what the presenters show, with no database: a
 * copy's own bonus rows (none, one, two), the loadout's cumulative totals,
 * the side-by-side comparison, a fabricated item, a drop line, and the Trial
 * screens. Delve's screens are covered against a real run in
 * `tests/integration/dungeonCombatModifiers.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFightResult,
  buildTrialDetail,
  combatBonusTotalsLine,
  modifiersLine,
  summarizeCombatEvents,
} from '../../src/discord/combatTrialPresenter';
import { rewardLines as dungeonRewardLines } from '../../src/discord/dungeonPresenter';
import {
  buildEquipmentHome,
  buildGearBag,
  buildItemDetail,
  buildSlotScreen,
  combatBonusLines,
  combatModifiersField,
  formatEquipmentDrop,
} from '../../src/discord/equipmentPresenter';
import { buildDismantleReview, buildFabricationResult } from '../../src/discord/workshopPresenter';
import { basicAttackController } from '../../src/modules/combat/combatController';
import { ZERO_COMBAT_MODIFIERS } from '../../src/modules/combat/combatMath';
import { simulateCombat } from '../../src/modules/combat/combatSimulator';
import { createCombatState } from '../../src/modules/combat/combatState';
import type { CombatModifiers } from '../../src/modules/combat/combatTypes';
import { CombatEnemyDefinitionSchema } from '../../src/modules/combat/enemyDefinitions';
import { CombatTrialDefinitionSchema } from '../../src/modules/combat/trialDefinitions';
import type { CombatTrialAttemptView, CombatTrialDetailView } from '../../src/modules/combatTrials/combatTrialService';
import type { CombatBonus } from '../../src/modules/equipment/combatBonuses';
import type { BagView, ItemView, SlotView } from '../../src/modules/equipment/equipmentManagementService';
import { assembleCombatStats, type CombatSlotItem } from '../../src/modules/equipment/equipmentMath';
import type { EquipmentDefinitionView, EquipmentInstanceView } from '../../src/modules/equipment/equipmentQueries';
import type { EquipmentGroup } from '../../src/modules/equipment/equipmentService';
import type { DismantlePreview, FabricationOutcome } from '../../src/modules/equipment/equipmentWorkshopService';
import type { EquipmentSlot } from '../../src/modules/equipment/vocabulary';
import { seededRng } from '../../src/shared/random';

// ── fixtures ──────────────────────────────────────────────────────────────

const def = (name: string, slot: EquipmentSlot, rarity: string, bp: number): EquipmentDefinitionView => ({
  key: name.toLowerCase().replace(/ /g, '_'),
  name,
  description: '',
  slot,
  rarity,
  multiplierMinBp: bp,
  multiplierMaxBp: bp,
  multiplierStepBp: 100,
  tags: [],
  regionId: null,
  artworkPath: null,
  enabled: true,
});

const BATON = def('Stun Baton', 'attack', 'N', 6_500);
const KNIFE = def('Combat Knife', 'attack', 'R', 8_000);
const RAIL = def('Railcarbine', 'attack', 'SR', 11_500);
const VEST = def('Kevlar Carrier', 'defense', 'R', 7_000);
const BOX = def('Dented Lunchbox', 'health', 'N', 20_000);

const CRIT_425: CombatBonus[] = [{ stat: 'crit_chance_bp', valueBp: 425 }];
const RAIL_BONUSES: CombatBonus[] = [
  { stat: 'crit_chance_bp', valueBp: 650 },
  { stat: 'double_attack_chance_bp', valueBp: 425 },
];

const instance = (id: number, d: EquipmentDefinitionView, combatBonuses: CombatBonus[] = [], over: Partial<EquipmentInstanceView> = {}): EquipmentInstanceView =>
  ({
    id,
    slot: d.slot,
    definition: d,
    rolledMultiplierBp: d.multiplierMinBp,
    affixKey: null,
    displayName: d.name,
    combatBonuses,
    rolledProperties: {},
    isFavorite: false,
    isLocked: false,
    sourceType: 'dungeon',
    sourceKey: null,
    acquiredAt: new Date(0),
    equipped: false,
    ...over,
  }) as EquipmentInstanceView;

const group = (id: number, d: EquipmentDefinitionView, combatBonuses: CombatBonus[] = []): EquipmentGroup => ({
  definition: d,
  rolledMultiplierBp: d.multiplierMinBp,
  affixKey: null,
  combatBonuses,
  displayName: d.name,
  count: 1,
  equippedCount: 0,
  favoriteCount: 0,
  lockedCount: 0,
  representativeId: id,
  instanceIds: [id],
});

const slotItem = (id: number, d: EquipmentDefinitionView, combatBonuses: CombatBonus[] = []): CombatSlotItem => ({
  equipmentId: id,
  definitionKey: d.key,
  name: d.name,
  definitionName: d.name,
  affixKey: null,
  rarity: d.rarity,
  multiplierBp: d.multiplierMinBp,
  combatBonuses,
  rolledProperties: {},
});

const BUDDY = { waifuId: 9, speciesSlug: 'wp', name: 'Warband Princess', level: 35, baseSp: 100, currentSp: 185 };
const stats = (attack: CombatBonus[] = [], defense: CombatBonus[] = [], health: CombatBonus[] = []) =>
  assembleCombatStats({
    buddy: BUDDY,
    loadoutId: 1,
    slots: { attack: slotItem(1, RAIL, attack), defense: slotItem(2, VEST, defense), health: slotItem(3, BOX, health) },
  });

type Field = { name: string; value: string; inline?: boolean };
type Json = { title?: string; description?: string; fields?: Field[] };
const embedOf = (payload: { embeds?: readonly unknown[] | undefined }): Json => {
  const embed = payload.embeds![0] as { toJSON?: () => Json };
  return embed.toJSON ? embed.toJSON() : (embed as Json);
};
const fieldOf = (payload: { embeds?: readonly unknown[] | undefined }, name: string) => embedOf(payload).fields?.find((f) => f.name === name);
const textOf = (payload: { embeds?: readonly unknown[] | undefined }) => JSON.stringify(embedOf(payload));

// ── shared formatters ─────────────────────────────────────────────────────

describe('bonus formatters', () => {
  it('lists a copy’s bonuses one per line, and nothing for none', () => {
    expect(combatBonusLines([])).toEqual([]);
    expect(combatBonusLines(undefined)).toEqual([]);
    expect(combatBonusLines(CRIT_425)).toEqual(['+4.25% Crit Chance']);
    expect(combatBonusLines(RAIL_BONUSES)).toEqual(['+6.5% Crit Chance', '+4.25% Double Attack']);
  });

  it('a drop line appends the bonuses and never a key or basis points', () => {
    expect(formatEquipmentDrop({ displayName: 'Stun Baton', slot: 'attack', rolledMultiplierBp: 6_500 })).toBe('⚔️ **Stun Baton** · ATK ×0.65');
    expect(formatEquipmentDrop({ displayName: 'Stun Baton', slot: 'attack', rolledMultiplierBp: 6_500, combatBonuses: [] })).toBe('⚔️ **Stun Baton** · ATK ×0.65');
    const line = formatEquipmentDrop({ displayName: 'Railcarbine', slot: 'attack', rolledMultiplierBp: 11_500, combatBonuses: RAIL_BONUSES });
    expect(line).toBe('⚔️ **Railcarbine** · ATK ×1.15 · +6.5% Crit Chance · +4.25% Double Attack');
    expect(line).not.toMatch(/_bp|650|425(?!%)/);
  });

  it('the totals field omits zero rows and is absent when everything is zero', () => {
    expect(combatModifiersField(ZERO_COMBAT_MODIFIERS)).toBeNull();
    expect(combatModifiersField(undefined)).toBeNull();
    expect(combatModifiersField({ ...ZERO_COMBAT_MODIFIERS, critChanceBp: 975, lifestealBp: 250 })).toEqual({
      name: 'Combat Bonuses',
      value: 'Crit: **9.75%** · Lifesteal: **2.5%**',
    });
  });
});

// ── Gear Bag ──────────────────────────────────────────────────────────────

describe('Gear Bag', () => {
  const bag = (...groups: EquipmentGroup[]): BagView => ({
    filter: 'all',
    entries: { items: groups.map((g) => ({ group: g, focusId: g.representativeId })), page: 0, totalPages: 1, totalItems: groups.length },
  });

  it('an N copy without a bonus shows its multiplier and nothing else', () => {
    const description = embedOf(buildGearBag(bag(group(1, BATON)))).description!;
    expect(description).toBe('**Stun Baton** ×1\nN • Attack • ×0.65');
    expect(description).not.toMatch(/bonus/i);
  });

  it('an R copy shows its one bonus under the multiplier', () => {
    expect(embedOf(buildGearBag(bag(group(2, KNIFE, CRIT_425)))).description).toBe('**Combat Knife** ×1\nR • Attack • ×0.80\n+4.25% Crit Chance');
  });

  it('an SR copy shows both bonus rows', () => {
    expect(embedOf(buildGearBag(bag(group(3, RAIL, RAIL_BONUSES)))).description).toBe(
      '**Railcarbine** ×1\nSR • Attack • ×1.15\n+6.5% Crit Chance\n+4.25% Double Attack',
    );
  });

  it('keeps each copy’s bonuses with its own entry', () => {
    const description = embedOf(buildGearBag(bag(group(1, BATON), group(2, KNIFE, CRIT_425), group(3, RAIL, RAIL_BONUSES)))).description!;
    expect(description.split('\n\n')).toEqual([
      '**Stun Baton** ×1\nN • Attack • ×0.65',
      '**Combat Knife** ×1\nR • Attack • ×0.80\n+4.25% Crit Chance',
      '**Railcarbine** ×1\nSR • Attack • ×1.15\n+6.5% Crit Chance\n+4.25% Double Attack',
    ]);
  });
});

// ── home / loadout totals ─────────────────────────────────────────────────

describe('Equipment home', () => {
  it('shows cumulative totals and each equipped item’s own bonuses', () => {
    const payload = buildEquipmentHome(
      stats(
        [{ stat: 'crit_chance_bp', valueBp: 325 }, { stat: 'crit_damage_bonus_bp', valueBp: 1_750 }],
        [{ stat: 'crit_chance_bp', valueBp: 200 }, { stat: 'armor_penetration_bp', valueBp: 600 }],
        [{ stat: 'crit_chance_bp', valueBp: 450 }, { stat: 'lifesteal_bp', valueBp: 250 }],
      ),
    );
    // Crit DMG is the total multiplier: 150% base + 17.5%.
    expect(fieldOf(payload, 'Combat Bonuses')!.value).toBe('Crit: **9.75%** · Crit DMG: **167.5%** · Armor Pen: **6%** · Lifesteal: **2.5%**');
    expect(fieldOf(payload, '⚔️ Attack')!.value).toBe('Railcarbine\n×1.15\n+3.25% Crit Chance\n+17.5% Crit Damage');
    expect(fieldOf(payload, '❤️ Health')!.value).toBe('Dented Lunchbox\n×2.00\n+4.5% Crit Chance\n+2.5% Lifesteal');
  });

  it('shows no totals field for a loadout with no bonuses', () => {
    const payload = buildEquipmentHome(stats());
    expect(fieldOf(payload, 'Combat Bonuses')).toBeUndefined();
    expect(fieldOf(payload, '⚔️ Attack')!.value).toBe('Railcarbine\n×1.15');
  });
});

// ── item detail and comparison ────────────────────────────────────────────

describe('item detail', () => {
  const item = (viewed: EquipmentInstanceView, equipped: EquipmentInstanceView | null): ItemView => ({
    instance: viewed,
    copies: [viewed.id],
    equippedCopies: viewed.equipped ? 1 : 0,
    slotEquipped: equipped,
    current: 213,
    preview: { equipmentId: viewed.id, available: true, value: 148, delta: -65 },
    stats: stats(),
  });

  it('lists the copy’s 0–2 rolled bonuses', () => {
    const none = buildItemDetail(item(instance(1, BATON), null), { kind: 'home' });
    expect(fieldOf(none, 'Combat Bonuses')).toBeUndefined();
    const one = buildItemDetail(item(instance(2, KNIFE, CRIT_425), null), { kind: 'home' });
    expect(fieldOf(one, 'Combat Bonuses')!.value).toBe('+4.25% Crit Chance');
    const two = buildItemDetail(item(instance(3, RAIL, RAIL_BONUSES), null), { kind: 'home' });
    expect(fieldOf(two, 'Combat Bonuses')!.value).toBe('+6.5% Crit Chance\n+4.25% Double Attack');
    expect(embedOf(two).description).toContain('ATK ×1.15');
  });

  it('compares secondary bonuses side by side, without scoring them', () => {
    const current = instance(10, RAIL, [{ stat: 'crit_chance_bp', valueBp: 500 }], { equipped: true });
    const candidate = instance(11, KNIFE, [
      { stat: 'armor_penetration_bp', valueBp: 750 },
      { stat: 'lifesteal_bp', valueBp: 400 },
    ]);
    const payload = buildItemDetail(item(candidate, current), { kind: 'home' });
    expect(fieldOf(payload, 'Equipped: Railcarbine')).toMatchObject({ value: 'ATK ×1.15\n+5% Crit Chance', inline: true });
    expect(fieldOf(payload, 'This item')).toMatchObject({ value: 'ATK ×0.80\n+7.5% Armor Pen\n+4% Lifesteal', inline: true });
    // The primary stat still gets its own numeric comparison…
    expect(fieldOf(payload, 'Comparison')!.value).toContain('Difference: -65');
    // …but nothing calls one set of bonuses better or reduces the item to a score.
    expect(textOf(payload)).not.toMatch(/better|worse|upgrade|downgrade|gear score|score/i);
  });

  it('shows the comparison when only one side has bonuses, and omits it when neither does', () => {
    const plain = instance(10, RAIL, [], { equipped: true });
    const withBonus = buildItemDetail(item(instance(11, KNIFE, CRIT_425), plain), { kind: 'home' });
    expect(fieldOf(withBonus, 'Equipped: Railcarbine')!.value).toBe('ATK ×1.15');
    expect(fieldOf(withBonus, 'This item')!.value).toBe('ATK ×0.80\n+4.25% Crit Chance');
    const neither = buildItemDetail(item(instance(12, BATON), plain), { kind: 'home' });
    expect(fieldOf(neither, 'This item')).toBeUndefined();
  });

  it('the slot screen shows the equipped copy’s and each candidate’s bonuses', () => {
    const view: SlotView = {
      slot: 'attack',
      stats: stats(RAIL_BONUSES),
      equipped: instance(1, RAIL, RAIL_BONUSES, { equipped: true }),
      current: 213,
      candidates: {
        items: [
          { group: group(2, KNIFE, CRIT_425), equipmentId: 2, preview: { equipmentId: 2, available: true, value: 148, delta: -65 } },
          { group: group(3, BATON), equipmentId: 3, preview: { equipmentId: 3, available: true, value: 120, delta: -93 } },
        ],
        page: 0,
        totalPages: 1,
        totalItems: 2,
      },
    };
    const payload = buildSlotScreen(view);
    expect(fieldOf(payload, 'Currently Equipped')!.value).toBe(
      '**Railcarbine**\nATK ×1.15\n+6.5% Crit Chance\n+4.25% Double Attack\nCurrent ATK: **213**',
    );
    expect(fieldOf(payload, 'Combat Knife')!.value).toBe('ATK ×0.80\n+4.25% Crit Chance\nWould give: **148 ATK** (-65)');
    expect(fieldOf(payload, 'Stun Baton')!.value).toBe('ATK ×0.65\nWould give: **120 ATK** (-93)');
  });
});

// ── Workshop ──────────────────────────────────────────────────────────────

describe('Workshop', () => {
  const fabrication = (combatBonuses: CombatBonus[]): FabricationOutcome => ({
    replayed: false,
    recipe: { key: 'advanced_rebuild', name: 'Advanced Rebuild', rarity: 'SR' },
    slotChoice: 'attack',
    cost: { components: 40, waifubux: 2_000 },
    item: {
      equipmentId: 77,
      displayName: 'Railcarbine of Bad Decisions',
      name: 'Railcarbine',
      slot: 'attack',
      rarity: 'SR',
      rolledMultiplierBp: 11_500,
      affixSuffix: 'of Bad Decisions',
      combatBonuses,
    },
    balances: { components: 3, waifubux: 3_500 },
  });

  it('a fabricated item shows the bonuses it rolled beside its multiplier and affix', () => {
    const payload = buildFabricationResult(fabrication(RAIL_BONUSES), null, true);
    expect(fieldOf(payload, 'Multiplier')!.value).toBe('ATK ×1.15');
    expect(fieldOf(payload, 'Affix')!.value).toBe('of Bad Decisions');
    expect(fieldOf(payload, 'Combat Bonuses')!.value).toBe('+6.5% Crit Chance\n+4.25% Double Attack');
  });

  it('a fabricated item with no bonus shows no bonus field', () => {
    expect(fieldOf(buildFabricationResult(fabrication([]), null, true), 'Combat Bonuses')).toBeUndefined();
  });

  it('the dismantle review shows what each selected copy carries', () => {
    const preview: DismantlePreview = {
      count: 2,
      byRarity: [{ rarity: 'R', count: 2, components: 8 }],
      totalComponents: 8,
      items: [
        { equipmentId: 1, displayName: 'Combat Knife', rarity: 'R', slot: 'attack', rolledMultiplierBp: 8_000, combatBonuses: CRIT_425, components: 4 },
        { equipmentId: 2, displayName: 'Kevlar Carrier', rarity: 'R', slot: 'defense', rolledMultiplierBp: 7_000, combatBonuses: [], components: 4 },
      ],
      balances: { components: 10, waifubux: 100 },
      componentsAfter: 18,
    };
    const selected = fieldOf(buildDismantleReview(preview, [1, 2], 0, 'nonce', null), 'Selected')!.value;
    expect(selected.split('\n')).toEqual(['⚔️ Combat Knife · R · ATK ×0.80 · +4.25% Crit Chance', '🛡️ Kevlar Carrier · R · DEF ×0.70']);
  });
});

// ── Dungeon drop ──────────────────────────────────────────────────────────

describe('Dungeon drop line', () => {
  const drop = (combatBonuses?: CombatBonus[]) => ({
    rewardIndex: 0,
    equipmentId: 5,
    definitionKey: 'combat_knife',
    displayName: 'Combat Knife of Mild Regret',
    slot: 'attack' as const,
    rarity: 'R',
    rolledMultiplierBp: 8_000,
    ...(combatBonuses ? { combatBonuses } : {}),
  });

  it('shows the dropped item’s bonuses', () => {
    const lines = dungeonRewardLines({ currency: 0, waifubux: 0, items: [], equipment: [drop(CRIT_425)] }, null, (s) => s);
    expect(lines).toEqual(['⚔️ **Combat Knife of Mild Regret** (R) · +4.25% Crit Chance — secured']);
  });

  it('a drop recorded before bonuses existed renders as it always did', () => {
    const lines = dungeonRewardLines({ currency: 0, waifubux: 0, items: [], equipment: [drop()] }, null, (s) => s);
    expect(lines).toEqual(['⚔️ **Combat Knife of Mild Regret** (R) — secured']);
  });
});

// ── Combat Trials ─────────────────────────────────────────────────────────

describe('Combat Trials', () => {
  const MODS: CombatModifiers = { critChanceBp: 2_500, critDamageBonusBp: 1_750, doubleAttackChanceBp: 2_000, armorPenetrationBp: 600, lifestealBp: 1_000 };
  const enemy = CombatEnemyDefinitionSchema.parse({ key: 'drone', name: 'Drone', attack: 90, defense: 60, hp: 1_500, enabled: true });
  const trial = CombatTrialDefinitionSchema.parse({ key: 't1', name: 'Trial One', description: 'A test.', enabled: true, enemyKey: 'drone', order: 1 });

  it('the detail screen shows the loadout’s cumulative modifiers', () => {
    const view: CombatTrialDetailView = {
      trial,
      enemy,
      progress: { cleared: false, firstClearedAt: null, attempts: 0, latest: null },
      stats: stats(
        [{ stat: 'crit_chance_bp', valueBp: 325 }],
        [{ stat: 'crit_chance_bp', valueBp: 200 }],
        [{ stat: 'crit_chance_bp', valueBp: 450 }, { stat: 'lifesteal_bp', valueBp: 275 }],
      ),
      blocker: null,
    };
    const buddy = fieldOf(buildTrialDetail(view, 'nonce'), 'Your Buddy — Warband Princess')!.value;
    expect(buddy.split('\n').slice(0, 3)).toEqual(['Current SP **185**', 'ATK 213 · DEF 130 · HP 370', 'Crit 9.75% · Lifesteal 2.75%']);
  });

  it('the detail screen adds no modifier line when there are none', () => {
    const view: CombatTrialDetailView = {
      trial,
      enemy,
      progress: { cleared: false, firstClearedAt: null, attempts: 0, latest: null },
      stats: stats(),
      blocker: null,
    };
    const buddy = fieldOf(buildTrialDetail(view, 'nonce'), 'Your Buddy — Warband Princess')!.value;
    expect(buddy.split('\n')[2]).toMatch(/^⚔️/);
    expect(modifiersLine(ZERO_COMBAT_MODIFIERS)).toBeNull();
  });

  function attempt(modifiers: CombatModifiers): CombatTrialAttemptView {
    const state = createCombatState({
      player: { id: 'buddy:9', name: 'Warband Princess', attack: 213, defense: 130, maxHp: 480, modifiers },
      enemy: { id: 'enemy:drone', name: 'Drone', attack: enemy.attack, defense: enemy.defense, maxHp: enemy.hp },
    });
    const result = simulateCombat(state, { player: basicAttackController, enemy: basicAttackController }, { rng: seededRng(3) });
    return {
      id: 1,
      trialKey: 't1',
      enemyKey: 'drone',
      result: result.result,
      endReason: result.reason,
      rounds: result.rounds,
      actions: result.actions,
      buddyWaifuId: 9,
      player: { name: 'Warband Princess', attack: 213, defense: 130, maxHp: 480, remainingHp: result.finalState.player.currentHp, modifiers },
      enemy: { name: 'Drone', attack: enemy.attack, defense: enemy.defense, maxHp: enemy.hp, remainingHp: result.finalState.enemy.currentHp, modifiers: { ...ZERO_COMBAT_MODIFIERS } },
      firstClear: false,
      rewards: null,
      events: result.events,
      combatSeed: 3,
      startedAt: new Date(0),
      completedAt: new Date(0),
    };
  }

  it('the result shows the modifiers the attempt was fought with, and what they did', () => {
    const a = attempt(MODS);
    const payload = buildFightResult({ attempt: a, replayed: false, trial }, { againNonce: 'n', itemName: (s) => s });
    expect(embedOf(payload).description).toContain('Crit 25% · Crit DMG 167.5% · Double 20% · Armor Pen 6% · Lifesteal 10%');
    const summary = fieldOf(payload, 'Combat summary')!.value;
    const totals = combatBonusTotalsLine(a.events, 'Warband Princess')!;
    expect(totals).toMatch(/^✨ Warband Princess: Crits \d+ · Bonus attacks \d+ · Lifesteal \+\d+ HP$/);
    expect(summary.split('\n').at(-1)).toBe(totals);
    expect(summarizeCombatEvents(a.events).some((l) => l.includes('**crits**') || l.includes('bonus attack'))).toBe(true);
  });

  it('a fight without modifiers reads exactly as before', () => {
    const a = attempt({ ...ZERO_COMBAT_MODIFIERS });
    const payload = buildFightResult({ attempt: a, replayed: false, trial }, { againNonce: 'n', itemName: (s) => s });
    expect(embedOf(payload).description).toBe(
      `**Warband Princess**\nHP: ${a.player.remainingHp} / 480\n\n**Drone**\nHP: ${a.enemy.remainingHp} / 1500\n\nRounds: ${a.rounds}`,
    );
    expect(combatBonusTotalsLine(a.events)).toBeNull();
    expect(fieldOf(payload, 'Combat summary')!.value).not.toMatch(/crits|bonus attack|Lifesteal/);
  });

  it('events recorded before modifiers existed still summarise', () => {
    const legacy = attempt({ ...ZERO_COMBAT_MODIFIERS }).events.map((e) => {
      if (e.type !== 'damage') return e;
      const { type, round, actor, target, amount, baseAmount, varianceBasisPoints, targetHpBefore, targetHpAfter } = e;
      return { type, round, actor, target, amount, baseAmount, varianceBasisPoints, targetHpBefore, targetHpAfter } as typeof e;
    });
    expect(summarizeCombatEvents(legacy)[0]).toMatch(/^R1 · Warband Princess hits Drone for \*\*\d+\*\* \(1500 → \d+\)$/);
  });
});
