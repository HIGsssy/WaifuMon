/**
 * Card cache operations — the testable core behind `cards:warm` and `cards:gc`.
 *
 * Both CLIs are thin wrappers over these functions, for the same reason
 * `appearanceSync.ts` is split that way: deciding *what* to warm or collect is
 * logic worth unit-testing against a temp directory, and a later umbrella
 * command should be able to call it rather than shell out and parse output.
 *
 * Everything here reaches the renderer through the cards module's public API
 * (`src/modules/cards/index.ts`) — never the composer, rasterizer, cache, or
 * asset loader directly.
 */
import { defaultAppearance, resolveAppearances } from '../modules/appearance/appearanceContent';
import { resolveAppearanceAssetOrLegacyPath } from '../modules/appearance/assetResolver';
import { createAppearanceService } from '../modules/appearance/appearanceService';
import type { CardPresentationDeps } from '../modules/appearance/cardPresentation';
import {
  OWNED_GRID_WIDTHS,
  warmOwnedCards,
  type OwnedCardWarmResult,
  type OwnedCardWarmSkip,
} from '../modules/appearance/ownedCardWarm';
import {
  listOwnedWarmSubjects,
  listPlayersWithOwnedCards,
} from '../modules/appearance/ownedCardWarmSubjects';
import {
  collectCardCacheGarbage,
  computeCardRenderKey,
  getCardRenderer,
  warmCardCache,
  type CardCacheGcResult,
  type CardRenderInput,
  type CardRenderer,
  type CardRenderPoolStats,
  type WarmCardCacheFailure,
  type WarmCardCacheResult,
} from '../modules/cards';
import type { Db } from '../db/client';
import { readContentFiles } from '../modules/content/loader';
import { toCardRenderInput } from '../modules/content/speciesCardInput';
import type { SpeciesContent } from '../modules/content/schemas';
import type { Logger } from '../shared/logger';

/**
 * Level printed on a warmed card.
 *
 * **Level is part of the render key**, so warming is deliberately one level
 * deep. Warming every level would multiply the cache by the level cap for no
 * benefit: nobody browses a species at all fifty levels, and any level that is
 * actually requested renders on demand in well under a second and is cached
 * from then on. Level 1 is what an encyclopedia preview shows.
 */
export const WARM_LEVEL = 1;

export interface CardWarmPlanOptions {
  contentDir: string;
  assetsDir: string;
  /** Warm every appearance in each catalog, not just the default look. */
  allAppearances?: boolean | undefined;
  /** Also warm these derivative widths. Masters are always warmed first. */
  widths?: readonly number[] | undefined;
  /** Include species content has disabled. Off by default — see below. */
  includeDisabled?: boolean | undefined;
  logger?: Logger | undefined;
}

export interface CardWarmPlan {
  inputs: CardRenderInput[];
  /** Species skipped because nothing resolved to real artwork. */
  skipped: { slug: string; appearanceId: string; reason: string }[];
  speciesConsidered: number;
}

/**
 * Builds the set of cards to warm.
 *
 * Disabled species are skipped by default: `enabled: false` is how content
 * retires a Waifumon or flags one whose art is missing, and warming a card
 * nobody can encounter spends render time on a file that may never be read.
 * Their cards still render on demand if something does ask.
 */
export function planCardWarm(options: CardWarmPlanOptions): CardWarmPlan {
  const content = readContentFiles(options.contentDir);
  const plan: CardWarmPlan = { inputs: [], skipped: [], speciesConsidered: 0 };

  for (const species of content.species) {
    if (!species.enabled && options.includeDisabled !== true) continue;
    plan.speciesConsidered += 1;

    const appearances =
      options.allAppearances === true ? resolveAppearances(species) : [defaultAppearance(species)];

    for (const appearance of appearances) {
      const artwork = resolveAppearanceAssetOrLegacyPath(
        { assetsDir: options.assetsDir },
        appearance.assetId,
        species.imagePath,
      );
      if (!artwork) {
        plan.skipped.push({
          slug: species.slug,
          appearanceId: appearance.id,
          reason: 'no artwork resolved',
        });
        continue;
      }

      // The master first: a derivative resizes from it, so warming widths
      // without the master would rasterize once per width.
      plan.inputs.push(buildInput(species, artwork, options.logger));
      for (const width of options.widths ?? []) {
        plan.inputs.push(buildInput(species, artwork, options.logger, width));
      }
    }
  }

  return plan;
}

function buildInput(
  species: SpeciesContent,
  artwork: Parameters<typeof toCardRenderInput>[1]['artwork'],
  logger: Logger | undefined,
  width?: number,
): CardRenderInput {
  return toCardRenderInput(species, {
    artwork,
    level: WARM_LEVEL,
    ...(width === undefined ? {} : { width }),
    ...(logger === undefined ? {} : { logger }),
  });
}

