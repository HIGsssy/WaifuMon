/**
 * The two presentation keys added after Phase 2, at the Discord handler
 * boundary:
 *
 *   `world_encounter.back_to_hunting`  — the exit from a resolved hunt-origin
 *       World Encounter;
 *   `collection.converted_to_essence`  — the result of converting a copy.
 *
 * What these pin:
 *   - with no authored variant, both screens keep exactly the copy, facts and
 *     navigation they had before;
 *   - authored prose is additional, and never replaces a mechanical line;
 *   - navigation is code-owned in both cases;
 *   - presentation is resolved *after* the gameplay call, once, and a refused
 *     action resolves none at all;
 *   - artwork degrades to text without touching the committed outcome.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveAppearanceAsset } = vi.hoisted(() => ({
  resolveAppearanceAsset: vi.fn(),
}));

vi.mock('../../src/discord/assets/resolveAppearanceAsset', () => ({
  CARD_FILENAME: 'card.png',
  resolveAppearanceAsset,
  resolveAppearanceAssetOrPath: vi.fn(() => null),
}));

import { handleHuntReturn } from '../../src/discord/commands/waifumonHunt';
import {
  handleDuplicateConvert,
  handleWaifuConvertConfirm,
} from '../../src/discord/commands/waifumonCollection';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type { ResultPresentationKey } from '../../src/modules/resultPresentation/keys';
import {
  presentVariant,
  resolveResultPresentation,
  type ResultPresentationVariant,
} from '../../src/modules/resultPresentation/resolver';
import { BACK_TO_HUNTING_FALLBACK_LINES } from '../../src/modules/resultPresentation/screens';
import { seededRng } from '../../src/shared/random';
import { NotADuplicateError } from '../../src/shared/errors';

const PLAYER_ID = 7;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;
const BUILT_IN_LINE = BACK_TO_HUNTING_FALLBACK_LINES[0]!;

let assetsDir: string;
beforeAll(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-extra-keys-'));
  fs.mkdirSync(path.join(assetsDir, 'results'));
  fs.writeFileSync(path.join(assetsDir, 'results', 'trail.webp'), 'x');
});
afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

beforeEach(() => {
  resolveAppearanceAsset.mockReset();
  resolveAppearanceAsset.mockImplementation(
    () => new AttachmentBuilder(Buffer.from('art'), { name: 'card.png' }),
  );
});

type Body = { content?: string; embeds?: unknown[]; components?: unknown[]; files?: unknown[] };

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

let variantId = 500;
function variant(
  key: ResultPresentationKey,
  overrides: Partial<ResultPresentationVariant> = {},
): ResultPresentationVariant {
  return {
    id: variantId++,
    presentationKey: key,
    enabled: true,
    weight: 1,
    flavorText: null,
    artworkPath: null,
    artworkMode: 'none',
    ...overrides,
  };
}

/** A presentation service double backed by the real single-variant resolver. */
function presentationService(variants: ResultPresentationVariant[]) {
  return {
    resolve: vi.fn(
      async (key: ResultPresentationKey, options: { fallbackFlavorLines?: readonly string[] } = {}) => {
        const mine = variants.filter((v) => v.presentationKey === key && v.enabled);
        const chosen = mine[0];
        // No variant: exactly what the real service does — the built-in
        // presentation, including the key's default artwork mode.
        if (!chosen) {
          return resolveResultPresentation({
            key,
            variants: [],
            fallbackFlavorLines: options.fallbackFlavorLines,
            rng: seededRng(1),
          });
        }
        return presentVariant(key, chosen, options.fallbackFlavorLines, seededRng(1));
      },
    ),
  };
}

const embedOf = (body: Body) =>
  JSON.parse(JSON.stringify(body.embeds?.[0] ?? {})) as {
    title?: string;
    description?: string;
    footer?: { text?: string };
    image?: { url?: string };
  };
const fileNames = (body: Body) =>
  (body.files ?? []).map((f) => (f as { name: string | null }).name);
const customIds = (body: Body) =>
  (JSON.stringify(body.components ?? []).match(/"custom_id":"([^"]+)"/g) ?? []).map((m) =>
    m.slice('"custom_id":"'.length, -1),
  );

