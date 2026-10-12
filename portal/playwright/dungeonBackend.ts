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
/** `rewards` adds the loot, item and equipment catalogues the reward checks need. */
export async function validate(definition: unknown, rewards?: object): Promise<Validation> {
  validator ??= import(VALIDATOR);
  return (await validator).validateDungeonDefinition(definition, { ...context, ...rewards });
}
const hasErrors = (issues: DungeonIssue[]) => issues.some((i) => i.severity === 'error');

/**
 * The engine's own reading of a draft's events and its sandbox, loaded by path
 * like the validator: pool odds, choice availability, check chances and a
 * played run are the real thing in a browser test, never a stand-in's sums.
 */
const EVENT_AUTHORING = '../../src/modules/dungeons/engine/eventAuthoring';
const SANDBOX = '../../src/modules/dungeons/engine/sandbox';
const EVENTS = '../../src/modules/dungeons/engine/events';
let engine:
  | Promise<{
      describeEventAuthoring: (definition: unknown, scenario?: unknown) => object;
      defaultEventAuthoringScenario: () => object;
      createDungeonSandbox: (options: unknown) => {
        view: { phase: string };
        state: { recent: unknown };
        effects: unknown[];
        input: (input: unknown) => Promise<{ status: string; refusal: string | null }>;
      };
      describeEventResults: (definition: unknown, recent: unknown) => unknown[];
    }>
  | undefined;
const loadEngine = () =>
  (engine ??= Promise.all([import(EVENT_AUTHORING), import(SANDBOX), import(EVENTS)]).then(
    ([authoring, sandbox, events]) => ({ ...authoring, ...sandbox, ...events }),
  ));

/** Loot the dungeon's rewards may use; see `dungeonLootBackend.ts`. */
export interface DungeonLootCatalogue {
  /** The reference rows the editor lists. */
  reference: () => { lootTables: unknown[]; items: unknown[] };
  /** The validation context for reward dependencies, as the catalogue stands now. */
  context: () => Promise<object>;
  /**
   * The tables as they stand, by key, so the stand-in can report what changed
   * since a publication the way the real `dependencyChanges` does.
   */
  tables?: () => Array<{
    key: string;
    name: string;
    archived: boolean;
    body: unknown;
    origin?: string;
  }>;
  /** Adds a table to the catalogue, as a conversion does. */
  create?: (table: {
    key: string;
    name: string;
    description: string;
    body: unknown;
  }) => Promise<void>;
}
/** A legacy expedition reward table a treasure may name, as the reward-table catalogue stores it. */
export interface LegacyRewardTable {
  enabled: boolean;
  definition: Record<string, unknown>;
}
/**
 * The real conversion (`dungeonTreasureConversion.ts`), loaded by path like
 * the validator above, so a browser test previews exactly what the server
 * would build.
 */
