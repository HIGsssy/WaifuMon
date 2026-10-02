/**
 * Equipment onboarding on Discord: the screens, the main-menu entry, and the
 * `onb:*` button handlers.
 *
 * The handlers are driven with a service double and a fake interaction. What
 * they must guarantee: nothing that matters comes from the custom id. It names
 * a flow and (for `adv`) a step; the player is always `prov.playerId`, and the
 * service recomputes state before acting. The transactional half — that a
 * stale or doubled step writes nothing — lives in
 * `tests/integration/equipmentOnboarding.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  equipmentLegendLine,
  equipmentMenuButton,
  menuComponents,
} from '../../src/discord/commands/waifumon';
import {
  handleOnboardingAdvance,
  handleOnboardingComplete,
  handleOnboardingOpen,
} from '../../src/discord/commands/waifumonOnboarding';
import {
  buildOnboardingView,
  explainLine,
  formatMultiplier,
  onboardingCustomId,
} from '../../src/discord/onboardingPresenter';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import { EQUIPMENT_HOME_TITLE, buildEquipmentHome, eqId } from '../../src/discord/equipmentPresenter';
import { handleEquipmentHome } from '../../src/discord/commands/waifumonEquipment';
import { assembleCombatStats, type CombatSlotItem } from '../../src/modules/equipment/equipmentMath';
import type { EquipmentEntryState } from '../../src/modules/onboarding/onboardingState';
import type {
  EquipmentOnboardingService,
  EquipmentOnboardingView,
} from '../../src/modules/onboarding/equipmentOnboardingService';
import { loadShippedContent } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

const shipped = loadShippedContent();
const CONTENT = {
  flow: shipped.onboarding!.equipment!,
  npc: shipped.npcs!.find((n) => n.key === 'patch')!,
};
const ctx = { config: { assetsDir: './assets' }, logger: silentLogger() } as unknown as AppContext;

const item = (equipmentId: number, definitionKey: string, name: string, multiplierBp: number): CombatSlotItem => ({
  equipmentId,
  definitionKey,
  name,
  definitionName: name,
  affixKey: null,
  rarity: 'N',
  multiplierBp,
  rolledProperties: {},
});
const STARTERS = {
  attack: item(1, 'rusty_pipe', 'Rusty Pipe', 4500),
  defense: item(2, 'scrap_plate', 'Scrap Plate', 3500),
  health: item(3, 'dented_lunchbox', 'Dented Lunchbox', 20000),
};
const BUDDY = { waifuId: 9, speciesSlug: 'warband_princess', name: 'Warband Princess', level: 30, baseSp: 200, currentSp: 280 };
const statsWith280 = () => assembleCombatStats({ buddy: BUDDY, loadoutId: null, slots: STARTERS });

type Json = { title?: string; description?: string; footer?: { text: string }; fields?: { name: string; value: string }[] };
function embedOf(payload: ReturnType<typeof buildOnboardingView>): Json {
  const embed = payload.embeds?.[0] as { toJSON(): Json } | undefined;
  return embed ? embed.toJSON() : {};
}
function buttonIds(payload: ReturnType<typeof buildOnboardingView>): string[] {
  return (payload.components ?? []).flatMap((row) =>
    (row as { toJSON(): { components: { custom_id?: string }[] } }).toJSON().components.map((c) => c.custom_id ?? ''),
  );
}
function buttonLabels(payload: ReturnType<typeof buildOnboardingView>): string[] {
  return (payload.components ?? []).flatMap((row) =>
    (row as { toJSON(): { components: { label?: string }[] } }).toJSON().components.map((c) => c.label ?? ''),
  );
}
const text = (json: Json) => [json.title, json.description, ...(json.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');

/* ───────────────────────── explanation maths ───────────────────────── */

