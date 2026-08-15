/**
 * `CARD_RENDERER_VERSION` invalidation, isolated in its own file because it
 * needs the module graph rebuilt around a stubbed constant.
 *
 * The constant exists so a renderer change that moves pixels can force every
 * cached card to be re-rendered. That guarantee is only real if the version
 * actually reaches the render key, which is what this asserts end to end.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardInput, listFiles, makeTempDir, writeArtwork } from '../../helpers/cardFixtures';

const VERSION_MODULE = '../../../src/modules/cards/version';
const CARDS_MODULE = '../../../src/modules/cards';

let workdir: string;
let artwork: string;

beforeAll(async () => {
  workdir = await makeTempDir('cards-rendererversion');
  artwork = await writeArtwork(path.join(workdir, 'art', 'standard.png'), { r: 40, g: 160, b: 90 });
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

afterEach(() => {
  vi.doUnmock(VERSION_MODULE);
  vi.resetModules();
});

/** Loads a fresh copy of the module graph with `CARD_RENDERER_VERSION` stubbed. */
async function loadCardsWithRendererVersion(
  version: string,
): Promise<typeof import('../../../src/modules/cards')> {
  vi.resetModules();
  vi.doMock(VERSION_MODULE, async () => {
    const actual = await vi.importActual<typeof import('../../../src/modules/cards/version')>(
      VERSION_MODULE,
    );
    return { ...actual, CARD_RENDERER_VERSION: version };
  });
  return import(CARDS_MODULE);
}

describe('renderer version invalidation', () => {
  it('changes the render key and re-renders when the renderer version is bumped', async () => {
    const cacheRoot = path.join(workdir, 'cache');

    const v1 = await loadCardsWithRendererVersion('1');
    const before = await v1.createCardRenderer({ cacheRoot }).renderCard(cardInput(artwork));

    const v2 = await loadCardsWithRendererVersion('2');
    const after = await v2.createCardRenderer({ cacheRoot }).renderCard(cardInput(artwork));

    expect(after.renderKey).not.toBe(before.renderKey);
    expect(after.fromCache).toBe(false);
    expect(await listFiles(cacheRoot)).toEqual([
      `alley_catgirl/${before.renderKey}.webp`,
      `alley_catgirl/${after.renderKey}.webp`,
    ].sort());
  });

  it('keeps the key stable when the version is unchanged', async () => {
    const cacheRoot = path.join(workdir, 'cache-stable');

    const first = await loadCardsWithRendererVersion('1');
    const a = await first.createCardRenderer({ cacheRoot }).renderCard(cardInput(artwork));

    const second = await loadCardsWithRendererVersion('1');
    const b = await second.createCardRenderer({ cacheRoot }).renderCard(cardInput(artwork));

    expect(b.renderKey).toBe(a.renderKey);
    expect(b.fromCache).toBe(true);
  });
});
