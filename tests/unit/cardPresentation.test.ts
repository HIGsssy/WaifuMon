/**
 * The shared card-presentation service.
 *
 * This is the chain the HTTP route and Discord both walk: species → appearance
 * → artwork (with fallbacks) → level → ownership → `CardRenderInput`. It exists
 * precisely so there is one copy of it, so the assertions here are about the
 * decisions rather than about either caller.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ownedCardRequest,
  speciesCardRequest,
  type CardPresentationDeps,
} from '../../src/modules/appearance/cardPresentation';
import { CardArtworkMissingError } from '../../src/modules/cards';
import { AppearanceLockedError, AppearanceNotFoundError } from '../../src/shared/errors';
import { SpeciesFileSchema, type SpeciesContent } from '../../src/modules/content/schemas';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';

const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'card_subject',
    name: 'Card Subject',
    rarity: 'SR',
    archetype: 'demon',
    race: 'demon',
    contentRating: 'suggestive',
    affinity: 'primal',
    description: 'A presentable subject.',
    imagePath: 'waifumon/card_subject/standard.png',
    card: { artist: 'Whistler' },
    appearances: [
      { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
      { id: 'level_20', name: 'Level 20', sortOrder: 20, unlock: { type: 'level', atLevel: 20 } },
      { id: 'level_40', name: 'Level 40', sortOrder: 40, unlock: { type: 'level', atLevel: 40 } },
    ],
  },
]);

let assetsDir: string;
let deps: CardPresentationDeps;
let subject: SpeciesContent;

function writeArt(slug: string, variant: string): string {
  const dir = path.join(assetsDir, 'waifumon', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${variant}.png`);
  fs.writeFileSync(file, Buffer.from(`art:${slug}:${variant}`));
  return file;
}

beforeAll(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-card-presentation-'));
  // `standard` and `level_20` have artwork; `level_40` deliberately does not.
  writeArt('card_subject', 'standard');
  writeArt('card_subject', 'level_20');

  const content = { items: [], species: SPECIES, tables: {} } as never;
  const appearance = createAppearanceService({ db: null as never, getContent: () => content });
  deps = { appearance, assetsDir };
  subject = SPECIES[0] as SpeciesContent;
});

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

describe('speciesCardRequest', () => {
  it('never sets the CAUGHT badge on a plain preview', () => {
    const { input } = speciesCardRequest(deps, subject);
    expect(input.context?.showCaughtBadge).not.toBe(true);
  });

  it('passes an explicit showCaughtBadge through to the render input', () => {
    const { input } = speciesCardRequest(deps, subject, { showCaughtBadge: true });
    expect(input.context?.showCaughtBadge).toBe(true);
  });

  it('previews at level 1 unless asked otherwise', () => {
    expect(speciesCardRequest(deps, subject).input.progress?.level).toBe(1);
    expect(speciesCardRequest(deps, subject, { level: 33 }).input.progress?.level).toBe(33);
  });

  it('wears the species default appearance when none is named', () => {
    const request = speciesCardRequest(deps, subject);
    expect(request.requestedAppearanceId).toBe('standard');
    expect(request.input.variant.appearanceId).toBe('standard');
  });

  it('wears an explicitly named appearance the caller has earned', () => {
    const request = speciesCardRequest(deps, subject, {
      appearanceId: 'level_20',
      unlockContext: { level: 20 },
    });
    expect(request.requestedAppearanceId).toBe('level_20');
    expect(request.input.variant.appearanceId).toBe('level_20');
    expect(request.input.variant.artworkAbsolutePath).toContain('level_20.png');
  });

  it('rejects an appearance the species does not have', () => {
    expect(() => speciesCardRequest(deps, subject, { appearanceId: 'nope' })).toThrow(
      AppearanceNotFoundError,
    );
  });

  /**
   * The render-side unlock fence.
   *
   * Naming an appearance by id is the one way to make this module draw artwork
   * nobody has earned, and it is reachable from the public species-card route.
   * Without a context there is no owned copy in scope, so nothing but the
   * ungated `owned` entry can be justified — and a level too low is refused for
   * the same reason.
   */
  it('refuses a gated appearance when no unlock context is supplied', () => {
    expect(() => speciesCardRequest(deps, subject, { appearanceId: 'level_20' })).toThrow(
      AppearanceLockedError,
    );
  });

  it('refuses a gated appearance the supplied context has not earned', () => {
    expect(() =>
      speciesCardRequest(deps, subject, {
        appearanceId: 'level_40',
        unlockContext: { level: 39 },
      }),
    ).toThrow(AppearanceLockedError);
  });

  it('still allows the ungated default with no unlock context', () => {
    const request = speciesCardRequest(deps, subject, { appearanceId: 'standard' });
    expect(request.input.variant.appearanceId).toBe('standard');
  });

  /**
   * The refusal must not double as an oracle. `level_40` has no artwork on
   * disk, so an unguarded request for it falls back to `standard` and answers
   * 200 — while `level_20`, which *does* have artwork, would answer with its
   * own. Refusing both identically means a locked id tells an attacker nothing
   * about whether the artwork behind it exists yet.
   */
  it('refuses gated ids identically whether or not their artwork exists', () => {
    const withArt = () => speciesCardRequest(deps, subject, { appearanceId: 'level_20' });
    const withoutArt = () => speciesCardRequest(deps, subject, { appearanceId: 'level_40' });

    expect(withArt).toThrow(AppearanceLockedError);
    expect(withoutArt).toThrow(AppearanceLockedError);
  });

  it('carries the requested width through, and omits it for the master', () => {
    expect(speciesCardRequest(deps, subject, { width: 512 }).input.output?.width).toBe(512);
    expect(speciesCardRequest(deps, subject).input.output).toBeUndefined();
  });

  it('carries authored card metadata onto the render input', () => {
    expect(speciesCardRequest(deps, subject).input.species.card?.artist).toBe('Whistler');
  });
});

