/**
 * Portal admin — dungeon authoring, the progression currency, and the sandbox.
 *
 * A dungeon is a mutable **draft** plus immutable **published revisions** (see
 * `modules/dungeons/dungeonContentService`). Players only ever meet a
 * published revision, and a run names the one it started on, so nothing here
 * changes a run in progress.
 *
 *   - `dungeons.read`    — list, get, revisions, history, reference data,
 *     validate (dry run), export, package inspection, the sandbox, the
 *     currency list, the Delve settings, and the artwork picker (bytes,
 *     browse, search — rooted at `dungeons/`, never the whole assets tree).
 *   - `dungeons.write`   — create, save the draft and its layout,
 *     enable/disable, the currency's display metadata, and the Delve settings
 *     (the shared daily run limit).
 *   - `dungeons.publish` — publish the draft as a new revision, and roll back
 *     to an earlier one. Its own grant because these are the only two acts
 *     that change what players get; a save never does.
 *
 * A draft save and a publish are optimistic: each names the `draftRevision`
 * it worked from, and one that lost a race answers `409 DUNGEON_DRAFT_STALE`
 * with the current revision instead of overwriting. A draft may be saved with
 * validation errors — it is work in progress — but its shape must be readable;
 * a publish (and a rollback) is refused with `400 DUNGEON_INVALID` and the
 * issues, each with a stable `code`. There is no delete — disable a dungeon.
 *
 * Validate, package inspection and the sandbox write nothing. The sandbox
 * plays the real engine against live enemies with an effects port that only
 * records. Importing a package is a later phase; `package/inspect` only
 * verifies a file on its own terms.
 */
import { z } from 'zod';
import { adminDungeonLootTableRoutes } from './dungeonLootTables';
import { dungeonLootTableTierSchema } from '../../../schemas/dungeonLootTables';
import { readFile } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { ApiErrorWithDetails, ApiFieldValidationError } from '../../../errors';
import {
  adminArtworkBrowseQuery,
  adminArtworkQuery,
  adminArtworkSearchQuery,
  artworkDirectorySchema,
  artworkSearchSchema,
  browseAdminArtwork,
  searchAdminArtwork,
  sendAdminArtwork,
} from '../../../adminArtwork';
import {
  AppError,
  DungeonConversionError,
  DungeonDraftStaleError,
  DungeonInvalidError,
  DungeonImportError,
  DungeonNotFoundError,
  DungeonRevisionNotFoundError,
  ProgressionCurrencyInvalidError,
  ProgressionCurrencyStaleError,
} from '../../../../shared/errors';
import {
  DUNGEON_DAILY_RUN_LIMIT_BOUNDS,
  type DungeonSettings,
} from '../../../../modules/dungeons/dungeonAllowanceService';
import type {
  DungeonContentEvent,
  DungeonContentService,
  DungeonTreasureConversionPlan,
  DungeonDetail,
  DungeonExportOrigin,
  DungeonPublishResult,
  DungeonRevisionDetail,
  DungeonRevisionSummary,
  DungeonSummary,
} from '../../../../modules/dungeons/dungeonContentService';
import {
  DUNGEON_ID_MAX_LENGTH,
  DUNGEON_KEY_MAX_LENGTH,
  DUNGEON_KEY_PATTERN,
  DungeonArtworkRefSchema,
  type DungeonArtworkRef,
  type DungeonDefinition,
} from '../../../../modules/dungeons/content/dungeonDefinition';
import { resolveEnemyVisual } from '../../../../modules/artworkAssets/enemyArtworkService';
import { locateCombatArtwork } from '../../../../modules/combat/combatArtwork';
import {
  composeFightScene,
  playerBuddySpriteLayer,
  type ArtworkRef,
} from '../../../../modules/artworkAssets/sceneLayers';
import { mirrorsPlayerBuddy } from '../../../../modules/artworkAssets/scenePlacement';
import { DungeonEngineContentError } from '../../../../modules/dungeons/engine/combat';
import { EVENT_SP_NEUTRAL } from '../../../../modules/dungeons/engine/eventChecks';
import { describeEventAuthoring } from '../../../../modules/dungeons/engine/eventAuthoring';
import { describeEventResults } from '../../../../modules/dungeons/engine/events';
import { autoPlayDungeonSandbox, createDungeonSandbox } from '../../../../modules/dungeons/engine/sandbox';
import { DungeonPreviewTablesSchema } from '../../../../modules/dungeons/dungeonRewardPreview';
import type { DungeonRewardSnapshot } from '../../../../modules/dungeons/content/dungeonRewardSnapshot';
import type { DungeonInput, EngineDependencies } from '../../../../modules/dungeons/engine/types';
import { dungeonPackageFilename, readDungeonPackage } from '../../../../modules/dungeons/package/dungeonPackage';
import { DungeonImportApplySchema, DungeonImportPlanRequestSchema, DungeonImportPlanSchema, DungeonImportResultSchema, DungeonImportHistorySchema } from '../../../../modules/dungeons/package/dungeonImportService';
import { hasErrors } from '../../../../modules/dungeons/validation/dungeonValidation';
import type {
  ProgressionCurrency,
  ProgressionCurrencyService,
} from '../../../../modules/progressionCurrency/progressionCurrencyService';

/**
 * The asset folders the Admin artwork picker may browse for a dungeon. Dungeon
 * art lives under `dungeons/` (`dungeons/zones/`, `dungeons/backgrounds/`).
 */
const DUNGEON_ARTWORK_ROOTS = ['dungeons'] as const;

/**
 * Body ceiling for the routes that carry a whole definition or package. A
 * dungeon of a couple of hundred rooms, each with its action sequence, is
 * well past the API's 64 KB default, and a save must be able to take back
 * what a get returned. Only these routes are raised.
 *
 * They check permission at `onRequest` rather than `preValidation` like the
 * rest of this file: Fastify parses the body before `preValidation`, so a
 * caller with no permission would otherwise still make the server read
 * megabytes (the same choice `bosses.ts` makes for its imports).
 */
export const DUNGEON_DEFINITION_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export const MAX_DUNGEON_SANDBOX_SEED = 0xffff_ffff;
export const MAX_DUNGEON_SANDBOX_INPUTS = 500;
export const MAX_DUNGEON_SANDBOX_STEPS = 2000;
/** The Buddy a sandbox run fights with when the request names no stats. */
export const DEFAULT_DUNGEON_SANDBOX_FIGHTER = { attack: 60, defense: 30, maxHp: 400 } as const;
const MAX_SANDBOX_FIGHTER_STAT = 1_000_000;

const keySchema = z.string().min(1).max(DUNGEON_KEY_MAX_LENGTH).regex(DUNGEON_KEY_PATTERN);
const revisionSchema = z.number().int().positive();
/** A definition or layout as stored: its own schema lives in `modules/dungeons/content`. */
const documentSchema = z.record(z.string(), z.unknown());

/** One problem with a definition. `code` is stable — see `dungeonValidation.ts`. */
const issueSchema = z.object({
  code: z.string(),
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});

const dependencyChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('table'),
    tableKey: z.string(),
    name: z.string(),
    /** `changed`: the body differs from the one published. The rest block publication until repaired. */
    status: z.enum(['changed', 'missing', 'archived', 'invalid']),
    publishedHash: z.string().nullable(),
    currentHash: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('equipment'),
    selectorKey: z.string(),
    description: z.string(),
    /** `empty`: nothing is eligible any more. */
    status: z.enum(['changed', 'empty']),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
]);

