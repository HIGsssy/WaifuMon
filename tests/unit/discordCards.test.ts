/**
 * Rendered cards on the Discord surfaces.
 *
 * Three surfaces switched to owned cards — capture success, the rare public
 * announcement, and inspect — and everything else deliberately did not. The
 * rules that matter:
 *
 *   - a card is an *enhancement*: when rendering is off, or fails, the surface
 *     falls back to the raw artwork it always showed and the player sees no
 *     configuration error;
 *   - only a copy that exists gets an owned card, so escapes and resists stay
 *     on species artwork rather than claiming a capture that did not happen;
 *   - Discord renders in-process, never through our own HTTP route.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { EmbedBuilder } from 'discord.js';
import {
  cardsEnabled,
  renderedCardFilename,
  renderOwnedCardAttachment,
  DISCORD_CARD_WIDTH,
} from '../../src/discord/assets/attachRenderedCard';
import { buildEphemeralOutcomeMessage } from '../../src/discord/commands/waifumonHunt';
import { renderCollectionEmbed } from '../../src/discord/commands/waifumonCollection';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import { SpeciesFileSchema } from '../../src/modules/content/schemas';
import type { AppContext } from '../../src/discord/types';
import { silentLogger } from '../helpers/testDb';

const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'discord_subject',
    name: 'Discord Subject',
    rarity: 'SR',
    archetype: 'demon',
    race: 'demon',
    contentRating: 'suggestive',
    affinity: 'primal',
    description: 'Attaches nicely.',
    imagePath: 'waifumon/discord_subject/standard.png',
    card: { artist: 'Whistler' },
  },
]);

let assetsDir: string;
let ctx: AppContext;

/** The species row shape the Discord builders receive from the DB. */
const speciesRow = { id: 1, slug: 'discord_subject', name: 'Discord Subject', rarity: 'SR', archetype: 'demon', description: 'Attaches nicely.', imagePath: 'waifumon/discord_subject/standard.png', affinity: 'primal' } as never;

const newWaifu = { id: 4821, playerId: 1, speciesId: 1, level: 7, variant: 'standard' } as never;

function makeCtx(cardsOn: boolean): AppContext {
  const content = { items: [], species: SPECIES, tables: { duplicate: { essenceByRarity: { SR: 5 } } } } as never;
  const appearance = createAppearanceService({ db: null as never, getContent: () => content });
  return {
    config: {
      assetsDir,
      platformApi: { enabled: true, host: '127.0.0.1', port: 3120, token: 't', cardRendererEnabled: cardsOn },
    },
    logger: silentLogger(),
    content,
    services: { appearance },
  } as unknown as AppContext;
}

/** The capture result shape the outcome builder reads. */
function captureResult(outcome: 'success' | 'escape' | 'failure', withCopy = true) {
  return {
    outcome,
    species: speciesRow,
    item: { id: 1, slug: 'basic_charm', name: 'Basic Charm', emoji: '💗' },
    isDuplicate: false,
    attempt: { attemptNumber: 1, guaranteed: false },
    attemptsRemaining: 2,
    newWaifu: outcome === 'success' && withCopy ? newWaifu : null,
    affinity: { buddyWaifuId: null, finalChance: 0.5 },
    effect: null,
    xpGranted: 0,
    levelUps: [],
    isNewDex: false,
  } as never;
}

const imageUrl = (payload: { embeds?: readonly unknown[] | undefined }): string | undefined =>
  (payload.embeds?.[0] as EmbedBuilder | undefined)?.data.image?.url;

const fileNames = (payload: { files?: readonly unknown[] | undefined }): string[] =>
  [...(payload.files ?? [])].map((f) => (f as { name: string }).name);

beforeAll(async () => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-discord-cards-'));
  const dir = path.join(assetsDir, 'waifumon', 'discord_subject');
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({ create: { width: 512, height: 748, channels: 3, background: { r: 80, g: 40, b: 120 } } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, 'standard.png'), png);
  ctx = makeCtx(true);
}, 60_000);

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

describe('renderedCardFilename', () => {
  it('names a species card readably, with no filesystem path', () => {
    const name = renderedCardFilename('void_empress');
    expect(name).toBe('waifumon-void-empress.webp');
    expect(name).not.toContain(path.sep);
    expect(name).not.toContain('.card-cache');
  });

  it('distinguishes one owned copy from another', () => {
    expect(renderedCardFilename('void_empress', 4821)).toBe('waifumon-void-empress-4821.webp');
    expect(renderedCardFilename('void_empress', 9)).not.toBe(renderedCardFilename('void_empress', 8));
  });
});

