/**
 * Combat Trials on Discord: the main-menu entry, the list, the pre-fight
 * screen, the Fight button and its idempotency nonce, the result screens and
 * the compact event summary — driven through the real handlers and presenter
 * with a scripted service. Persistence and the engine run for real in
 * `tests/integration/combatTrials.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentBuilder } from 'discord.js';

vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  ownedArtworkImage: vi.fn(() => ({
    file: new AttachmentBuilder(Buffer.from('buddy'), { name: 'waifumon-buddy-9.webp' }),
    url: 'attachment://waifumon-buddy-9.webp',
  })),
}));

import { ownedArtworkImage } from '../../src/discord/assets/attachRenderedCard';
import {
  COMBAT_TRIALS_CTA_TEXT,
  COMBAT_TRIALS_CTA_TITLE,
  INCOMPLETE_LOADOUT_BLOCKER,
  LOCKED_TRIALS,
  NO_BUDDY_BLOCKER,
  REPLAYED_FIGHT,
  RESULT_TITLE,
  TRIAL_UNAVAILABLE,
  buildFightResult,
  buildTrialDetail,
  buildTrialList,
  ctId,
  summarizeCombatEvents,
} from '../../src/discord/combatTrialPresenter';
import {
  fightRequestKey,
  handleCombatTrialFight,
  handleCombatTrialView,
  handleCombatTrialsHome,
} from '../../src/discord/commands/waifumonCombatTrials';
import { combatTrialsLegendLine, menuComponents } from '../../src/discord/commands/waifumon';
import { buildOnboardingView } from '../../src/discord/onboardingPresenter';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import { basicAttackController } from '../../src/modules/combat/combatController';
import { simulateCombat } from '../../src/modules/combat/combatSimulator';
import { createCombatState } from '../../src/modules/combat/combatState';
import type { CombatResult } from '../../src/modules/combat/combatTypes';
import { CombatEnemyDefinitionSchema } from '../../src/modules/combat/enemyDefinitions';
import { CombatTrialDefinitionSchema } from '../../src/modules/combat/trialDefinitions';
import type {
  CombatTrialAttemptView,
  CombatTrialDetailView,
  CombatTrialFightOutcome,
  CombatTrialListView,
  CombatTrialService,
} from '../../src/modules/combatTrials/combatTrialService';
import { assembleCombatStats, type CombatSlotItem } from '../../src/modules/equipment/equipmentMath';
import type { EquipmentEntryState } from '../../src/modules/onboarding/onboardingState';
import {
  CombatBuddyRequiredError,
  CombatTrialUnavailableError,
  FeatureLockedError,
} from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import { loadShippedContent } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

/* ───────────────────────── fixtures ───────────────────────── */

const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-assets-'));
fs.mkdirSync(path.join(assetsDir, 'combat', 'enemies'), { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'combat', 'enemies', 'scrapyard_drone.webp'), 'webp');
afterAll(() => fs.rmSync(assetsDir, { recursive: true, force: true }));

const DRONE = CombatEnemyDefinitionSchema.parse({
  key: 'scrapyard_drone',
  name: 'Scrapyard Drone',
  attack: 55,
  defense: 30,
  hp: 300,
  enabled: true,
  artworkPath: 'combat/enemies/scrapyard_drone.webp',
});
const BRUISER = CombatEnemyDefinitionSchema.parse({
  key: 'alley_bruiser',
  name: 'Alley Bruiser',
  attack: 100,
  defense: 55,
  hp: 520,
  enabled: true,
  // Authored but not deployed: must fall back to text-only.
  artworkPath: 'combat/enemies/alley_bruiser.webp',
});
const T1 = CombatTrialDefinitionSchema.parse({
  key: 'trial_scrapyard_drone',
  name: 'Trial 1 — Scrapyard Drone',
  description: 'A patched-together sentry drone.',
  enemyKey: 'scrapyard_drone',
  enabled: true,
  order: 10,
  recommended: { attack: 70, defense: 55, hp: 300 },
  firstClearRewards: { waifubux: 100, items: [{ slug: 'sticky_joystick', quantity: 2 }] },
});
const T2 = CombatTrialDefinitionSchema.parse({
  key: 'trial_alley_bruiser',
  name: 'Trial 2 — Alley Bruiser',
  description: 'A back-alley heavy.',
  enemyKey: 'alley_bruiser',
  enabled: true,
  order: 20,
});

