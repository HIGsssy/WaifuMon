/**
 * Optional encounter artwork, as Discord actually receives it.
 *
 * Artwork is authored as a path relative to `assets/` and resolved through
 * `resolveAssetPath` — the same confinement helper the content loader and the
 * boss presenter use. There is no second asset system here, and no encounter
 * is required to have artwork.
 *
 * The three cases that matter are the two ends and the failure in between:
 * no artwork at all (the common case), artwork that exists, and artwork whose
 * file is missing or whose path escapes the assets directory. The last must
 * degrade to a text-only embed, because a typo in an optional field should
 * never cost a player their encounter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEncounterPresent,
  buildEncounterResolved,
} from '../../src/discord/worldEncounterPresenter';
import type { AppContext } from '../../src/discord/types';
import type {
  EncounterActivation,
  Resolution,
} from '../../src/modules/worldEncounters/worldEncounterService';

const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'assets');
/** A file that really is on disk, so the attachment path is genuinely taken. */
const REAL_ASSET = 'placeholder.png';

function makeCtx() {
  const warn = vi.fn();
  const error = vi.fn();
  const ctx = {
    config: { assetsDir: ASSETS_DIR },
    logger: { warn, error, info: vi.fn(), debug: vi.fn() },
  } as unknown as AppContext;
  return { ctx, warn, error };
}

function activationWith(artworkPath: string | null): EncounterActivation {
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

function resolutionFor(activation: EncounterActivation): Resolution {
  return {
    encounter: activation.encounter,
    choice: { id: 1, label: 'Fight' },
    check: { chance: 1, roll: 0, success: true, breakdown: {} },
    effectsApplied: [],
    followUps: [],
    chainedEncounterSlug: null,
    continuationActiveId: null,
    vendorInstance: null,
    wildEncounter: null,
    journey: null,
  } as unknown as Resolution;
}

/** The `image.url` the embed carries, if any. */
function imageUrl(view: { embeds?: readonly unknown[] | undefined }): string | undefined {
  const embed = (view.embeds ?? [])[0] as { data?: { image?: { url?: string } } } | undefined;
  return embed?.data?.image?.url;
}

it('the fixture asset this suite relies on is present', () => {
  expect(fs.existsSync(path.join(ASSETS_DIR, REAL_ASSET))).toBe(true);
});

describe('encounter with no artwork', () => {
  it('presents text-only, with no attachment', () => {
    const { ctx, warn, error } = makeCtx();
    const view = buildEncounterPresent(ctx, activationWith(null));

    expect(view.files ?? []).toHaveLength(0);
    expect(imageUrl(view)).toBeUndefined();
    // Not having artwork is normal, not a problem worth logging.
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('renders the result screen too', () => {
    const { ctx } = makeCtx();
    const activation = activationWith(null);
    const view = buildEncounterResolved(ctx, activation, resolutionFor(activation));

    expect(view.files ?? []).toHaveLength(0);
    expect(JSON.stringify(view.embeds)).toContain('Bandit Ambush');
  });
});

describe('encounter with artwork', () => {
  it('attaches the file and points the embed image at it', () => {
    const { ctx } = makeCtx();
    const view = buildEncounterPresent(ctx, activationWith(REAL_ASSET));

    expect(view.files ?? []).toHaveLength(1);
    // Discord's own convention: the embed references the attachment by name
    // rather than by any external URL.
    expect(imageUrl(view)).toMatch(/^attachment:\/\//);
    const [file] = (view.files ?? []) as unknown as Array<{ name: string | null }>;
    expect(imageUrl(view)).toBe(`attachment://${file!.name}`);
  });

  it('keeps the artwork on the resolved result screen', () => {
    const { ctx } = makeCtx();
    const activation = activationWith(REAL_ASSET);
    const view = buildEncounterResolved(ctx, activation, resolutionFor(activation));

    expect(view.files ?? []).toHaveLength(1);
    expect(imageUrl(view)).toMatch(/^attachment:\/\//);
  });

  it('names the attachment after the encounter, not the source file', () => {
    // Keeps `assets/` layout out of what Discord shows, and keeps the name
    // stable if the artwork file is later swapped.
    const { ctx } = makeCtx();
    const view = buildEncounterPresent(ctx, activationWith(REAL_ASSET));
    const [file] = (view.files ?? []) as unknown as Array<{ name: string | null }>;
    expect(file!.name).toContain('tv_bandit_ambush');
  });
});

describe('artwork that cannot be served', () => {
  it('degrades to text-only when the file is missing, and says so once', () => {
    const { ctx, warn } = makeCtx();
    const view = buildEncounterPresent(ctx, activationWith('encounters/definitely_absent.webp'));

    expect(view.files ?? []).toHaveLength(0);
    expect(imageUrl(view)).toBeUndefined();
    // The encounter still renders — the embed is intact.
    expect(JSON.stringify(view.embeds)).toContain('Bandit Ambush');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a path that escapes the assets directory', () => {
    const { ctx, error } = makeCtx();
    const view = buildEncounterPresent(ctx, activationWith('../../../etc/passwd'));

    expect(view.files ?? []).toHaveLength(0);
    expect(imageUrl(view)).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