describe('artwork fallback', () => {
  /**
   * The load-bearing rule: after a fallback, the *resolved* asset is what
   * reaches the renderer. Keying a card by the appearance that was asked for
   * would mint two masters of one identical image.
   */
  it('falls back to the species default and keys by what resolved', () => {
    const request = speciesCardRequest(deps, subject, {
      appearanceId: 'level_40',
      unlockContext: { level: 40 },
    });

    expect(request.requestedAppearanceId).toBe('level_40');
    expect(request.artwork.source).toBe('species-default');
    expect(request.artwork.assetId.variant).toBe('standard');
    // The render input follows the artwork, not the request.
    expect(request.input.variant.appearanceId).toBe('standard');
    expect(request.input.variant.artworkAbsolutePath).toContain('standard.png');
  });

  it('gives two appearances that both fall back the same render identity', () => {
    const a = speciesCardRequest(deps, subject, {
      appearanceId: 'level_40',
      unlockContext: { level: 40 },
    });
    const b = speciesCardRequest(deps, subject);
    expect(a.input.variant).toEqual(b.input.variant);
  });

  it('reports a species with no resolvable artwork rather than rendering nothing', () => {
    const orphan = { ...subject, slug: 'no_such_species', imagePath: 'waifumon/nope/nope.png' };
    expect(() => speciesCardRequest(deps, orphan as SpeciesContent)).toThrow(
      CardArtworkMissingError,
    );
  });
});

describe('ownedCardRequest', () => {
  const copy = (level: number, variant: string | null) => ({
    waifu: { id: 42, level, variant },
    species: { slug: 'card_subject' },
  });

  it('does not set the CAUGHT badge just because the card is owned', () => {
    expect(ownedCardRequest(deps, copy(12, 'standard')).input.context?.showCaughtBadge).not.toBe(
      true,
    );
  });

  it('accepts an explicit showCaughtBadge for callers that want to override the default', () => {
    expect(
      ownedCardRequest(deps, copy(12, 'standard'), { showCaughtBadge: true }).input.context
        ?.showCaughtBadge,
    ).toBe(true);
  });

  it('uses the copy’s actual level, not a preview default', () => {
    expect(ownedCardRequest(deps, copy(37, 'standard')).input.progress?.level).toBe(37);
    expect(ownedCardRequest(deps, copy(1, 'standard')).input.progress?.level).toBe(1);
  });

  it('uses the appearance she is currently wearing', () => {
    const request = ownedCardRequest(deps, copy(25, 'level_20'));
    expect(request.requestedAppearanceId).toBe('level_20');
    expect(request.input.variant.appearanceId).toBe('level_20');
    expect(request.input.variant.artworkAbsolutePath).toContain('level_20.png');
  });

  it('falls back exactly like the species route when her look has no artwork', () => {
    const owned = ownedCardRequest(deps, copy(45, 'level_40'));
    const preview = speciesCardRequest(deps, subject, {
      appearanceId: 'level_40',
      unlockContext: { level: 45 },
    });

    expect(owned.artwork.source).toBe('species-default');
    expect(owned.artwork.absolutePath).toBe(preview.artwork.absolutePath);
    expect(owned.input.variant.appearanceId).toBe(preview.input.variant.appearanceId);
  });

  /**
   * The stale-equipped case. `variant` is a stored id, and a copy can stop
   * qualifying for it — a rolled-back level, a restore, an author raising
   * `atLevel` after the fact. The old lookup trusted the id and printed Level
   * 20 artwork onto a Level 5 card; it now degrades to her default, the same
   * way a *deleted* variant always has.
   */
  it('degrades a look she no longer qualifies for to her default', () => {
    const request = ownedCardRequest(deps, copy(5, 'level_20'));

    expect(request.requestedAppearanceId).toBe('standard');
    expect(request.input.variant.appearanceId).toBe('standard');
    expect(request.input.variant.artworkAbsolutePath).toContain('standard.png');
    expect(request.input.variant.artworkAbsolutePath).not.toContain('level_20');
  });

  it('renders the identical card for a stale look and for no look at all', () => {
    // Nothing about the stored id survives into the render, so a stale
    // `variant` cannot even be *distinguished* from the default downstream.
    expect(ownedCardRequest(deps, copy(5, 'level_20')).input.variant).toEqual(
      ownedCardRequest(deps, copy(5, null)).input.variant,
    );
  });

  it('treats a null variant as her default look', () => {
    expect(ownedCardRequest(deps, copy(3, null)).input.variant.appearanceId).toBe('standard');
  });

  it('reports missing artwork for a copy whose species left the content snapshot', () => {
    const ghost = { waifu: { id: 9, level: 5, variant: null }, species: { slug: 'departed' } };
    expect(() => ownedCardRequest(deps, ghost)).toThrow(CardArtworkMissingError);
  });

  it('differs from the species preview of the same copy only by level, not by the CAUGHT badge', () => {
    const owned = ownedCardRequest(deps, copy(1, 'standard'));
    const preview = speciesCardRequest(deps, subject);

    expect(owned.input.variant).toEqual(preview.input.variant);
    expect(owned.input.species).toEqual(preview.input.species);
    // Neither surface stamps the badge by default — that is the encounter's job.
    expect(owned.input.context?.showCaughtBadge).not.toBe(true);
    expect(preview.input.context?.showCaughtBadge).not.toBe(true);
  });
});