export interface CardWarmRunOptions extends CardWarmPlanOptions {
  renderer?: CardRenderer | undefined;
  concurrency?: number | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface CardWarmRunReport extends WarmCardCacheResult {
  planned: number;
  skipped: CardWarmPlan['skipped'];
  speciesConsidered: number;
}

export async function runCardWarm(options: CardWarmRunOptions): Promise<CardWarmRunReport> {
  const plan = planCardWarm(options);
  const result = await warmCardCache(plan.inputs, {
    ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  return {
    ...result,
    planned: plan.inputs.length,
    skipped: plan.skipped,
    speciesConsidered: plan.speciesConsidered,
  };
}

export function formatWarmReport(report: CardWarmRunReport): string {
  const lines = [
    `Cards warmed: ${report.rendered} rendered, ${report.cached} already cached ` +
      `(${report.planned} planned across ${report.speciesConsidered} species) ` +
      `in ${(report.durationMs / 1000).toFixed(1)}s`,
  ];
  for (const skip of report.skipped) {
    lines.push(`  skipped ${skip.slug}/${skip.appearanceId}: ${skip.reason}`);
  }
  for (const failure of report.failed) {
    lines.push(`  FAILED ${failure.slug}/${failure.appearanceId}: ${failure.message}`);
  }
  return lines.join('\n');
}

// ── Owned-card warming (`cards:warm --player` / `--all-players`) ────────────

/**
 * Players warmed at once.
 *
 * One, and it is the same reasoning as `DEFAULT_OWNED_WARM_CONCURRENCY`: a
 * back-catalogue warm is a long operator job on a machine that is also serving
 * Discord, and finishing it in half the time is worth nothing if the bot goes
 * unresponsive while it runs. `--player-concurrency` raises it for an operator
 * who has measured their own node — never `os.cpus()`, which describes the
 * developer's workstation and not the deployment.
 */
export const DEFAULT_OWNED_WARM_PLAYER_CONCURRENCY = 1;

export interface OwnedWarmRunOptions {
  db: Db;
  contentDir: string;
  assetsDir: string;
  /** Players to warm. Omitted means every player who owns anything. */
  playerIds?: readonly number[] | undefined;
  /** Cards in flight per player. Defaults to the owned warm's own default (1). */
  concurrency?: number | undefined;
  /** Players in flight at once. {@link DEFAULT_OWNED_WARM_PLAYER_CONCURRENCY}. */
  playerConcurrency?: number | undefined;
  /** Derivative widths. Defaults to {@link OWNED_GRID_WIDTHS} (256, 512). */
  widths?: readonly number[] | undefined;
  renderer?: CardRenderer | undefined;
  logger?: Logger | undefined;
  onPlayer?: ((done: number, total: number, playerId: number) => void) | undefined;
}

export interface OwnedWarmRunReport {
  playersProcessed: number;
  ownedConsidered: number;
  mastersRendered: number;
  mastersCached: number;
  derivativesCreated: number;
  derivativesCached: number;
  skipped: OwnedCardWarmSkip[];
  failed: WarmCardCacheFailure[];
  durationMs: number;
  /** Cards in flight per player, as actually used. */
  concurrency: number;
  /** Players in flight, as actually used. */
  playerConcurrency: number;
  /**
   * Worker-pool counters, present only once a cold master has been drawn.
   * Absent is the good outcome: the run was cache hits and no render thread
   * ever started.
   */
  workers?: CardRenderPoolStats | undefined;
}

/**
 * Back-catalogue warm for owned cards.
 *
 * Uses exactly the same planner the runtime self-heal and the post-capture
 * follow-up use ({@link warmOwnedCards}), so a card this warms is byte-identical
 * to the one a request would have produced. A CLI-only construction path would
 * be a second definition of "which card does this copy have", and the first time
 * the two disagreed the cache would silently double.
 */
export async function runOwnedCardWarm(options: OwnedWarmRunOptions): Promise<OwnedWarmRunReport> {
  const started = Date.now();
  const content = readContentFiles(options.contentDir);
  // Resolved once, and *named*, rather than left to `warmOwnedCards` to default
  // internally: the report quotes worker-pool counters at the end, and a run
  // that reached for the shared renderer implicitly would have nothing to quote
  // and would report "no threads started" after drawing a hundred masters.
  const renderer: CardRenderer = options.renderer ?? getCardRenderer();
  const appearance = createAppearanceService({ db: options.db, getContent: () => content });
  const presentation: CardPresentationDeps = {
    appearance,
    assetsDir: options.assetsDir,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };

  const playerIds = options.playerIds ?? (await listPlayersWithOwnedCards(options.db));
  const playerConcurrency = Math.max(
    1,
    options.playerConcurrency ?? DEFAULT_OWNED_WARM_PLAYER_CONCURRENCY,
  );

  const report: OwnedWarmRunReport = {
    playersProcessed: 0,
    ownedConsidered: 0,
    mastersRendered: 0,
    mastersCached: 0,
    derivativesCreated: 0,
    derivativesCached: 0,
    skipped: [],
    failed: [],
    durationMs: 0,
    concurrency: Math.max(1, options.concurrency ?? 1),
    playerConcurrency,
  };

  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const playerId = playerIds[index];
      if (playerId === undefined) return;

      const subjects = await listOwnedWarmSubjects(options.db, playerId);
      const result: OwnedCardWarmResult = await warmOwnedCards(presentation, subjects, {
        renderer,
        widths: options.widths ?? OWNED_GRID_WIDTHS,
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });

      report.playersProcessed += 1;
      report.ownedConsidered += result.ownedConsidered;
      report.mastersRendered += result.mastersRendered;
      report.mastersCached += result.mastersCached;
      report.derivativesCreated += result.derivativesCreated;
      report.derivativesCached += result.derivativesCached;
      report.skipped.push(...result.skipped);
      report.failed.push(...result.failed);

      done += 1;
      options.onPlayer?.(done, playerIds.length, playerId);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(playerConcurrency, playerIds.length) }, () => worker()),
  );

