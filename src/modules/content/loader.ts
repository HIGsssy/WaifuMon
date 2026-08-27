import fs from 'node:fs';
import path from 'node:path';
import type { ZodError, ZodType, ZodTypeDef } from 'zod';
import { appearanceAssetRelativePath, defaultAssetId } from '../appearance/appearanceContent';
import { archetypeToRace, DEFAULT_RACE } from '../cards/race';
import { ContentValidationError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import {
  BossesFileSchema,
  ItemsFileSchema,
  SpeciesFileSchema,
  TablesFileSchema,
  type AppearanceContent,
  type AssetId,
  type BossContent,
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
 * Boss artwork pre-flight — a **warning**, never a disable.
 *
 * Deliberately the opposite severity from a missing species image. A species
 * that cannot render has nothing to show and is disabled; a boss that cannot
 * render still has a name, an affinity, a description and three pieces of
 * prose, which is a complete encounter. Dropping the boss instead would take
 * a guild's whole scouting window away over a missing file, and — worse — it
 * would do so *after* an encounter had already been announced and committed
 * to, since artwork is resolved at post time.
 *
 * So the path is nulled out and the announcement degrades to a text/embed
 * encounter. Resolution, damage and rewards never touch artwork at all.
 */
export function validateBossAssets(
  bosses: BossContent[],
  assetsDir: string,
  logger: Logger,
): BossContent[] {
  return bosses.map((boss) => {
    if (!boss.artwork) return boss;
    let absolute: string;
    try {
      absolute = resolveAssetPath(assetsDir, boss.artwork);
    } catch {
      // Traversal — the schema should already have rejected it, so this is the
      // belt to that braces. Treated as missing, loudly.
      logger.warn(
        { bossId: boss.id, artwork: boss.artwork },
        'boss artwork resolves outside the assets directory — encounter will render text-only',
      );
      return { ...boss, artwork: null };
    }
    if (fs.existsSync(absolute)) return boss;
    logger.warn(
      { bossId: boss.id, artwork: boss.artwork },
      'boss artwork missing — encounter will render text-only',
    );
    return { ...boss, artwork: null };
  });
}

/**
 * Boss cross-file invariants.
 *
 * Split out of `validateContentSet` only so the shipped-content test can call
 * it against a hand-built set; the real loader always runs it as part of the
 * whole-set validation.
 *
 * Everything here is fatal rather than a warning, and each for a specific
 * reason:
 *
 *   - **Duplicate ids** would make `bossId` ambiguous on stored encounter rows,
 *     which is the key a historical result is read back by.
 *   - **An unknown reward table** mints an encounter nobody can be paid for,
 *     and it fails at *resolution* — an hour after the announcement, with
 *     committed participants waiting.
 *   - **An unknown reward item** is the same failure one level down: a payout
 *     naming an item that cannot be granted.
 *   - **No enabled boss for an enabled region** means the scheduler has
 *     nothing to draw, which would look exactly like a silently broken
 *     feature.
 *
 * A *disabled* reward item is deliberately **not** fatal, unlike the
 * affection-gift loot table. The distinction is when the item is resolved: a
 * gift freezes its slug at generation time and can therefore mint something
 * unclaimable, whereas a boss reward is looked up and granted inside the payout
 * transaction from the live `items` row — which still exists, and can still be
 * added to an inventory, while it is disabled. Disabling rather than deleting
 * is the admin panel's documented affordance, and making it fatal here would
 * quietly take that away for any item a boss happens to drop. The panel raises
 * a warning instead.
 *
 * Affinity and region identifiers are already closed enums in the schema, so
 * they need no re-check here.
 */
export function validateBossContent(content: LoadedContent): void {
  const { bosses, items, tables } = content;
  const config = tables.bossEncounters;

  const ids = bosses.map((b) => b.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ContentValidationError(`Duplicate boss id: ${duplicate}`);

  const rewardTables = config.rewardTables;
  const itemSlugs = new Set(items.map((i) => i.slug));

  for (const boss of bosses) {
    if (!Object.prototype.hasOwnProperty.call(rewardTables, boss.rewardTable)) {
      throw new ContentValidationError(
        `boss "${boss.id}" references unknown reward table: ${boss.rewardTable}`,
      );
    }
  }

  for (const [key, table] of Object.entries(rewardTables)) {
    const entries = [
      ...table.minorItems.map((e) => ({ slug: e.slug, where: 'minorItems' })),
      ...(table.jackpot ? [{ slug: table.jackpot.slug, where: 'jackpot' }] : []),
    ];
    for (const entry of entries) {
      if (!itemSlugs.has(entry.slug)) {
        throw new ContentValidationError(
          `bossEncounters.rewardTables["${key}"].${entry.where} references unknown item slug: ${entry.slug}`,
        );
      }
    }
  }

  // The per-region check guards against boss content that was *mis-authored* —
  // someone disabling the last Dominant boss, or moving a region's whole roster
  // elsewhere. It deliberately does not fire on a content set that carries no
  // boss content at all, because `bosses.json` is optional on disk: a
  // deployment without it, an appearance-sync working directory, and an admin
  // panel candidate set are all legitimate boss-free sets, and rejecting them
  // would make an optional file mandatory by the back door.
  //
  // The stronger guarantee — that the *shipped* content always has a drawable
  // boss for every enabled region — is asserted in `tests/unit/bossContent.ts`,
  // which is the right place for an invariant about what we ship rather than
  // about what the loader will accept.
  if (!config.enabled || bosses.length === 0) return;
  for (const region of config.regions) {
    const hasEnabled = bosses.some((b) => b.enabled && b.region === region);
    if (!hasEnabled) {
      throw new ContentValidationError(
        `bossEncounters is enabled for region "${region}" but no enabled boss belongs to it`,
      );
    }
  }
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
  // Affection gifts: the loot table is rolled at *generation* time and the
  // slug is frozen onto the gift row, so a dangling or disabled reference
  // would mint a gift nobody can ever claim. Both are fatal here rather than
  // deferred to a warning — a gift that cannot be handed over is worse than a
  // loud startup failure. (Weight shape is the schema's job; this layer is the
  // only one holding items.json and tables.json at the same time.)
  if (tables.affectionGifts.enabled) {
    const enabledItemSlugs = new Set(items.filter((i) => i.enabled).map((i) => i.slug));
    for (const entry of tables.affectionGifts.lootTable) {
      if (!itemSlugs.has(entry.slug)) {
        throw new ContentValidationError(
          `affectionGifts.lootTable references unknown item slug: ${entry.slug}`,
        );
      }
      if (!enabledItemSlugs.has(entry.slug)) {
        throw new ContentValidationError(
          `affectionGifts.lootTable references disabled item slug: ${entry.slug}`,
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

  validateBossContent(content);
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

  /**
   * Bosses are **optional on disk**. A deployment that predates the feature,
   * or one that deliberately runs without it, has no `bosses.json` and loads
   * with an empty list — the scheduler then finds nothing to draw and stays
   * quiet. A file that *is* present is validated as strictly as every other.
   */
  const bossesPath = path.join(contentDir, 'bosses.json');
  const bosses = fs.existsSync(bossesPath) ? parseJsonFile(bossesPath, BossesFileSchema) : [];

  return { items: itemsFile.items, species, tables, bosses };
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
  const validatedBosses = validateBossAssets(content.bosses, assetsDir, logger);

  logger.info(
    {
      items: content.items.length,
      species: validatedSpecies.length,
      bosses: validatedBosses.length,
    },
    'content loaded and validated',
  );
  return { ...content, species: validatedSpecies, bosses: validatedBosses };
}
