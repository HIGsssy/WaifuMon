/**
 * A stand-in dungeon authoring API for browser tests that keeps the part that
 * matters real: drafts are checked by the server's own
 * `validateDungeonDefinition`, so a draft the real API would refuse to store
 * is refused here, and every issue shown is one the real validator raised.
 */
import type { Page } from '@playwright/test';
import type {
  DungeonDefinition,
  DungeonDetail,
  DungeonIssue,
  DungeonLayout,
} from '../src/api/adminDungeons';

export const ENEMIES = [
  {
    key: 'slime',
    name: 'Scrapyard Drone',
    enabled: true,
    attack: 6,
    defense: 2,
    hp: 40,
    sprite: true,
    artwork: true,
  },
  {
    key: 'golem',
    name: 'Rust Golem',
    enabled: true,
    attack: 9,
    defense: 5,
    hp: 90,
    sprite: false,
    artwork: true,
  },
  {
    key: 'warden',
    name: 'The Warden',
    enabled: true,
    attack: 14,
    defense: 8,
    hp: 220,
    sprite: true,
    artwork: true,
  },
  {
    key: 'retired',
    name: 'Old Sentry',
    enabled: false,
    attack: 3,
    defense: 1,
    hp: 20,
    sprite: false,
    artwork: false,
  },
];
/** A real, decodable image for every picture the stand-in serves. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHxcCAr7uqmIAAAAASUVORK5CYII=',
  'base64',
);
const hash = (letter: string) => letter.repeat(64);
const asset = (id: string, name: string, category: string, contentHash: string) => ({
  id,
  category,
  name,
  originalFilename: `${name.toLowerCase().replace(/\s+/g, '_')}.png`,
  mimeType: 'image/png',
  width: 1200,
  height: 675,
  hasAlpha: false,
  fileSize: 204800,
  contentHash,
  version: 1,
  status: 'active',
  uploadedBy: '777',
  updatedBy: '777',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  replacedAt: null,
});
/** The uploaded pictures this server holds. Anything else a dungeon names is "not on this server". */
export const LIBRARY = [
  asset('00000001-0000-4000-8000-000000000001', 'Night Tunnels', 'dungeon_background', hash('a')),
  asset('00000002-0000-4000-8000-000000000002', 'Boiler Room', 'dungeon_background', hash('b')),
  asset('00000003-0000-4000-8000-000000000003', 'Tunnels Cover', 'dungeon_zone', hash('c')),
];
const REGIONS = [{ id: 'waifu-valley', name: 'Waifu Valley', enabled: true }];
const TABLES = [{ id: 'tunnel_loot', enabled: true }];
const index = <T extends { enabled: boolean }>(rows: T[], key: (row: T) => string) =>
  new Map(rows.map((row) => [key(row), { enabled: row.enabled }]));
const context = {
  enemies: index(ENEMIES, (e) => e.key),
  regions: index(REGIONS, (r) => r.id),
  rewardTables: index(TABLES, (t) => t.id),
  currencies: new Map<string, { enabled: boolean }>(),
  // What the real service passes: every uploaded picture a reference resolves to here.
  managedArtwork: new Set(LIBRARY.map((a) => `${a.category}:${a.contentHash}`)),
};
interface Validation {
  definition: unknown | null;
  issues: DungeonIssue[];
}
/**
 * The validator is the bot's own module, loaded by path when a test runs. It
 * is deliberately not a static import: the Portal's typecheck, lint rule and
 * production build must never depend on bot source, and this file is only
 * ever executed by Playwright from a full checkout.
 */
const VALIDATOR = '../../src/modules/dungeons/validation/dungeonValidation';
let validator:
  Promise<{ validateDungeonDefinition: (raw: unknown, ctx: unknown) => Validation }> | undefined;
export async function validate(definition: unknown): Promise<Validation> {
  validator ??= import(VALIDATOR);
  return (await validator).validateDungeonDefinition(definition, context);
}
const hasErrors = (issues: DungeonIssue[]) => issues.some((i) => i.severity === 'error');