describe('the SP → stat explanation', () => {
  it('shows the real Current SP and the combat-stat results', () => {
    const stats = statsWith280();
    expect(stats.stats).toEqual({ attack: 126, defense: 98, maxHp: 560 });
    expect(explainLine(280, STARTERS.attack, 'attack', stats.stats.attack)).toBe('280 × 0.45 = 126 ATK');
    expect(explainLine(280, STARTERS.defense, 'defense', stats.stats.defense)).toBe('280 × 0.35 = 98 DEF');
    expect(explainLine(280, STARTERS.health, 'health', stats.stats.maxHp)).toBe('280 × 2.00 = 560 HP');
  });

  it('renders a missing value as —, never 0', () => {
    expect(explainLine(280, STARTERS.attack, 'attack', null)).toBe('280 × 0.45 = — ATK');
  });

  it('formats multipliers from basis points', () => {
    expect(formatMultiplier(4500)).toBe('×0.45');
    expect(formatMultiplier(20000)).toBe('×2.00');
  });

  it('paints the Buddy, the three lines and Patch on the explain screen', () => {
    const payload = buildOnboardingView(ctx, { kind: 'explain', stats: statsWith280() }, CONTENT);
    const body = text(embedOf(payload));
    expect(body).toContain('Warband Princess');
    expect(body).toContain('Current SP: **280**');
    expect(body).toContain('280 × 0.45 = 126 ATK');
    expect(body).toContain('280 × 0.35 = 98 DEF');
    expect(body).toContain('280 × 2.00 = 560 HP');
    expect(body).toContain('**Patch:** “Your Buddy supplies the SP. Gear turns it into something useful.”');
    expect(body).toContain('That’s the whole trick. Better Buddy, better gear, bigger numbers.');
    expect(buttonIds(payload)[0]).toBe(onboardingCustomId('done'));
    expect(buttonLabels(payload)[0]).toBe('Gear up');
  });
});

/* ───────────────────────── screens ───────────────────────── */

