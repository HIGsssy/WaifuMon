/**
 * Authored artwork → Discord attachment, shared by World Encounters and
 * Result Presentations.
 *
 * Pins the fix for World Encounter artwork that was always attached as
 * `<slug>.png` whatever the source format was: the attachment keeps the
 * source file's real extension. Also pins the "Along the way" field a World
 * Encounter screen gains when it takes over a hunt that already granted a
 * reward, and that the encounter's own artwork stays the only image.
 *
 * Uses a throwaway assets directory so every supported format really exists
 * on disk; the bytes are irrelevant, the attachment only carries the path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  artworkAttachmentFilename,
  artworkExtensionOf,
  isSafeRelativeArtworkPath,
} from '../../src/modules/assets/artworkPath';
import { resolveArtworkAttachment } from '../../src/discord/assets/resolveArtworkAttachment';
import {
  ALONG_THE_WAY_FIELD,
  buildEncounterPresent,
  encounterArtworkFilename,
} from '../../src/discord/worldEncounterPresenter';
import type { AppContext } from '../../src/discord/types';
import type { EncounterActivation } from '../../src/modules/worldEncounters/worldEncounterService';

let assetsDir: string;
const FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

beforeAll(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-artwork-'));
  fs.mkdirSync(path.join(assetsDir, 'encounters'));
  for (const ext of FORMATS) {
    fs.writeFileSync(path.join(assetsDir, 'encounters', `scene.${ext}`), 'not really an image');
  }
  fs.writeFileSync(path.join(assetsDir, 'encounters', 'notes.txt'), 'text');
});
afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

function makeCtx() {
  const warn = vi.fn();
  const error = vi.fn();
  return {
    ctx: { config: { assetsDir }, logger: { warn, error, info: vi.fn(), debug: vi.fn() } },
    warn,
    error,
  };
}

function nameOf(file: unknown): string | null {
  return (file as { name: string | null }).name;
}

describe('artwork path helpers', () => {
  it.each([
    ['a/b.png', 'png'],
    ['a/b.JPG', 'jpg'],
    ['b.jpeg', 'jpeg'],
    ['a/b.webp', 'webp'],
    ['a/b.gif', 'gif'],
    ['a/b.svg', null],
    ['a/b', null],
    ['a.dir/b', null],
    ['a/.png', null],
  ])('reads the extension of %s', (input, expected) => {
    expect(artworkExtensionOf(input)).toBe(expected);
  });

  it('keeps the source extension on the attachment filename', () => {
    expect(artworkAttachmentFilename('tv_bandit_ambush', 'encounters/x.png')).toBe('tv_bandit_ambush.png');
    expect(artworkAttachmentFilename('tv_bandit_ambush', 'encounters/x.JPG')).toBe('tv_bandit_ambush.jpg');
    expect(artworkAttachmentFilename('tv_bandit_ambush', 'encounters/x.webp')).toBe(
      'tv_bandit_ambush.webp',
    );
    expect(artworkAttachmentFilename('Weird Slug!', 'x.gif')).toBe('weird_slug_.gif');
    expect(artworkAttachmentFilename('slug', 'x.txt')).toBeNull();
  });

  it('World Encounter attachment names no longer assume .png', () => {
    expect(encounterArtworkFilename('ff_bogged_down', 'encounters/ff_bogged_down.webp')).toBe(
      'ff_bogged_down.webp',
    );
    expect(encounterArtworkFilename('ff_bogged_down', 'encounters/ff_bogged_down.jpg')).toBe(
      'ff_bogged_down.jpg',
    );
    expect(encounterArtworkFilename('ff_bogged_down', 'encounters/ff_bogged_down.png')).toBe(
      'ff_bogged_down.png',
    );
  });

  it('applies the strict path rules', () => {
    expect(isSafeRelativeArtworkPath('encounters/scene.webp')).toBe(true);
    expect(isSafeRelativeArtworkPath('../scene.webp')).toBe(false);
    expect(isSafeRelativeArtworkPath('C:/scene.webp')).toBe(false);
    expect(isSafeRelativeArtworkPath('encounters\\scene.webp')).toBe(false);
  });
});

describe('resolveArtworkAttachment', () => {
  it.each(FORMATS)('attaches a .%s file under its real extension', (ext) => {
    const { ctx, warn, error } = makeCtx();
    const resolved = resolveArtworkAttachment(ctx, {
      relativePath: `encounters/scene.${ext}`,
      stem: 'result_hunt_item_find',
      logTag: 'test',
    });
    expect(resolved).not.toBeNull();
    expect(nameOf(resolved!.file)).toBe(`result_hunt_item_find.${ext}`);
    expect(resolved!.url).toBe(`attachment://result_hunt_item_find.${ext}`);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('returns null quietly for no artwork', () => {
    const { ctx, warn, error } = makeCtx();
    expect(resolveArtworkAttachment(ctx, { relativePath: null, stem: 's', logTag: 't' })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('warns once and returns null for a missing file', () => {
    const { ctx, warn } = makeCtx();
    expect(
      resolveArtworkAttachment(ctx, { relativePath: 'encounters/absent.webp', stem: 's', logTag: 't' }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ tag: 't/artwork-missing', artwork: 'encounters/absent.webp' });
  });

  it.each(['../outside.png', '/etc/passwd.png', 'encounters/notes.txt', 'C:/x.png'])(
    'refuses %s with one error and no file access',
    (relativePath) => {
      const { ctx, error } = makeCtx();
      const exists = vi.spyOn(fs, 'existsSync');
      expect(resolveArtworkAttachment(ctx, { relativePath, stem: 's', logTag: 't' })).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(exists).not.toHaveBeenCalled();
      exists.mockRestore();
    },
  );
});

function activation(artworkPath: string | null): EncounterActivation {
  return {
    activeId: 42,
    encounter: {
      id: 1,
      slug: 'tv_bandit_ambush',
      name: 'Bandit Ambush',
      description: 'Rough company on the road.',
      type: 'combat',
      rarity: 'uncommon',
      artworkPath,
      choices: [],
    },
    buddy: null,
    buddyBonusPercent: 0,
    choiceViews: [],
  } as unknown as EncounterActivation;
}

type EmbedJson = { fields?: Array<{ name: string; value: string }>; image?: { url?: string } };
const embedJson = (view: { embeds?: readonly unknown[] | undefined }): EmbedJson =>
  JSON.parse(JSON.stringify((view.embeds ?? [])[0] ?? {}));

describe('World Encounter screen', () => {
  it('attaches .webp encounter artwork as .webp', () => {
    const { ctx } = makeCtx();
    const view = buildEncounterPresent(ctx as unknown as AppContext, activation('encounters/scene.webp'));
    expect((view.files ?? []).map(nameOf)).toEqual(['tv_bandit_ambush.webp']);
    expect(embedJson(view).image?.url).toBe('attachment://tv_bandit_ambush.webp');
  });

  it('adds "Along the way" and keeps the encounter artwork as the only image', () => {
    const { ctx } = makeCtx();
    const view = buildEncounterPresent(ctx as unknown as AppContext, activation('encounters/scene.jpg'), {
      alongTheWay: '💰 +12 WaifuBux',
    });
    const embed = embedJson(view);
    expect(embed.fields).toContainEqual({ name: ALONG_THE_WAY_FIELD, value: '💰 +12 WaifuBux', inline: false });
    expect((view.files ?? []).map(nameOf)).toEqual(['tv_bandit_ambush.jpg']);
    expect(embed.image?.url).toBe('attachment://tv_bandit_ambush.jpg');
  });

  it('adds no "Along the way" field without a summary', () => {
    const { ctx } = makeCtx();
    for (const alongTheWay of [undefined, null, '']) {
      const view = buildEncounterPresent(ctx as unknown as AppContext, activation(null), { alongTheWay });
      expect((embedJson(view).fields ?? []).map((f) => f.name)).not.toContain(ALONG_THE_WAY_FIELD);
    }
    const plain = buildEncounterPresent(ctx as unknown as AppContext, activation(null));
    expect((embedJson(plain).fields ?? []).map((f) => f.name)).not.toContain(ALONG_THE_WAY_FIELD);
  });
});
