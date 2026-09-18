/**
 * Content-schema validation for appearances, plus the loader's asset pre-flight.
 *
 * The through-line: **a content mistake should cost the smallest possible
 * thing**. A missing non-default image costs one gallery tile. A duplicate id
 * or a missing default costs a validation error at boot, loudly, with the
 * species named — never a half-rendered card in front of a player.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateSpeciesAssets } from '../../src/modules/content/loader';
import {
  SpeciesContentSchema,
  type SpeciesContent,
} from '../../src/modules/content/schemas';
import { silentLogger } from '../helpers/testDb';

const BASE = {
  slug: 'alley_catgirl',
  name: 'Alley Catgirl',
  rarity: 'N',
  archetype: 'demi-human',
  contentRating: 'suggestive',
  imagePath: 'waifumon/alley_catgirl/standard.png',
};

const OWNED = { id: 'standard', name: 'Standard', unlock: { type: 'owned' } };

describe('SpeciesContentSchema — backward compatibility', () => {
  it('accepts a species with no appearances at all', () => {
    // Every species that predates this system. If this ever fails, existing
    // content stops loading — the single most important assertion here.
    const parsed = SpeciesContentSchema.safeParse(BASE);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.appearances).toBeUndefined();
  });

  it('leaves imagePath intact — it remains the loader-private probe', () => {
    const parsed = SpeciesContentSchema.parse(BASE);
    expect(parsed.imagePath).toBe('waifumon/alley_catgirl/standard.png');
  });
});

describe('SpeciesContentSchema — appearance validation', () => {
  it('accepts a full catalog with rich cosmetic metadata', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [
        OWNED,
        {
          id: 'level_20',
          name: 'Midnight Bloom',
          description: 'A darker cut of her usual silhouette.',
          flavorText: 'Prepared for the annual shrine celebration.',
          cosmeticRarity: 'seasonal',
          introducedVersion: 'v1.3',
          sortOrder: 20,
          tags: ['seasonal'],
          unlock: { type: 'level', atLevel: 20 },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults cosmeticRarity to standard when omitted', () => {
    const parsed = SpeciesContentSchema.parse({ ...BASE, appearances: [OWNED] });
    expect(parsed.appearances?.[0]?.cosmeticRarity).toBe('standard');
  });

  it('rejects an unknown cosmeticRarity rather than passing a raw string through', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [{ ...OWNED, cosmeticRarity: 'mythic' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate appearance ids within a species', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [OWNED, { ...OWNED, name: 'Second' }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && JSON.stringify(parsed.error.issues)).toContain(
      'duplicate appearance id',
    );
  });

  it('rejects a catalog with no owned default — a fresh copy must have something to wear', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [{ id: 'level_20', name: 'Midnight', unlock: { type: 'level', atLevel: 20 } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('reports the missing-owned-default rule by name when the entries are otherwise valid', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [
        { id: 'a', name: 'A', unlock: { type: 'level', atLevel: 20 } },
        { id: 'b', name: 'B', unlock: { type: 'level', atLevel: 40 } },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && JSON.stringify(parsed.error.issues)).toContain(
      'exactly one appearance must have unlock.type',
    );
  });

  it('rejects two owned defaults — "which one" must never be a coin flip', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [OWNED, { id: 'alt', name: 'Alt', unlock: { type: 'owned' } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-positive level gate', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [OWNED, { id: 'l', name: 'L', unlock: { type: 'level', atLevel: 0 } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('names reserved future unlock types explicitly instead of "invalid discriminator"', () => {
    // An author who tries `{"type":"event"}` should be told it is reserved,
    // not that it does not exist — the difference is a support ticket.
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [OWNED, { id: 'e', name: 'E', unlock: { type: 'event', eventKey: 'winter' } }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && JSON.stringify(parsed.error.issues)).toContain(
      'reserved for a future version',
    );
  });

  it('rejects an assetId that points at a different species', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [
        OWNED,
        {
          id: 'borrowed',
          name: 'Borrowed',
          unlock: { type: 'level', atLevel: 5 },
          assetId: { kind: 'waifumon', slug: 'someone_else', variant: 'borrowed' },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an assetId kind other than waifumon', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [
        { ...OWNED, assetId: { kind: 'card_print', slug: 'alley_catgirl', variant: 'standard' } },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts introducedVersion as a free-form string', () => {
    const parsed = SpeciesContentSchema.safeParse({
      ...BASE,
      appearances: [{ ...OWNED, introducedVersion: 'winter-drop-2' }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('validateSpeciesAssets — appearance pre-flight', () => {
  let assetsDir: string;

  const write = (relative: string): void => {
    const absolute = path.join(assetsDir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'not-really-a-png');
  };

  const speciesWith = (appearances: SpeciesContent['appearances']): SpeciesContent =>
    SpeciesContentSchema.parse({ ...BASE, appearances }) as SpeciesContent;

  beforeEach(() => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-appearance-'));
    write('waifumon/alley_catgirl/standard.png');
  });

  afterEach(() => {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  it('leaves a species with no catalog untouched', () => {
    const input = SpeciesContentSchema.parse(BASE) as SpeciesContent;
    const [result] = validateSpeciesAssets([input], assetsDir, silentLogger());
    expect(result?.enabled).toBe(true);
    expect(result?.appearances).toBeUndefined();
  });

  it('drops a non-default appearance whose artwork is missing, keeping the species enabled', () => {
    // Half-shipped artwork costs one gallery tile, never a whole Waifumon.
    const input = speciesWith([
      OWNED,
      { id: 'level_20', name: 'Midnight', unlock: { type: 'level', atLevel: 20 } },
    ] as SpeciesContent['appearances']);
    const [result] = validateSpeciesAssets([input], assetsDir, silentLogger());
    expect(result?.enabled).toBe(true);
    expect(result?.appearances?.map((a) => a.id)).toEqual(['standard']);
  });

  it('keeps an appearance whose artwork exists', () => {
    write('waifumon/alley_catgirl/level_20.png');
    const input = speciesWith([
      OWNED,
      { id: 'level_20', name: 'Midnight', unlock: { type: 'level', atLevel: 20 } },
    ] as SpeciesContent['appearances']);
    const [result] = validateSpeciesAssets([input], assetsDir, silentLogger());
    expect(result?.appearances?.map((a) => a.id)).toEqual(['standard', 'level_20']);
  });

  it('disables a species whose base imagePath is missing (unchanged behaviour)', () => {
    fs.rmSync(path.join(assetsDir, 'waifumon/alley_catgirl/standard.png'));
    const input = SpeciesContentSchema.parse(BASE) as SpeciesContent;
    const [result] = validateSpeciesAssets([input], assetsDir, silentLogger());
    expect(result?.enabled).toBe(false);
  });

  it('keeps the default appearance even when its artwork is missing, for consumer fallback', () => {
    // The default has nothing to degrade to, and the species still has a valid
    // `imagePath`. Dropping it would leave the copy unrenderable; keeping it
    // lets each consumer's resolver fall back.
    const input = speciesWith([
      { id: 'base', name: 'Base', unlock: { type: 'owned' } },
    ] as SpeciesContent['appearances']);
    const [result] = validateSpeciesAssets([input], assetsDir, silentLogger());
    expect(result?.enabled).toBe(true);
    expect(result?.appearances?.map((a) => a.id)).toEqual(['base']);
  });
});

/**
 * The pre-flight asks the shared artwork resolver, so it must accept artwork
 * in any runtime format. The regression this guards against is the one that
 * matters most for the WebP migration: converting a species to WebP must never
 * disable it, and converting one appearance must never drop it from the
 * gallery. PNG-only trees keep behaving exactly as before.
 */