const item = (equipmentId: number, name: string, multiplierBp: number): CombatSlotItem => ({
  equipmentId,
  definitionKey: name.toLowerCase().replace(/ /g, '_'),
  name,
  definitionName: name,
  affixKey: null,
  rarity: 'N',
  multiplierBp,
  rolledProperties: {},
});
const STARTERS = {
  attack: item(1, 'Rusty Pipe', 4500),
  defense: item(2, 'Scrap Plate', 3500),
  health: item(3, 'Dented Lunchbox', 20000),
};
const BUDDY = { waifuId: 9, speciesSlug: 'nebula_nurse', name: 'Nebula Nurse', level: 35, baseSp: 100, currentSp: 185 };
const stats185 = () => assembleCombatStats({ buddy: BUDDY, loadoutId: 1, slots: STARTERS });

const notCleared = { cleared: false, firstClearedAt: null, attempts: 0, latest: null };
const cleared = {
  cleared: true,
  firstClearedAt: new Date('2026-10-01T00:00:00Z'),
  attempts: 3,
  latest: { result: 'enemy_victory' as const, completedAt: new Date('2026-10-02T00:00:00Z') },
};

const LIST: CombatTrialListView = {
  trials: [
    { trial: T1, enemy: DRONE, progress: cleared },
    { trial: T2, enemy: BRUISER, progress: notCleared },
  ],
};

function detail(over: Partial<CombatTrialDetailView> = {}): CombatTrialDetailView {
  return { trial: T1, enemy: DRONE, progress: notCleared, stats: stats185(), blocker: null, ...over };
}

/** A real fight through the engine, shaped as the service returns it. */
function attemptFrom(result: CombatResult, over: Partial<CombatTrialAttemptView> = {}): CombatTrialAttemptView {
  const { player, enemy } = result.finalState;
  const start = result.events[0] as Extract<CombatResult['events'][number], { type: 'combat_started' }>;
  return {
    id: 1,
    trialKey: T1.key,
    enemyKey: DRONE.key,
    result: result.result,
    endReason: result.reason,
    rounds: result.rounds,
    actions: result.actions,
    buddyWaifuId: 9,
    player: { name: player.name, attack: player.attack, defense: player.defense, maxHp: start.player.maxHp, remainingHp: player.currentHp },
    enemy: { name: enemy.name, attack: enemy.attack, defense: enemy.defense, maxHp: start.enemy.maxHp, remainingHp: enemy.currentHp },
    firstClear: false,
    rewards: null,
    events: result.events,
    startedAt: new Date(),
    completedAt: new Date(),
    ...over,
  };
}
function fightResult(player: { attack: number; defense: number; maxHp: number }, enemy = { attack: 55, defense: 30, maxHp: 300 }) {
  return simulateCombat(
    createCombatState({
      player: { id: 'buddy:9', name: 'Nebula Nurse', ...player },
      enemy: { id: 'enemy:scrapyard_drone', name: 'Scrapyard Drone', ...enemy },
    }),
    { player: basicAttackController, enemy: basicAttackController },
    { rng: seededRng(1) },
  );
}
const VICTORY = () => fightResult({ attack: 83, defense: 65, maxHp: 370 });
const DEFEAT = () => fightResult({ attack: 20, defense: 5, maxHp: 50 });
const DRAW = () => fightResult({ attack: 1, defense: 1_000_000, maxHp: 100 }, { attack: 1, defense: 1_000_000, maxHp: 100 });
const outcome = (attempt: CombatTrialAttemptView, over: Partial<CombatTrialFightOutcome> = {}): CombatTrialFightOutcome => ({
  attempt,
  replayed: false,
  trial: T1,
  ...over,
});

/* ───────────────────────── harness ───────────────────────── */

type Json = {
  title?: string;
  description?: string;
  image?: { url: string };
  thumbnail?: { url: string };
  fields?: { name: string; value: string }[];
};
type Payload = { content?: string; embeds?: { toJSON(): Json }[]; components?: { toJSON(): unknown }[]; files?: { name?: string | null }[] };
type ButtonJson = { custom_id?: string; label?: string; disabled?: boolean; style?: number; emoji?: { name: string } };

