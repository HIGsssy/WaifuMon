import fs from 'node:fs';
import path from 'node:path';
import type { ZodError, ZodType, ZodTypeDef } from 'zod';
import { ContentValidationError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import {
  ItemsFileSchema,
  SpeciesFileSchema,
  TablesFileSchema,
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

/** Missing image = warning + species auto-disabled; never render a broken card. */
export function validateSpeciesAssets(
  species: SpeciesContent[],
  assetsDir: string,
  logger: Logger,
): SpeciesContent[] {
  return species.map((s) => {
    const absolute = resolveAssetPath(assetsDir, s.imagePath);
    if (!fs.existsSync(absolute)) {
      logger.warn({ slug: s.slug, imagePath: s.imagePath }, 'species image missing — disabling');
      return { ...s, enabled: false };
    }
    return s;
  });
}

/**
 * Loads and validates all content JSON. Bad content fails loudly with
 * file+field errors — never silently.
 */
export function loadContent(contentDir: string, assetsDir: string, logger: Logger): LoadedContent {
  const itemsFile = parseJsonFile(path.join(contentDir, 'items.json'), ItemsFileSchema);
  const tables = parseJsonFile(path.join(contentDir, 'tables.json'), TablesFileSchema);

  const speciesDir = path.join(contentDir, 'species');
  if (!fs.existsSync(speciesDir)) {
    throw new ContentValidationError(`Species content directory missing: ${speciesDir}`);
  }
  const speciesFiles = fs
    .readdirSync(speciesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (speciesFiles.length === 0) {
    throw new ContentValidationError(`No species JSON files found in ${speciesDir}`);
  }
  const species = speciesFiles.flatMap((f) =>
    parseJsonFile(path.join(speciesDir, f), SpeciesFileSchema),
  );

  const items = itemsFile.items;

  const dupSlug = (slugs: string[]): string | undefined =>
    slugs.find((s, i) => slugs.indexOf(s) !== i);
  const dupItem = dupSlug(items.map((i) => i.slug));
  if (dupItem) throw new ContentValidationError(`Duplicate item slug: ${dupItem}`);
  const dupSpecies = dupSlug(species.map((s) => s.slug));
  if (dupSpecies) throw new ContentValidationError(`Duplicate species slug: ${dupSpecies}`);

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

  const validatedSpecies = validateSpeciesAssets(species, assetsDir, logger);

  logger.info(
    { items: items.length, species: validatedSpecies.length },
    'content loaded and validated',
  );
  return { items, species: validatedSpecies, tables };
}