const CONVERSION = '../../src/modules/dungeons/dungeonTreasureConversion';
interface Conversion {
  rewards: unknown | null;
  tables: Array<{
    sourceTable: string;
    action: 'create' | 'reuse';
    key: string;
    name: string;
    description: string;
    body: unknown;
    contentHash: string;
    draws: number;
  }>;
  omitted: unknown[];
  blockers: unknown[];
}
let conversion: Promise<{ convertLegacyTreasure: (input: unknown) => Conversion }> | undefined;
export async function serveDungeon(
  page: Page,
  definition: DungeonDefinition,
  layout: DungeonLayout = { rooms: {}, notes: [] },
  loot?: DungeonLootCatalogue,
  legacyTables: Record<string, LegacyRewardTable> = {},
) {
  const check = async (draft: unknown) => validate(draft, await loot?.context());
  /** What the last publication froze: the definition, and each referenced table's body. */
  let published: { definition: string; tables: Record<string, string> } | null = null;
  const referenced = (draft: DungeonDefinition) => [
    ...new Set(
      draft.rooms.flatMap((room) =>
        room.actions.flatMap((action) => (action.rewards?.tables ?? []).map((ref) => ref.table)),
      ),
    ),
  ];
  /** The draft against the publication, definition and loot reported separately. */
  const withStatus = (detail: DungeonDetail): DungeonDetail => {
    const now = loot?.tables?.() ?? [];
    const draftDiffers =
      published === null || JSON.stringify(detail.draft) !== published.definition;
    const dependencyChanges = referenced(detail.draft).flatMap(
      (key): NonNullable<DungeonDetail['dependencyChanges']> => {
        const table = now.find((t) => t.key === key);
        const pinned = published?.tables[key];
        const change = (status: 'changed' | 'missing' | 'archived', name: string) => [
          {
            kind: 'table' as const,
            tableKey: key,
            name,
            status,
            publishedHash: pinned === undefined ? null : 'sha256:published',
            currentHash: table ? 'sha256:current' : null,
          },
        ];
        if (!table) return change('missing', key);
        if (table.archived) return change('archived', table.name);
        return pinned !== undefined && pinned !== JSON.stringify(table.body)
          ? change('changed', table.name)
          : [];
      },
    );
    return {
      ...detail,
      draftDiffers,
      draftGameplayHash: null,
      dependenciesDiffer: published !== null && !draftDiffers && dependencyChanges.length > 0,
      dependencyChanges,
    };
  };
  /** One legacy treasure's conversion as the stand-in catalogues stand, with the hash that names it. */
  const planConversion = async (input: { roomId: string; actionId: string }) => {
    const target = { roomId: input.roomId, actionId: input.actionId };
    const draft = state.detail.draft;
    const room = draft.rooms.find((r) => r.id === target.roomId);
    const action = room?.actions.find((a) => a.id === target.actionId);
    if (!room || !action?.reward || action.rewards) return null;
    conversion ??= import(CONVERSION);
    const hashBody = (body: unknown) => JSON.stringify(body);
    const result = (await conversion).convertLegacyTreasure({
      reward: action.reward,
      sources: new Map(
        [action.reward.rewardTable, action.reward.equipmentRewardTable]
          .filter((id): id is string => id !== null)
          .map((id) => {
            const table = legacyTables[id];
            return [id, table ? { ...table, contentHash: JSON.stringify(table.definition) } : null];
          }),
      ),
      lootTables: new Map(
        (loot?.tables?.() ?? []).map((t) => [
          t.key,
          { origin: t.origin ?? 'portal', contentHash: hashBody(t.body), archived: t.archived },
        ]),
      ),
      hashBody,
    });
    const bodies = JSON.stringify(result.tables.map((t) => t.body));
    return {
      dungeonKey: draft.key,
      ...target,
      roomName: room.name,
      draftRevision: state.detail.draftRevision,
      legacy: action.reward,
      ...result,
      tables: result.tables.map((t) => ({ ...t, sourceContentHash: 'sha256:source' })),
      // The stand-in does not re-check the converted rewards; the real server lists what needs fixing.
      issues: [],
      waifubuxAtRisk: bodies.includes('"waifubux"'),
      retention: {
        defeatBasisPoints: draft.settings.defeatCurrencyRetentionBasisPoints,
        abandonBasisPoints:
          draft.settings.abandonCurrencyRetentionBasisPoints ??
          draft.settings.defeatCurrencyRetentionBasisPoints,
      },
      planHash: `plan:${JSON.stringify([state.detail.draftRevision, target, result])}`,
    };
  };
  const state = {
    saves: 0,
    sandboxRuns: 0,
    publishes: 0,
    conversions: 0,
    /** What `GET reward-health` answers; a spec sets it to the situation under test. */
    health: [] as unknown[],
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
      issues: (await check(definition)).issues,
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
    const conflict = (code: string, message: string) =>
      route.fulfill({ status: 409, json: { error: { code, message }, meta } });
    if (path.endsWith('/treasure-conversion/plan')) {
      const plan = await planConversion(route.request().postDataJSON());
      return plan
        ? route.fulfill({ json: { data: plan, meta } })
        : conflict('DUNGEON_CONVERSION_UNAVAILABLE', 'This activity is not a legacy treasure.');
    }
    if (path.endsWith('/treasure-conversion/apply')) {
      const input = route.request().postDataJSON();
      if (input.expectedRevision !== state.detail.draftRevision)
        return conflict('DUNGEON_DRAFT_STALE', 'This dungeon was changed since you opened it.');
      const plan = await planConversion(input);
      if (!plan) return conflict('DUNGEON_CONVERSION_UNAVAILABLE', 'Nothing to convert.');
      if (plan.blockers.length > 0 || !plan.rewards)
        return conflict('DUNGEON_CONVERSION_BLOCKED', 'This treasure cannot be converted yet.');
      if (plan.planHash !== input.expectedPlanHash)
        return conflict('DUNGEON_CONVERSION_STALE', 'Something changed since this preview.');
      const created = plan.tables.filter((t) => t.action === 'create');
      for (const table of created) await loot?.create?.(table);
      const draft: DungeonDefinition = {
        ...state.detail.draft,
        rooms: state.detail.draft.rooms.map((room) =>
          room.id !== input.roomId
            ? room
            : {
                ...room,
                actions: room.actions.map((action) => {
                  if (action.id !== input.actionId) return action;
                  const { reward: _legacy, ...rest } = action;
                  return { ...rest, rewards: plan.rewards } as typeof action;
                }),
              },
        ),
      };
      state.conversions++;
      state.detail = {
        ...state.detail,
        draft,
        draftRevision: state.detail.draftRevision + 1,
        issues: (await check(draft)).issues,
      };
      return route.fulfill({
        json: {
          data: {
            dungeon: withStatus(state.detail),
            createdTables: created.map((t) => t.key),
            reusedTables: plan.tables.filter((t) => t.action === 'reuse').map((t) => t.key),
            replayed: false,
          },
          meta,
        },
      });
    }
    let data: unknown = withStatus(state.detail);
    if (path.endsWith('/reference'))
      data = {
        regions: REGIONS,
        currencies: [],
        rewardTables: TABLES,
        actionTypes: [],
        reservedActionTypes: {},
        enemies: ENEMIES,
        lootTables: [],
        items: [],
        ...loot?.reference(),
      };
    // Answered by `serveLoot` when a spec uses loot; otherwise there is none.
    else if (path.includes('/loot-tables')) data = { tables: [] };
    else if (path.endsWith('/reward-health')) data = { dungeons: state.health };
    else if (path.endsWith('/definitions')) data = { dungeons: [withStatus(state.detail)] };
    else if (path.endsWith('/settings'))
      data = {
        dailyRunLimit: 3,
        dailyRunLimitMin: 0,
        dailyRunLimitMax: 50,
        updatedAt: null,
        updatedBy: null,
      };
    else if (path.endsWith('/currencies')) data = { currencies: [] };
    else if (path.endsWith('/revisions')) data = { revisions: [] };
    else if (path.endsWith('/import-history')) data = { imports: [] };
    else if (path.endsWith('/history')) data = { events: [] };
    else if (path.endsWith('/validate')) {
      const body = route.request().postDataJSON();
      const report = await check(body.definition);
      const { describeEventAuthoring, defaultEventAuthoringScenario } = await loadEngine();
      data = {
        definition: report.definition,
        contentHash: 'hash',
        issues: report.issues,
        publishable: report.definition != null && !hasErrors(report.issues),
        ...(report.definition
          ? describeEventAuthoring(report.definition, {
              ...defaultEventAuthoringScenario(),
              ...body.eventScenario,
            })
          : { eventPools: [], eventPreviews: [] }),
      };
    } else if (path.endsWith('/sandbox')) {
      // Played by the real engine and kept nowhere, as the real route does.
      const body = route.request().postDataJSON();
      const report = await check(body.definition);
      if (!report.definition || hasErrors(report.issues)) return refuse(report.issues);
      state.sandboxRuns++;
      const { createDungeonSandbox, describeEventResults } = await loadEngine();
      const sandbox = createDungeonSandbox({
        definition: report.definition,
        dependencies: { enemies: {}, rewardTables: {} },
        fighter: { waifuId: 0, name: 'Sandbox Buddy', ...body.fighter },
        seed: body.seed ?? 1,
        inventory: body.inventory ?? {},
      });
      let steps = 0;
      let refusal: string | null = null;
      for (const input of body.inputs ?? []) {
        const step = await sandbox.input(input);
        if (step.status === 'refused') {
          refusal = step.refusal ?? 'refused';
          break;
        }
        steps += 1;
      }
      data = {
        view: sandbox.view,
        state: sandbox.state,
        effects: sandbox.effects,
        log: [],
        eventResults: describeEventResults(report.definition, sandbox.state.recent),
        steps,
        stoppedBy: refusal !== null ? 'refused' : sandbox.view.phase === 'ended' ? 'ended' : null,
        refusal,
      };
    } else if (path.endsWith('/draft')) {
      const input = route.request().postDataJSON();
      const report = await check(input.definition);
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
      data = withStatus(state.detail);
    } else if (path.endsWith('/publish')) {
      const report = await check(state.detail.draft);
      if (!report.definition || hasErrors(report.issues)) return refuse(report.issues);
      state.publishes++;
      const revision = {
        revisionId: state.publishes,
        number: state.publishes,
        contentHash: 'hash',
        publishedAt: '2026-10-10T00:00:00Z',
        publishedBy: 'author',
      };
      const bodies = loot?.tables?.() ?? [];
      published = {
        definition: JSON.stringify(state.detail.draft),
        tables: Object.fromEntries(
          referenced(state.detail.draft).flatMap((key) => {
            const table = bodies.find((t) => t.key === key);
            return table ? [[key, JSON.stringify(table.body)]] : [];
          }),
        ),
      };
      state.detail = { ...state.detail, published: revision, issues: report.issues };
      data = {
        dungeon: withStatus(state.detail),
        revision: { ...revision, source: 'editor', draftRevision: 1, current: true, activeRuns: 0 },
        unchanged: false,
      };
    }
    await route.fulfill({ json: { data, meta } });
  });
  return state;
}