const embedOf = (raw: unknown): Json => (raw as Payload).embeds?.[0]?.toJSON() ?? {};
const buttons = (raw: unknown): ButtonJson[] =>
  ((raw as Payload).components ?? []).flatMap((r) => (r.toJSON() as { components: ButtonJson[] }).components);
const ids = (p: unknown) => buttons(p).map((b) => b.custom_id ?? '');
const text = (p: unknown) => {
  const j = embedOf(p);
  return [(p as Payload).content ?? '', j.title, j.description, ...(j.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
};
const embedSize = (p: unknown) => {
  const j = embedOf(p);
  return [j.title, j.description, ...(j.fields ?? []).flatMap((f) => [f.name, f.value])].join('').length;
};
const fightButton = (p: unknown) => buttons(p).find((b) => b.custom_id?.startsWith('wm|v1|ct|fight|'));

function fakeService(over: Partial<Record<keyof CombatTrialService, unknown>> = {}) {
  return {
    isAvailable: vi.fn(async () => true),
    list: vi.fn(async () => LIST),
    detail: vi.fn(async () => detail()),
    fight: vi.fn(async () => outcome(attemptFrom(VICTORY()))),
    ...over,
  } as unknown as CombatTrialService & Record<keyof CombatTrialService, ReturnType<typeof vi.fn>>;
}

const shipped = loadShippedContent();
function makeCtx(service: CombatTrialService | undefined, buddyId = 9): AppContext {
  return {
    config: { assetsDir },
    logger: silentLogger(),
    content: { items: shipped.items, combatEnemies: [DRONE, BRUISER] },
    services: {
      combatTrials: service,
      collection: { getBuddy: vi.fn(async () => ({ waifu: { id: buddyId }, species: { slug: 'nebula_nurse' } })) },
    },
  } as unknown as AppContext;
}

function click() {
  const painted: Payload[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as Payload);
  });
  const i = { replied: false, deferred: false, isButton: () => true, isStringSelectMenu: () => false, update: paint, reply: paint, editReply: paint, followUp: paint };
  return { i: i as never, last: () => painted[painted.length - 1]! };
}
const prov = { playerId: 42, guildDbId: 1 } as Provisioned;

beforeEach(() => vi.mocked(ownedArtworkImage).mockClear());

/* ───────────────────────── main menu ───────────────────────── */

describe('main-menu entry', () => {
  const care = { active: false, enabled: true, currentEnergy: 5 } as never;
  const menuIds = (entry: EquipmentEntryState, enabled = true) =>
    menuComponents(care, true, entry, enabled).flatMap((row) =>
      row.toJSON().components.map((c) => c as ButtonJson),
    );

  it('offers ⚔️ Combat Trials once Equipment is unlocked', () => {
    const button = menuIds('available').find((b) => b.custom_id === ctId.home(0));
    expect(button).toMatchObject({ label: 'Combat Trials', emoji: { name: '⚔️' } });
    expect(combatTrialsLegendLine('available', true)).toContain('Combat Trials');
  });

  it.each(['hidden', 'begin', 'resume'] as const)('is absent for a player without the unlock (%s)', (entry) => {
    expect(menuIds(entry).some((b) => b.custom_id?.includes('|ct|'))).toBe(false);
    expect(combatTrialsLegendLine(entry, true)).toBe('');
  });

  it('is absent when the service is not wired, and defaults off for older callers', () => {
    expect(menuIds('available', false).some((b) => b.custom_id?.includes('|ct|'))).toBe(false);
    expect(menuComponents(care, true, 'available').flatMap((r) => r.toJSON().components).some((c) => (c as ButtonJson).custom_id?.includes('|ct|'))).toBe(false);
  });

  it('fits the bottom row even with every optional button present', () => {
    const rows = menuComponents({ active: true, enabled: true, currentEnergy: 5 } as never, true, 'available', true);
    for (const row of rows) expect(row.toJSON().components.length).toBeLessThanOrEqual(5);
    expect(rows[rows.length - 1]!.toJSON().components.length).toBe(5);
  });
});

/* ───────────────────────── locked ───────────────────────── */