  report.durationMs = Date.now() - started;
  const workers = renderer.getStats().workers;
  if (workers !== undefined) report.workers = workers;
  return report;
}

export function formatOwnedWarmReport(report: OwnedWarmRunReport): string {
  const lines = [
    `Owned cards warmed for ${report.playersProcessed} player(s): ` +
      `${report.ownedConsidered} owned copies considered`,
    `  masters:     ${report.mastersRendered} rendered, ${report.mastersCached} already cached`,
    `  derivatives: ${report.derivativesCreated} created, ${report.derivativesCached} already cached`,
    `  concurrency: ${report.concurrency} card(s) x ${report.playerConcurrency} player(s)`,
    `  elapsed:     ${(report.durationMs / 1000).toFixed(1)}s`,
  ];

  if (report.workers) {
    lines.push(
      `  workers:     ${report.workers.workers} thread(s), ` +
        `peak concurrent ${report.workers.peakConcurrent}, ` +
        `peak queued ${report.workers.peakQueued}, ` +
        `dispatched ${report.workers.dispatched}`,
    );
  } else {
    lines.push('  workers:     none started (nothing needed a cold render)');
  }

  for (const skip of report.skipped) {
    lines.push(`  skipped waifu ${skip.waifuId} (${skip.slug}): ${skip.reason}`);
  }
  for (const failure of report.failed) {
    lines.push(`  FAILED ${failure.slug}/${failure.appearanceId}: ${failure.message}`);
  }
  return lines.join('\n');
}

export interface CardGcRunOptions {
  contentDir: string;
  assetsDir: string;
  cacheRoot?: string | undefined;
  maxAgeDays?: number | undefined;
  dryRun?: boolean | undefined;
  logger?: Logger | undefined;
  renderer?: CardRenderer | undefined;
  now?: Date | undefined;
}

/**
 * Sweeps the cache, keeping the warm set alive.
 *
 * The keep-set is computed by hashing artwork — the same work
 * `computeMasterRenderKey` does per request, no rasterizing — so a GC run costs
 * a few hundred file hashes rather than a few hundred renders.
 */
export async function runCardGc(options: CardGcRunOptions): Promise<CardCacheGcResult> {
  const content = readContentFiles(options.contentDir);
  const plan = planCardWarm({
    contentDir: options.contentDir,
    assetsDir: options.assetsDir,
    allAppearances: true,
    includeDisabled: true,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const keyOf = options.renderer
    ? (input: CardRenderInput): Promise<string> =>
        (options.renderer as CardRenderer).computeMasterRenderKey(input)
    : computeCardRenderKey;

  const keepRenderKeys: string[] = [];
  for (const input of plan.inputs) {
    try {
      keepRenderKeys.push(await keyOf(input));
    } catch {
      // An entry we cannot key is an entry we cannot protect. Age still guards
      // it, and one whose artwork has gone missing should be collectable.
    }
  }

  return collectCardCacheGarbage({
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    keepRenderKeys,
    knownSlugs: content.species.map((s) => s.slug),
    ...(options.maxAgeDays === undefined ? {} : { maxAgeDays: options.maxAgeDays }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function formatGcReport(result: CardCacheGcResult): string {
  const mb = (result.bytesReclaimed / (1024 * 1024)).toFixed(2);
  const lines = [
    `${result.dryRun ? '[dry run] ' : ''}Card cache: scanned ${result.scanned}, ` +
      `kept ${result.kept}, ${result.dryRun ? 'would remove' : 'removed'} ` +
      `${result.removed.length} (${mb} MB)`,
  ];
  for (const removal of result.removed) {
    lines.push(`  ${removal.reason}: ${removal.file}`);
  }
  return lines.join('\n');
}
