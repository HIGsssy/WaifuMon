/**
 * The Equipment summary and the surfaces that mention it — no database.
 *
 * `equipmentManagement.summary` is the read model behind Buddy inspect, the
 * Player Profile and the Care Mode Trainer Profile: a projection of
 * `calculateCombatStats` that copies the numbers verbatim and carries no
 * internal metadata. The Equipment home keeps the full `CombatStats` and gains
 * the active Buddy's artwork as a thumbnail. Real-database coverage, including
 * the four-surface consistency case, is `tests/integration/equipmentSurfaces`.
 */
import { describe, expect, it, vi } from 'vitest';
import { AttachmentBuilder } from 'discord.js';

vi.mock('../../src/discord/assets/attachRenderedCard', async (orig) => ({
  ...(await orig<typeof import('../../src/discord/assets/attachRenderedCard')>()),
  ownedArtworkImage: vi.fn(),
}));

import { ownedArtworkImage } from '../../src/discord/assets/attachRenderedCard';
import { handleEquipmentHome } from '../../src/discord/commands/waifumonEquipment';
import {
  buildEquipmentHome,
  summaryGearLines,
  summaryStatParts,
  type UnlockedEquipmentSummary,
} from '../../src/discord/equipmentPresenter';
import { buildTrainerProfileView, type TrainerProfileInput } from '../../src/discord/trainerProfile';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type { CareState } from '../../src/modules/care/careService';
import {
  createEquipmentManagementService,
  type EquipmentManagementDeps,
  type EquipmentManagementService,
} from '../../src/modules/equipment/equipmentManagementService';
import { assembleCombatStats, type CombatSlotItem, type CombatStats } from '../../src/modules/equipment/equipmentMath';
import { silentLogger } from '../helpers/testDb';

// ── fixtures ──────────────────────────────────────────────────────────────

const item = (equipmentId: number, name: string, multiplierBp: number): CombatSlotItem => ({
  equipmentId,
  definitionKey: name.toLowerCase().replace(/ /g, '_'),
  name,
  definitionName: name,
  affixKey: null,
  rarity: 'SR',
  multiplierBp,
  combatBonuses: [],
  rolledProperties: { secret: 'roll' },
});

const BUDDY = { waifuId: 9, speciesSlug: 'alley_catgirl', name: 'Warband Princess', level: 1, baseSp: 420, currentSp: 420 };

/** Current SP 420 with ×0.80 / ×0.55 / ×3.20 → ATK 336, DEF 231, HP 1344. */
function stats(opts: { buddy?: boolean; health?: boolean } = {}): CombatStats {
  return assembleCombatStats({
    buddy: opts.buddy === false ? null : BUDDY,
    loadoutId: 3,
    slots: {
      attack: item(101, 'Plasma Coil Ring', 8_000),
      defense: item(102, 'Reinforced Battle Belt', 5_500),
      health: opts.health === false ? null : item(103, 'Tactical Corset', 32_000),
    },
  });
}

function management(opts: { unlocked?: boolean; stats?: CombatStats } = {}) {
  const deps = {
    equipment: {},
    combatStats: { calculateCombatStats: vi.fn(async () => opts.stats ?? stats()), previewSlot: vi.fn() },
    featureUnlocks: { isUnlocked: vi.fn(async () => opts.unlocked !== false) },
  } as unknown as EquipmentManagementDeps;
  return { service: createEquipmentManagementService(deps), deps };
}

async function unlockedSummary(s: CombatStats = stats()): Promise<UnlockedEquipmentSummary> {
  const summary = await management({ stats: s }).service.summary(1);
  if (!summary.unlocked) throw new Error('expected unlocked');
  return summary;
}

// ── the read model ────────────────────────────────────────────────────────

