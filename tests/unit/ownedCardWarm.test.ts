/**
 * Owned-card warming — what gets warmed, and what deliberately does not.
 *
 * The renderer here is a double. Everything under test is a *decision* — which
 * card, at which widths, whether to render at all, whether to start a second
 * warm for a player already being warmed — and none of those decisions need a
 * 1.4-second rasterization to be observed. The real bytes are covered by
 * `tests/integration/cards/warm.owned.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OwnedCardWarmer,
  OWNED_GRID_WIDTHS,
  planOwnedCardWarm,
  warmOwnedCards,
  type OwnedCardWarmSubject,
} from '../../src/modules/appearance/ownedCardWarm';
import type { CardPresentationDeps } from '../../src/modules/appearance/cardPresentation';
import { CARD_MASTER_WIDTH, type CardRenderInput, type CardRenderer } from '../../src/modules/cards';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import { SpeciesFileSchema } from '../../src/modules/content/schemas';

const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'warm_subject',
    name: 'Warm Subject',
    rarity: 'SR',
    archetype: 'demon',
    race: 'demon',
    contentRating: 'suggestive',
    affinity: 'primal',
    description: 'A warmable subject.',
    imagePath: 'waifumon/warm_subject/standard.png',
    appearances: [
      { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
      { id: 'level_20', name: 'Level 20', sortOrder: 20, unlock: { type: 'level', atLevel: 20 } },
    ],
  },
  {
    slug: 'warm_other',
    name: 'Warm Other',
    rarity: 'N',
    archetype: 'spirit',
    race: 'spirit',
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: 'waifumon/warm_other/standard.png',
  },
]);

let assetsDir: string;
let deps: CardPresentationDeps;

function writeArt(slug: string, variant: string): void {
  const dir = path.join(assetsDir, 'waifumon', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${variant}.png`), Buffer.from(`art:${slug}:${variant}`));
}

/** An owned copy, as `listOwnedWarmSubjects` would hand it over. */
function copy(
  id: number,
  level: number,
  variant: string | null,
  slug = 'warm_subject',
): OwnedCardWarmSubject {
  return { waifu: { id, level, variant }, species: { slug } };
}

/** Identity of one planned card, at the granularity the cache uses. */
function keyOf(input: CardRenderInput): string {
  const width = input.output?.width ?? CARD_MASTER_WIDTH;
  return [
    input.species.slug,
    input.variant.appearanceId,
    `lv${input.progress?.level ?? 1}`,
    input.context?.owned === true ? 'owned' : 'preview',
    `w${width}`,
  ].join(':');
}

/**
 * A renderer that records instead of rasterizing.
 *
 * `cached` is the disk: `isCached` reads it, and a render adds to it, so the
 * "second run does nothing" property is a real consequence rather than a
 * hard-coded answer.
 */
class FakeRenderer implements CardRenderer {
  readonly cached = new Set<string>();
  readonly probed: string[] = [];
  readonly renders: CardRenderInput[] = [];
  /** Slugs whose render throws — content debt, simulated. */
  readonly failing = new Set<string>();

  async isCached(input: CardRenderInput): Promise<boolean> {
    const key = keyOf(input);
    this.probed.push(key);
    return this.cached.has(key);
  }

  async renderCard(input: CardRenderInput): Promise<never | ReturnType<typeof fakeResult>> {
    if (this.failing.has(input.species.slug)) {
      throw new Error(`no artwork for ${input.species.slug}`);
    }
    this.renders.push(input);
    const key = keyOf(input);
    const fromCache = this.cached.has(key);
    this.cached.add(key);
    // A derivative render also produces its master, exactly as the real one does.
    this.cached.add(keyOf({ ...input, output: undefined }));
    return fakeResult(input, fromCache);
  }

  async computeMasterRenderKey(input: CardRenderInput): Promise<string> {
    return keyOf({ ...input, output: undefined });
  }

  async hashArtwork(): Promise<string> {
    return 'hash';
  }

  async validateAssets(): Promise<void> {}

  getStats() {
    return { masterRenders: 0, derivativeRenders: 0, cacheHits: 0, dedupedRenders: 0 };
  }

  async shutdown(): Promise<void> {}

  /** Widths this renderer was actually asked to draw, master included. */
  renderedWidths(): number[] {
    return this.renders.map((input) => input.output?.width ?? CARD_MASTER_WIDTH);
  }
}

function fakeResult(input: CardRenderInput, fromCache: boolean) {
  const width = input.output?.width ?? CARD_MASTER_WIDTH;
  return {
    bytes: Buffer.alloc(0),
    contentType: 'image/webp' as const,
    renderKey: keyOf({ ...input, output: undefined }),
    fromCache,
    width,
    height: width,
    etag: '"fake"',
  };
}