describe('validateSpeciesAssets — artwork format', () => {
  let assetsDir: string;

  const write = (relative: string): void => {
    const absolute = path.join(assetsDir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'image-bytes');
  };

  const LEVEL_20 = { id: 'level_20', name: 'Midnight', unlock: { type: 'level', atLevel: 20 } };

  const speciesWith = (appearances?: unknown[]): SpeciesContent =>
    SpeciesContentSchema.parse(appearances ? { ...BASE, appearances } : BASE) as SpeciesContent;

  const run = (input: SpeciesContent): SpeciesContent =>
    validateSpeciesAssets([input], assetsDir, silentLogger())[0]!;

  beforeEach(() => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-appearance-fmt-'));
  });

  afterEach(() => {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  it('enables a species that has only standard.png', () => {
    write('waifumon/alley_catgirl/standard.png');
    expect(run(speciesWith()).enabled).toBe(true);
  });

  it('enables a species that has only standard.webp, even though imagePath names a .png', () => {
    write('waifumon/alley_catgirl/standard.webp');
    expect(run(speciesWith()).enabled).toBe(true);
  });

  it('enables a species that has both formats', () => {
    write('waifumon/alley_catgirl/standard.png');
    write('waifumon/alley_catgirl/standard.webp');
    expect(run(speciesWith()).enabled).toBe(true);
  });

  it('enables a WebP-only species with an authored catalog', () => {
    write('waifumon/alley_catgirl/standard.webp');
    const result = run(speciesWith([OWNED]));
    expect(result.enabled).toBe(true);
    expect(result.appearances?.map((a) => a.id)).toEqual(['standard']);
  });

  it('keeps an alternate appearance that exists only as WebP', () => {
    write('waifumon/alley_catgirl/standard.png');
    write('waifumon/alley_catgirl/level_20.webp');
    const result = run(speciesWith([OWNED, LEVEL_20]));
    expect(result.appearances?.map((a) => a.id)).toEqual(['standard', 'level_20']);
  });

  it('keeps an alternate appearance that exists only as PNG', () => {
    write('waifumon/alley_catgirl/standard.webp');
    write('waifumon/alley_catgirl/level_20.png');
    const result = run(speciesWith([OWNED, LEVEL_20]));
    expect(result.appearances?.map((a) => a.id)).toEqual(['standard', 'level_20']);
  });

  it('still drops an alternate appearance with no artwork in any format', () => {
    write('waifumon/alley_catgirl/standard.webp');
    const result = run(speciesWith([OWNED, LEVEL_20]));
    expect(result.enabled).toBe(true);
    expect(result.appearances?.map((a) => a.id)).toEqual(['standard']);
  });

  it('still disables a species with no default artwork in any format', () => {
    write('waifumon/alley_catgirl/level_20.webp');
    expect(run(speciesWith()).enabled).toBe(false);
  });

  it('still rejects an imagePath that escapes the assets root', () => {
    write('waifumon/alley_catgirl/standard.webp');
    const input = SpeciesContentSchema.parse({
      ...BASE,
      imagePath: '../outside.png',
    }) as SpeciesContent;
    expect(() => validateSpeciesAssets([input], assetsDir, silentLogger())).toThrow(
      /outside the assets directory/,
    );
  });
});
