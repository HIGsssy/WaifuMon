/**
 * `ownedCardImage` — the picture of one owned copy.
 *
 * One helper now serves both surfaces that show a copy the player owns: the
 * collection inspect card and the Care Mode Trainer Profile. What matters here
 * is the descent — rendered card → the artwork for the look she is **wearing**
 * → the species' legacy path → nothing — because the tier that fires decides
 * whether a player who unlocked an appearance actually sees it.
 *
 * Card rendering is left off in most of these: with the renderer disabled the
 * helper drops straight to raw artwork, which is precisely the tier this file
 * exists to pin. The rendered-card tier has its own coverage under
 * `tests/integration/cards/`.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownedCardImage } from '../../src/discord/assets/attachRenderedCard';
import { CARD_FILENAME } from '../../src/discord/assets/resolveAppearanceAsset';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import type { SpeciesRow } from '../../src/db/schema';
import type { AppContext } from '../../src/discord/types';
import { ASSETS_DIR, loadShippedContent } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

const content = loadShippedContent();
// `currentAppearance` is a pure content lookup, so the service needs no
// database to answer the only question this helper asks it.
const appearance = createAppearanceService({ db: null as never, getContent: () => content });

function ctxFor(cardRendererEnabled = false): AppContext {
  return {
    config: { assetsDir: ASSETS_DIR, platformApi: { cardRendererEnabled } },
    logger: silentLogger(),
    services: { appearance },
  } as unknown as AppContext;
}

function subject(
  variant: string,
  opts: { slug?: string; imagePath?: string } = {},
): { waifu: { id: number; level: number; variant: string }; species: SpeciesRow } {
  const slug = opts.slug ?? 'alley_catgirl';
  return {
    waifu: { id: 7, level: 20, variant },
    species: {
      slug,
      imagePath: opts.imagePath ?? `waifumon/${slug}/standard.png`,
    } as SpeciesRow,
  };
}

/** The absolute path an `AttachmentBuilder` was built from. */
function attachedPath(file: { attachment: unknown }): string {
  return String(file.attachment);
}

describe('the appearance she is wearing', () => {
  it('uses the equipped look, not the species default', async () => {
    const image = await ownedCardImage(ctxFor(), subject('level_20'));

    expect(image).not.toBeNull();
    expect(path.basename(attachedPath(image!.file))).toBe('level_20.png');
    expect(attachedPath(image!.file)).not.toContain('standard.png');
  });

  it.each(['standard', 'level_10', 'level_50'])(
    'follows the copy from look to look (%s)',
    async (variant) => {
      const image = await ownedCardImage(ctxFor(), subject(variant));
      expect(path.basename(attachedPath(image!.file))).toBe(`${variant}.png`);
    },
  );

  it('references the attachment under the shared filename', async () => {
    const image = await ownedCardImage(ctxFor(), subject('level_20'));

    // The embed points at `attachment://…`, so the name and the URL have to
    // agree or the picture silently fails to bind.
    expect(image!.file.name).toBe(CARD_FILENAME);
    expect(image!.url).toBe(`attachment://${CARD_FILENAME}`);
  });
});

describe('degrading', () => {
  it('falls back to the species default when a look has no artwork', async () => {
    const image = await ownedCardImage(ctxFor(), subject('level_9001'));

    expect(path.basename(attachedPath(image!.file))).toBe('standard.png');
  });

  it('degrades to raw artwork when the card render fails', async () => {
    // Renderer *on*, but the species is absent from the content snapshot, so
    // `ownedCardRequest` throws before a single pixel is composed. The copy is
    // real; only her card could not be drawn.
    const image = await ownedCardImage(
      ctxFor(true),
      subject('standard', {
        slug: 'species_that_content_forgot',
        imagePath: 'waifumon/alley_catgirl/standard.png',
      }),
    );

    expect(image).not.toBeNull();
    expect(path.basename(attachedPath(image!.file))).toBe('standard.png');
  });

  it('returns null when no artwork exists at all', async () => {
    const image = await ownedCardImage(
      ctxFor(),
      subject('standard', { slug: 'no_such_species', imagePath: 'waifumon/nope/nope.png' }),
    );

    expect(image).toBeNull();
  });

  it('never throws — a broken appearance lookup costs the image only', async () => {
    const broken = {
      config: { assetsDir: ASSETS_DIR, platformApi: { cardRendererEnabled: false } },
      logger: silentLogger(),
      services: {
        appearance: {
          currentAppearance: () => {
            throw new Error('content snapshot is mid-reload');
          },
        },
      },
    } as unknown as AppContext;

    await expect(ownedCardImage(broken, subject('standard'))).resolves.toBeNull();
  });
});