export async function serveDungeon(
  page: Page,
  definition: DungeonDefinition,
  layout: DungeonLayout = { rooms: {}, notes: [] },
) {
  const state = {
    saves: 0,
    publishes: 0,
    /** Every fight preview the editor asked for. */
    scenes: [] as Array<{ enemyKey: string; backgrounds: unknown[] }>,
    detail: {
      key: definition.key,
      name: definition.name,
      enabled: true,
      position: 0,
      roomCount: definition.rooms.length,
      draftRevision: 1,
      draftHash: 'hash',
      published: null,
      draftDiffers: true,
      open: false,
      updatedAt: '2026-10-10T00:00:00Z',
      updatedBy: null,
      draft: definition,
      layout,
      issues: (await validate(definition)).issues,
    } as DungeonDetail,
  };
  await page.route('**/api/v1/admin/artwork/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/file'))
      return route.fulfill({ contentType: 'image/png', body: PNG });
    const category = url.searchParams.get('category');
    const assets = LIBRARY.filter((a) => !category || a.category === category);
    await route.fulfill({
      json: { data: { assets, total: assets.length }, meta: { requestId: 'dungeon-backend' } },
    });
  });
  await page.route('**/api/v1/admin/dungeons/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const meta = { requestId: 'dungeon-backend' };
    const refuse = (issues: unknown[]) =>
      route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'DUNGEON_INVALID',
            message: 'The dungeon is not valid.',
            details: { issues },
          },
          meta,
        },
      });
    const missing = () =>
      route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'Not found.' }, meta },
      });
    if (path.endsWith('/artwork/managed')) {
      const query = new URL(route.request().url()).searchParams;
      const held = LIBRARY.some(
        (a) => a.category === query.get('category') && a.contentHash === query.get('contentHash'),
      );
      return held ? route.fulfill({ contentType: 'image/png', body: PNG }) : missing();
    }
    if (path.endsWith('/artwork')) return missing();
    if (path.endsWith('/scene-preview')) {
      const input = route.request().postDataJSON() as {
        enemyKey: string;
        backgrounds: Array<{ kind: string; category?: string; contentHash?: string } | null>;
      };
      state.scenes.push(input);
      const enemy = ENEMIES.find((e) => e.key === input.enemyKey);
      if (!enemy || (!enemy.sprite && !enemy.artwork)) return missing();
      // The same fallback a run uses: the first background this server actually holds.
      const used = input.backgrounds.findIndex(
        (ref) =>
          ref?.kind === 'managed' &&
          LIBRARY.some((a) => a.category === ref.category && a.contentHash === ref.contentHash),
      );
      return route.fulfill({
        contentType: 'image/png',
        body: PNG,
        headers: enemy.sprite
          ? {
              'x-dungeon-scene': 'sprite',
              'x-dungeon-scene-background': used < 0 ? 'plain' : String(used),
            }
          : { 'x-dungeon-scene': 'full-art' },
      });
    }
    let data: unknown = state.detail;
    if (path.endsWith('/reference'))
      data = {
        regions: REGIONS,
        currencies: [],
        rewardTables: TABLES,
        actionTypes: [],
        reservedActionTypes: {},
        enemies: ENEMIES,
      };
    else if (path.endsWith('/revisions')) data = { revisions: [] };
    else if (path.endsWith('/import-history')) data = { imports: [] };
    else if (path.endsWith('/history')) data = { events: [] };
    else if (path.endsWith('/validate')) {
      const report = await validate(route.request().postDataJSON().definition);
      data = {
        definition: report.definition,
        contentHash: 'hash',
        issues: report.issues,
        publishable: report.definition != null && !hasErrors(report.issues),
      };
    } else if (path.endsWith('/draft')) {
      const input = route.request().postDataJSON();
      const report = await validate(input.definition);
      // The real service stores only a draft whose shape parses.
      if (!report.definition) return refuse(report.issues);
      const draft = report.definition as DungeonDefinition;
      state.saves++;
      state.detail = {
        ...state.detail,
        name: draft.name,
        draft,
        layout: input.layout,
        draftRevision: state.detail.draftRevision + 1,
        issues: report.issues,
      };
      data = state.detail;
    } else if (path.endsWith('/publish')) {
      const report = await validate(state.detail.draft);
      if (!report.definition || hasErrors(report.issues)) return refuse(report.issues);
      state.publishes++;
      const revision = {
        revisionId: state.publishes,
        number: state.publishes,
        contentHash: 'hash',
        publishedAt: '2026-10-10T00:00:00Z',
        publishedBy: 'author',
      };
      state.detail = { ...state.detail, published: revision, draftDiffers: false };
      data = {
        dungeon: state.detail,
        revision: { ...revision, source: 'editor', draftRevision: 1, current: true, activeRuns: 0 },
        unchanged: false,
      };
    }
    await route.fulfill({ json: { data, meta } });
  });
  return state;
}
