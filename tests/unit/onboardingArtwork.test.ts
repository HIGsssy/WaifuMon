/**
 * Equipment onboarding artwork: which one picture a screen shows, and that a
 * missing or absent picture never costs the player the screen.
 *
 * Precedence, per screen: the step's scene art, then (hand-overs) the item's
 * artwork, then the NPC's portrait, then text-only. Everything renders into
 * the embed's image slot, so there is never a second competing image.
 *
 * Files live in a throwaway assets directory; the resolver only checks that a
 * regular file is there, so the bytes need not be a real image.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleOnboardingAdvance, handleOnboardingOpen } from '../../src/discord/commands/waifumonOnboarding';
import { buildOnboardingView, type OnboardingPresenterContent } from '../../src/discord/onboardingPresenter';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  EquipmentOnboardingContentSchema,
  NpcSchema,
  type NpcContent,
} from '../../src/modules/content/onboardingSchemas';
import { validateEquipmentDefinition } from '../../src/modules/equipment/definitionSchema';
import { assembleCombatStats, type CombatSlotItem } from '../../src/modules/equipment/equipmentMath';
import type {
  EquipmentOnboardingService,
  EquipmentOnboardingView,
} from '../../src/modules/onboarding/equipmentOnboardingService';
import { loadShippedContent } from '../helpers/fixtures';

const shipped = loadShippedContent();
const SHIPPED_FLOW = shipped.onboarding!.equipment!;
const SHIPPED_PATCH = shipped.npcs!.find((n) => n.key === 'patch')!;

let assetsDir: string;
const PRESENT = [
  'npcs/patch.webp',
  'onboarding/equipment/intro.webp',
  'onboarding/equipment/attack.webp',
  'onboarding/equipment/explain.webp',
  'onboarding/equipment/no_buddy.webp',
  'onboarding/equipment/complete.webp',
  'equipment/rusty_pipe.webp',
];

beforeAll(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-onboarding-art-'));
  for (const rel of PRESENT) {
    fs.mkdirSync(path.dirname(path.join(assetsDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, rel), 'not really an image');
  }
});
afterAll(() => fs.rmSync(assetsDir, { recursive: true, force: true }));

function makeCtx() {
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const ctx = { config: { assetsDir }, logger } as unknown as AppContext;
  return { ctx, logger };
}

const PATCH: NpcContent = { ...SHIPPED_PATCH, portraitPath: 'npcs/patch.webp' };

/** The shipped narrative with every step's art set as the conventions say. */
function contentWith(
  overrides: { npc?: NpcContent | null; art?: Partial<Record<'intro' | 'attack' | 'defense' | 'health' | 'explain' | 'complete' | 'noBuddy', string | null>> } = {},
): OnboardingPresenterContent {
  const art = overrides.art ?? {};
  const s = SHIPPED_FLOW.steps;
  const pick = (k: keyof typeof art, fallback: string | null) => (k in art ? art[k]! : fallback);
  return {
    npc: overrides.npc === undefined ? PATCH : overrides.npc,
    flow: {
      ...SHIPPED_FLOW,
      steps: {
        intro: { ...s.intro, artworkPath: pick('intro', null) },
        attack: { ...s.attack, artworkPath: pick('attack', null) },
        defense: { ...s.defense, artworkPath: pick('defense', null) },
        health: { ...s.health, artworkPath: pick('health', null) },
        explain: {
          ...s.explain,
          artworkPath: pick('explain', null),
          noBuddy: { ...s.explain.noBuddy, artworkPath: pick('noBuddy', null) },
        },
        complete: { ...s.complete, artworkPath: pick('complete', null) },
      },
    },
  };
}

type Payload = ReturnType<typeof buildOnboardingView>;
const fileNames = (p: Payload) => (p.files ?? []).map((f) => (f as { name: string }).name);
function embedJson(p: Payload) {
  const e = p.embeds?.[0] as { toJSON(): { image?: { url: string }; thumbnail?: { url: string } } } | undefined;
  return e?.toJSON() ?? {};
}