/* ───────────────────────── Back to Hunting ───────────────────────── */

describe('world_encounter.back_to_hunting', () => {
  const STATUS = { currentRegionName: 'Twin Peeks', currentRegion: 'twin-peeks' };

  function makeCtx(opts: {
    presentation?: ReturnType<typeof presentationService> | undefined;
    huntReturn?: unknown;
  }) {
    const warn = vi.fn();
    const getHuntReturnContext = vi.fn(async () =>
      opts.huntReturn === undefined ? { regionId: 'twin-peeks' } : opts.huntReturn,
    );
    const ctx = {
      config: { assetsDir },
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      services: {
        worldEncounter: { getHuntReturnContext },
        travel: { getStatus: vi.fn(async () => STATUS) },
        currency: { getBalances: vi.fn(async () => ({ huntEnergy: 12 })) },
        ...(opts.presentation ? { resultPresentation: opts.presentation } : {}),
      },
    } as unknown as AppContext;
    return { ctx, warn, getHuntReturnContext };
  }

  async function paint(opts: Parameters<typeof makeCtx>[0] = {}) {
    const { bodies, interaction } = makeInteraction();
    const made = makeCtx(opts);
    await handleHuntReturn(made.ctx, interaction as never, prov, ['42']);
    return { ...made, body: bodies[bodies.length - 1]!, bodies };
  }

  it('keeps the built-in screen, copy and navigation with no authored variant', async () => {
    for (const presentation of [undefined, presentationService([])]) {
      const { body } = await paint({ presentation });
      const embed = embedOf(body);
      expect(embed.title).toBe('🏹 Hunting');
      expect(embed.description).toBe(`${BUILT_IN_LINE}\n\nYou are hunting in **Twin Peeks**.`);
      expect(embed.footer?.text).toBe('Energy left: 12');
      expect(customIds(body)).toEqual(['wm|v1|menu|hunt', 'wm|v1|menu|back']);
      expect(body.files ?? []).toEqual([]);
    }
  });

  it('asks for the key once, with the built-in line as the fallback', async () => {
    const svc = presentationService([]);
    await paint({ presentation: svc });
    expect(svc.resolve).toHaveBeenCalledTimes(1);
    expect(svc.resolve.mock.calls[0]).toEqual([
      'world_encounter.back_to_hunting',
      { fallbackFlavorLines: BACK_TO_HUNTING_FALLBACK_LINES },
    ]);
  });

  it('puts authored prose above the region and Energy, and keeps the buttons', async () => {
    const svc = presentationService([
      variant('world_encounter.back_to_hunting', { flavorText: 'The trail is warm again.' }),
    ]);
    const { body } = await paint({ presentation: svc });
    const embed = embedOf(body);
    expect(embed.description).toBe('The trail is warm again.\n\nYou are hunting in **Twin Peeks**.');
    expect(embed.footer?.text).toBe('Energy left: 12');
    expect(customIds(body)).toEqual(['wm|v1|menu|hunt', 'wm|v1|menu|back']);
  });

  it('attaches custom artwork under its real extension', async () => {
    const svc = presentationService([
      variant('world_encounter.back_to_hunting', {
        artworkMode: 'custom',
        artworkPath: 'results/trail.webp',
      }),
    ]);
    const { body } = await paint({ presentation: svc });
    expect(fileNames(body)).toEqual(['result_world_encounter_back_to_hunting.webp']);
    expect(embedOf(body).image?.url).toBe(
      'attachment://result_world_encounter_back_to_hunting.webp',
    );
  });

  it('degrades to text when the image is missing, and still says where you are', async () => {
    const svc = presentationService([
      variant('world_encounter.back_to_hunting', {
        artworkMode: 'custom',
        artworkPath: 'results/absent.png',
      }),
    ]);
    const { body, warn } = await paint({ presentation: svc });
    expect(body.files ?? []).toEqual([]);
    expect(embedOf(body).description).toContain('You are hunting in **Twin Peeks**.');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ tag: 'result-presentation/artwork-missing' });
  });

  it('resolves no presentation for a button it refuses', async () => {
    // A travel-origin encounter, someone else's, or a forged id: the service
    // answers null and this is not the Back to Hunting path at all.
    const svc = presentationService([]);
    const { body } = await paint({ presentation: svc, huntReturn: null });
    expect(svc.resolve).not.toHaveBeenCalled();
    expect(body.content).toBe('That button has expired — re-run /waifumon.');
    expect(body.embeds ?? []).toEqual([]);
  });

  it('never shows her artwork: there is no Waifumon on this screen', async () => {
    // `encountered` is not a legal mode for this key, but even if a row said
    // so the screen falls back to no image rather than inventing a subject.
    const svc = presentationService([
      variant('world_encounter.back_to_hunting', { artworkMode: 'encountered' }),
    ]);
    const { body } = await paint({ presentation: svc });
    expect(body.files ?? []).toEqual([]);
    expect(resolveAppearanceAsset).not.toHaveBeenCalled();
  });
});