let renderer: FakeRenderer;

beforeAll(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-owned-warm-'));
  writeArt('warm_subject', 'standard');
  writeArt('warm_subject', 'level_20');
  writeArt('warm_other', 'standard');

  const content = { items: [], species: SPECIES, tables: {} } as never;
  const appearance = createAppearanceService({ db: null as never, getContent: () => content });
  deps = { appearance, assetsDir };
});

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

beforeEach(() => {
  renderer = new FakeRenderer();
});

describe('planOwnedCardWarm', () => {
  it('warms the copy’s current level, not a preview level', () => {
    const plan = planOwnedCardWarm(deps, [copy(1, 37, 'standard')]);
    expect(new Set(plan.inputs.map((i) => i.progress?.level))).toEqual(new Set([37]));
  });

  it('warms the appearance she is currently wearing', () => {
    const plan = planOwnedCardWarm(deps, [copy(1, 25, 'level_20')]);
    for (const input of plan.inputs) {
      expect(input.variant.appearanceId).toBe('level_20');
      expect(input.variant.artworkAbsolutePath).toContain('level_20.png');
    }
  });

  it('marks every warmed card as owned, so the CAUGHT badge is in the key', () => {
    const plan = planOwnedCardWarm(deps, [copy(1, 5, 'standard')]);
    expect(plan.inputs.every((i) => i.context?.owned === true)).toBe(true);
  });

  /**
   * The load-bearing scope rule. Level and appearance are both part of the
   * render key, so warming her history or her future would multiply the cache
   * by the level cap for cards nothing will request.
   */
  it('warms only her current state — one card, three widths, nothing else', () => {
    const plan = planOwnedCardWarm(deps, [copy(1, 25, 'level_20')]);

    expect(plan.inputs).toHaveLength(1 + OWNED_GRID_WIDTHS.length);
    expect(new Set(plan.inputs.map(keyOf))).toEqual(
      new Set([
        'warm_subject:level_20:lv25:owned:w1500',
        'warm_subject:level_20:lv25:owned:w256',
        'warm_subject:level_20:lv25:owned:w512',
      ]),
    );
  });

  it('plans the master plus the two grid derivatives, and no @1024', () => {
    const plan = planOwnedCardWarm(deps, [copy(1, 5, 'standard')]);
    const widths = plan.inputs.map((i) => i.output?.width ?? CARD_MASTER_WIDTH);

    expect(widths).toEqual([CARD_MASTER_WIDTH, 256, 512]);
    expect(widths).not.toContain(1024);
  });

  it('plans the master before the derivatives that resize from it', () => {
    const plan = planOwnedCardWarm(deps, [copy(1, 5, 'standard')]);
    expect(plan.inputs[0]?.output).toBeUndefined();
  });

  it('can skip the master, for a copy whose card was just rendered', () => {
    const plan = planOwnedCardWarm(deps, [copy(1, 5, 'standard')], { includeMaster: false });
    expect(plan.inputs.map((i) => i.output?.width)).toEqual([256, 512]);
  });

  it('records a copy it cannot resolve rather than throwing', () => {
    const plan = planOwnedCardWarm(deps, [
      copy(1, 5, 'standard'),
      copy(2, 5, 'standard', 'departed_species'),
    ]);

    expect(plan.ownedConsidered).toBe(2);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.waifuId).toBe(2);
    expect(plan.inputs.every((i) => i.species.slug === 'warm_subject')).toBe(true);
  });
});