const item = (equipmentId: number, definitionKey: string, name: string, multiplierBp: number): CombatSlotItem => ({
  equipmentId, definitionKey, name, definitionName: name, affixKey: null, rarity: 'N', multiplierBp, combatBonuses: [], rolledProperties: {},
});
const STATS = assembleCombatStats({
  buddy: { waifuId: 9, speciesSlug: 'warband_princess', name: 'Warband Princess', level: 30, baseSp: 200, currentSp: 280 },
  loadoutId: null,
  slots: {
    attack: item(1, 'rusty_pipe', 'Rusty Pipe', 4500),
    defense: item(2, 'scrap_plate', 'Scrap Plate', 3500),
    health: item(3, 'dented_lunchbox', 'Dented Lunchbox', 20000),
  },
});
function handover(step: 'attack' | 'defense' | 'health', artworkPath: string | null): EquipmentOnboardingView {
  return {
    kind: 'handover',
    step,
    item: {
      slot: step,
      definition: {
        key: 'k', name: 'Thing', description: '', slot: step, rarity: 'N',
        multiplierMinBp: 4500, multiplierMaxBp: 4500, multiplierStepBp: 100,
        tags: [], regionId: null, artworkPath, enabled: true,
      },
      multiplierBp: 4500,
      displayName: 'Thing',
    },
  } as EquipmentOnboardingView;
}

/* ───────────────────────── content schema ───────────────────────── */

describe('NPC portrait paths', () => {
  it('Patch can reference npcs/patch.webp', () => {
    expect(NpcSchema.parse({ key: 'patch', name: 'Patch', portraitPath: 'npcs/patch.webp' }).portraitPath).toBe(
      'npcs/patch.webp',
    );
  });

  it('defaults to no portrait', () => {
    expect(NpcSchema.parse({ key: 'patch', name: 'Patch' }).portraitPath).toBeNull();
  });

  it.each([
    '../patch.webp',
    'npcs/../../patch.webp',
    '/abs/patch.webp',
    'C:/patch.webp',
    'npcs\\patch.webp',
    'https://cdn.example/patch.webp',
    'npcs/patch.txt',
    'npcs/patch',
  ])('rejects %j', (portraitPath) => {
    expect(NpcSchema.safeParse({ key: 'patch', name: 'Patch', portraitPath }).success).toBe(false);
  });
});

describe('onboarding step artwork', () => {
  it('accepts the conventional path on every step, the no-Buddy screen included', () => {
    const raw = JSON.parse(JSON.stringify(SHIPPED_FLOW)) as Record<string, any>;
    for (const step of ['intro', 'attack', 'defense', 'health', 'explain', 'complete']) {
      raw.steps[step].artworkPath = `onboarding/equipment/${step}.webp`;
    }
    raw.steps.explain.noBuddy.artworkPath = 'onboarding/equipment/no_buddy.webp';
    const parsed = EquipmentOnboardingContentSchema.parse(raw);
    expect(parsed.steps.intro.artworkPath).toBe('onboarding/equipment/intro.webp');
    expect(parsed.steps.explain.noBuddy.artworkPath).toBe('onboarding/equipment/no_buddy.webp');
  });

  it('is optional: omitted means null', () => {
    const raw = JSON.parse(JSON.stringify(SHIPPED_FLOW)) as Record<string, any>;
    delete raw.steps.intro.artworkPath;
    delete raw.steps.explain.noBuddy.artworkPath;
    const parsed = EquipmentOnboardingContentSchema.parse(raw);
    expect(parsed.steps.intro.artworkPath).toBeNull();
    expect(parsed.steps.explain.noBuddy.artworkPath).toBeNull();
  });

  it('rejects an escaping no-Buddy path', () => {
    const raw = JSON.parse(JSON.stringify(SHIPPED_FLOW)) as Record<string, any>;
    raw.steps.explain.noBuddy.artworkPath = '../no_buddy.webp';
    expect(EquipmentOnboardingContentSchema.safeParse(raw).success).toBe(false);
  });
});