describe('equipmentManagement.summary', () => {
  it('is { unlocked: false } for a locked player, without calculating anything', async () => {
    const { service, deps } = management({ unlocked: false });
    await expect(service.summary(1)).resolves.toEqual({ unlocked: false });
    expect(deps.combatStats.calculateCombatStats).not.toHaveBeenCalled();
  });

  it('copies the combat-stat numbers verbatim', async () => {
    const source = stats();
    const summary = await unlockedSummary(source);
    expect(summary.stats).toEqual(source.stats);
    expect(summary.stats).toEqual({ attack: 336, defense: 231, maxHp: 1344 });
    expect(summary.isComplete).toBe(true);
  });

  it('carries display data only — no instance ids, keys, multipliers or rolls', async () => {
    const summary = await unlockedSummary();
    expect(summary.buddy).toEqual({ waifuId: 9, name: 'Warband Princess' });
    expect(summary.slots).toEqual({
      attack: { name: 'Plasma Coil Ring', rarity: 'SR' },
      defense: { name: 'Reinforced Battle Belt', rarity: 'SR' },
      health: { name: 'Tactical Corset', rarity: 'SR' },
    });
    const json = JSON.stringify(summary);
    for (const leak of ['equipmentId', 'definitionKey', 'multiplierBp', 'rolledProperties', 'secret', 'loadoutId', '101']) {
      expect(json).not.toContain(leak);
    }
  });

  it('reports empty slots and a missing Buddy as null, not zero', async () => {
    const partial = await unlockedSummary(stats({ health: false }));
    expect(partial.slots.health).toBeNull();
    expect(partial.stats.maxHp).toBeNull();
    expect(partial.isComplete).toBe(false);
    const noBuddy = await unlockedSummary(stats({ buddy: false }));
    expect(noBuddy.buddy).toBeNull();
    expect(noBuddy.stats).toEqual({ attack: null, defense: null, maxHp: null });
  });

  it('re-reads on every call', async () => {
    const { service, deps } = management();
    await service.summary(1);
    await service.summary(1);
    expect(deps.combatStats.calculateCombatStats).toHaveBeenCalledTimes(2);
  });
});

describe('summary lines', () => {
  it('formats gear and stats, with — for anything unavailable', async () => {
    const full = await unlockedSummary();
    expect(summaryGearLines(full)).toEqual(['⚔️ Plasma Coil Ring', '🛡️ Reinforced Battle Belt', '❤️ Tactical Corset']);
    expect(summaryGearLines(full, { labelled: true })[0]).toBe('Attack: Plasma Coil Ring');
    expect(summaryStatParts(full)).toEqual(['ATK 336', 'DEF 231', 'HP 1344']);
    const partial = await unlockedSummary(stats({ health: false }));
    expect(summaryGearLines(partial)[2]).toBe('❤️ —');
    expect(summaryStatParts(partial)[2]).toBe('HP —');
  });
});

// ── Equipment home ────────────────────────────────────────────────────────

const ART = { file: new AttachmentBuilder(Buffer.from('x'), { name: 'card.webp' }), url: 'attachment://card.webp' };
type Json = { thumbnail?: { url: string }; fields?: { name: string; value: string }[] };
const embedJson = (p: { readonly embeds?: readonly unknown[] | undefined }) => (p.embeds![0] as { toJSON(): Json }).toJSON();

describe('buildEquipmentHome artwork', () => {
  it('shows the artwork as a thumbnail and attaches it', () => {
    const payload = buildEquipmentHome(stats(), null, ART);
    expect(embedJson(payload).thumbnail?.url).toBe('attachment://card.webp');
    expect(payload.files).toEqual([ART.file]);
  });

  it('drops the artwork without a Buddy', () => {
    const payload = buildEquipmentHome(stats({ buddy: false }), null, ART);
    expect(embedJson(payload).thumbnail).toBeUndefined();
    expect(payload.files).toEqual([]);
  });

  it('is unchanged text-only when no artwork could be drawn', () => {
    const payload = buildEquipmentHome(stats(), null, null);
    expect(embedJson(payload).thumbnail).toBeUndefined();
    expect(payload.files).toEqual([]);
    expect(embedJson(payload).fields?.find((f) => f.name === 'Combat Stats')?.value).toBe(
      'ATK **336** · DEF **231** · HP **1344**',
    );
  });
});