describe('CARD_RENDERER_ENABLED', () => {
  it('reads the flag the API and Portal already agree on', () => {
    expect(cardsEnabled(makeCtx(true))).toBe(true);
    expect(cardsEnabled(makeCtx(false))).toBe(false);
  });

  /**
   * An optional feature's gate must answer "no" for a context that does not
   * describe one, not throw. A context with no `platformApi` block reached this
   * and took the whole command down with it.
   */
  it('reads as off — never throws — for a context with no API config', () => {
    const bare = { config: { assetsDir } } as unknown as Parameters<typeof cardsEnabled>[0];
    expect(() => cardsEnabled(bare)).not.toThrow();
    expect(cardsEnabled(bare)).toBe(false);
  });

  it('renders no card, and raises nothing, when disabled', async () => {
    const attachment = await renderOwnedCardAttachment(makeCtx(false), {
      waifu: newWaifu,
      species: speciesRow,
    });
    expect(attachment).toBeNull();
  });

  it('degrades to null rather than throwing when a card cannot be drawn', async () => {
    // A species the content snapshot does not have — the render chain fails
    // deep inside, and the surface must still be able to send its embed.
    const attachment = await renderOwnedCardAttachment(ctx, {
      waifu: newWaifu,
      species: { slug: 'not_in_content' } as never,
    });
    expect(attachment).toBeNull();
  });
});

describe('owned card attachment', () => {
  it('renders a WebP card at the Discord width', async () => {
    const attachment = await renderOwnedCardAttachment(ctx, { waifu: newWaifu, species: speciesRow });
    expect(attachment).not.toBeNull();
    expect(attachment!.file.name).toBe('waifumon-discord-subject-4821.webp');
    expect(attachment!.url).toBe('attachment://waifumon-discord-subject-4821.webp');

    const bytes = attachment!.file.attachment as Buffer;
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(DISCORD_CARD_WIDTH);
  }, 60_000);

  it('attaches bytes, never a cache path', async () => {
    const attachment = await renderOwnedCardAttachment(ctx, { waifu: newWaifu, species: speciesRow });
    expect(Buffer.isBuffer(attachment!.file.attachment)).toBe(true);
  }, 60_000);
});

describe('capture outcome embed', () => {
  it('shows the rendered owned card on a successful capture', async () => {
    const payload = await buildEphemeralOutcomeMessage(ctx, captureResult('success'));
    expect(fileNames(payload)).toEqual(['waifumon-discord-subject-4821.webp']);
    expect(imageUrl(payload)).toBe('attachment://waifumon-discord-subject-4821.webp');
  }, 60_000);

  it('falls back to raw artwork when the renderer is disabled', async () => {
    const payload = await buildEphemeralOutcomeMessage(makeCtx(false), captureResult('success'));
    expect(fileNames(payload)).toEqual(['card.png']);
    expect(imageUrl(payload)).toBe('attachment://card.png');
  });

  /** She got away — there is no owned copy, so there is no owned card. */
  it('keeps raw artwork when she escapes', async () => {
    const payload = await buildEphemeralOutcomeMessage(ctx, captureResult('escape'));
    expect(fileNames(payload)).toEqual(['card.png']);
    expect(imageUrl(payload)).toBe('attachment://card.png');
  });

  it('keeps raw artwork when the attempt fails', async () => {
    const payload = await buildEphemeralOutcomeMessage(ctx, captureResult('failure'));
    expect(fileNames(payload)).toEqual(['card.png']);
  });

  it('keeps raw artwork on a success that somehow produced no copy', async () => {
    const payload = await buildEphemeralOutcomeMessage(ctx, captureResult('success', false));
    expect(fileNames(payload)).toEqual(['card.png']);
  });
});

describe('collection list', () => {
  it('stays image-free — a page of cards is not what that surface is for', () => {
    const embed = renderCollectionEmbed(
      { entries: [], page: 1, pageSize: 10, total: 0, totalPages: 1 } as never,
      { owned: 0, distinctSpecies: 0, totalSpecies: 10 },
    );
    expect(embed.data.image).toBeUndefined();
    expect(embed.data.thumbnail).toBeUndefined();
  });
});

/**
 * Discord and the Platform API are one process. A card here is a function call
 * into the cards module; routing it through our own HTTP route would add a
 * socket, a serializer and a bearer token to that call.
 */
describe('render path', () => {
  const discordSources = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
    };
    walk(path.resolve(__dirname, '../../src/discord'));
    return out;
  };

  it('never calls the card HTTP routes from inside the bot', () => {
    for (const file of discordSources()) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${file} builds a card API URL`).not.toContain('/v1/cards/');
      expect(source, `${file} builds an owned-card URL`).not.toContain('/collection/owned/');
      expect(source, `${file} points at a local API`).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
    }
  });

  it('reaches the renderer only through the cards module’s public entry point', () => {
    for (const file of discordSources()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const internal of ['cards/composer', 'cards/rasterizer', 'cards/cache', 'cards/assets/']) {
        expect(source, `${file} imports ${internal}`).not.toContain(internal);
      }
    }
  });
});