describe('Equipment definition artwork paths', () => {
  const base = {
    key: 'rusty_pipe',
    name: 'Rusty Pipe',
    slot: 'attack',
    rarity: 'N',
    multiplierMinBp: 4000,
    multiplierMaxBp: 6000,
    multiplierStepBp: 500,
  };

  it('accepts assets under equipment/', () => {
    for (const artworkPath of ['equipment/rusty_pipe.webp', 'equipment/scrap_plate.png', 'equipment/dented_lunchbox.webp']) {
      expect(validateEquipmentDefinition({ ...base, artworkPath }).ok).toBe(true);
    }
  });

  it('still requires no artwork', () => {
    expect(validateEquipmentDefinition(base).ok).toBe(true);
    expect(validateEquipmentDefinition({ ...base, artworkPath: null }).ok).toBe(true);
  });

  it.each(['https://cdn.example/pipe.webp', 'equipment/rusty_pipe.txt', 'equipment/../../pipe.webp'])(
    'rejects %j, which the Discord resolver would refuse to serve',
    (artworkPath) => {
      expect(validateEquipmentDefinition({ ...base, artworkPath }).ok).toBe(false);
    },
  );

  it('resolves to an attachment from the shared assets root', () => {
    const { ctx } = makeCtx();
    const payload = buildOnboardingView(ctx, handover('attack', 'equipment/rusty_pipe.webp'), contentWith({ npc: null }));
    expect(fileNames(payload)).toEqual(['onboarding_attack_item.webp']);
  });
});

/* ───────────────────────── precedence ───────────────────────── */

