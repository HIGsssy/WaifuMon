/**
 * `cards:warm --player` and `--all-players`, against a real database.
 *
 * The CLI itself is argument parsing; the thing worth testing is
 * `runOwnedCardWarm` — the query that finds a player's copies, the planner that
 * turns them into cards, and the report the operator reads. So this suite
 * drives that directly, with real rows, real shipped content, and real
 * rendering into a temp cache.
 *
 * The critical property is the one that has no unit-test equivalent: the CLI
 * warms through **the same planner runtime uses**. A back-catalogue warm that
 * built its inputs its own way would fill the cache with keys no request ever
 * asks for, and the symptom would be a warm run that reports success while the
 * grid stays cold.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../helpers/testDb';
import {
  ASSETS_DIR,
  CONTENT_DIR,
  bootstrapApp,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../../helpers/fixtures';
import { makeTempDir } from '../../helpers/cardFixtures';
import { playerWaifus, species as speciesTable } from '../../../src/db/schema';
import { createCardRenderer, type CardRenderer } from '../../../src/modules/cards';
import { runOwnedCardWarm } from '../../../src/tools/cardCacheOps';
import {
  listOwnedWarmSubjects,
  listPlayersWithOwnedCards,
} from '../../../src/modules/appearance/ownedCardWarmSubjects';
import { readContentFiles } from '../../../src/modules/content/loader';
import { defaultAppearance } from '../../../src/modules/appearance/appearanceContent';
import { resolveAppearanceAssetOrLegacyPath } from '../../../src/modules/appearance/assetResolver';

let t: TestDb;
let app: App;
let workdir: string;
let cacheRoot: string;
let renderer: CardRenderer;
let playerA: number;
let playerB: number;
/** Two enabled species whose default artwork really exists on disk. */
let slugs: string[];

/** Files under the temp cache, so "did the warm write anything" is observable. */
async function cacheFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const slug of slugs) {
    const dir = path.join(cacheRoot, slug);
    try {
      out.push(...(await fs.readdir(dir)).map((f) => `${slug}/${f}`));
    } catch {
      // No directory means nothing warmed for that species — a real answer.
    }
  }
  return out.sort();
}

async function giveCopy(playerId: number, slug: string, level: number): Promise<number> {
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.slug, slug));
  if (!row) throw new Error(`species ${slug} was not seeded`);
  const inserted = await insertOwnedWaifu(t.db, { playerId, speciesId: row.id, level });
  return inserted!.id;
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);

  // Two players in two guilds, so `--all-players` has something to enumerate.
  playerA = (await provisionPlayer(app, 'g-warm-a', 'u-warm-a')).playerId;
  playerB = (await provisionPlayer(app, 'g-warm-b', 'u-warm-b')).playerId;

  // Pick species from the shipped set whose default artwork actually resolves,
  // rather than naming slugs that a content edit could retire underneath us.
  const content = readContentFiles(CONTENT_DIR);
  slugs = content.species
    .filter((s) => s.enabled)
    .filter(
      (s) =>
        resolveAppearanceAssetOrLegacyPath(
          { assetsDir: ASSETS_DIR },
          defaultAppearance(s).assetId,
          s.imagePath,
        ) !== null,
    )
    .slice(0, 2)
    .map((s) => s.slug);
  expect(slugs).toHaveLength(2);

  await giveCopy(playerA, slugs[0]!, 14);
  await giveCopy(playerB, slugs[1]!, 3);

  workdir = await makeTempDir('cards-owned-cli');
  cacheRoot = path.join(workdir, 'cache');
  renderer = createCardRenderer({ cacheRoot, workers: 0 });
}, 180_000);

afterAll(async () => {
  await renderer?.shutdown();
  await fs.rm(workdir, { recursive: true, force: true });
  await t?.cleanup();
});

describe('listing what to warm', () => {
  it('finds a player’s active copies, with the level and look on the row', async () => {
    const subjects = await listOwnedWarmSubjects(t.db, playerA);

    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatchObject({
      waifu: { level: 14, variant: 'standard' },
      species: { slug: slugs[0] },
    });
  });

  it('excludes a released copy — she is not in the grid, so she needs no card', async () => {
    const releasedId = await giveCopy(playerA, slugs[0]!, 9);
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, releasedId));

    const subjects = await listOwnedWarmSubjects(t.db, playerA);
    expect(subjects.map((s) => s.waifu.id)).not.toContain(releasedId);

    await t.db.delete(playerWaifus).where(eq(playerWaifus.id, releasedId));
  });

  it('enumerates only players who own something', async () => {
    const players = await listPlayersWithOwnedCards(t.db);
    expect(players).toEqual([playerA, playerB].sort((a, b) => a - b));
  });
});

describe('cards:warm --player', () => {
  it('warms that player’s cards and nobody else’s', async () => {
    const report = await runOwnedCardWarm({
      db: t.db,
      contentDir: CONTENT_DIR,
      assetsDir: ASSETS_DIR,
      playerIds: [playerA],
      renderer,
    });

    expect(report.playersProcessed).toBe(1);
    expect(report.ownedConsidered).toBe(1);
    expect(report.mastersRendered).toBe(1);
    expect(report.derivativesCreated).toBe(2);
    expect(report.failed).toEqual([]);

    // Player B's species has no cache directory yet.
    expect(await cacheFiles()).toHaveLength(3);
  }, 120_000);

  it('reports everything as cached on a second run and renders nothing', async () => {
    const report = await runOwnedCardWarm({
      db: t.db,
      contentDir: CONTENT_DIR,
      assetsDir: ASSETS_DIR,
      playerIds: [playerA],
      renderer,
    });

    expect(report.mastersCached).toBe(1);
    expect(report.derivativesCached).toBe(2);
    expect(report.mastersRendered + report.derivativesCreated).toBe(0);
  }, 120_000);

  it('produces the master plus @256 and @512, and no @1024', async () => {
    const widths = (await cacheFiles())
      .filter((file) => file.startsWith(`${slugs[0]}/`))
      .map((file) => /@(\d+)\.webp$/.exec(file)?.[1] ?? 'master')
      .sort();

    expect(widths).toEqual(['256', '512', 'master']);
  });

  it('warms nothing for a player with no copies, without failing', async () => {
    const empty = (await provisionPlayer(app, 'g-warm-c', 'u-warm-c')).playerId;

    const report = await runOwnedCardWarm({
      db: t.db,
      contentDir: CONTENT_DIR,
      assetsDir: ASSETS_DIR,
      playerIds: [empty],
      renderer,
    });

    expect(report.playersProcessed).toBe(1);
    expect(report.ownedConsidered).toBe(0);
    expect(report.failed).toEqual([]);
  });
});

describe('cards:warm --all-players', () => {
  it('covers every player who owns something, conservatively by default', async () => {
    const report = await runOwnedCardWarm({
      db: t.db,
      contentDir: CONTENT_DIR,
      assetsDir: ASSETS_DIR,
      renderer,
    });

    expect(report.playersProcessed).toBe(2);
    expect(report.ownedConsidered).toBe(2);
    // Player A was already warm; only player B's card is new work.
    expect(report.mastersRendered).toBe(1);
    expect(report.mastersCached).toBe(1);

    // One player warmed at a time unless an operator says otherwise.
    expect(report.playerConcurrency).toBe(1);

    expect(await cacheFiles()).toHaveLength(6);
  }, 180_000);
});
