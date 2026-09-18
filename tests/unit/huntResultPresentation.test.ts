/**
 * Authored Result Presentations on the Discord hunt and release screens.
 *
 * Every test hands the handler an *already-resolved* gameplay result and a
 * presentation service double backed by the real pure resolver. What must
 * hold:
 *
 *   - authored prose appears, but every mechanical line (amount, balance,
 *     item, quantity, Buddy lines, Energy) is still the result's own;
 *   - presentation is resolved once per screen, and a missing image degrades
 *     to text without a second roll;
 *   - when a World Encounter takes the turn, the granted reward is handed to
 *     it as a one-line summary and no find presentation is chosen;
 *   - Let Her Go shows her art by default, honours authored modes, and works
 *     the same for spawned encounters.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { maybeTriggerHuntEncounter, resolveAppearanceAssetOrPath } = vi.hoisted(() => ({
  maybeTriggerHuntEncounter: vi.fn(async (..._args: unknown[]) => false),
  resolveAppearanceAssetOrPath: vi.fn(),
}));

vi.mock('../../src/discord/commands/waifumonWorldEncounter', () => ({
  maybeTriggerHuntEncounter,
}));
vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  renderOwnedCardAttachment: vi.fn(async () => null),
  renderEncounterDuplicateCardAttachment: vi.fn(async () => null),
}));
vi.mock('../../src/discord/assets/resolveAppearanceAsset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/discord/assets/resolveAppearanceAsset')>()),
  resolveAppearanceAsset: vi.fn(() => null),
  resolveAppearanceAssetOrPath,
}));

import { handleEncounterRelease, handleHunt } from '../../src/discord/commands/waifumonHunt';
import { buddyBonusFeedbackLines } from '../../src/discord/buddyBonusFeedback';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type { HuntResult } from '../../src/modules/hunt/huntService';
import type { AppliedBuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import type { ResultPresentationKey } from '../../src/modules/resultPresentation/keys';
import {
  resolveResultPresentation,
  type ResultPresentationVariant,
} from '../../src/modules/resultPresentation/resolver';
import type { ResolvePresentationOptions } from '../../src/modules/resultPresentation/resultPresentationService';
import { seededRng } from '../../src/shared/random';

const PLAYER_ID = 7;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;
const FLAVOR_POOL = ['A heart-shaped rock.', 'Only the wind.'];

let assetsDir: string;
beforeAll(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-presentation-'));
  fs.mkdirSync(path.join(assetsDir, 'results'));
  fs.writeFileSync(path.join(assetsDir, 'results', 'coins.webp'), 'x');
  fs.writeFileSync(path.join(assetsDir, 'results', 'wave.jpg'), 'x');
  // A file outside the assets directory, linked from inside it; and a link
  // that stays inside.
  fs.writeFileSync(path.join(path.dirname(assetsDir), `${path.basename(assetsDir)}-secret.png`), 'secret');
  fs.symlinkSync(
    path.join(path.dirname(assetsDir), `${path.basename(assetsDir)}-secret.png`),
    path.join(assetsDir, 'results', 'escape.png'),
  );
  fs.symlinkSync(path.join(assetsDir, 'results', 'coins.webp'), path.join(assetsDir, 'results', 'alias.webp'));
});
afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(assetsDir), `${path.basename(assetsDir)}-secret.png`), { force: true });
});

beforeEach(() => {
  maybeTriggerHuntEncounter.mockReset();
  maybeTriggerHuntEncounter.mockResolvedValue(false);
  resolveAppearanceAssetOrPath.mockReset();
  resolveAppearanceAssetOrPath.mockImplementation(
    () => new AttachmentBuilder(Buffer.from('art'), { name: 'card.png' }),
  );
});

type Body = { content?: string; embeds?: unknown[]; components?: unknown[]; files?: unknown[] };
type EmbedJson = {
  title?: string;
  description?: string;
  footer?: { text?: string };
  image?: { url?: string };
};

function makeInteraction() {
  const bodies: Body[] = [];
  const record = vi.fn(async (body: Body) => {
    bodies.push(body);
  });
  return {
    bodies,
    interaction: {
      channelId: 'c-1',
      replied: false,
      deferred: false,
      user: { id: 'u-1' },
      isButton: () => true,
      isStringSelectMenu: () => false,
      update: record,
      reply: record,
      editReply: record,
      followUp: record,
    },
  };
}

let nextId = 100;
function variant(
  key: ResultPresentationKey,
  overrides: Partial<ResultPresentationVariant> = {},
): ResultPresentationVariant {
  return {
    id: nextId++,
    presentationKey: key,
    enabled: true,
    weight: 1,
    flavorText: null,
    artworkPath: null,
    artworkMode: 'none',
    ...overrides,
  };
}

/** A presentation service double backed by the real resolver. */
function presentationService(variants: ResultPresentationVariant[]) {
  return {
    resolve: vi.fn(async (key: ResultPresentationKey, options: ResolvePresentationOptions = {}) =>
      resolveResultPresentation({
        key,
        variants: variants.filter((v) => v.presentationKey === key),
        fallbackFlavorLines: options.fallbackFlavorLines,
        rng: seededRng(11),
      }),
    ),
  };
}

