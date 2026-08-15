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
import {
  collectCardCacheGarbage,
  computeCardRenderKey,
  warmCardCache,
  type CardCacheGcResult,
  type CardRenderInput,
  type CardRenderer,
  type WarmCardCacheResult,
} from '../modules/cards';
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