describe('a locked player', () => {
  it('reaching any Trial button gets the locked screen, and nothing is fought', async () => {
    const locked = () => Promise.reject(new FeatureLockedError('equipment'));
    const service = fakeService({ list: vi.fn(locked), detail: vi.fn(locked), fight: vi.fn(locked) });
    for (const run of [
      (c: ReturnType<typeof click>) => handleCombatTrialsHome(makeCtx(service), c.i, prov, ['0']),
      (c: ReturnType<typeof click>) => handleCombatTrialView(makeCtx(service), c.i, prov, [T1.key]),
      (c: ReturnType<typeof click>) => handleCombatTrialFight(makeCtx(service), c.i, prov, [T1.key, 'abcdefgh']),
    ]) {
      const c = click();
      await run(c);
      expect(c.last().content).toBe(LOCKED_TRIALS);
      expect(ids(c.last())).toEqual(['wm|v1|menu|start']);
    }
  });

  it('a deployment without the service answers a stale button plainly', async () => {
    const c = click();
    await handleCombatTrialsHome(makeCtx(undefined), c.i, prov, ['0']);
    expect(c.last().content).toBe('That button no longer works.');
  });
});

/* ───────────────────────── list ───────────────────────── */

describe('Trial list', () => {
  it('shows each Trial with its enemy, description, recommendation and status', async () => {
    const c = click();
    await handleCombatTrialsHome(makeCtx(fakeService()), c.i, prov, ['0']);
    const body = text(c.last());
    expect(embedOf(c.last()).title).toBe('⚔️ Combat Trials');
    expect(body).toContain('Trial 1 — Scrapyard Drone');
    expect(body).toContain('Enemy: **Scrapyard Drone**');
    expect(body).toContain('A patched-together sentry drone.');
    expect(body).toContain('Recommended: ATK 70+ · DEF 55+ · HP 300+');
    expect(body).toContain('Trial 2 — Alley Bruiser');
    expect(ids(c.last())).toEqual([ctId.view(T1.key), ctId.view(T2.key), 'wm|v1|menu|start']);
  });

  it('marks cleared and not-cleared Trials', () => {
    const fields = embedOf(buildTrialList(LIST, 0)).fields!;
    expect(fields[0]!.value).toContain('Status: ✅ Cleared · Last: Defeat');
    expect(fields[1]!.value).toContain('Status: Not Cleared');
    expect(fields[1]!.value).not.toContain('Recommended');
  });

  it('paginates five to a page', () => {
    const many: CombatTrialListView = {
      trials: Array.from({ length: 7 }, (_, n) => ({
        trial: { ...T1, key: `t${n}`, name: `Trial ${n}` },
        enemy: DRONE,
        progress: notCleared,
      })),
    };
    const first = buildTrialList(many, 0);
    expect(embedOf(first).fields).toHaveLength(5);
    expect(buttons(first).find((b) => b.label === 'Page 1 / 2')?.disabled).toBe(true);
    const second = buildTrialList(many, 1);
    expect(embedOf(second).fields!.map((f) => f.name)).toEqual(['Trial 5', 'Trial 6']);
    expect(new Set(ids(second)).size).toBe(ids(second).length);
  });

  it('an empty ladder says so', () => {
    expect(text(buildTrialList({ trials: [] }, 0))).toContain('No Trials are available');
  });

  it('a malformed page is refused without calling the service', async () => {
    const service = fakeService();
    const c = click();
    await handleCombatTrialsHome(makeCtx(service), c.i, prov, ['x']);
    expect(c.last().content).toContain('malformed');
    expect(service.list).not.toHaveBeenCalled();
  });
});

/* ───────────────────────── detail ───────────────────────── */