const summarySchema = z.object({
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  position: z.number().int(),
  roomCount: z.number().int(),
  draftRevision: z.number().int(),
  draftHash: z.string(),
  published: z
    .object({
      revisionId: z.number().int(),
      number: z.number().int(),
      contentHash: z.string(),
      /** Null when the revision has no v2 rewards. */
      gameplayHash: z.string().nullable(),
      publishedAt: z.string(),
      publishedBy: z.string().nullable(),
    })
    .nullable(),
  /** The draft's definition differs from the published revision's. */
  draftDiffers: z.boolean(),
  /** The gameplay hash a publish would write now; null without v2 rewards or while a reward dependency is broken. */
  draftGameplayHash: z.string().nullable(),
  /** The definition is published as is, but the reward dependencies it pinned are not what the catalogues hold now. */
  dependenciesDiffer: z.boolean(),
  dependencyChanges: z.array(dependencyChangeSchema),
  /** Enabled and published: players can start runs. */
  open: z.boolean(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

const detailSchema = summarySchema.extend({
  draft: documentSchema,
  layout: documentSchema,
  issues: z.array(issueSchema),
});

const revisionSummarySchema = z.object({
  revisionId: z.number().int(),
  number: z.number().int(),
  contentHash: z.string(),
  gameplayHash: z.string().nullable(),
  source: z.string(),
  draftRevision: z.number().int(),
  publishedAt: z.string(),
  publishedBy: z.string().nullable(),
  /** The revision new runs start on. */
  current: z.boolean(),
  activeRuns: z.number().int(),
});

const revisionDetailSchema = revisionSummarySchema.extend({
  content: documentSchema,
  layout: documentSchema,
  /** The reward dependencies pinned at publication; null without v2 rewards. */
  rewardSnapshot: documentSchema.nullable(),
});

const publishResultSchema = z.object({
  dungeon: detailSchema,
  revision: revisionSummarySchema,
  /** Nothing moved: the draft was already published / that revision was already current. */
  unchanged: z.boolean(),
});

const contentEventSchema = z.object({
  id: z.number().int(),
  dungeonKey: z.string(),
  action: z.string(),
  actor: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const referenceSchema = z.object({
  lootTables: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      tier: dungeonLootTableTierSchema.nullable(),
      archived: z.boolean(),
      contentHash: z.string(),
    }),
  ),
  items: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      category: z.string(),
      enabled: z.boolean(),
      maxOwned: z.number().int().nullable(),
    }),
  ),
  actionTypes: z.array(z.string()),
  reservedActionTypes: z.record(z.string(), z.string()),
  enemies: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      attack: z.number().int(),
      defense: z.number().int(),
      hp: z.number().int(),
      sprite: z.boolean(),
      artwork: z.boolean(),
    }),
  ),
  rewardTables: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
  currencies: z.array(
    z.object({ key: z.string(), singularName: z.string(), pluralName: z.string(), enabled: z.boolean() }),
  ),
  regions: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
});

const MAX_EVENT_SCENARIO_ENTRIES = 200;
const scenarioIds = z.array(z.string().min(1).max(DUNGEON_ID_MAX_LENGTH)).max(MAX_EVENT_SCENARIO_ENTRIES).default([]);
/**
 * An imagined run to judge the definition's events against: what it remembers,
 * what it has finished and met, what the player holds and how strong the Buddy
 * is. Assumed only; no run or inventory is read.
 */
const eventScenarioSchema = z.object({
  flags: scenarioIds,
  completedRooms: scenarioIds,
  seenEvents: scenarioIds,
  inventory: z
    .record(z.string().min(1).max(100), z.number().int().min(0).max(1_000_000))
    .refine((inventory) => Object.keys(inventory).length <= MAX_EVENT_SCENARIO_ENTRIES, `at most ${MAX_EVENT_SCENARIO_ENTRIES} items may be assumed`)
    .default({}),
  currentSp: z.number().int().min(0).max(1_000_000).default(EVENT_SP_NEUTRAL),
  canTurnBack: z.boolean().default(true),
});

const eventPoolAnalysisSchema = z.object({
  totalWeight: z.number().int(),
  /** The chance that no event is presented; 1 when nothing is in the draw. */
  nothingProbability: z.number(),
  entries: z.array(z.object({
    id: z.string(),
    eventId: z.string().nullable(),
    weight: z.number().int(),
    eligible: z.boolean(),
    reason: z.enum(['condition', 'already_seen']).nullable(),
    probability: z.number(),
  })),
});

const eventChoicePreviewSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  available: z.boolean(),
  unavailableReason: z.enum(['requires', 'items', 'no_way_back']).nullable(),
  unavailableText: z.string(),
  check: z.object({ chanceBasisPoints: z.number().int(), sp: z.number().int().nullable() }).nullable(),
  items: z.array(z.object({ item: z.string(), quantity: z.number().int(), consume: z.boolean(), owned: z.number().int() })),
  consumesOnSelect: z.boolean(),
  walksAway: z.boolean(),
  hidden: z.boolean(),
  chances: z.object({ weakest: z.number().int(), average: z.number().int(), strongest: z.number().int() }).nullable(),
});

const validationSchema = z.object({
  /** The definition with defaults applied; null when its shape could not be read. */
  definition: documentSchema.nullable(),
  contentHash: z.string().nullable(),
  issues: z.array(issueSchema),
  publishable: z.boolean(),
  /**
   * Each event pool's odds, by the engine's own draw rules: `base` with every
   * entry in the draw, `scenario` as `eventScenario` (or an empty run) stands.
   * Empty when the definition has no pools or its shape could not be read.
   */
  eventPools: z.array(z.object({ poolId: z.string(), base: eventPoolAnalysisSchema, scenario: eventPoolAnalysisSchema })),
  /** Each event's choices as a player in the scenario would meet them, hidden ones included and marked. */
  eventPreviews: z.array(z.object({ eventId: z.string(), choices: z.array(eventChoicePreviewSchema) })),
});

const packageInspectionSchema = z.object({
  /** No error-severity issue: the package is internally sound. Says nothing about this server. */
  ok: z.boolean(),
  issues: z.array(issueSchema),
  summary: z
    .object({
      dungeonKey: z.string(),
      contentHash: z.string(),
      schemaVersion: z.number().int(),
      rooms: z.number().int(),
      bundledEnemies: z.number().int(),
    })
    .nullable(),
});

const sandboxStat = z.number().int().positive().max(MAX_SANDBOX_FIGHTER_STAT);
const connectionIdSchema = z.string().min(1).max(DUNGEON_ID_MAX_LENGTH);
const sandboxInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('advance') }),
  z.object({ type: z.literal('decline') }),
  z.object({ type: z.literal('move'), connectionId: connectionIdSchema }),
  z.object({ type: z.literal('extract') }),
  z.object({ type: z.literal('abandon') }),
  /** Answer the offered event with one of its choices. */
  z.object({ type: z.literal('choose'), choiceId: connectionIdSchema }),
]);
const MAX_SANDBOX_INVENTORY_ITEMS = 50;
/** Item slug → how many the imagined player holds. Assumed, never read from or written to anyone's inventory. */
const sandboxInventorySchema = z
  .record(z.string().min(1).max(100), z.number().int().min(0).max(1_000_000))
  .refine((inventory) => Object.keys(inventory).length <= MAX_SANDBOX_INVENTORY_ITEMS, `at most ${MAX_SANDBOX_INVENTORY_ITEMS} items may be assumed`);

