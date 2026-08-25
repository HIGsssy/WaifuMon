/**
 * Encounter card semantics: the CAUGHT badge is a **pre-catch duplicate
 * warning**, drawn on the encounter reveal when the player already owns ≥1
 * active copy of the species — never on inspect, capture-success, or any
 * other owned surface.
 *
 * The tests here drive the two artwork adapters directly, so we can assert the
 * shape of the requests they produce without spinning up the whole hunt flow.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  cardsEnabled,
  renderedCardFilename,
  renderEncounterDuplicateCardAttachment,
  renderOwnedCardAttachment,
} from '../../src/discord/assets/attachRenderedCard';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import { SpeciesFileSchema } from '../../src/modules/content/schemas';
import * as cardsModule from '../../src/modules/cards';
import type { AppContext } from '../../src/discord/types';
import { silentLogger } from '../helpers/testDb';

const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'encounter_subject',
    name: 'Encounter Subject',
    rarity: 'SR',
    archetype: 'demon',
    race: 'demon',
    contentRating: 'suggestive',
    affinity: 'primal',
    description: 'Stares back.',
    imagePath: 'waifumon/encounter_subject/standard.png',
  },
]);

const speciesRow = {
  id: 1,
  slug: 'encounter_subject',
  name: 'Encounter Subject',
  rarity: 'SR',
  archetype: 'demon',
  description: 'Stares back.',
  imagePath: 'waifumon/encounter_subject/standard.png',
  affinity: 'primal',
};

const newWaifu = { id: 4821, playerId: 1, speciesId: 1, level: 7, variant: 'standard' };

let assetsDir: string;
let ctx: AppContext;

function makeCtx(cardsOn: boolean): AppContext {
  const content = { items: [], species: SPECIES, tables: {} } as never;
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

beforeAll(async () => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-encounter-badge-'));
  const dir = path.join(assetsDir, 'waifumon', 'encounter_subject');
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({ create: { width: 512, height: 748, channels: 3, background: { r: 60, g: 20, b: 80 } } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, 'standard.png'), png);
  ctx = makeCtx(true);
}, 60_000);

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

describe('renderEncounterDuplicateCardAttachment', () => {
  it('renders the species card with the CAUGHT badge set on the render input', async () => {
    const spy = vi.spyOn(cardsModule, 'renderCard');
    try {
      const attachment = await renderEncounterDuplicateCardAttachment(ctx, speciesRow);
      expect(attachment).not.toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0]?.[0];
      expect(input?.context?.showCaughtBadge, 'encounter renders with showCaughtBadge: true').toBe(
        true,
      );
      // The encounter path uses a species preview, so the level printed on the
      // card is the preview default (1), not any player-owned level.
      expect(input?.progress?.level ?? 1).toBe(1);
      expect(attachment?.file.name).toBe(renderedCardFilename(speciesRow.slug));
    } finally {
      spy.mockRestore();
    }
  });

  it('returns null when the renderer is disabled — falls back to raw artwork', async () => {
    const off = makeCtx(false);
    expect(cardsEnabled(off)).toBe(false);
    const attachment = await renderEncounterDuplicateCardAttachment(off, speciesRow);
    expect(attachment).toBeNull();
  });

  it('returns null when the species is not in the content snapshot', async () => {
    const attachment = await renderEncounterDuplicateCardAttachment(ctx, { slug: 'not_a_species' });
    expect(attachment).toBeNull();
  });

  it('returns null (never throws) when the underlying render throws', async () => {
    const spy = vi.spyOn(cardsModule, 'renderCard').mockRejectedValue(new Error('kit missing'));
    try {
      const attachment = await renderEncounterDuplicateCardAttachment(ctx, speciesRow);
      expect(attachment).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('renderOwnedCardAttachment', () => {
  it('never sets the CAUGHT badge — owned surfaces are not the duplicate warning', async () => {
    const spy = vi.spyOn(cardsModule, 'renderCard');
    try {
      const attachment = await renderOwnedCardAttachment(ctx, { waifu: newWaifu, species: speciesRow });
      expect(attachment).not.toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0]?.[0];
      expect(input?.context?.showCaughtBadge, 'owned card must not composite the CAUGHT badge').not.toBe(
        true,
      );
      // The copy's real level reaches the render input.
      expect(input?.progress?.level).toBe(newWaifu.level);
    } finally {
      spy.mockRestore();
    }
  });
});