describe('Trial detail (pre-fight)', () => {
  it('shows the active Buddy, Equipment-derived stats, gear, enemy and recommendations', async () => {
    const service = fakeService();
    const c = click();
    await handleCombatTrialView(makeCtx(service), c.i, prov, [T1.key]);
    const body = text(c.last());
    expect(service.detail).toHaveBeenCalledWith(42, T1.key);
    expect(body).toContain('Your Buddy — Nebula Nurse');
    expect(body).toContain('Current SP **185**');
    expect(body).toContain('ATK 83 · DEF 65 · HP 370');
    for (const name of ['Rusty Pipe', 'Scrap Plate', 'Dented Lunchbox']) expect(body).toContain(name);
    expect(body).toContain('Enemy — Scrapyard Drone');
    expect(body).toContain('ATK 55 · DEF 30 · HP 300');
    expect(body).toContain('ATK 70+ · DEF 55+ · HP 300+');
    expect(body).toContain('Status');
  });

  it('opening a Trial never fights — it offers an enabled Fight button with a nonce', async () => {
    const service = fakeService();
    const c = click();
    await handleCombatTrialView(makeCtx(service), c.i, prov, [T1.key]);
    expect(service.fight).not.toHaveBeenCalled();
    const fight = fightButton(c.last())!;
    expect(fight).toMatchObject({ label: 'Fight', disabled: false });
    const parsed = parseCustomId(fight.custom_id!);
    expect(parsed).toMatchObject({ scope: 'ct', action: 'fight', args: [T1.key, expect.stringMatching(/^[A-Za-z0-9_-]{12}$/)] });
    expect(fight.custom_id!.length).toBeLessThanOrEqual(100);
  });

  it('every render mints a fresh Fight nonce', async () => {
    const a = click();
    const b = click();
    await handleCombatTrialView(makeCtx(fakeService()), a.i, prov, [T1.key]);
    await handleCombatTrialView(makeCtx(fakeService()), b.i, prov, [T1.key]);
    expect(fightButton(a.last())!.custom_id).not.toBe(fightButton(b.last())!.custom_id);
  });

  it('enemy art is the large image and Buddy art the thumbnail', async () => {
    const c = click();
    await handleCombatTrialView(makeCtx(fakeService()), c.i, prov, [T1.key]);
    const json = embedOf(c.last());
    expect(json.image?.url).toBe('attachment://combat-trial-trial-scrapyard-drone.webp');
    expect(json.thumbnail?.url).toBe('attachment://waifumon-buddy-9.webp');
    expect(c.last().files?.map((f) => f.name)).toEqual(['combat-trial-trial-scrapyard-drone.webp', 'waifumon-buddy-9.webp']);
  });

  it('missing art falls back to text-only', async () => {
    vi.mocked(ownedArtworkImage).mockReturnValueOnce(null);
    const service = fakeService({ detail: vi.fn(async () => detail({ trial: T2, enemy: BRUISER })) });
    const c = click();
    await handleCombatTrialView(makeCtx(service), c.i, prov, [T2.key]);
    const json = embedOf(c.last());
    expect(json.image).toBeUndefined();
    expect(json.thumbnail).toBeUndefined();
    expect(c.last().files).toEqual([]);
    expect(fightButton(c.last())?.disabled).toBe(false);
  });

  it('a Buddy swapped between reads costs the picture, never shows the wrong one', async () => {
    const c = click();
    await handleCombatTrialView(makeCtx(fakeService(), 777), c.i, prov, [T1.key]);
    expect(embedOf(c.last()).thumbnail).toBeUndefined();
  });

  it('no Buddy: explains, disables Fight and offers the Collection', () => {
    const stats = assembleCombatStats({ buddy: null, loadoutId: 1, slots: STARTERS });
    const payload = buildTrialDetail(detail({ stats, blocker: 'no_buddy' }), 'nonce123', {
      buddy: { file: new AttachmentBuilder(Buffer.from('x'), { name: 'b.webp' }), url: 'attachment://b.webp' },
    });
    expect(text(payload)).toContain(NO_BUDDY_BLOCKER);
    expect(text(payload)).toContain('No active Buddy.');
    expect(fightButton(payload)?.disabled).toBe(true);
    expect(ids(payload)).toContain('wm|v1|menu|collection');
    expect(embedOf(payload).thumbnail).toBeUndefined();
  });

  it('an incomplete loadout disables Fight and points at Equipment', () => {
    const stats = assembleCombatStats({ buddy: BUDDY, loadoutId: 1, slots: { ...STARTERS, health: null } });
    const payload = buildTrialDetail(detail({ stats, blocker: 'incomplete_loadout' }), 'nonce123');
    expect(text(payload)).toContain(INCOMPLETE_LOADOUT_BLOCKER);
    expect(text(payload)).toContain('HP —');
    expect(fightButton(payload)?.disabled).toBe(true);
    expect(ids(payload)).toContain('wm|v1|eq|home');
  });

  it('an unavailable Trial falls back to the list with a note', async () => {
    const service = fakeService({ detail: vi.fn(() => Promise.reject(new CombatTrialUnavailableError('x', 'disabled'))) });
    const c = click();
    await handleCombatTrialView(makeCtx(service), c.i, prov, ['x']);
    expect(c.last().content).toBe(TRIAL_UNAVAILABLE);
    expect(embedOf(c.last()).title).toBe('⚔️ Combat Trials');
  });
});