describe('which picture a screen shows', () => {
  it('step scene art beats Patch’s portrait, and only one image is attached', () => {
    const { ctx } = makeCtx();
    const payload = buildOnboardingView(ctx, { kind: 'intro' }, contentWith({ art: { intro: 'onboarding/equipment/intro.webp' } }));
    expect(fileNames(payload)).toEqual(['onboarding_intro.webp']);
    expect(embedJson(payload).image?.url).toBe('attachment://onboarding_intro.webp');
    expect(embedJson(payload).thumbnail).toBeUndefined();
  });

  it('Patch’s portrait fills in when the step has no scene art', () => {
    const { ctx } = makeCtx();
    const payload = buildOnboardingView(ctx, { kind: 'intro' }, contentWith());
    expect(fileNames(payload)).toEqual(['npc_patch.webp']);
    expect(embedJson(payload).image?.url).toBe('attachment://npc_patch.webp');
  });

  it('a hand-over prefers scene art, then the item’s art, then Patch', () => {
    const { ctx } = makeCtx();
    const scene = contentWith({ art: { attack: 'onboarding/equipment/attack.webp' } });
    expect(fileNames(buildOnboardingView(ctx, handover('attack', 'equipment/rusty_pipe.webp'), scene))).toEqual([
      'onboarding_attack.webp',
    ]);
    expect(fileNames(buildOnboardingView(ctx, handover('attack', 'equipment/rusty_pipe.webp'), contentWith()))).toEqual([
      'onboarding_attack_item.webp',
    ]);
    expect(fileNames(buildOnboardingView(ctx, handover('defense', null), contentWith()))).toEqual(['npc_patch.webp']);
  });

  it('text-only when nothing is authored', () => {
    const { ctx, logger } = makeCtx();
    const payload = buildOnboardingView(ctx, { kind: 'intro' }, contentWith({ npc: { ...PATCH, portraitPath: null } }));
    expect(payload.files).toEqual([]);
    expect(embedJson(payload).image).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('shipped content resolves against the real assets/ tree, quietly', () => {
    // Every shipped onboarding path must point at a file that exists in the
    // repository's assets/ — a path that validates but resolves nowhere (e.g.
    // one prefixed with "assets/") would otherwise fail silently to text-only.
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const ctx = { config: { assetsDir: path.resolve(__dirname, '..', '..', 'assets') }, logger } as unknown as AppContext;
    const content = { flow: SHIPPED_FLOW, npc: SHIPPED_PATCH };
    const shown = (view: EquipmentOnboardingView) => fileNames(buildOnboardingView(ctx, view, content));
    // Only the explanation ships scene art today; every other step is text-only.
    expect(shown({ kind: 'explain', stats: STATS } as EquipmentOnboardingView)).toEqual(['onboarding_explain.webp']);
    for (const view of [
      { kind: 'intro' },
      handover('attack', null),
      { kind: 'needs_buddy' },
      { kind: 'complete', stats: STATS, report: null },
    ] as EquipmentOnboardingView[]) {
      expect(shown(view)).toEqual([]);
    }
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

/* ───────────────────────── failure ───────────────────────── */

describe('missing artwork', () => {
  it('missing scene art warns and falls back to Patch', () => {
    const { ctx, logger } = makeCtx();
    const payload = buildOnboardingView(ctx, { kind: 'intro' }, contentWith({ art: { intro: 'onboarding/equipment/gone.webp' } }));
    expect(fileNames(payload)).toEqual(['npc_patch.webp']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'equipment-onboarding/artwork-missing', artwork: 'onboarding/equipment/gone.webp' }),
      expect.any(String),
    );
  });

  it('missing scene art and a missing portrait still render the screen, text-only', () => {
    const { ctx, logger } = makeCtx();
    const payload = buildOnboardingView(
      ctx,
      { kind: 'complete', stats: STATS, report: null },
      contentWith({ npc: { ...PATCH, portraitPath: 'npcs/nobody.webp' }, art: { complete: 'onboarding/equipment/gone.webp' } }),
    );
    expect(payload.files).toEqual([]);
    expect((payload.embeds?.[0] as { toJSON(): { title: string } }).toJSON().title).toBe('Equipment Unlocked');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('an unsafe path that slipped past the schema is refused at render, not served', () => {
    const { ctx, logger } = makeCtx();
    const payload = buildOnboardingView(ctx, { kind: 'intro' }, contentWith({ npc: { ...PATCH, portraitPath: '../outside.webp' } }));
    expect(payload.files).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ tag: 'npc-portrait/artwork-unsafe' }), expect.any(String));
  });
});

/* ───────────────────────── screens & repaints ───────────────────────── */

describe('every screen', () => {
  it('no-Buddy: its own art when authored, else Patch', () => {
    const { ctx } = makeCtx();
    expect(fileNames(buildOnboardingView(ctx, { kind: 'needs_buddy' }, contentWith({ art: { noBuddy: 'onboarding/equipment/no_buddy.webp' } })))).toEqual(
      ['onboarding_no_buddy.webp'],
    );
    expect(fileNames(buildOnboardingView(ctx, { kind: 'needs_buddy' }, contentWith()))).toEqual(['npc_patch.webp']);
  });

  it('explain and complete use their own scene art', () => {
    const { ctx } = makeCtx();
    const content = contentWith({ art: { explain: 'onboarding/equipment/explain.webp', complete: 'onboarding/equipment/complete.webp' } });
    expect(fileNames(buildOnboardingView(ctx, { kind: 'explain', stats: STATS }, content))).toEqual(['onboarding_explain.webp']);
    expect(fileNames(buildOnboardingView(ctx, { kind: 'complete', stats: STATS, report: null }, content))).toEqual([
      'onboarding_complete.webp',
    ]);
  });

  it('unavailable carries no attachment', () => {
    const { ctx } = makeCtx();
    expect(buildOnboardingView(ctx, { kind: 'unavailable', reason: 'disabled' }, contentWith()).files).toEqual([]);
    expect(buildOnboardingView(ctx, { kind: 'intro' }, null).files).toEqual([]);
  });
});

const prov = { playerId: 7, guildDbId: 3 } as unknown as Provisioned;

/** A fake button interaction that records exactly what discord.js would be sent. */
function makeInteraction() {
  const painted: { files?: unknown[]; embeds?: unknown[] }[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as { files?: unknown[] });
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

function serviceReturning(content: OnboardingPresenterContent, ...views: EquipmentOnboardingView[]) {
  const next = vi.fn(async () => views.shift()!);
  return { open: next, advance: next, complete: next, content: () => content } as unknown as EquipmentOnboardingService;
}

const paintedNames = (p: { files?: unknown[] }) => (p.files ?? []).map((f) => (f as { name: string }).name);

describe('repaints', () => {
  it('moving to the next step replaces the previous step’s picture', async () => {
    const { ctx } = makeCtx();
    const content = contentWith({ art: { intro: 'onboarding/equipment/intro.webp' } });
    const service = serviceReturning(content, { kind: 'intro' }, handover('attack', null));
    const { interaction, painted } = makeInteraction();
    const appCtx = { ...ctx, services: { equipmentOnboarding: service } } as unknown as AppContext;

    await handleOnboardingOpen(appCtx, interaction as never, prov, ['equipment']);
    await handleOnboardingAdvance(appCtx, interaction as never, prov, ['equipment', 'intro']);

    expect(paintedNames(painted[0]!)).toEqual(['onboarding_intro.webp']);
    // The full file list is sent on every edit, so the intro art is dropped.
    expect(paintedNames(painted[1]!)).toEqual(['npc_patch.webp']);
  });

  it('a text-only step after an illustrated one sends an empty file list, clearing the old image', async () => {
    const { ctx } = makeCtx();
    const content = contentWith({ npc: null, art: { intro: 'onboarding/equipment/intro.webp' } });
    const service = serviceReturning(content, { kind: 'intro' }, handover('defense', null));
    const { interaction, painted } = makeInteraction();
    const appCtx = { ...ctx, services: { equipmentOnboarding: service } } as unknown as AppContext;

    await handleOnboardingOpen(appCtx, interaction as never, prov, ['equipment']);
    await handleOnboardingAdvance(appCtx, interaction as never, prov, ['equipment', 'intro']);

    expect(paintedNames(painted[0]!)).toEqual(['onboarding_intro.webp']);
    expect(painted[1]!.files).toEqual([]);
  });

  it('resume paints the art of the step the player is actually on', async () => {
    const { ctx } = makeCtx();
    const content = contentWith({ art: { intro: 'onboarding/equipment/intro.webp', explain: 'onboarding/equipment/explain.webp' } });
    const service = serviceReturning(content, { kind: 'explain', stats: STATS });
    const { interaction, painted } = makeInteraction();
    await handleOnboardingOpen({ ...ctx, services: { equipmentOnboarding: service } } as unknown as AppContext, interaction as never, prov, [
      'equipment',
    ]);
    expect(paintedNames(painted[0]!)).toEqual(['onboarding_explain.webp']);
  });

  it('a stale button repaints the current step with that step’s art, not the button’s', async () => {
    const { ctx } = makeCtx();
    const content = contentWith({ art: { intro: 'onboarding/equipment/intro.webp', complete: 'onboarding/equipment/complete.webp' } });
    // The intro button is pressed, but the service says the player has finished.
    const service = serviceReturning(content, { kind: 'complete', stats: STATS, report: null });
    const { interaction, painted } = makeInteraction();
    await handleOnboardingAdvance({ ...ctx, services: { equipmentOnboarding: service } } as unknown as AppContext, interaction as never, prov, [
      'equipment',
      'intro',
    ]);
    expect(paintedNames(painted[0]!)).toEqual(['onboarding_complete.webp']);
  });

  it('switching the onboarding off mid-flow clears the picture', async () => {
    const { ctx } = makeCtx();
    const service = serviceReturning(contentWith(), { kind: 'intro' }, { kind: 'unavailable', reason: 'disabled' });
    const { interaction, painted } = makeInteraction();
    const appCtx = { ...ctx, services: { equipmentOnboarding: service } } as unknown as AppContext;
    await handleOnboardingOpen(appCtx, interaction as never, prov, ['equipment']);
    await handleOnboardingAdvance(appCtx, interaction as never, prov, ['equipment', 'intro']);
    expect(paintedNames(painted[0]!)).toEqual(['npc_patch.webp']);
    expect(painted[1]!.files).toEqual([]);
    expect(painted[1]!.embeds).toEqual([]);
  });
});
