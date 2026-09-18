/**
 * Raw species artwork reaches Discord under a filename whose extension matches
 * the bytes — `card.webp` for WebP, `card.png` for PNG — and every embed points
 * at the attachment's real name.
 *
 * Before the resolver became format-agnostic every raw-art attachment was
 * named `card.png` and every embed hard-coded `attachment://card.png`. That was
 * true while all artwork was PNG and silently false the moment one file became
 * WebP. The fixtures here are real encoded images, so the assertion is about
 * the bytes Discord would receive, not just a path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { AttachmentBuilder } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  artworkAttachmentUrl,
  resolveAppearanceAsset,
  resolveAppearanceAssetOrPath,
} from '../../src/discord/assets/resolveAppearanceAsset';
import { ownedCardImage } from '../../src/discord/assets/attachRenderedCard';
import { buildAppearanceUnlockView } from '../../src/discord/appearanceToast';
import { renderResultScreen } from '../../src/discord/resultScreenRenderer';
import { defaultAssetId } from '../../src/modules/appearance/appearanceContent';
import type { AppearanceUnlockRef } from '../../src/modules/appearance/appearanceService';
import type { ResolvedResultPresentation } from '../../src/modules/resultPresentation/resolver';
import type { ResultScreen } from '../../src/modules/resultPresentation/screens';
import type { SpeciesRow } from '../../src/db/schema';
import type { AppContext } from '../../src/discord/types';
import { silentLogger } from '../helpers/testDb';

let assetsDir: string;

async function writeImage(relative: string, format: 'png' | 'webp'): Promise<void> {
  const absolute = path.join(assetsDir, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const image = sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 40, b: 120 } },
  });
  fs.writeFileSync(absolute, await (format === 'png' ? image.png() : image.webp()).toBuffer());
}

/** The format sharp detects in the bytes an attachment would upload. */
async function uploadedFormat(file: AttachmentBuilder): Promise<string | undefined> {
  return (await sharp(fs.readFileSync(String(file.attachment))).metadata()).format;
}

/** Asserts the attachment's extension, its bytes and the embed URL all agree. */
async function expectConsistent(file: AttachmentBuilder, url: string, format: 'png' | 'webp') {
  expect(file.name).toBe(`card.${format}`);
  expect(await uploadedFormat(file)).toBe(format);
  expect(url).toBe(`attachment://card.${format}`);
}

function ctx(appearance?: unknown): AppContext {
  return {
    config: { assetsDir, platformApi: { cardRendererEnabled: false } },
    logger: silentLogger(),
    services: { appearance },
  } as unknown as AppContext;
}

beforeAll(async () => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-attach-fmt-'));
  await writeImage('waifumon/webp_girl/standard.webp', 'webp');
  await writeImage('waifumon/webp_girl/level_20.webp', 'webp');
  await writeImage('waifumon/png_girl/standard.png', 'png');
  await writeImage('waifumon/both_girl/standard.png', 'png');
  await writeImage('waifumon/both_girl/standard.webp', 'webp');
  await writeImage('legacy/only.webp', 'webp');
});

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

describe('resolveAppearanceAsset (Discord adapter)', () => {
  it('attaches WebP bytes as .webp', async () => {
    const file = resolveAppearanceAsset(ctx(), defaultAssetId('webp_girl', 'standard'))!;
    await expectConsistent(file, artworkAttachmentUrl(file), 'webp');
  });

  it('attaches PNG bytes as .png', async () => {
    const file = resolveAppearanceAsset(ctx(), defaultAssetId('png_girl', 'standard'))!;
    await expectConsistent(file, artworkAttachmentUrl(file), 'png');
  });

  it('attaches the WebP when both formats exist', async () => {
    const file = resolveAppearanceAsset(ctx(), defaultAssetId('both_girl', 'standard'))!;
    await expectConsistent(file, artworkAttachmentUrl(file), 'webp');
  });

  it('names a species-default fallback by the format it fell back to', async () => {
    const file = resolveAppearanceAsset(ctx(), defaultAssetId('png_girl', 'level_50'))!;
    await expectConsistent(file, artworkAttachmentUrl(file), 'png');
  });
});

describe('resolveAppearanceAssetOrPath — the hunt reveal and inspect fallbacks', () => {
  it('names a legacy imagePath that now exists only as WebP as .webp', async () => {
    const file = resolveAppearanceAssetOrPath(
      ctx(),
      defaultAssetId('no_such_species', 'standard'),
      'legacy/only.png',
    )!;
    await expectConsistent(file, artworkAttachmentUrl(file), 'webp');
  });
});

describe('ownedCardImage — raw-artwork tier (capture, inspect, Trainer Profile)', () => {
  const species = { slug: 'webp_girl', imagePath: 'waifumon/webp_girl/standard.png' } as SpeciesRow;

  it('points the embed at a .webp attachment for WebP artwork', async () => {
    const appearance = {
      currentAppearance: () => ({ assetId: defaultAssetId('webp_girl', 'level_20') }),
    };
    const image = await ownedCardImage(ctx(appearance), {
      waifu: { id: 1, level: 20, variant: 'level_20' },
      species,
    });
    await expectConsistent(image!.file, image!.url, 'webp');
  });
});

describe('appearance unlock toast', () => {
  it('points the embed at the attachment it actually sends', async () => {
    const unlock = {
      waifuId: 1,
      speciesSlug: 'webp_girl',
      appearanceId: 'level_20',
      name: 'Midnight',
      assetId: defaultAssetId('webp_girl', 'level_20'),
      cosmeticRarity: 'standard',
      unlockLabel: 'Reach Level 20',
      source: 'level',
    } as unknown as AppearanceUnlockRef;

    const view = buildAppearanceUnlockView(ctx(), unlock, 'Webp Girl');
    await expectConsistent(view.card!, view.embed.data.image!.url, 'webp');
  });
});

describe('result screen — encountered artwork (release)', () => {
  it('points the embed at the attachment the species artwork resolved to', async () => {
    const screen = {
      key: 'release',
      title: 'Released',
      sections: [],
      description: 'Bye',
      color: 0,
      footer: null,
      artwork: { kind: 'encountered' },
    } as unknown as ResultScreen;
    const presentation = { variantId: null } as unknown as ResolvedResultPresentation;

    const { embed, files } = renderResultScreen(
      { config: { assetsDir }, logger: silentLogger() },
      screen,
      presentation,
      () => resolveAppearanceAsset(ctx(), defaultAssetId('webp_girl', 'standard')),
    );

    expect(files).toHaveLength(1);
    await expectConsistent(files[0]!, embed.data.image!.url, 'webp');
  });
});
