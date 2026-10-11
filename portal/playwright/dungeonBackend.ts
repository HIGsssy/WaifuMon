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
  { key: 'slime', name: 'Scrapyard Drone', enabled: true, attack: 6, defense: 2, hp: 40 },
  { key: 'golem', name: 'Rust Golem', enabled: true, attack: 9, defense: 5, hp: 90 },
  { key: 'warden', name: 'The Warden', enabled: true, attack: 14, defense: 8, hp: 220 },
  { key: 'retired', name: 'Old Sentry', enabled: false, attack: 3, defense: 1, hp: 20 },
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