const speciesRow = {
  id: 3,
  slug: 'neko_barista',
  name: 'Neko Barista',
  rarity: 'SR',
  archetype: 'neko',
  affinity: 'sweet',
  imagePath: 'waifumon/neko_barista/default.png',
};

function makeCtx(opts: {
  result?: HuntResult;
  presentation?: ReturnType<typeof presentationService> | undefined;
  species?: typeof speciesRow | null | 'throws';
  letHerGo?: (...args: unknown[]) => Promise<unknown>;
}) {
  const warn = vi.fn();
  const error = vi.fn();
  // Both `loadPlayerLevel` and `loadSpeciesById` read through this chain.
  const select = (shape?: unknown) => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          if (shape) return [{ level: 10 }];
          if (opts.species === 'throws') throw new Error('db down');
          return opts.species === null ? [] : [opts.species ?? speciesRow];
        },
      }),
    }),
  });
  const ctx = {
    config: { assetsDir },
    logger: { warn, error, info: vi.fn(), debug: vi.fn() },
    db: { select },
    content: { tables: { hunt: { flavor: FLAVOR_POOL } }, items: [] },
    events: { emit: vi.fn() },
    huntSessions: { open: vi.fn(), close: vi.fn() },
    services: {
      hunt: {
        hunt: vi.fn(async () => opts.result),
        letHerGo: opts.letHerGo ?? vi.fn(async () => releasedRow()),
      },
      session: {
        ensureSession: vi.fn(async () => ({ id: 1 })),
        recordEvent: vi.fn(async () => {}),
      },
      travel: { getCurrentRegion: vi.fn(async () => 'waifu-valley') },
      appearance: { currentAppearance: vi.fn(() => ({ assetId: { kind: 'waifumon' } })) },
      ...(opts.presentation ? { resultPresentation: opts.presentation } : {}),
    },
  } as unknown as AppContext;
  return { ctx, warn, error };
}

function releasedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 55,
    playerId: PLAYER_ID,
    speciesId: 3,
    channelId: 'c-1',
    state: 'released',
    attemptCount: 1,
    maxAttempts: 3,
    selectedItemId: null,
    regionId: 'waifu-valley',
    originKind: null,
    originRef: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    resolvedAt: new Date(),
    ...overrides,
  };
}

const base = {
  levelUps: [],
  buddyAward: null,
  buddyBonuses: [] as AppliedBuddyBonus[],
  careExit: null,
  energySaved: false,
  energyRemaining: 4,
  session: { opened: false, closedPreviousReason: null, at: new Date(), previousLastHuntAt: null },
};
const silk = { id: 11, slug: 'silk_charm', name: 'Silk Charm', emoji: '🪢', enabled: true };
const velvet = { id: 12, slug: 'velvet_charm', name: 'Velvet Charm', emoji: '💜', enabled: true };

const results = {
  waifubux: { ...base, kind: 'waifubux_find', amount: 12, balanceAfter: 112 } as HuntResult,
  essence: { ...base, kind: 'essence_find', amount: 26, balanceAfter: 226 } as HuntResult,
  item: { ...base, kind: 'item_find', item: silk, quantity: 2 } as unknown as HuntResult,
  rare: { ...base, kind: 'rare_item_find', item: velvet, quantity: 1 } as unknown as HuntResult,
  nothing: { ...base, kind: 'flavor' } as HuntResult,
};

const embedOf = (body: Body): EmbedJson => JSON.parse(JSON.stringify(body.embeds?.[0] ?? {}));
const fileNames = (body: Body): Array<string | null> =>
  (body.files ?? []).map((f) => (f as { name: string | null }).name);

async function hunt(result: HuntResult, presentation?: ReturnType<typeof presentationService>) {
  const { bodies, interaction } = makeInteraction();
  const made = makeCtx({ result, presentation });
  await handleHunt(made.ctx, interaction as never, prov);
  return { ...made, bodies, body: bodies[bodies.length - 1]! };
}