/* ───────────────────────── fight ───────────────────────── */

describe('Fight', () => {
  it('passes the nonce through as the request key, and the same nonce twice is the same key', async () => {
    const service = fakeService();
    for (let n = 0; n < 2; n += 1) {
      const c = click();
      await handleCombatTrialFight(makeCtx(service), c.i, prov, [T1.key, 'sameNonce123']);
    }
    expect(service.fight).toHaveBeenNthCalledWith(1, 42, T1.key, fightRequestKey('sameNonce123'));
    expect(service.fight).toHaveBeenNthCalledWith(2, 42, T1.key, fightRequestKey('sameNonce123'));
  });

  it('a replayed (double-clicked or retried) Fight repaints the original result with a note', async () => {
    const attempt = attemptFrom(VICTORY());
    const service = fakeService({ fight: vi.fn(async () => outcome(attempt, { replayed: true })) });
    const c = click();
    await handleCombatTrialFight(makeCtx(service), c.i, prov, [T1.key, 'sameNonce123']);
    expect(c.last().content).toBe(REPLAYED_FIGHT);
    expect(embedOf(c.last()).title).toContain(RESULT_TITLE.player_victory);
  });

  it('refuses a malformed nonce without calling the service', async () => {
    const service = fakeService();
    for (const args of [[T1.key], [T1.key, 'bad|nonce'], [T1.key, 'x'], []]) {
      const c = click();
      await handleCombatTrialFight(makeCtx(service), c.i, prov, args);
      expect(c.last().content).toContain('malformed');
    }
    expect(service.fight).not.toHaveBeenCalled();
  });

  it('losing the Buddy before Fight repaints the detail with the reason', async () => {
    const service = fakeService({
      fight: vi.fn(() => Promise.reject(new CombatBuddyRequiredError())),
      detail: vi.fn(async () => detail({ stats: assembleCombatStats({ buddy: null, loadoutId: 1, slots: STARTERS }), blocker: 'no_buddy' })),
    });
    const c = click();
    await handleCombatTrialFight(makeCtx(service), c.i, prov, [T1.key, 'abcdefgh']);
    expect(c.last().content).toBe(new CombatBuddyRequiredError().userMessage);
    expect(fightButton(c.last())?.disabled).toBe(true);
  });

  it('result screens offer Fight Again with a new nonce, the list and the menu', async () => {
    const c = click();
    await handleCombatTrialFight(makeCtx(fakeService()), c.i, prov, [T1.key, 'firstNonce12']);
    const again = fightButton(c.last())!;
    expect(again.label).toBe('Fight Again');
    expect(again.custom_id).not.toContain('firstNonce12');
    expect(ids(c.last())).toEqual([again.custom_id, ctId.home(0), 'wm|v1|menu|start']);
  });
});

/* ───────────────────────── results ───────────────────────── */

