import fs from 'node:fs';
import path from 'node:path';
import type { ZodError, ZodType, ZodTypeDef } from 'zod';
import { appearanceAssetRelativePath, defaultAssetId } from '../appearance/appearanceContent';
import { archetypeToRace, DEFAULT_RACE } from '../cards/race';
import { ContentValidationError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import {
  ItemsFileSchema,
  SpeciesFileSchema,
  TablesFileSchema,
  type AppearanceContent,
  type AssetId,
  type LoadedContent,
  type SpeciesContent,
} from './schemas';

function formatZodError(file: string, err: ZodError): string {
  const details = err.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  return `Content validation failed in ${file}:\n${details}`;
}

function parseJsonFile<T>(filePath: string, schema: ZodType<T, ZodTypeDef, unknown>): T {
  if (!fs.existsSync(filePath)) {
    throw new ContentValidationError(`Content file missing: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ContentValidationError(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ContentValidationError(formatZodError(filePath, parsed.error));
  }
  return parsed.data;
}

/**
 * Resolves a species image path under the assets root, rejecting escapes
 * (a malicious image_path in content JSON must not read outside ASSETS_DIR).
 */
export function resolveAssetPath(assetsDir: string, imagePath: string): string {
  const root = path.resolve(assetsDir);
  const resolved = path.resolve(root, imagePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ContentValidationError(
      `image_path "${imagePath}" resolves outside the assets directory`,
    );
  }
  return resolved;
}

/**
 * Asset pre-flight.
 *
 * Two different severities, on purpose:
 *   - a missing **default** image disables the species (unchanged behavior —
 *     a species that cannot render at all is worse than one that is absent);
 *   - a missing **non-default appearance** file drops just that appearance
 *     with a warning and leaves the species enabled. Half-shipped artwork
 *     should cost one gallery tile, not a whole Waifumon.
 *
 * Species with no authored catalog are untouched: their implicit `standard`
 * appearance is covered by the `imagePath` probe that already existed.
 */
export function validateSpeciesAssets(
  species: SpeciesContent[],
  assetsDir: string,
  logger: Logger,
): SpeciesContent[] {
  const exists = (relative: string): boolean => {
    try {
      return fs.existsSync(resolveAssetPath(assetsDir, relative));
    } catch {
      // Path traversal — treated as missing rather than fatal, matching the
      // "never render a broken card" rule. `resolveAssetPath` already logged
      // the intent by throwing.
      return false;
    }
  };

  return species.map((s) => {
    const absolute = resolveAssetPath(assetsDir, s.imagePath);
    if (!fs.existsSync(absolute)) {
      logger.warn({ slug: s.slug, imagePath: s.imagePath }, 'species image missing — disabling');
      return { ...s, enabled: false };
    }

    if (!s.appearances || s.appearances.length === 0) return s;

    const kept: AppearanceContent[] = [];
    for (const appearance of s.appearances) {
      const assetId = appearance.assetId ?? defaultAssetId(s.slug, appearance.id);
      const relative = appearanceAssetRelativePath(assetId);
      if (exists(relative)) {
        kept.push(appearance);
        continue;
      }
      if (appearance.unlock.type === 'owned') {
        // The default entry has no fallback to degrade to. Rather than disable
        // a species that has a perfectly good `imagePath`, keep the entry and
        // let the consumer's resolver fall back (Discord → species card,
        // Portal → silhouette). Loud, because it is an authoring mistake.
        logger.warn(
          { slug: s.slug, appearanceId: appearance.id, assetId },
          'default appearance artwork missing — consumers will fall back',
        );
        kept.push(appearance);
        continue;
      }
      logger.warn(
        { slug: s.slug, appearanceId: appearance.id, assetId },
        'appearance artwork missing — appearance disabled',
      );
    }
    return { ...s, appearances: kept };
  });
}

/**
 * Race pre-flight — diagnostics only, never a failure and never a mutation.
 *
 * Three cases, one of which is worth a log line:
 *
 *   - explicit `race` → nothing to say;
 *   - no `race`, but `archetype` maps to one → the migration fallback working
 *     as designed, and silent, because warning on it would fire for nearly
 *     every species in the corpus and train everyone to ignore the channel;
 *   - no `race` and `archetype` maps to nothing → warn, because this species
 *     is now rendering with the `human` frame by default and only an author
 *     can say whether that is right.
 *
 * Deliberately does **not** write the resolved race back onto the species. The
 * JSON stays the source of truth; the renderer resolves per render. A loader
 * that quietly filled the field in would make `race` look authored when it was
 * guessed, and the guess would then survive an admin panel round-trip to disk.
 */
export function checkSpeciesRaces(species: SpeciesContent[], logger: Logger): void {
  for (const offender of findUnresolvableRaces(species)) {
    logger.warn(
      {
        tag: 'card-renderer/race-fallback',
        slug: offender.slug,
        archetype: offender.archetype,
        fallbackRace: DEFAULT_RACE,
      },
      unresolvableRaceMessage(offender),
    );
  }
}

/** A species whose race can only be reached by falling back to the default. */
export interface UnresolvableRace {
  slug: string;
  archetype: string;
}

/**
 * Every species that would hit the `human` fallback — no explicit `race`, and
 * an `archetype` that maps to nothing.
 *
 * Shared by two callers that want the same answer for opposite reasons, which
 * is the point of hoisting it out of the warning path:
 *
 *   - **Runtime** (`checkSpeciesRaces`) logs and carries on. Bad content
 *     reaching production must still render a card.
 *   - **CI** (the content invariant test) fails the build. Shipped content
 *     should never *rely* on the fallback; the fallback is for content that
 *     escaped review, not a substitute for authoring `race`.
 *
 * Deduped by slug so one offender cannot be reported twice in a single pass.
 */
export function findUnresolvableRaces(species: SpeciesContent[]): UnresolvableRace[] {
  const seen = new Set<string>();
  const offenders: UnresolvableRace[] = [];
  for (const s of species) {
    if (s.race) continue;
    if (archetypeToRace(s.archetype)) continue;
    if (seen.has(s.slug)) continue;
    seen.add(s.slug);
    offenders.push({ slug: s.slug, archetype: s.archetype });
  }
  return offenders;
}

/** Shared wording so the CI failure reads exactly like the runtime warning. */
export function unresolvableRaceMessage(offender: UnresolvableRace): string {
  return (
    `species "${offender.slug}": archetype "${offender.archetype}" maps to no race — ` +
    `cards will render as "${DEFAULT_RACE}". Add an explicit "race" field to fix.`
  );
}

/**
 * Cross-file content invariants: slug uniqueness and every cross-reference
 * (daily package, hunt find tables, progression bonuses, quest rewards)
 * pointing at an item that actually exists.
 *
 * Kept separate from file I/O so the admin panel can validate a *candidate*
 * content set — edits held in memory, before anything is written to disk —
 * with exactly the same rules the bot enforces at startup. Throws
 * `ContentValidationError` on the first violation.
 */
export function validateContentSet(content: LoadedContent): void {
  const { items, species, tables } = content;

  const dupSlug = (slugs: string[]): string | undefined =>
    slugs.find((s, i) => slugs.indexOf(s) !== i);
  const dupItem = dupSlug(items.map((i) => i.slug));
  if (dupItem) throw new ContentValidationError(`Duplicate item slug: ${dupItem}`);
  const dupSpecies = dupSlug(species.map((s) => s.slug));
  if (dupSpecies) throw new ContentValidationError(`Duplicate species slug: ${dupSpecies}`);

  // Appearance level gates are checked here rather than in the species schema
  // because the ceiling lives in tables.json — the two files are only both in
  // hand at this layer. A gate above `maxLevel` is unreachable content, which
  // is an authoring mistake worth failing on rather than shipping a tile no
  // player can ever earn.
  const maxWaifuLevel = tables.waifuProgression.maxLevel;
  for (const s of species) {
    for (const appearance of s.appearances ?? []) {
      if (appearance.unlock.type !== 'level') continue;
      if (appearance.unlock.atLevel > maxWaifuLevel) {
        throw new ContentValidationError(
          `species "${s.slug}": appearance "${appearance.id}" unlocks at level ` +
            `${appearance.unlock.atLevel}, above waifuProgression.maxLevel (${maxWaifuLevel})`,
        );
      }
    }
  }

  const itemSlugs = new Set(items.map((i) => i.slug));
  for (const slug of Object.keys(tables.dailyPackage.items)) {
    if (!itemSlugs.has(slug)) {
      throw new ContentValidationError(`dailyPackage references unknown item slug: ${slug}`);
    }
  }
  for (const sub of tables.hunt.itemFind.sub) {
    if (!itemSlugs.has(sub.slug)) {
      throw new ContentValidationError(`hunt.itemFind references unknown item slug: ${sub.slug}`);
    }
  }
  for (const sub of tables.hunt.rareItemFind.sub) {
    if (!itemSlugs.has(sub.slug)) {
      throw new ContentValidationError(
        `hunt.rareItemFind references unknown item slug: ${sub.slug}`,
      );
    }
  }
  for (const bonus of tables.progression.dailyBonusItems) {
    if (!itemSlugs.has(bonus.slug)) {
      throw new ContentValidationError(
        `progression.dailyBonusItems references unknown item slug: ${bonus.slug}`,
      );
    }
  }
  if (!itemSlugs.has(tables.progression.dailyRareItemChance.slug)) {
    throw new ContentValidationError(
      `progression.dailyRareItemChance references unknown item slug: ${tables.progression.dailyRareItemChance.slug}`,
    );
  }

  // Daily-quest reward slugs.
  for (const entry of tables.dailyQuests.pool) {
    for (const item of entry.rewards.items) {
      if (!itemSlugs.has(item.slug)) {
        throw new ContentValidationError(
          `dailyQuests.pool[${entry.slug}].rewards.items references unknown item slug: ${item.slug}`,
        );
      }
    }
  }
  if (tables.dailyQuests.allCompleteBonus) {
    for (const item of tables.dailyQuests.allCompleteBonus.items) {
      if (!itemSlugs.has(item.slug)) {
        throw new ContentValidationError(
          `dailyQuests.allCompleteBonus references unknown item slug: ${item.slug}`,
        );
      }
    }
  }
}

/**
 * Reads every content JSON file under `contentDir` and schema-validates each
 * one. Does **not** apply asset checks or cross-file checks — callers that
 * want the full picture use `loadContent`.
 */
export function readContentFiles(contentDir: string): LoadedContent {
  const itemsFile = parseJsonFile(path.join(contentDir, 'items.json'), ItemsFileSchema);
  const tables = parseJsonFile(path.join(contentDir, 'tables.json'), TablesFileSchema);

  const speciesDir = path.join(contentDir, 'species');
  if (!fs.existsSync(speciesDir)) {
    throw new ContentValidationError(`Species content directory missing: ${speciesDir}`);
  }
  const speciesFiles = listSpeciesFiles(speciesDir);
  if (speciesFiles.length === 0) {
    throw new ContentValidationError(`No species JSON files found in ${speciesDir}`);
  }
  const species = speciesFiles.flatMap((f) =>
    parseJsonFile(path.join(speciesDir, f), SpeciesFileSchema),
  );

  return { items: itemsFile.items, species, tables };
}

/** Sorted list of species JSON filenames (basenames) in a species directory. */
export function listSpeciesFiles(speciesDir: string): string[] {
  return fs
    .readdirSync(speciesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/**
 * Loads and validates all content JSON. Bad content fails loudly with
 * file+field errors — never silently.
 */
export function loadContent(contentDir: string, assetsDir: string, logger: Logger): LoadedContent {
  const content = readContentFiles(contentDir);
  validateContentSet(content);
  checkSpeciesRaces(content.species, logger);

  const validatedSpecies = validateSpeciesAssets(content.species, assetsDir, logger);

  logger.info(
    { items: content.items.length, species: validatedSpecies.length },
    'content loaded and validated',
  );
  return { ...content, species: validatedSpecies };
}