describe('authored flavor on hunt finds', () => {
  it('shows authored prose above the authoritative WaifuBux line', async () => {
    const svc = presentationService([
      variant('hunt.waifubux_find', { flavorText: 'Coins under a bench!' }),
    ]);
    const { body } = await hunt(results.waifubux, svc);
    const embed = embedOf(body);
    expect(embed.title).toBe('💰 WaifuBux Found');
    expect(embed.description).toBe('Coins under a bench!\n\n+**12** WaifuBux (balance: 112)');
    expect(embed.footer?.text).toBe('Energy left: 4');
    expect(svc.resolve).toHaveBeenCalledTimes(1);
    expect(svc.resolve.mock.calls[0]![0]).toBe('hunt.waifubux_find');
  });

  it('keeps the Essence amount and Buddy Bonus feedback authoritative', async () => {
    const bonus: AppliedBuddyBonus = {
      name: 'Extra Serving',
      effectId: 'essence_gain',
      value: 30,
      target: null,
      targetLabel: null,
      baseValue: 20,
      finalValue: 26,
    };
    const svc = presentationService([
      // Prose that *mentions* a different number changes nothing mechanical.
      variant('hunt.essence_find', { flavorText: 'Worth at least 999 Essence!' }),
    ]);
    const { body } = await hunt({ ...results.essence, buddyBonuses: [bonus] } as HuntResult, svc);
    const description = embedOf(body).description!;
    expect(description).toContain('+**26** Essence (balance: 226)');
    for (const line of buddyBonusFeedbackLines([bonus])) expect(description).toContain(line);
    expect(description.startsWith('Worth at least 999 Essence!')).toBe(true);
  });

  it('keeps item name and quantity, and the rare distinction', async () => {
    const svc = presentationService([
      variant('hunt.item_find', { flavorText: 'Tangled in the brambles.' }),
      variant('hunt.rare_item_find', { flavorText: 'It hums with power.' }),
    ]);
    const item = embedOf((await hunt(results.item, svc)).body);
    expect(item.title).toBe('🎒 Item Found');
    expect(item.description).toBe('Tangled in the brambles.\n\n🪢 **Silk Charm** ×2');

    const rare = embedOf((await hunt(results.rare, svc)).body);
    expect(rare.title).toBe('🌟 Rare Find!');
    expect(rare.description).toBe('It hums with power.\n\n💜 **Velvet Charm** ×1');
    expect(svc.resolve.mock.calls.map((c) => c[0])).toEqual(['hunt.item_find', 'hunt.rare_item_find']);
  });

  it('shows the plain find when there is no authored text', async () => {
    const { body } = await hunt(results.waifubux, presentationService([]));
    expect(embedOf(body).description).toBe('+**12** WaifuBux (balance: 112)');
    expect(body.files ?? []).toEqual([]);
  });

  it('keeps level-up and Buddy lines after the find', async () => {
    const svc = presentationService([variant('hunt.waifubux_find', { flavorText: 'Shiny.' })]);
    const { body } = await hunt(
      {
        ...results.waifubux,
        levelUps: [{ fromLevel: 1, toLevel: 2, rewardLabels: [] }],
      } as unknown as HuntResult,
      svc,
    );
    expect(embedOf(body).description).toBe(
      'Shiny.\n\n+**12** WaifuBux (balance: 112)\n\n⬆️ **Level 2!**',
    );
  });
});

describe('nothing found', () => {
  it('uses authored text instead of the content pool', async () => {
    const svc = presentationService([
      variant('hunt.nothing_found', { flavorText: 'A crow laughs at you.' }),
    ]);
    const { body } = await hunt(results.nothing, svc);
    expect(embedOf(body).title).toBe('🍃 Nothing but wind…');
    expect(embedOf(body).description).toBe('A crow laughs at you.');
    expect(svc.resolve.mock.calls[0]).toEqual([
      'hunt.nothing_found',
      { fallbackFlavorLines: FLAVOR_POOL },
    ]);
  });

  it('falls back to the content pool without a variant, service or no service', async () => {
    for (const svc of [presentationService([]), undefined]) {
      const { body } = await hunt(results.nothing, svc);
      expect(FLAVOR_POOL).toContain(embedOf(body).description);
    }
  });

  it('only finds get the pool; other keys get no fallback lines', async () => {
    const svc = presentationService([]);
    await hunt(results.item, svc);
    expect(svc.resolve.mock.calls[0]).toEqual(['hunt.item_find', { fallbackFlavorLines: [] }]);
  });
});