describe('result screens', () => {
  const opts = { againNonce: 'again123', itemName: (slug: string) => shipped.items.find((i) => i.slug === slug)?.name ?? slug };

  it('victory: both sides’ HP, rounds and a short summary', () => {
    const attempt = attemptFrom(VICTORY());
    const p = buildFightResult(outcome(attempt), opts);
    const json = embedOf(p);
    expect(json.title).toBe('🏆 Victory! — Trial 1 — Scrapyard Drone');
    expect(json.description).toContain(`**Nebula Nurse**\nHP: ${attempt.player.remainingHp} / 370`);
    expect(json.description).toContain('**Scrapyard Drone**\nHP: 0 / 300');
    expect(json.description).toContain(`Rounds: ${attempt.rounds}`);
    expect(text(p)).toContain('💥 Scrapyard Drone is defeated.');
  });

  it('loss', () => {
    const attempt = attemptFrom(DEFEAT());
    expect(attempt.result).toBe('enemy_victory');
    const p = buildFightResult(outcome(attempt), opts);
    expect(embedOf(p).title).toContain('💀 Defeat');
    expect(embedOf(p).description).toContain('HP: 0 / 50');
    expect(text(p)).toContain('💥 Nebula Nurse is defeated.');
  });

  it('draw', () => {
    const attempt = attemptFrom(DRAW());
    expect(attempt.result).toBe('draw');
    const p = buildFightResult(outcome(attempt), opts);
    expect(embedOf(p).title).toContain('⏱️ Draw');
    expect(text(p)).toContain('Round limit reached');
  });

  it('a first clear lists what it paid', () => {
    const attempt = attemptFrom(VICTORY(), {
      firstClear: true,
      rewards: { waifubux: 100, items: [{ slug: 'sticky_joystick', quantity: 2 }] },
    });
    const body = text(buildFightResult(outcome(attempt), opts));
    expect(body).toContain('🎉 First Clear!');
    expect(body).toContain('+100 WaifuBux');
    expect(body).toContain('+2 Sticky Joystick');
  });

  it('a repeat clear shows no reward', () => {
    expect(text(buildFightResult(outcome(attemptFrom(VICTORY())), opts))).not.toContain('First Clear');
  });

  it('a removed Trial still renders from the stored attempt, without Fight Again', () => {
    const p = buildFightResult(outcome(attemptFrom(VICTORY()), { trial: null }), opts);
    expect(embedOf(p).title).toContain(T1.key);
    expect(fightButton(p)).toBeUndefined();
  });

  it('stays well inside Discord embed limits even for a 30-round draw', () => {
    const p = buildFightResult(outcome(attemptFrom(DRAW(), { firstClear: true, rewards: T1.firstClearRewards })), opts);
    expect(embedSize(p)).toBeLessThan(2000);
    for (const f of embedOf(p).fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
  });
});

describe('compact combat summary', () => {
  it('lists the opening hits, counts the skipped ones, then the final blow', () => {
    const r = fightResult({ attack: 40, defense: 30, maxHp: 1000 });
    const hits = r.events.filter((e) => e.type === 'damage');
    expect(hits.length).toBeGreaterThan(6);
    const lines = summarizeCombatEvents(r.events);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toMatch(/^R1 · Nebula Nurse hits Scrapyard Drone for \*\*\d+\*\* \(300 → \d+\)$/);
    expect(lines).toContain(`… ${hits.length - 4} more hits …`);
    expect(lines[lines.length - 1]).toBe('💥 Scrapyard Drone is defeated.');
  });

  it('a one-hit fight is just that hit and the knockout', () => {
    const r = fightResult({ attack: 10_000, defense: 0, maxHp: 10 });
    expect(summarizeCombatEvents(r.events)).toEqual([
      expect.stringMatching(/^R1 · Nebula Nurse hits Scrapyard Drone/),
      '💥 Scrapyard Drone is defeated.',
    ]);
  });

  it('formats events without changing them', () => {
    const r = VICTORY();
    const before = JSON.stringify(r.events);
    summarizeCombatEvents(r.events);
    expect(JSON.stringify(r.events)).toBe(before);
  });
});

/* ───────────────────────── onboarding CTA ───────────────────────── */

describe('Equipment onboarding completion', () => {
  const content = { flow: shipped.onboarding!.equipment!, npc: shipped.npcs!.find((n) => n.key === 'patch')! };
  const view = { kind: 'complete' as const, stats: stats185(), report: null };

  it('points the player at Combat Trials when the feature is wired', () => {
    const ctx = { config: { assetsDir: './assets' }, logger: silentLogger(), services: { combatTrials: fakeService() } } as unknown as AppContext;
    const p = buildOnboardingView(ctx, view, content);
    expect(text(p)).toContain(COMBAT_TRIALS_CTA_TITLE);
    expect(text(p)).toContain(COMBAT_TRIALS_CTA_TEXT);
    expect(ids(p)).toEqual(['wm|v1|menu|start', ctId.home(0)]);
  });

  it('is unchanged without it', () => {
    const ctx = { config: { assetsDir: './assets' }, logger: silentLogger() } as unknown as AppContext;
    const p = buildOnboardingView(ctx, view, content);
    expect(text(p)).not.toContain(COMBAT_TRIALS_CTA_TITLE);
    expect(ids(p)).toEqual(['wm|v1|menu|start']);
  });
});