describe('onboarding screens', () => {
  it('intro: Patch waves you over, button advances from intro', () => {
    const payload = buildOnboardingView(ctx, { kind: 'intro' }, CONTENT);
    expect(embedOf(payload).description).toContain('A woman surrounded by a suspicious amount of scrap waves you over.');
    expect(buttonIds(payload)[0]).toBe('wm|v1|onb|adv|equipment|intro');
    expect(buttonLabels(payload)[0]).toBe('Hear her out');
  });

  it.each([
    ['attack', 'Rusty Pipe', 4500, 'Attack Gear', 'Take the Rusty Pipe'],
    ['defense', 'Scrap Plate', 3500, 'Defense Gear', 'Take the Scrap Plate'],
    ['health', 'Dented Lunchbox', 20000, 'Health Gear', 'Take the Lunchbox'],
  ] as const)('%s hand-over shows the item card and advances from its own step', (slot, name, bp, gear, button) => {
    const view: EquipmentOnboardingView = {
      kind: 'handover',
      step: slot,
      item: {
        slot,
        definition: {
          key: 'k', name, description: 'flavour', slot, rarity: 'N',
          multiplierMinBp: bp, multiplierMaxBp: bp, multiplierStepBp: 100,
          tags: [], regionId: null, artworkPath: null, enabled: true,
        },
        multiplierBp: bp,
        displayName: name,
      },
    };
    const payload = buildOnboardingView(ctx, view, CONTENT);
    const body = text(embedOf(payload));
    expect(body).toContain(name);
    expect(body).toContain(`${gear} · ${formatMultiplier(bp)}`);
    expect(body).toContain('*flavour*');
    expect(buttonIds(payload)[0]).toBe(`wm|v1|onb|adv|equipment|${slot}`);
    expect(buttonLabels(payload)[0]).toBe(button);
  });

  it('needs_buddy offers the Collection and a way back, and no completion', () => {
    const payload = buildOnboardingView(ctx, { kind: 'needs_buddy' }, CONTENT);
    expect(buttonIds(payload)).toEqual(['wm|v1|menu|collection', 'wm|v1|menu|start']);
    expect(buttonIds(payload)).not.toContain(onboardingCustomId('done'));
  });

  it('complete: Equipment Unlocked, the equipped items and real stats', () => {
    const payload = buildOnboardingView(ctx, { kind: 'complete', stats: statsWith280(), report: null }, CONTENT);
    const json = embedOf(payload);
    expect(json.title).toBe('Equipment Unlocked');
    const body = text(json);
    expect(body).toContain('There. Now you look slightly less doomed.');
    for (const name of ['Rusty Pipe', 'Scrap Plate', 'Dented Lunchbox']) expect(body).toContain(name);
    const fields = Object.fromEntries((json.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields).toMatchObject({ ATK: '126', DEF: '98', HP: '560' });
    expect(buttonLabels(payload)).toEqual(['Back to Waifumon']);
    expect(buttonIds(payload)).toEqual(['wm|v1|menu|start']);
  });

  it('complete: names a slot it kept rather than overwrote', () => {
    const stats = assembleCombatStats({
      buddy: BUDDY,
      loadoutId: 1,
      slots: { ...STARTERS, attack: item(99, 'plasma_coil_ring', 'Plasma Coil Ring', 8600) },
    });
    const report = { equipped: [], alreadyEquipped: [], kept: [{ slot: 'attack' as const, equipmentId: 99 }], skipped: [] };
    const body = text(embedOf(buildOnboardingView(ctx, { kind: 'complete', stats, report }, CONTENT)));
    expect(body).toContain('Kept your **Plasma Coil Ring**');
  });

  it('overview (Phase 2B): an unlocked player re-opening the onboarding lands on Equipment management', () => {
    const payload = buildOnboardingView(ctx, { kind: 'overview', stats: statsWith280() }, CONTENT);
    expect(embedOf(payload).title).toBe(EQUIPMENT_HOME_TITLE);
    expect(buttonIds(payload)).toEqual(buttonIds(buildEquipmentHome(statsWith280())));
    expect(buttonIds(payload)).toContain(eqId.bag());
  });

  it('unavailable: the content message and a way back', () => {
    const payload = buildOnboardingView(ctx, { kind: 'unavailable', reason: 'disabled' }, CONTENT);
    expect(payload.content).toBe(CONTENT.flow.unavailableText);
    expect(buttonIds(payload)).toEqual(['wm|v1|menu|start']);
  });
});

/* ───────────────────────── custom ids ───────────────────────── */

describe('custom ids', () => {
  it('round-trip through the shared parser', () => {
    expect(parseCustomId(onboardingCustomId('open'))).toEqual({ scope: 'onb', action: 'open', args: ['equipment'] });
    expect(parseCustomId(onboardingCustomId('adv', 'defense'))).toEqual({
      scope: 'onb',
      action: 'adv',
      args: ['equipment', 'defense'],
    });
    expect(parseCustomId(onboardingCustomId('done'))).toEqual({ scope: 'onb', action: 'done', args: ['equipment'] });
    expect(parseCustomId(onboardingCustomId('view'))).toEqual({ scope: 'onb', action: 'view', args: ['equipment'] });
  });

  it('never carry a player id', () => {
    for (const id of [onboardingCustomId('open'), onboardingCustomId('adv', 'explain'), onboardingCustomId('view')]) {
      expect(id).not.toMatch(/\d{2,}/);
    }
  });
});

/* ───────────────────────── main menu ───────────────────────── */

describe('main menu Equipment entry', () => {
  const care = { active: false, enabled: true, currentEnergy: 5 } as never;
  const idsFor = (entry: EquipmentEntryState, careState = care) =>
    menuComponents(careState, true, entry).map((row) =>
      row.toJSON().components.map((c) => (c as { custom_id?: string }).custom_id ?? ''),
    );

  it('is absent while hidden (below level 35, switched off, not ready)', () => {
    expect(idsFor('hidden').flat().some((id) => id.includes('|onb|'))).toBe(false);
    expect(equipmentMenuButton('hidden')).toBeNull();
    expect(equipmentLegendLine('hidden')).toBe('');
  });

  it('defaults to hidden for callers that do not pass a state', () => {
    const ids = menuComponents(care, true).flatMap((row) =>
      row.toJSON().components.map((c) => (c as { custom_id?: string }).custom_id ?? ''),
    );
    expect(ids.some((id) => id.includes('|onb|'))).toBe(false);
  });

  it.each(['begin', 'resume'] as const)('%s: a primary 🔧 Equipment ✨ that opens the onboarding', (entry) => {
    const json = equipmentMenuButton(entry)!.toJSON() as { label: string; style: number; custom_id: string; emoji: { name: string } };
    expect(json.label).toBe('Equipment ✨');
    expect(json.emoji.name).toBe('🔧');
    expect(json.style).toBe(1); // Primary
    expect(json.custom_id).toBe(onboardingCustomId('open'));
    expect(idsFor(entry).flat()).toContain(onboardingCustomId('open'));
  });

  it('available: a secondary ⚔️ Equipment that opens the overview', () => {
    const json = equipmentMenuButton('available')!.toJSON() as { label: string; style: number; custom_id: string; emoji: { name: string } };
    expect(json.label).toBe('Equipment');
    expect(json.emoji.name).toBe('⚔️');
    expect(json.style).toBe(2); // Secondary
    expect(json.custom_id).toBe(onboardingCustomId('view'));
  });

  it('never pushes a row past five buttons, Care Mode active included', () => {
    for (const entry of ['hidden', 'begin', 'resume', 'available'] as const) {
      for (const careState of [care, { active: true, enabled: true, currentEnergy: 0 } as never]) {
        for (const row of idsFor(entry, careState)) expect(row.length).toBeLessThanOrEqual(5);
      }
    }
  });
});

/* ───────────────────────── handlers ───────────────────────── */

const PLAYER_ID = 7;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;

function makeInteraction() {
  const painted: { content?: string; embeds?: unknown[] }[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as { content?: string });
  });
  const interaction = {
    replied: false,
    deferred: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    update: paint,
    reply: paint,
    editReply: paint,
    followUp: paint,
  };
  return { interaction, painted };
}