const sandboxBody = z
  .object({
    /** Unsaved table bodies for draft/unsaved playthroughs only. */
    tables: DungeonPreviewTablesSchema.optional(),
    /** An unsaved definition, validated against this server first. */
    definition: z.unknown().optional(),
    /** A saved dungeon; `source` picks its draft or its published revision. */
    key: keySchema.optional(),
    source: z.enum(['draft', 'published']).default('draft'),
    seed: z.number().int().min(0).max(MAX_DUNGEON_SANDBOX_SEED).default(1),
    fighter: z
      .object({
        attack: sandboxStat,
        defense: sandboxStat,
        maxHp: sandboxStat,
        /** The Buddy strength event checks read. Omitted: an average Buddy. */
        currentSp: z.number().int().min(0).max(MAX_SANDBOX_FIGHTER_STAT).optional(),
      })
      .default({ ...DEFAULT_DUNGEON_SANDBOX_FIGHTER }),
    /** What the imagined player holds, for event choices that need items. Nothing is ever spent. */
    inventory: sandboxInventorySchema.default({}),
    inputs: z.array(sandboxInputSchema).max(MAX_DUNGEON_SANDBOX_INPUTS).default([]),
    autoPlay: z.boolean().default(false),
    maxSteps: z.number().int().min(1).max(MAX_DUNGEON_SANDBOX_STEPS).default(MAX_DUNGEON_SANDBOX_STEPS),
  })
  .refine((body) => (body.definition === undefined) !== (body.key === undefined), {
    message: 'send exactly one of `definition` (an unsaved definition) or `key` (a saved dungeon)',
  })
  .refine((body) => !(body.key !== undefined && body.source === 'published' && body.tables !== undefined), {
    message: 'published sandbox runs use their pinned reward snapshot; tables overrides are for drafts',
  });