describe('handleEquipmentHome artwork', () => {
  const prov = { playerId: 1 } as Provisioned;
  const entry = (id: number) => ({ waifu: { id, level: 1, variant: 'standard' }, species: { slug: 'alley_catgirl' } });

  function run(getBuddy: () => Promise<unknown>, s: CombatStats = stats()) {
    const painted: { embeds?: unknown[]; files?: unknown[] }[] = [];
    const i = { replied: false, deferred: false, isButton: () => true, update: vi.fn(async (b: never) => void painted.push(b)) };
    const svc = { home: vi.fn(async () => ({ stats: s })) } as unknown as EquipmentManagementService;
    const ctx = {
      config: { assetsDir: './assets' },
      logger: silentLogger(),
      services: { equipmentManagement: svc, collection: { getBuddy: vi.fn(getBuddy) } },
    } as unknown as AppContext;
    return { painted, done: handleEquipmentHome(ctx, i as never, prov), ctx };
  }

  it('reuses ownedArtworkImage for the Buddy the stats were calculated for', async () => {
    vi.mocked(ownedArtworkImage).mockReset().mockReturnValue(ART);
    const { painted, done, ctx } = run(async () => entry(9));
    await done;
    expect(ownedArtworkImage).toHaveBeenCalledWith(ctx, entry(9));
    expect(embedJson(painted[0]!).thumbnail?.url).toBe(ART.url);
  });

  it('shows no picture when the Buddy changed between the reads', async () => {
    vi.mocked(ownedArtworkImage).mockReset().mockReturnValue(ART);
    const { painted, done } = run(async () => entry(10));
    await done;
    expect(ownedArtworkImage).not.toHaveBeenCalled();
    expect(embedJson(painted[0]!).thumbnail).toBeUndefined();
  });

  it('never asks for a picture without a Buddy, and survives a failed lookup', async () => {
    vi.mocked(ownedArtworkImage).mockReset().mockReturnValue(ART);
    const none = run(async () => entry(9), stats({ buddy: false }));
    await none.done;
    expect(ownedArtworkImage).not.toHaveBeenCalled();
    const failing = run(async () => {
      throw new Error('db down');
    });
    await failing.done;
    expect(embedJson(failing.painted[0]!).fields?.[0]?.value).toContain('Warband Princess');
    expect(failing.painted[0]!.files).toEqual([]);
  });
});

// ── Trainer Profile view ──────────────────────────────────────────────────

function careState(targetId: number | null): CareState {
  return {
    active: true,
    nextTickAt: null,
    target:
      targetId == null
        ? null
        : { waifu: { id: targetId, nickname: null, level: 1, affection: 0, baseSp: 420 }, species: { name: 'Luna', rarity: 'SR', affinity: 'dominant' } },
    energyPerTick: 1,
    waifuXpPerTick: 2,
    affectionPerTick: 1,
    effectiveEnergyCap: 20,
    currentEnergy: 1,
  } as unknown as CareState;
}

function trainerFields(equipment: UnlockedEquipmentSummary | null, targetId: number | null = 9) {
  const view = buildTrainerProfileView({
    playerName: 'Whistler',
    player: { level: 3, createdAt: new Date('2026-01-01') } as TrainerProfileInput['player'],
    currencies: { huntEnergy: 1, waifubux: 0, essence: 0 },
    careState: careState(targetId),
    collectionProgress: { owned: 1, distinctSpecies: 1, totalSpecies: 10 } as TrainerProfileInput['collectionProgress'],
    maxEnergy: 25,
    prestigeTitle: null,
    equipment,
  });
  return new Map((view.embeds[0]!.toJSON().fields ?? []).map((f) => [f.name, f.value]));
}

describe('buildTrainerProfileView equipment panel', () => {
  it('shows gear and the summary’s numbers when caring for the Buddy', async () => {
    expect(trainerFields(await unlockedSummary()).get('⚔️ Equipment')).toBe(
      '⚔️ Plasma Coil Ring\n🛡️ Reinforced Battle Belt\n❤️ Tactical Corset\nATK 336 · DEF 231 · HP 1344',
    );
  });

  it('says whose stats they are when the care target is someone else', async () => {
    const value = trainerFields(await unlockedSummary(), 77).get('⚔️ Equipment')!;
    // The attribution sits on the line immediately above the numbers.
    expect(value.split('\n').slice(-2)).toEqual([
      'Stats for active Buddy **Warband Princess**:',
      'ATK 336 · DEF 231 · HP 1344',
    ]);
    // …and never appears when caring for the Buddy herself.
    expect(trainerFields(await unlockedSummary(), 9).get('⚔️ Equipment')).not.toContain('Stats for');
  });

  it('renders — for an empty slot and omits stats without a Buddy', async () => {
    expect(trainerFields(await unlockedSummary(stats({ health: false }))).get('⚔️ Equipment')).toContain('❤️ —\nATK 336 · DEF 231 · HP —');
    expect(trainerFields(await unlockedSummary(stats({ buddy: false })), null).get('⚔️ Equipment')).toBe(
      '⚔️ Plasma Coil Ring\n🛡️ Reinforced Battle Belt\n❤️ Tactical Corset',
    );
  });

  it('is the pre-Equipment profile when the feature is locked', () => {
    const fields = trainerFields(null);
    expect(fields.has('⚔️ Equipment')).toBe(false);
    expect([...fields.keys()]).toEqual(['👤 Trainer', '⭐ Buddy', '🎒 Collection', '💗 Activity']);
  });
});