function serviceDouble(view: EquipmentOnboardingView = { kind: 'intro' }) {
  return {
    open: vi.fn(async () => view),
    advance: vi.fn(async () => view),
    complete: vi.fn(async () => view),
    overview: vi.fn(async () => view),
    content: vi.fn(() => CONTENT),
  } as unknown as EquipmentOnboardingService & Record<'open' | 'advance' | 'complete' | 'overview', ReturnType<typeof vi.fn>>;
}

function handlerCtx(service: unknown): AppContext {
  return { ...ctx, services: { equipmentOnboarding: service } } as unknown as AppContext;
}

describe('onb:* handlers', () => {
  it('act on the clicking player only — the id names no one', async () => {
    const service = serviceDouble();
    const { interaction } = makeInteraction();
    await handleOnboardingAdvance(handlerCtx(service), interaction as never, prov, ['equipment', 'attack']);
    expect(service.advance).toHaveBeenCalledWith(PLAYER_ID, 'attack');
    await handleOnboardingOpen(handlerCtx(service), interaction as never, prov, ['equipment']);
    expect(service.open).toHaveBeenCalledWith(PLAYER_ID);
    await handleOnboardingComplete(handlerCtx(service), interaction as never, prov, ['equipment']);
    expect(service.complete).toHaveBeenCalledWith(PLAYER_ID);
  });

  it('a different player pressing the same button acts on their own state', async () => {
    const service = serviceDouble();
    const { interaction } = makeInteraction();
    const other = { playerId: 8, guildDbId: 3 } as unknown as Provisioned;
    await handleOnboardingAdvance(handlerCtx(service), interaction as never, other, ['equipment', 'attack']);
    expect(service.advance).toHaveBeenCalledWith(8, 'attack');
    expect(service.advance).not.toHaveBeenCalledWith(PLAYER_ID, expect.anything());
  });

  it('a double-click simply asks the service twice; the service decides', async () => {
    const service = serviceDouble({ kind: 'intro' });
    const { interaction, painted } = makeInteraction();
    await Promise.all([
      handleOnboardingAdvance(handlerCtx(service), interaction as never, prov, ['equipment', 'defense']),
      handleOnboardingAdvance(handlerCtx(service), interaction as never, prov, ['equipment', 'defense']),
    ]);
    expect(service.advance).toHaveBeenCalledTimes(2);
    expect(painted).toHaveLength(2);
  });

  it.each([
    ['an unknown step', ['equipment', 'gear_up']],
    ['a missing step', ['equipment']],
    ['a different flow', ['dungeon', 'attack']],
  ])('refuses %s as malformed without calling the service', async (_label, args) => {
    const service = serviceDouble();
    const { interaction, painted } = makeInteraction();
    await handleOnboardingAdvance(handlerCtx(service), interaction as never, prov, args);
    expect(service.advance).not.toHaveBeenCalled();
    expect(JSON.stringify(painted)).toContain('malformed');
  });

  it('a stale button on a deployment without the service says so', async () => {
    const { interaction, painted } = makeInteraction();
    await handleOnboardingOpen(handlerCtx(undefined), interaction as never, prov, ['equipment']);
    expect(JSON.stringify(painted)).toContain('no longer works');
  });

  it('with the switch off, the onboarding answers "not available"', async () => {
    const service = serviceDouble({ kind: 'unavailable', reason: 'disabled' });
    const { interaction, painted } = makeInteraction();
    await handleOnboardingOpen(handlerCtx(service), interaction as never, prov, ['equipment']);
    expect(painted[0]?.content).toBe(CONTENT.flow.unavailableText);
  });

  it('onb|view|equipment (the menu button) opens Equipment management for the clicking player', async () => {
    const stats = statsWith280();
    const management = { home: vi.fn(async () => ({ stats })) };
    const { interaction, painted } = makeInteraction();
    const appCtx = { ...ctx, services: { equipmentManagement: management } } as unknown as AppContext;
    await handleEquipmentHome(appCtx, interaction as never, prov);
    expect(management.home).toHaveBeenCalledWith(PLAYER_ID);
    expect(JSON.stringify(painted)).toContain(EQUIPMENT_HOME_TITLE);
  });
});