/* ───────────────────────── Converted to Essence ───────────────────────── */

describe('collection.converted_to_essence', () => {
  const species = {
    id: 3,
    slug: 'neko_barista',
    name: 'Neko Barista',
    rarity: 'SR',
    imagePath: 'waifumon/neko_barista/default.png',
  };
  const waifu = { id: 55, playerId: PLAYER_ID, speciesId: 3, nickname: null, releasedAt: new Date() };

  function conversionResult(overrides: Record<string, unknown> = {}) {
    return {
      waifu,
      species,
      essenceGranted: 48,
      essenceBonus: null,
      balanceAfter: 1048,
      ...overrides,
    };
  }

  function makeCtx(opts: {
    presentation?: ReturnType<typeof presentationService> | undefined;
    result?: Record<string, unknown>;
    convert?: (...args: unknown[]) => Promise<unknown>;
  }) {
    const warn = vi.fn();
    const order: string[] = [];
    const convertDuplicateToEssence =
      opts.convert ??
      vi.fn(async () => {
        order.push('convert');
        return opts.result ?? conversionResult();
      });
    const presentation = opts.presentation;
    if (presentation) {
      const inner = presentation.resolve;
      presentation.resolve = vi.fn(async (...args: Parameters<typeof inner>) => {
        order.push('presentation');
        return inner(...args);
      }) as typeof inner;
    }
    const ctx = {
      config: { assetsDir },
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      services: {
        collection: {
          convertDuplicateToEssence,
          getOwned: vi.fn(async () => ({ waifu, species })),
        },
        appearance: { currentAppearance: vi.fn(() => ({ assetId: { kind: 'waifumon' } })) },
        ...(presentation ? { resultPresentation: presentation } : {}),
      },
    } as unknown as AppContext;
    return { ctx, warn, order, convertDuplicateToEssence };
  }

  /** The post-capture duplicate prompt. */
  async function convertFromPrompt(opts: Parameters<typeof makeCtx>[0] = {}) {
    const { bodies, interaction } = makeInteraction();
    const made = makeCtx(opts);
    await handleDuplicateConvert(made.ctx, interaction as never, prov, ['55']);
    return { ...made, body: bodies[bodies.length - 1]!, bodies };
  }

  /** Inspect → Convert (already past the favourite confirmation). */
  async function convertFromInspect(opts: Parameters<typeof makeCtx>[0] = {}) {
    const { bodies, interaction } = makeInteraction();
    const made = makeCtx(opts);
    await handleWaifuConvertConfirm(made.ctx, interaction as never, prov, ['55', 'force']);
    return { ...made, body: bodies[bodies.length - 1]!, bodies };
  }

  for (const [label, convert] of [
    ['post-capture prompt', convertFromPrompt],
    ['inspect', convertFromInspect],
  ] as const) {
    describe(label, () => {
      it('keeps the conversion facts and her artwork with no authored variant', async () => {
        for (const presentation of [undefined, presentationService([])]) {
          const { body } = await convert({ presentation });
          const embed = embedOf(body);
          expect(embed.title).toBe('✨ Converted Neko Barista to Essence');
          expect(embed.description).toBe('+**48** Essence (balance: 1048).');
          expect(embed.image?.url).toBe('attachment://card.png');
          expect(fileNames(body)).toEqual(['card.png']);
        }
      });

      it('converts exactly once, and only then resolves the presentation', async () => {
        const svc = presentationService([]);
        const { order, convertDuplicateToEssence } = await convert({ presentation: svc });
        expect(convertDuplicateToEssence).toHaveBeenCalledTimes(1);
        expect(svc.resolve).toHaveBeenCalledTimes(1);
        expect(svc.resolve.mock.calls[0]![0]).toBe('collection.converted_to_essence');
        expect(order).toEqual(['convert', 'presentation']);
      });

      it('adds authored prose above the code-generated facts', async () => {
        const svc = presentationService([
          variant('collection.converted_to_essence', {
            flavorText: 'Her lingering energy crystallizes in your hands…',
            artworkMode: 'encountered',
          }),
        ]);
        const { body } = await convert({ presentation: svc });
        expect(embedOf(body).description).toBe(
          'Her lingering energy crystallizes in your hands…\n\n+**48** Essence (balance: 1048).',
        );
        expect(fileNames(body)).toEqual(['card.png']);
      });

      it('keeps the Buddy Bonus line code-owned', async () => {
        const svc = presentationService([
          variant('collection.converted_to_essence', { flavorText: 'Worth 9999 Essence!' }),
        ]);
        const { body } = await convert({
          presentation: svc,
          result: conversionResult({
            essenceGranted: 62,
            balanceAfter: 1062,
            essenceBonus: {
              name: 'Extra Serving',
              effectId: 'essence_gain',
              value: 30,
              target: null,
              targetLabel: null,
              baseValue: 48,
              finalValue: 62,
            },
          }),
        });
        const description = embedOf(body).description!;
        expect(description).toContain('+**62** Essence (balance: 1062).');
        expect(description).toContain('Extra Serving');
        expect(description.startsWith('Worth 9999 Essence!')).toBe(true);
      });

      it('honours custom and no-artwork modes', async () => {
        const custom = await convert({
          presentation: presentationService([
            variant('collection.converted_to_essence', {
              artworkMode: 'custom',
              artworkPath: 'results/trail.webp',
            }),
          ]),
        });
        expect(fileNames(custom.body)).toEqual(['result_collection_converted_to_essence.webp']);
        expect(resolveAppearanceAsset).not.toHaveBeenCalled();

        const none = await convert({
          presentation: presentationService([
            variant('collection.converted_to_essence', { artworkMode: 'none' }),
          ]),
        });
        expect(none.body.files ?? []).toEqual([]);
        expect(embedOf(none.body).description).toBe('+**48** Essence (balance: 1048).');
      });

      it('still reports the conversion when her artwork cannot be resolved', async () => {
        resolveAppearanceAsset.mockImplementation(() => {
          throw new Error('bad asset id');
        });
        const { body, warn } = await convert({ presentation: presentationService([]) });
        expect(body.files ?? []).toEqual([]);
        expect(embedOf(body).description).toBe('+**48** Essence (balance: 1048).');
        expect(warn).toHaveBeenCalled();
      });

      it('keeps its own navigation', async () => {
        const { body } = await convert({ presentation: presentationService([]) });
        const ids = customIds(body);
        expect(ids).toContain('wm|v1|menu|back');
        if (label === 'inspect') expect(ids).toContain('wm|v1|menu|collection');
        else expect(ids).not.toContain('wm|v1|menu|collection');
      });

      it('resolves no presentation when the conversion is refused', async () => {
        const svc = presentationService([]);
        const { body } = await convert({
          presentation: svc,
          convert: vi.fn(async () => {
            throw new NotADuplicateError(55);
          }),
        });
        expect(svc.resolve).not.toHaveBeenCalled();
        expect(body.content).toBe(new NotADuplicateError(55).userMessage);
        expect(body.embeds ?? []).toEqual([]);
      });
    });
  }

  it('shows her nickname on Inspect and her species name post-capture', async () => {
    const nicknamed = conversionResult({
      waifu: { ...waifu, nickname: 'Beans' },
    });
    const prompt = await convertFromPrompt({ result: nicknamed });
    expect(embedOf(prompt.body).title).toBe('✨ Converted Neko Barista to Essence');
    const inspect = await convertFromInspect({ result: nicknamed });
    expect(embedOf(inspect.body).title).toBe('✨ Converted Beans (Neko Barista) to Essence');
  });
});