describe('warmOwnedCards', () => {
  it('renders the master and both derivatives on a cold cache', async () => {
    const result = await warmOwnedCards(deps, [copy(1, 5, 'standard')], { renderer });

    expect(result.mastersRendered).toBe(1);
    expect(result.derivativesCreated).toBe(2);
    expect(renderer.renderedWidths()).toEqual([CARD_MASTER_WIDTH, 256, 512]);
  });

  it('never asks for @1024 — that is the hero bucket, not a grid tile', async () => {
    await warmOwnedCards(deps, [copy(1, 5, 'standard')], { renderer });
    expect(renderer.renderedWidths()).not.toContain(1024);
    expect(renderer.probed.some((key) => key.endsWith('w1024'))).toBe(false);
  });

  it('does not draw a cold master when one is already cached', async () => {
    renderer.cached.add('warm_subject:standard:lv5:owned:w1500');

    const result = await warmOwnedCards(deps, [copy(1, 5, 'standard')], { renderer });

    expect(result.mastersRendered).toBe(0);
    expect(result.mastersCached).toBe(1);
    expect(renderer.renderedWidths()).toEqual([256, 512]);
  });

  it('does not resize a derivative that is already cached', async () => {
    renderer.cached.add('warm_subject:standard:lv5:owned:w256');

    const result = await warmOwnedCards(deps, [copy(1, 5, 'standard')], { renderer });

    expect(result.derivativesCached).toBe(1);
    expect(result.derivativesCreated).toBe(1);
    expect(renderer.renderedWidths()).not.toContain(256);
  });

  it('is idempotent — a second run over the same copies renders nothing', async () => {
    await warmOwnedCards(deps, [copy(1, 5, 'standard')], { renderer });
    renderer.renders.length = 0;

    const second = await warmOwnedCards(deps, [copy(1, 5, 'standard')], { renderer });

    expect(renderer.renders).toHaveLength(0);
    expect(second.mastersRendered + second.derivativesCreated).toBe(0);
    expect(second.mastersCached).toBe(1);
    expect(second.derivativesCached).toBe(2);
  });

  it('keeps warming the rest of a collection after one card fails', async () => {
    renderer.failing.add('warm_other');

    const result = await warmOwnedCards(
      deps,
      [copy(1, 5, 'standard', 'warm_other'), copy(2, 9, 'standard')],
      { renderer },
    );

    expect(result.failed).toHaveLength(3); // the failing copy's master and both widths
    expect(result.failed.every((f) => f.slug === 'warm_other')).toBe(true);
    // The healthy copy is warmed in full regardless.
    expect(result.mastersRendered).toBe(1);
    expect(result.derivativesCreated).toBe(2);
  });
});

describe('OwnedCardWarmer', () => {
  function warmer(subjects: OwnedCardWarmSubject[], maxActive?: number): OwnedCardWarmer {
    return new OwnedCardWarmer({
      presentation: deps,
      listSubjects: async () => subjects,
      renderer,
      ...(maxActive === undefined ? {} : { maxActive }),
    });
  }

  it('starts one background warm per player and dedupes the rest', async () => {
    const warm = warmer([copy(1, 5, 'standard')]);

    expect(warm.schedulePlayerWarm(7)).toBe('started');
    expect(warm.schedulePlayerWarm(7)).toBe('deduped');
    expect(warm.schedulePlayerWarm(7)).toBe('deduped');
    expect(warm.isWarmingPlayer(7)).toBe(true);

    await warm.whenIdle();

    // One warm ran, not three.
    expect(renderer.renders).toHaveLength(3);
    expect(warm.activeWarms).toBe(0);
  });

  it('warms a different player concurrently rather than deduping them together', () => {
    const warm = warmer([copy(1, 5, 'standard')]);

    expect(warm.schedulePlayerWarm(7)).toBe('started');
    expect(warm.schedulePlayerWarm(8)).toBe('started');
    expect(warm.activeWarms).toBe(2);
  });

  it('drops a warm rather than queueing it when too many are running', async () => {
    const warm = warmer([copy(1, 5, 'standard')], 1);

    expect(warm.schedulePlayerWarm(7)).toBe('started');
    expect(warm.schedulePlayerWarm(8)).toBe('saturated');

    await warm.whenIdle();
    // Dropped, not deferred: nothing runs for player 8 afterwards either.
    expect(warm.activeWarms).toBe(0);
  });

  it('returns synchronously — a caller never waits for the warm', () => {
    const warm = warmer([copy(1, 5, 'standard')]);
    const disposition = warm.schedulePlayerWarm(7);

    expect(disposition).toBe('started');
    // The work has not run yet; the caller has already been handed an answer.
    expect(renderer.renders).toHaveLength(0);
  });

  it('never rejects, even when every card in the warm fails', async () => {
    renderer.failing.add('warm_subject');
    const warm = warmer([copy(1, 5, 'standard')]);

    expect(warm.schedulePlayerWarm(7)).toBe('started');
    await expect(warm.whenIdle()).resolves.toBeUndefined();
  });

  it('warms only the grid derivatives after a capture, never a fresh master', async () => {
    const warm = warmer([]);

    expect(warm.scheduleCopyWarm(copy(42, 5, 'standard'))).toBe('started');
    await warm.whenIdle();

    expect(renderer.renderedWidths()).toEqual([256, 512]);
    expect(renderer.renderedWidths()).not.toContain(CARD_MASTER_WIDTH);
  });

  it('dedupes the two card renders one capture produces into one warm', async () => {
    const warm = warmer([]);
    const captured = copy(42, 5, 'standard');

    // The ephemeral reply and the public announcement both render this card.
    expect(warm.scheduleCopyWarm(captured)).toBe('started');
    expect(warm.scheduleCopyWarm(captured)).toBe('deduped');

    await warm.whenIdle();
    expect(renderer.renders).toHaveLength(2);
  });
});