describe('custom artwork on hunt finds', () => {
  it('attaches the image under its real extension', async () => {
    const svc = presentationService([
      variant('hunt.waifubux_find', { artworkMode: 'custom', artworkPath: 'results/coins.webp' }),
    ]);
    const { body } = await hunt(results.waifubux, svc);
    expect(fileNames(body)).toEqual(['result_hunt_waifubux_find.webp']);
    expect(embedOf(body).image?.url).toBe('attachment://result_hunt_waifubux_find.webp');
    expect(embedOf(body).description).toBe('+**12** WaifuBux (balance: 112)');
  });

  it('degrades to text when the file is missing, logs once, and does not re-roll', async () => {
    const svc = presentationService([
      variant('hunt.item_find', {
        flavorText: 'Something glints.',
        artworkMode: 'custom',
        artworkPath: 'results/absent.png',
      }),
    ]);
    const { body, warn } = await hunt(results.item, svc);
    expect(body.files ?? []).toEqual([]);
    expect(embedOf(body).image).toBeUndefined();
    expect(embedOf(body).description).toBe('Something glints.\n\n🪢 **Silk Charm** ×2');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ tag: 'result-presentation/artwork-missing' });
    expect(svc.resolve).toHaveBeenCalledTimes(1);
  });

  it('refuses a stored path that escapes the assets directory', async () => {
    const svc = presentationService([
      variant('hunt.waifubux_find', { artworkMode: 'custom', artworkPath: '../../secrets.png' }),
    ]);
    const { body, error } = await hunt(results.waifubux, svc);
    expect(body.files ?? []).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('attaches artwork reached through a symlink that stays inside assets', async () => {
    const svc = presentationService([
      variant('hunt.waifubux_find', { artworkMode: 'custom', artworkPath: 'results/alias.webp' }),
    ]);
    const { body } = await hunt(results.waifubux, svc);
    expect(fileNames(body)).toEqual(['result_hunt_waifubux_find.webp']);
  });

  it('a symlink out of assets degrades to text-only: same result, logged, no re-roll', async () => {
    const svc = presentationService([
      variant('hunt.waifubux_find', {
        flavorText: 'A purse!',
        artworkMode: 'custom',
        artworkPath: 'results/escape.png',
      }),
    ]);
    const { body, error } = await hunt(results.waifubux, svc);
    expect(body.files ?? []).toEqual([]);
    expect(embedOf(body).image).toBeUndefined();
    // The already-committed reward is still what the player sees.
    expect(embedOf(body).description).toBe('A purse!\n\n+**12** WaifuBux (balance: 112)');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ tag: 'result-presentation/artwork-unsafe' });
    expect(svc.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('World Encounter takes the turn ("Along the way")', () => {
  it.each([
    ['waifubux', '💰 +12 WaifuBux'],
    ['essence', '✨ +26 Essence'],
    ['item', '🎒 Found 🪢 **Silk Charm** ×2'],
    ['rare', '🌟 Rare find: 💜 **Velvet Charm** ×1'],
  ] as const)('hands the %s already granted to the encounter screen', async (which, summary) => {
    maybeTriggerHuntEncounter.mockResolvedValue(true);
    const svc = presentationService([variant('hunt.waifubux_find', { flavorText: 'unused' })]);
    const { bodies } = await hunt(results[which], svc);
    expect(maybeTriggerHuntEncounter).toHaveBeenCalledTimes(1);
    expect(maybeTriggerHuntEncounter.mock.calls[0]![3]).toMatchObject({ alongTheWay: summary });
    // The encounter paints the screen; no find screen and no find presentation.
    expect(bodies).toHaveLength(0);
    expect(svc.resolve).not.toHaveBeenCalled();
  });

  it('does not summarise "nothing found"', async () => {
    maybeTriggerHuntEncounter.mockResolvedValue(true);
    await hunt(results.nothing, presentationService([]));
    expect(maybeTriggerHuntEncounter.mock.calls[0]![3]).toMatchObject({ alongTheWay: null });
  });

  it('still offers the summary when the encounter does not fire, then paints the find', async () => {
    const { body } = await hunt(results.waifubux, presentationService([]));
    expect(maybeTriggerHuntEncounter.mock.calls[0]![3]).toMatchObject({
      alongTheWay: '💰 +12 WaifuBux',
    });
    expect(embedOf(body).title).toBe('💰 WaifuBux Found');
  });
});

describe('Let Her Go', () => {
  async function release(opts: Parameters<typeof makeCtx>[0] = {}) {
    const { bodies, interaction } = makeInteraction();
    const made = makeCtx(opts);
    await handleEncounterRelease(made.ctx, interaction as never, prov, ['55']);
    return { ...made, body: bodies[bodies.length - 1]! };
  }

  it('by default shows her canonical artwork with the built-in line', async () => {
    for (const presentation of [undefined, presentationService([])]) {
      const { body } = await release({ presentation });
      const embed = embedOf(body);
      expect(embed.title).toBe('👋 You let Neko Barista go');
      expect(embed.description).toBe('You let her slip back into the neon~');
      expect(embed.image?.url).toBe('attachment://card.png');
      expect(fileNames(body)).toEqual(['card.png']);
      expect(body.content).toBe('');
    }
    expect(resolveAppearanceAssetOrPath).toHaveBeenCalled();
  });

  it('asks for the encounter.released presentation with the built-in line as fallback', async () => {
    const svc = presentationService([]);
    await release({ presentation: svc });
    expect(svc.resolve).toHaveBeenCalledTimes(1);
    expect(svc.resolve.mock.calls[0]).toEqual([
      'encounter.released',
      { fallbackFlavorLines: ['You let her slip back into the neon~'] },
    ]);
  });

  it('authored encountered mode: her art with authored text', async () => {
    const svc = presentationService([
      variant('encounter.released', { flavorText: 'She blows a kiss and vanishes.', artworkMode: 'encountered' }),
    ]);
    const { body } = await release({ presentation: svc });
    expect(embedOf(body).description).toBe('She blows a kiss and vanishes.');
    expect(fileNames(body)).toEqual(['card.png']);
  });

  it('authored custom mode: the variant image instead of hers', async () => {
    const svc = presentationService([
      variant('encounter.released', { artworkMode: 'custom', artworkPath: 'results/wave.jpg' }),
    ]);
    const { body } = await release({ presentation: svc });
    expect(fileNames(body)).toEqual(['result_encounter_released.jpg']);
    expect(embedOf(body).image?.url).toBe('attachment://result_encounter_released.jpg');
    // Artwork-only variant keeps the built-in line.
    expect(embedOf(body).description).toBe('You let her slip back into the neon~');
    expect(resolveAppearanceAssetOrPath).not.toHaveBeenCalled();
  });

  it('authored none mode: no image at all', async () => {
    const svc = presentationService([
      variant('encounter.released', { flavorText: 'Gone.', artworkMode: 'none' }),
    ]);
    const { body } = await release({ presentation: svc });
    expect(body.files ?? []).toEqual([]);
    expect(embedOf(body).image).toBeUndefined();
    expect(resolveAppearanceAssetOrPath).not.toHaveBeenCalled();
  });

  it('missing custom artwork degrades to text, not to her art', async () => {
    const svc = presentationService([
      variant('encounter.released', { artworkMode: 'custom', artworkPath: 'results/nope.webp' }),
    ]);
    const { body, warn } = await release({ presentation: svc });
    expect(body.files ?? []).toEqual([]);
    expect(embedOf(body).title).toBe('👋 You let Neko Barista go');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(svc.resolve).toHaveBeenCalledTimes(1);
  });

  it('works the same for a Waifumon spawned by a World Encounter', async () => {
    const letHerGo = vi.fn(async () =>
      releasedRow({ id: 77, originKind: 'world_encounter', originRef: '12', channelId: 'c-9' }),
    );
    const { bodies, interaction } = makeInteraction();
    const { ctx } = makeCtx({ letHerGo });
    await handleEncounterRelease(ctx, interaction as never, prov, ['77']);
    expect(letHerGo).toHaveBeenCalledWith(PLAYER_ID, 77);
    const body = bodies[bodies.length - 1]!;
    expect(embedOf(body).title).toBe('👋 You let Neko Barista go');
    expect(fileNames(body)).toEqual(['card.png']);
  });

  it('still answers if her species row cannot be read', async () => {
    for (const species of [null, 'throws'] as const) {
      const { body } = await release({ species });
      expect(embedOf(body).title).toBe('👋 You let her go');
      expect(embedOf(body).description).toBe('You let her slip back into the neon~');
      expect(body.files ?? []).toEqual([]);
    }
  });

  it('still answers if her artwork cannot be resolved', async () => {
    resolveAppearanceAssetOrPath.mockImplementation(() => {
      throw new Error('bad asset id');
    });
    const { body, warn } = await release();
    expect(embedOf(body).title).toBe('👋 You let Neko Barista go');
    expect(body.files ?? []).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
