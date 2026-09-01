/**
 * Throwaway copies of the real `content/` tree plus a minimal assets root, so
 * admin-panel tests exercise the shipped schemas and cross-references without
 * ever writing to the repository's own content files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminContentService, type AdminContentService } from '../../src/modules/content/adminContentService';
import type { ReloadResult } from '../../src/modules/content/reloadService';
import { createLogger, type Logger } from '../../src/shared/logger';

const REPO_CONTENT = path.resolve(process.cwd(), 'content');

export interface AdminFixture {
  contentDir: string;
  assetsDir: string;
  logger: Logger;
  service: AdminContentService;
  /** Incremented every time the injected reloader runs. */
  reloadCalls: number;
  readSpecies(file: string): unknown[];
  readItems(): { items: unknown[] };
  readTables(): Record<string, unknown>;
  /** Writes tables.json directly, bypassing the service's validation. */
  writeTablesRaw(tables: Record<string, unknown>): void;
  backups(): string[];
  cleanup(): void;
}

export function createAdminFixture(
  opts: { reload?: () => Promise<ReloadResult> } = {},
): AdminFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-admin-'));
  const contentDir = path.join(root, 'content');
  const assetsDir = path.join(root, 'assets');
  fs.mkdirSync(path.join(contentDir, 'species'), { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  for (const file of ['items.json', 'tables.json']) {
    fs.copyFileSync(path.join(REPO_CONTENT, file), path.join(contentDir, file));
  }
  for (const file of fs.readdirSync(path.join(REPO_CONTENT, 'species'))) {
    if (!file.endsWith('.json')) continue;
    fs.copyFileSync(
      path.join(REPO_CONTENT, 'species', file),
      path.join(contentDir, 'species', file),
    );
  }

  // One real art file so the authenticated preview route has something to serve.
  fs.mkdirSync(path.join(assetsDir, 'waifumon', 'alley_catgirl'), { recursive: true });
  fs.writeFileSync(
    path.join(assetsDir, 'waifumon', 'alley_catgirl', 'standard.png'),
    Buffer.from('89504e470d0a1a0a', 'hex'),
  );

  const logger = createLogger('silent');
  const fixture: AdminFixture = {
    contentDir,
    assetsDir,
    logger,
    reloadCalls: 0,
    service: undefined as unknown as AdminContentService,
    readSpecies: (file) =>
      JSON.parse(fs.readFileSync(path.join(contentDir, 'species', file), 'utf8')),
    readItems: () => JSON.parse(fs.readFileSync(path.join(contentDir, 'items.json'), 'utf8')),
    readTables: () => JSON.parse(fs.readFileSync(path.join(contentDir, 'tables.json'), 'utf8')),
    writeTablesRaw: (tables) =>
      fs.writeFileSync(
        path.join(contentDir, 'tables.json'),
        `${JSON.stringify(tables, null, 2)}\n`,
        'utf8',
      ),
    backups: () => {
      const dir = path.join(contentDir, 'backups');
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };

  fixture.service = createAdminContentService({
    contentDir,
    assetsDir,
    logger,
    reload: async () => {
      fixture.reloadCalls += 1;
      return (
        (await opts.reload?.()) ??
        ({
          content: { items: [], species: [], tables: {} },
          summary: { items: 0, species: 0, disabledItems: 0, disabledSpecies: 0 },
        } as unknown as ReloadResult)
      );
    },
  });
  return fixture;
}

/** A valid species payload; spread over it to build invalid variants. */
export function validSpeciesInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'test_admin_waifu',
    name: 'Test Admin Waifu',
    rarity: 'R',
    archetype: 'tester',
    baseCaptureRate: null,
    description: 'Added by the admin panel test suite.',
    tags: ['test'],
    contentRating: 'suggestive',
    affinity: 'dominant',
    imagePath: 'waifumon/test_admin_waifu/standard.png',
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    ...overrides,
  };
}

export function validItemInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'test_admin_item',
    name: 'Test Admin Item',
    category: 'material',
    captureModifier: null,
    isGuaranteedCapture: false,
    shopRegions: [],
    buyPrice: null,
    priceCurrency: 'waifubux',
    dailyStockLimit: null,
    effectType: null,
    effectConfig: null,
    description: 'Added by the admin panel test suite.',
    emoji: null,
    enabled: true,
    ...overrides,
  };
}