const sandboxSchema = z.object({
  /** What a player would be shown now. */
  view: z.record(z.string(), z.unknown()),
  /** The engine's run state. */
  state: z.record(z.string(), z.unknown()),
  /** Every effect the run produced, in order. None was carried out. */
  effects: z.array(z.record(z.string(), z.unknown())),
  /** The run's structured history, without the per-wave combat event lists. */
  log: z.array(
    z.object({
      type: z.string(),
      roomId: z.string().nullable(),
      actionId: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
  /**
   * Events as an author needs to see them: what the latest step's choices did,
   * in their own words. The event on offer is `view.action.event`; every
   * selection made so far is `state.events`.
   */
  eventResults: z.array(z.object({
    roomId: z.string(),
    actionId: z.string(),
    eventTitle: z.string(),
    choiceLabel: z.string(),
    text: z.string(),
    tone: z.enum(['good', 'neutral', 'bad']),
  })),
  /** Steps applied: the accepted `inputs`, plus whatever auto-play took. */
  steps: z.number().int(),
  /**
   * Why it stopped: the run `ended`; an input was `refused` (see `refusal`);
   * auto-play was `stuck` or hit `max_steps`. Null when the given inputs were
   * all applied and the run is still going.
   */
  stoppedBy: z.enum(['ended', 'stuck', 'max_steps', 'refused']).nullable(),
  /** The engine's reason, when one of `inputs` was the step refused. */
  refusal: z.string().nullable(),
});

const currencySchema = z.object({
  key: z.string(),
  singularName: z.string(),
  pluralName: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  enabled: z.boolean(),
  revision: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

/** Delve-wide settings, with the bounds the editor needs to offer them. */
const settingsSchema = z.object({
  dailyRunLimit: z.number().int(),
  dailyRunLimitMin: z.number().int(),
  dailyRunLimitMax: z.number().int(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const toSettings = (s: DungeonSettings): z.infer<typeof settingsSchema> => ({
  dailyRunLimit: s.dailyRunLimit,
  dailyRunLimitMin: DUNGEON_DAILY_RUN_LIMIT_BOUNDS.min,
  dailyRunLimitMax: DUNGEON_DAILY_RUN_LIMIT_BOUNDS.max,
  updatedAt: s.updatedAt?.toISOString() ?? null,
  updatedBy: s.updatedBy,
});

const keyParams = z.object({ key: keySchema });

const dungeonNotFoundResponse = {
  404: errorSchema.describe('DUNGEON_NOT_FOUND, or DUNGEON_REVISION_NOT_FOUND for a revision it does not have.'),
} as const;
const invalidResponse = {
  400: errorSchema.describe(
    'Request failed schema validation, or DUNGEON_INVALID — details.issues lists every problem, each with a stable `code`.',
  ),
} as const;
const staleResponse = {
  409: errorSchema.describe('DUNGEON_DRAFT_STALE — someone saved first; details.currentRevision is the draft now.'),
} as const;
const tooLargeResponse = {
  413: errorSchema.describe('PAYLOAD_TOO_LARGE — over the definition limit (details.maxBytes).'),
} as const;

function toSummary(s: DungeonSummary): z.infer<typeof summarySchema> {
  return {
    key: s.key,
    name: s.name,
    enabled: s.enabled,
    position: s.position,
    roomCount: s.roomCount,
    draftRevision: s.draftRevision,
    draftHash: s.draftHash,
    published: s.published && { ...s.published, publishedAt: s.published.publishedAt.toISOString() },
    draftDiffers: s.draftDiffers,
    draftGameplayHash: s.draftGameplayHash,
    dependenciesDiffer: s.dependenciesDiffer,
    dependencyChanges: s.dependencyChanges,
    open: s.open,
    updatedAt: s.updatedAt.toISOString(),
    updatedBy: s.updatedBy,
  };
}

function toDetail(d: DungeonDetail): z.infer<typeof detailSchema> {
  return {
    ...toSummary(d),
    draft: d.draft as unknown as Record<string, unknown>,
    layout: d.layout as unknown as Record<string, unknown>,
    issues: d.issues,
  };
}

const treasureTargetSchema = z.object({ roomId: z.string().min(1).max(64), actionId: z.string().min(1).max(64) }).strict();
const conversionBlockerSchema = z.object({ code: z.string(), table: z.string().nullable(), message: z.string() });
const treasureConversionPlanSchema = z.object({
  dungeonKey: z.string(),
  roomId: z.string(),
  actionId: z.string(),
  roomName: z.string(),
  draftRevision: z.number().int(),
  legacy: z.object({
    rewardTable: z.string().nullable(),
    equipmentRewardTable: z.string().nullable(),
    currency: z.object({ min: z.number().int(), max: z.number().int() }),
  }),
  rewards: documentSchema.nullable(),
  tables: z.array(z.object({
    sourceTable: z.string(),
    sourceContentHash: z.string(),
    draws: z.number().int(),
    action: z.enum(['create', 'reuse']),
    key: z.string(),
    name: z.string(),
    description: z.string(),
    body: documentSchema,
    contentHash: z.string(),
  })),
  omitted: z.array(z.object({ table: z.string().nullable(), reason: z.enum(['never_paid', 'disabled', 'cannot_drop']), text: z.string() })),
  blockers: z.array(conversionBlockerSchema),
  issues: z.array(issueSchema),
  waifubuxAtRisk: z.boolean(),
  retention: z.object({ defeatBasisPoints: z.number().int(), abandonBasisPoints: z.number().int() }),
  planHash: z.string(),
});
function toConversionPlan(plan: DungeonTreasureConversionPlan): z.infer<typeof treasureConversionPlanSchema> {
  return {
    ...plan,
    rewards: plan.rewards as unknown as Record<string, unknown> | null,
    tables: plan.tables.map((t) => ({ ...t, body: t.body as unknown as Record<string, unknown> })),
  };
}
const rewardHealthProblemSchema = z.object({
  type: z.enum(['item', 'equipment', 'snapshot']),
  reason: z.enum(['item_missing', 'item_capped', 'equipment_missing', 'snapshot_missing', 'snapshot_unreadable', 'snapshot_unsupported', 'snapshot_corrupt', 'revision_unreadable']),
  key: z.string().nullable(),
  name: z.string(),
  message: z.string(),
  hint: z.string(),
});
const rewardHealthNoticeSchema = z.object({
  type: z.literal('event_item'),
  reason: z.enum(['item_missing', 'item_disabled']),
  key: z.string(),
  name: z.string(),
  message: z.string(),
  hint: z.string(),
});
const rewardHealthSchema = z.object({
  dungeons: z.array(z.object({
    key: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    revision: z.number().int().nullable(),
    /** The current published revision. */
    status: z.enum(['healthy', 'broken', 'no_rewards', 'unpublished']),
    problems: z.array(rewardHealthProblemSchema),
    /** Informational, never part of `status`: an event choice needs an item that is gone or disabled. */
    notices: z.array(rewardHealthNoticeSchema),
    draftErrors: z.number().int(),
    /** Runs in progress on the current published revision. */
    activeRuns: z.number().int(),
    /** Older revisions with runs still in progress, newest first. Counts only; no player is identified. */
    activeRevisions: z.array(z.object({
      revision: z.number().int(),
      activeRuns: z.number().int(),
      status: z.enum(['healthy', 'broken', 'no_rewards']),
      problems: z.array(rewardHealthProblemSchema),
      notices: z.array(rewardHealthNoticeSchema),
    })),
  })),
});

function toRevisionSummary(r: DungeonRevisionSummary): z.infer<typeof revisionSummarySchema> {
  return {
    revisionId: r.revisionId,
    number: r.number,
    contentHash: r.contentHash,
    gameplayHash: r.gameplayHash,
    source: r.source,
    draftRevision: r.draftRevision,
    publishedAt: r.publishedAt.toISOString(),
    publishedBy: r.publishedBy,
    current: r.current,
    activeRuns: r.activeRuns,
  };
}

function toRevisionDetail(r: DungeonRevisionDetail): z.infer<typeof revisionDetailSchema> {
  return {
    ...toRevisionSummary(r),
    content: r.content as unknown as Record<string, unknown>,
    layout: r.layout as unknown as Record<string, unknown>,
    rewardSnapshot: r.rewardSnapshot as Record<string, unknown> | null,
  };
}

function toPublishResult(r: DungeonPublishResult): z.infer<typeof publishResultSchema> {
  return { dungeon: toDetail(r.dungeon), revision: toRevisionSummary(r.revision), unchanged: r.unchanged };
}

function toContentEvent(e: DungeonContentEvent): z.infer<typeof contentEventSchema> {
  return { ...e, createdAt: e.createdAt.toISOString() };
}

function toCurrency(c: ProgressionCurrency): z.infer<typeof currencySchema> {
  return { ...c, updatedAt: c.updatedAt.toISOString() };
}

/**
 * Service errors that carry structure the editor needs, re-raised with it as
 * `details`: per-path issues, and the revision a stale save lost to.
 */
function withDetails(err: unknown): unknown {
  if (err instanceof DungeonImportError) return new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
  if (err instanceof DungeonInvalidError || err instanceof ProgressionCurrencyInvalidError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
  }
  if (err instanceof DungeonConversionError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, { blockers: [...err.blockers] });
  }
  if (err instanceof DungeonDraftStaleError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
      expectedRevision: err.expectedRevision,
      currentRevision: err.currentRevision,
      updatedBy: err.updatedBy,
      updatedAt: err.updatedAt.toISOString(),
    });
  }
  if (err instanceof ProgressionCurrencyStaleError) {
    return new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
      expectedRevision: err.expectedRevision,
      currentRevision: err.currentRevision,
    });
  }
  return err;
}

async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw withDetails(err);
  }
}

/** Reply shape for a binary body; the zod provider only types JSON replies. */
type BinaryReply = { header(k: string, v: string): BinaryReply; send(payload: Buffer): unknown };
const binaryReply = (reply: FastifyReply) => reply as unknown as BinaryReply;

export const adminDungeonRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    await app.register(adminDungeonLootTableRoutes(ctx));
    const contentService = ctx.services.dungeonContent;
    const currencyService = ctx.services.progressionCurrency;
    const authorization = ctx.portalAuthorization;
    if (!contentService || !currencyService) return;
    const dungeons: DungeonContentService = contentService;
    const currencies: ProgressionCurrencyService = currencyService;
    /** The actor comes from the authenticated session, never the body. */
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const tags = ['Admin — Dungeons'];

    const gate =
      (permission: 'dungeons.read' | 'dungeons.write' | 'dungeons.publish') =>
      async (req: FastifyRequest): Promise<void> => {
        if (!authorization) {
          throw new AppError(
            'PORTAL_PERMISSION_DENIED',
            'Portal authorization service is not configured',
            'Admin features are unavailable.',
          );
        }
        await requirePortalPermission(req, authorization, permission, {
          allowBearer: ctx.adminBearerAllowed === true,
        });
      };

    app.post('/admin/dungeons/import/plan', {
      bodyLimit: DUNGEON_DEFINITION_BODY_LIMIT_BYTES,
      onRequest: gate('dungeons.write'),
      schema: { tags, summary: 'Read-only dungeon package import plan, target conflicts and dependencies', body: DungeonImportPlanRequestSchema, response: { 200: dataSchema(DungeonImportPlanSchema), ...tooLargeResponse, ...commonErrorResponses } },
    }, async req => ok(req, await translate(() => dungeons.planImport(req.body.package, req.body.lootTables))));
    app.post('/admin/dungeons/import/apply', {
      bodyLimit: DUNGEON_DEFINITION_BODY_LIMIT_BYTES,
      onRequest: gate('dungeons.write'),
      schema: { tags, summary: 'Apply explicit import decisions to the draft only, with a durable retry receipt', body: DungeonImportApplySchema, response: { 200: dataSchema(DungeonImportResultSchema), 409: errorSchema, ...tooLargeResponse, ...commonErrorResponses } },
    }, async req => ok(req, await translate(() => dungeons.applyImport(req.body, actorOf(req)))));
    app.post('/admin/dungeons/definitions/:key/treasure-conversion/plan', {
      onRequest: gate('dungeons.write'),
      schema: {
        tags,
        summary:
          'Preview converting one legacy treasure to dungeon rewards: the loot tables it would create or reuse, the ' +
          'reward bundle, what is left out, and anything that blocks it. Writes nothing',
        params: keyParams,
        body: treasureTargetSchema,
        response: { 200: dataSchema(treasureConversionPlanSchema), 409: errorSchema.describe('DUNGEON_CONVERSION_UNAVAILABLE — not a legacy treasure.'), ...dungeonNotFoundResponse, ...commonErrorResponses },
      },
    }, async req => ok(req, toConversionPlan(await translate(() => dungeons.planTreasureConversion(req.params.key, req.body)))));
    app.post('/admin/dungeons/definitions/:key/treasure-conversion/apply', {
      onRequest: gate('dungeons.write'),
      schema: {
        tags,
        summary:
          'Apply a previewed conversion in one transaction: create its loot tables and replace the treasure in the ' +
          'draft. `expectedPlanHash` must be the plan that was reviewed; if the draft, a source table or the loot ' +
          'catalogue has changed the plan, nothing is written (409 DUNGEON_CONVERSION_STALE). Nothing is published',
        params: keyParams,
        body: treasureTargetSchema.extend({ expectedRevision: revisionSchema, expectedPlanHash: z.string().min(1).max(100) }),
        response: {
          200: dataSchema(z.object({ dungeon: detailSchema, createdTables: z.array(z.string()), reusedTables: z.array(z.string()), replayed: z.boolean() })),
          409: errorSchema.describe('DUNGEON_DRAFT_STALE, DUNGEON_CONVERSION_STALE, DUNGEON_CONVERSION_BLOCKED (details.blockers) or DUNGEON_CONVERSION_UNAVAILABLE.'),
          ...dungeonNotFoundResponse,
          ...commonErrorResponses,
          ...invalidResponse,
        },
      },
    }, async req => {
      const result = await translate(() => dungeons.convertTreasure(req.params.key, req.body, actorOf(req)));
      return ok(req, { ...result, dungeon: toDetail(result.dungeon) });
    });
    app.get('/admin/dungeons/reward-health', {
      preValidation: gate('dungeons.read'),
      schema: {
        tags,
        summary:
          'Whether each dungeon\'s published rewards can still be delivered: frozen items that were deleted or capped, ' +
          'frozen gear that was deleted, and missing, damaged or unsupported reward snapshots. Covers the current ' +
          'published revision and any older revision that runs in progress are still on. Reads only',
        response: { 200: dataSchema(rewardHealthSchema), ...commonErrorResponses },
      },
    }, async req => ok(req, await dungeons.rewardHealth()));
    app.get('/admin/dungeons/definitions/:key/import-history', {
      preValidation: gate('dungeons.read'),
      schema: { tags, summary: 'Successful dungeon imports and decisions, newest first', params: keyParams, querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), response: { 200: dataSchema(DungeonImportHistorySchema), ...commonErrorResponses } },
    }, async req => ok(req, { imports: (await dungeons.importHistory(req.params.key, req.query.limit)).map(r => ({ ...r, importedAt: r.importedAt.toISOString() })) }));


    app.get(
      '/admin/dungeons/definitions',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'List dungeons, with draft revision, what is published and whether players can start runs',
          response: {
            200: dataSchema(z.object({ dungeons: z.array(summarySchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { dungeons: (await dungeons.list()).map(toSummary) }),
    );

    app.post(
      '/admin/dungeons/definitions',
      {
        bodyLimit: DUNGEON_DEFINITION_BODY_LIMIT_BYTES,
        onRequest: gate('dungeons.write'),
        schema: {
          tags,
          summary:
            'Create a dungeon as an unpublished draft (409 DUNGEON_KEY_TAKEN when the key is taken). ' +
            'The key cannot be changed afterwards',
          body: z.object({ definition: z.unknown(), layout: z.unknown().optional() }),
          response: {
            201: dataSchema(detailSchema),
            409: errorSchema.describe('DUNGEON_KEY_TAKEN — another dungeon already uses that key.'),
            ...tooLargeResponse,
            ...commonErrorResponses,
            ...invalidResponse,
          },
        },
      },
      async (req, reply) => {
        const detail = await translate(() =>
          dungeons.create({ definition: req.body.definition, layout: req.body.layout }, actorOf(req)),
        );
        reply.code(201);
        return ok(req, toDetail(detail));
      },
    );

    app.get(
      '/admin/dungeons/definitions/:key',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Get one dungeon: its draft, editor layout, current problems and what is published',
          params: keyParams,
          response: { 200: dataSchema(detailSchema), ...dungeonNotFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const detail = await translate(() => dungeons.get(req.params.key));
        if (!detail) throw new DungeonNotFoundError(req.params.key);
        return ok(req, toDetail(detail));
      },
    );

    app.put(
      '/admin/dungeons/definitions/:key/draft',
      {
        bodyLimit: DUNGEON_DEFINITION_BODY_LIMIT_BYTES,
        onRequest: gate('dungeons.write'),
        schema: {
          tags,
          summary:
            'Save the draft, the editor layout, or both. `expectedRevision` must be the draft revision you loaded; ' +
            'a stale save is refused with 409 DUNGEON_DRAFT_STALE rather than overwriting. Validation errors do ' +
            'not block a save — only an unreadable shape does — and nothing is published',
          params: keyParams,
          body: z.object({
            definition: z.unknown().optional(),
            layout: z.unknown().optional(),
            expectedRevision: revisionSchema,
          }),
          response: {
            200: dataSchema(detailSchema),
            ...dungeonNotFoundResponse,
            ...staleResponse,
            ...tooLargeResponse,
            ...commonErrorResponses,
            ...invalidResponse,
          },
        },
      },
      async (req) =>
        ok(
          req,
          toDetail(
            await translate(() =>
              dungeons.saveDraft(
                req.params.key,
                {
                  definition: req.body.definition,
                  layout: req.body.layout,
                  expectedRevision: req.body.expectedRevision,
                },
                actorOf(req),
              ),
            ),
          ),
        ),
    );

    app.put(
      '/admin/dungeons/definitions/:key/enabled',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          tags,
          summary:
            'Enable or disable a dungeon. Players can start runs only in a dungeon that is enabled and published. ' +
            'Runs already started are unaffected',
          params: keyParams,
          body: z.object({ enabled: z.boolean() }),
          response: { 200: dataSchema(detailSchema), ...dungeonNotFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, toDetail(await translate(() => dungeons.setEnabled(req.params.key, req.body.enabled, actorOf(req))))),
    );

    app.post(
      '/admin/dungeons/definitions/:key/publish',
      {
        preValidation: gate('dungeons.publish'),
        schema: {
          tags,
          summary:
            'Publish the draft as a new immutable revision and make it the one new runs start on. Re-validated ' +
            'against this server first: any error refuses it with 400 DUNGEON_INVALID. `expectedRevision` must be ' +
            'the draft revision you reviewed. Publishing what is already published writes nothing (`unchanged`)',
          params: keyParams,
          body: z.object({ expectedRevision: revisionSchema }),
          response: {
            200: dataSchema(publishResultSchema),
            ...dungeonNotFoundResponse,
            ...staleResponse,
            ...commonErrorResponses,
            ...invalidResponse,
          },
        },
      },
      async (req) =>
        ok(
          req,
          toPublishResult(
            await translate(() =>
              dungeons.publish(req.params.key, { expectedRevision: req.body.expectedRevision }, actorOf(req)),
            ),
          ),
        ),
    );

    app.post(
      '/admin/dungeons/definitions/:key/rollback',
      {
        preValidation: gate('dungeons.publish'),
        schema: {
          tags,
          summary:
            'Make an earlier published revision (by its `revision` number) the one new runs start on. No content ' +
            'is copied and the draft is untouched. Refused with 400 DUNGEON_INVALID when that revision names ' +
            'something this server no longer has',
          params: keyParams,
          body: z.object({ revision: revisionSchema }),
          response: {
            200: dataSchema(publishResultSchema),
            ...dungeonNotFoundResponse,
            ...commonErrorResponses,
            ...invalidResponse,
          },
        },
      },
      async (req) =>
        ok(
          req,
          toPublishResult(
            await translate(() => dungeons.rollback(req.params.key, { revision: req.body.revision }, actorOf(req))),
          ),
        ),
    );

    app.get(
      '/admin/dungeons/definitions/:key/revisions',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Published revisions of a dungeon, newest first, with which is current and its active runs',
          params: keyParams,
          response: {
            200: dataSchema(z.object({ revisions: z.array(revisionSummarySchema) })),
            ...dungeonNotFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const revisions = await dungeons.revisions(req.params.key);
        if (!revisions) throw new DungeonNotFoundError(req.params.key);
        return ok(req, { revisions: revisions.map(toRevisionSummary) });
      },
    );

    app.get(
      '/admin/dungeons/definitions/:key/revisions/:number',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'One published revision, with its content and the layout it was published with',
          params: keyParams.extend({ number: z.coerce.number().int().positive() }),
          response: {
            200: dataSchema(revisionDetailSchema),
            ...dungeonNotFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const revision = await translate(() => dungeons.revision(req.params.key, req.params.number));
        if (!revision) throw new DungeonRevisionNotFoundError(req.params.key, req.params.number);
        return ok(req, toRevisionDetail(revision));
      },
    );

    app.get(
      '/admin/dungeons/definitions/:key/history',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'The audit trail of a dungeon, newest first: saves, publishes, rollbacks, enable/disable, exports',
          params: keyParams,
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
          response: {
            200: dataSchema(z.object({ events: z.array(contentEventSchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) =>
        ok(req, { events: (await dungeons.history(req.params.key, req.query.limit)).map(toContentEvent) }),
    );

    app.get(
      '/admin/dungeons/definitions/:key/export',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary:
            'Export one dungeon as a Dungeon Content Package: the working draft (the default, `origin=draft`), ' +
            'the published revision (`origin=published`), or a numbered one (`revision=<n>`) — one of the two ' +
            'parameters at most. The export is recorded in the dungeon’s history',
          params: keyParams,
          querystring: z.object({
            origin: z.enum(['draft', 'published']).optional(),
            revision: z.coerce.number().int().positive().optional(),
          }),
          response: {
            200: dataSchema(z.object({}).passthrough()),
            ...dungeonNotFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req, reply) => {
        const { origin, revision } = req.query;
        if (origin !== undefined && revision !== undefined) {
          throw new ApiFieldValidationError([{ path: 'revision', message: 'send `origin` or `revision`, not both' }]);
        }
        const wanted: DungeonExportOrigin = revision !== undefined ? { revision } : (origin ?? 'draft');
        const pkg = await translate(() => dungeons.exportPackage(req.params.key, wanted, actorOf(req)));
        // Returned inside the standard envelope like every other export; the
        // Portal unwraps `data` and saves that as the file, under the name the
        // header carries, so the file on disk is a bare package.
        reply.header('content-disposition', `attachment; filename="${dungeonPackageFilename(pkg)}"`);
        return ok(req, pkg as unknown as Record<string, unknown>);
      },
    );

    app.get(
      '/admin/dungeons/reference',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Action types, enemies, reward tables, loot tables, items, currencies and regions the dungeon editor offers',
          response: { 200: dataSchema(referenceSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const [reference, lootTables] = await Promise.all([
          dungeons.reference(),
          ctx.services.dungeonLootTables?.list({ includeArchived: true }) ?? Promise.resolve([]),
        ]);
        return ok(req, {
          ...reference,
          lootTables: lootTables.map((t) => ({
            key: t.key,
            name: t.name,
            tier: t.tier,
            archived: t.archivedAt !== null,
            contentHash: t.contentHash,
          })),
          items: ctx.getContent().items
            .map((i) => ({
              slug: i.slug,
              name: i.name,
              category: i.category,
              enabled: i.enabled,
              maxOwned: i.maxOwned ?? null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          actionTypes: [...reference.actionTypes],
          reservedActionTypes: { ...reference.reservedActionTypes },
        });
      },
    );

    app.post(
      '/admin/dungeons/validate',
      {
        bodyLimit: DUNGEON_DEFINITION_BODY_LIMIT_BYTES,
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary:
            'Dry run: every issue this definition has on this server, its content hash, and whether it could be ' +
            'published. Also answers how its events would play: every event pool’s odds and every event’s choices, ' +
            'for the imagined run in `eventScenario` (omitted: nothing remembered, nothing held, an average Buddy). ' +
            'Writes nothing',
          body: z.object({ definition: z.unknown(), eventScenario: eventScenarioSchema.optional() }),
          response: { 200: dataSchema(validationSchema), ...tooLargeResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const report = await dungeons.validate(req.body.definition);
        const events = report.definition
          ? describeEventAuthoring(report.definition, req.body.eventScenario)
          : { eventPools: [], eventPreviews: [] };
        return ok(req, { ...report, ...events, definition: report.definition as unknown as Record<string, unknown> | null });
      },
    );

    app.post(
      '/admin/dungeons/package/inspect',
      {
        bodyLimit: DUNGEON_DEFINITION_BODY_LIMIT_BYTES,
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary:
            'Verify a Dungeon Content Package on its own terms: format, version, shape, that its hash and ' +
            'manifest match the dungeon inside, and that the dungeon is structurally valid. Says nothing about ' +
            'whether this server has what it needs, imports nothing and writes nothing',
          body: z.object({ package: z.unknown() }),
          response: { 200: dataSchema(packageInspectionSchema), ...tooLargeResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const read = readDungeonPackage(req.body.package);
        const pkg = read.package;
        return ok(req, {
          ok: read.ok,
          issues: read.issues,
          summary: pkg && {
            dungeonKey: pkg.dungeon.key,
            contentHash: pkg.contentHash,
            schemaVersion: pkg.schemaVersion,
            rooms: pkg.dungeon.rooms.length,
            bundledEnemies: pkg.bundled.enemies.length,
          },
        });
      },
    );

    /**
     * Validate drafts against current dependencies and request-only tables.
     * Published rewards are validated against their own verified snapshot.
     */
    async function sandboxDefinition(body: z.infer<typeof sandboxBody>): Promise<{ definition: DungeonDefinition; rewards: DungeonRewardSnapshot | null }> {
      let raw: unknown = body.definition;
      let snapshot: DungeonRewardSnapshot | null | undefined;
      if (body.key !== undefined) {
        const key = body.key;
        const detail = await translate(() => dungeons.get(key));
        if (!detail) throw new DungeonNotFoundError(key);
        if (body.source === 'draft') {
          raw = detail.draft;
        } else {
          const revision = detail.published && (await translate(() => dungeons.revision(key, detail.published!.number)));
          if (!revision) {
            throw new AppError(
              'DUNGEON_REVISION_NOT_FOUND',
              `Dungeon "${key}" has no published revision`,
              'That dungeon has not been published yet.',
            );
          }
          raw = revision.content;
          snapshot = revision.rewardSnapshot;
        }
      }
      const report = await translate(() => dungeons.previewRewards(raw, {
        ...(body.tables === undefined ? {} : { tables: body.tables }),
        ...(snapshot === undefined ? {} : { snapshot }),
      }));
      if (!report.definition || hasErrors(report.issues)) throw withDetails(new DungeonInvalidError(report.issues));
      return { definition: report.definition, rewards: report.rewards };
    }

    app.post(
      '/admin/dungeons/sandbox',
      {
        bodyLimit: DUNGEON_DEFINITION_BODY_LIMIT_BYTES,
        onRequest: gate('dungeons.read'),
        schema: {
          tags,
          summary:
            'Play a dungeon in the sandbox: an unsaved `definition`, or a saved one by `key` (its draft, or with ' +
            '`source: "published"` its published revision) — exactly one. The real engine runs it from `seed` ' +
            'against this server’s live enemies, applies `inputs` in order (stopping at the first one refused) ' +
            'and then, with `autoPlay`, takes the first thing on offer until the run ends or `maxSteps`. The same ' +
            'request always plays out the same way. Nothing is persisted and nothing is granted: effects are ' +
            'only listed. Draft v2 rewards use current dependencies and optional unsaved tables; published ' +
            'v2 rewards use their pinned snapshot. Legacy rewards retain currency-only previews. An event is ' +
            'answered with a `choose` input; `inventory` is what the imagined player holds for choices that need ' +
            'items (item use is listed as an effect and nothing is spent), and `fighter.currentSp` is the ' +
            'strength event checks read. A ' +
            'definition with errors is refused with 400 DUNGEON_INVALID',
          body: sandboxBody,
          response: {
            200: dataSchema(sandboxSchema),
            ...dungeonNotFoundResponse,
            ...tooLargeResponse,
            ...commonErrorResponses,
            ...invalidResponse,
          },
        },
      },
      async (req) => {
        const body = req.body;
        const { definition, rewards } = await sandboxDefinition(body);
        const enemies = ctx.services.enemies ? (await ctx.services.enemies.snapshot()).definitions : [];
        const dependencies: EngineDependencies = {
          enemies: Object.fromEntries(enemies.map((enemy) => [enemy.key, enemy])),
          // Preserve legacy currency-only sandbox behavior; v2 tables live in `rewards`.
          rewardTables: {},
        };
        try {
          const sandbox = createDungeonSandbox({
            definition,
            rewards,
            dependencies,
            fighter: { waifuId: 0, name: 'Sandbox Buddy', ...body.fighter, currentSp: body.fighter.currentSp ?? EVENT_SP_NEUTRAL },
            seed: body.seed,
            inventory: body.inventory,
          });
          let steps = 0;
          let refusal: string | null = null;
          for (const input of body.inputs) {
            const step = await sandbox.input(input satisfies DungeonInput);
            if (step.status === 'refused') {
              refusal = step.refusal ?? 'refused';
              break;
            }
            steps += 1;
          }
          let stoppedBy: z.infer<typeof sandboxSchema>['stoppedBy'] = refusal !== null ? 'refused' : null;
          if (refusal === null && body.autoPlay) {
            const played = await autoPlayDungeonSandbox(sandbox, { maxSteps: body.maxSteps });
            steps += played.steps;
            stoppedBy = played.stoppedBy;
          } else if (refusal === null && sandbox.view.phase === 'ended') {
            stoppedBy = 'ended';
          }
          return ok(req, {
            view: sandbox.view as unknown as Record<string, unknown>,
            state: sandbox.state as unknown as Record<string, unknown>,
            effects: sandbox.effects as unknown as Record<string, unknown>[],
            // Combat event lists are large, and the sandbox is not a replay viewer.
            log: sandbox.log.map((entry) => {
              const { events: _events, ...payload } = entry.payload;
              return { type: entry.type, roomId: entry.roomId, actionId: entry.actionId, payload };
            }),
            eventResults: describeEventResults(definition, sandbox.state.recent),
            steps,
            stoppedBy,
            refusal,
          });
        } catch (err) {
          // Validation passed against the same catalogue, so this is an enemy
          // that went between the two reads. Still the definition's problem.
          if (err instanceof DungeonEngineContentError) {
            throw new ApiErrorWithDetails('DUNGEON_INVALID', err.message, 'That dungeon cannot be played on this server right now.', {
              issues: [{ code: 'enemy_missing', severity: 'error', path: '', message: err.message }],
            });
          }
          throw err;
        }
      },
    );

    /**
     * Dungeon artwork for the editor: the bytes of one authored path, and the
     * picker (one folder at a time, and a bounded search). Read-only and
     * rooted at {@link DUNGEON_ARTWORK_ROOTS}, so `dungeons.read` never lists
     * the rest of the assets tree. A path that is unsafe is 400; a well-formed
     * path with no file is 404 — which is what a typo looks like.
     */
    const assetsDir = ctx.assetsDir ?? './assets';
    app.get(
      '/admin/dungeons/artwork',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Stream dungeon artwork for the editor preview',
          querystring: adminArtworkQuery,
          response: { ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req, reply) => sendAdminArtwork(reply, assetsDir, req.query.path),
    );
    app.get(
      '/admin/dungeons/artwork/browse',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'List one folder of dungeon artwork for the picker',
          querystring: adminArtworkBrowseQuery,
          response: { 200: dataSchema(artworkDirectorySchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await browseAdminArtwork(assetsDir, DUNGEON_ARTWORK_ROOTS, req.query.path)),
    );
    app.get(
      '/admin/dungeons/artwork/search',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Search dungeon artwork by file name or folder',
          querystring: adminArtworkSearchQuery,
          response: { 200: dataSchema(artworkSearchSchema), ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, await searchAdminArtwork(assetsDir, DUNGEON_ARTWORK_ROOTS, req.query.q, req.query.limit)),
    );

    /**
     * What a run would actually show, for the editor. Both resolve artwork by
     * the rules gameplay uses (`managedArtworkLookup`, `composeFightScene`),
     * so a preview that appears is a picture players get, and a 404 is a
     * picture they do not.
     */
    const artworkAssets = ctx.services.artworkAssets;
    const scenes = ctx.services.sceneComposition;
    const enemyCatalogue = ctx.services.enemies;
    const resolvedArtwork = async (ref: DungeonArtworkRef | null | undefined): Promise<ArtworkRef | null> => {
      if (!ref) return null;
      if (ref.kind === 'shipped') return { artworkPath: ref.path };
      const assetId = await contentService.resolveManagedArtwork(ref);
      return assetId ? { assetId } : null;
    };
    if (artworkAssets) {
      app.get(
        '/admin/dungeons/artwork/managed',
        {
          preValidation: gate('dungeons.read'),
          schema: {
            tags,
            summary:
              'Stream the managed image a dungeon reference (category + content hash) resolves to on this server, ' +
              'as a run would resolve it. 404 when no active asset holds or held those bytes',
            querystring: z.object({
              category: z.string().min(1).max(40),
              contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            }),
            response: { ...notFoundResponse, ...commonErrorResponses },
          },
        },
        async (req, reply) => {
          const resolved = await resolvedArtwork({ kind: 'managed', ...req.query });
          const found = resolved?.assetId ? await artworkAssets.readUsable(resolved.assetId) : null;
          if (!found) {
            throw new AppError('NOT_FOUND', 'Managed dungeon artwork not available', 'That image is not available on this server.');
          }
          binaryReply(reply)
            .header('content-type', found.asset.mimeType)
            .header('x-content-type-options', 'nosniff')
            .header('cache-control', 'private, no-cache')
            .send(found.bytes);
          return reply;
        },
      );
    }
    if (scenes && enemyCatalogue) {
      app.post(
        '/admin/dungeons/scene-preview',
        {
          preValidation: gate('dungeons.read'),
          schema: {
            tags,
            summary:
              'The picture a fight against one enemy shows, composed as a run composes it: the first usable ' +
              'background (else a plain stage), a stand-in Buddy and the enemy sprite — or, for an enemy with no ' +
              'usable sprite, its full artwork alone, unchanged and without the Buddy. `x-dungeon-scene` is `sprite` or `full-art`; ' +
              '`x-dungeon-scene-background` is the index of the background used, or `plain`. Persists nothing ' +
              'but the render cache',
            body: z
              .object({
                enemyKey: z.string().min(1).max(100),
                /** In fallback order: the room's own background, the dungeon background, the dungeon artwork. */
                backgrounds: z.array(DungeonArtworkRefSchema.nullable()).max(4).default([]),
              })
              .strict(),
            response: { ...notFoundResponse, ...commonErrorResponses },
          },
        },
        async (req, reply) => {
          const catalogue = await enemyCatalogue.snapshot();
          const enemy = catalogue.definitions.find((e) => e.key === req.body.enemyKey);
          if (!enemy) throw new AppError('NOT_FOUND', `Enemy ${req.body.enemyKey} not found`, 'That enemy is not in the Enemy Catalogue.');
          const visual = resolveEnemyVisual(enemy, catalogue.artwork[enemy.key]);
          // The Buddy is the player's, never authored: any species with a sprite stands in.
          const species = ctx.getContent().species;
          let playerBuddy: { layer: NonNullable<ReturnType<typeof playerBuddySpriteLayer>>; mirror: boolean; label: string } | null = null;
          for (const slug of species.map((s) => s.slug).sort()) {
            const layer = playerBuddySpriteLayer(assetsDir, slug);
            if (layer) {
              playerBuddy = { layer, mirror: mirrorsPlayerBuddy(species.find((s) => s.slug === slug)?.spriteFacing), label: slug };
              break;
            }
          }
          const backgrounds = await Promise.all(req.body.backgrounds.map((ref) => resolvedArtwork(ref)));
          const layers = { assets: artworkAssets, assetsDir, scenes };
          if (visual.spriteAssetId || visual.spriteArtworkPath) {
            const composed = await composeFightScene(layers, {
              backgrounds,
              sprite: { ref: { assetId: visual.spriteAssetId, artworkPath: visual.spriteArtworkPath }, placement: visual.spritePlacement },
              playerBuddy,
            });
            if (composed) {
              binaryReply(reply)
                .header('content-type', composed.scene.contentType)
                .header('x-content-type-options', 'nosniff')
                .header('cache-control', 'private, no-cache')
                .header('x-dungeon-scene', 'sprite')
                .header('x-dungeon-scene-background', String(composed.background))
                .send(await readFile(composed.scene.absolutePath));
              return reply;
            }
          }
          // No usable sprite: the enemy's full artwork is the whole picture, as it is — no Buddy over it.
          const managedArt = (await artworkAssets?.readUsable(visual.artworkAssetId)) ?? null;
          const shippedArt = managedArt ? null : locateCombatArtwork(assetsDir, visual.artworkPath);
          const art = managedArt
            ? { bytes: managedArt.bytes, contentType: managedArt.asset.mimeType as string }
            : shippedArt?.status === 'available'
              ? { bytes: await readFile(shippedArt.absolutePath), contentType: shippedArt.contentType }
              : null;
          if (!art) {
            throw new AppError('NOT_FOUND', 'Enemy has no usable artwork', 'This enemy has no sprite or artwork that can be shown.');
          }
          binaryReply(reply)
            .header('content-type', art.contentType)
            .header('x-content-type-options', 'nosniff')
            .header('cache-control', 'private, no-cache')
            .header('x-dungeon-scene', 'full-art')
            .send(art.bytes);
          return reply;
        },
      );
    }

    // Delve-wide settings. Registered only where the allowance service is wired.
    const allowance = ctx.services.dungeonAllowance;
    if (allowance) {
      app.get(
        '/admin/dungeons/settings',
        {
          preValidation: gate('dungeons.read'),
          schema: {
            tags,
            summary: 'Delve-wide settings: the daily run limit shared by every zone',
            response: { 200: dataSchema(settingsSchema), ...commonErrorResponses },
          },
        },
        async (req) => ok(req, toSettings(await allowance.getSettings())),
      );

      app.put(
        '/admin/dungeons/settings',
        {
          preValidation: gate('dungeons.write'),
          schema: {
            tags,
            summary:
              'Set the daily Delve run limit (runs a player may start per game day, across all zones). ' +
              '0 closes Delve to new runs; active runs are unaffected',
            // Only the type is enforced here: a fraction or an out-of-bounds value is
            // refused by the service with 400 DUNGEON_SETTINGS_INVALID.
            body: z.object({ dailyRunLimit: z.number() }).strict(),
            response: {
              200: dataSchema(settingsSchema),
              ...commonErrorResponses,
            },
          },
        },
        async (req) => ok(req, toSettings(await allowance.updateSettings(req.body, actorOf(req)))),
      );
    }

    app.get(
      '/admin/dungeons/currencies',
      {
        preValidation: gate('dungeons.read'),
        schema: {
          tags,
          summary: 'Progression currencies: stable key and editable display metadata',
          response: {
            200: dataSchema(z.object({ currencies: z.array(currencySchema) })),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, { currencies: (await currencies.list()).map(toCurrency) }),
    );

    app.put(
      '/admin/dungeons/currencies/:key',
      {
        preValidation: gate('dungeons.write'),
        schema: {
          tags,
          summary:
            "Edit a progression currency's display metadata. The key is the path and cannot be changed; " +
            'a stale save is refused with 409 PROGRESSION_CURRENCY_STALE',
          params: keyParams,
          body: z
            .object({
              singularName: z.string(),
              pluralName: z.string(),
              description: z.string().optional(),
              icon: z.string().nullable().optional(),
              enabled: z.boolean(),
              expectedRevision: revisionSchema,
            })
            .strict(),
          response: {
            200: dataSchema(currencySchema),
            ...notFoundResponse,
            409: errorSchema.describe('PROGRESSION_CURRENCY_STALE — someone saved first.'),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { expectedRevision, ...metadata } = req.body;
        const updated = await translate(() =>
          currencies.updateMetadata(req.params.key, { metadata, expectedRevision }, actorOf(req)),
        );
        if (!updated) {
          throw new AppError('NOT_FOUND', `Progression currency "${req.params.key}" not found`, 'Not found.');
        }
        return ok(req, toCurrency(updated));
      },
    );
  };
