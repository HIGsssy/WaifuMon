import fs from 'node:fs';
import path from 'node:path';
import type { ZodError, ZodType, ZodTypeDef } from 'zod';
import { appearanceAssetRelativePath, defaultAssetId } from '../appearance/appearanceContent';
import { archetypeToRace, DEFAULT_RACE } from '../cards/race';
import { ContentValidationError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { DEFAULT_REGION, isRegion, REGION_EXCLUSIVE_TAG } from '../locations/regions';
import {
  BossesFileSchema,
  BossRewardsFileSchema,
  ExpansionContentSchema,
  ItemsFileSchema,
  RegionContentSchema,
  SpeciesFileSchema,
  TablesFileSchema,
  type AppearanceContent,
  type AssetId,
  type BossContent,
  type ExpansionContent,
  type LoadedContent,
  type RegionContent,
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
 *     and it fails at *resolution* — half an hour after the announcement, with
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
 * added to an inventory, while it is disabled.
 *
 * The `items.enabled` flag is **retirement, not Shop availability** — the Shop
 * has its own `purchasable` flag, and `items.enabled: false` withdraws an item
 * from every source at once. A boss table may therefore legitimately be
 * checked against it, and `adminContentService` does exactly that as a
 * non-blocking warning, because a boss dropping a retired item is a content
 * mistake worth hearing about but not one worth refusing to boot over. Nothing
 * Shop-specific — `purchasable`, `buyPrice` — is consulted here or anywhere
 * else on the boss path.
 *
 * A *disabled reward table* is likewise not fatal on its own — a boss pointing
 * at one is simply undrawable, and `bossEncounterService` logs an actionable
 * error when it skips it. It becomes fatal only when it leaves an enabled
 * region with nothing to draw at all, which is checked below alongside the
 * disabled-boss case, because from the players' side those are one failure.
 *
 * Affinity and region identifiers are already closed enums in the schema, so
 * they need no re-check here.
 */
export function validateBossContent(content: LoadedContent): void {
  const { bosses, bossRewards, items, tables } = content;
  const config = tables.bossEncounters;

  const ids = bosses.map((b) => b.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ContentValidationError(`Duplicate boss id: ${duplicate}`);

  const rewardTables = new Map(bossRewards.map((t) => [t.id, t]));
  const itemSlugs = new Set(items.map((i) => i.slug));

  for (const boss of bosses) {
    if (!rewardTables.has(boss.rewardTable)) {
      throw new ContentValidationError(
        `boss "${boss.id}" references unknown reward table: ${boss.rewardTable}. ` +
          `Add it to content/bossRewards.json (known tables: ${[...rewardTables.keys()].join(', ') || 'none'}).`,
      );
    }
  }

  for (const table of bossRewards) {
    for (const group of table.groups) {
      for (const entry of group.entries) {
        if (!itemSlugs.has(entry.itemId)) {
          throw new ContentValidationError(
            `bossRewards["${table.id}"].groups["${group.id}"] references unknown item slug: ${entry.itemId}`,
          );
        }
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
    // "Drawable" is the union of both switches: a boss is only schedulable if
    // it is itself enabled *and* the table it is paid from is. Checking them
    // together is what makes disabling the last reward table produce a message
    // that names the actual problem rather than a silent stop.
    const drawable = bosses.filter(
      (b) => b.enabled && b.region === region && rewardTables.get(b.rewardTable)?.enabled,
    );
    if (drawable.length === 0) {
      const enabledInRegion = bosses.filter((b) => b.enabled && b.region === region);
      const detail =
        enabledInRegion.length === 0
          ? 'no enabled boss belongs to it'
          : `every enabled boss in it points at a disabled reward table ` +
            `(${[...new Set(enabledInRegion.map((b) => b.rewardTable))].join(', ')}). ` +
            'Re-enable the table in content/bossRewards.json, or disable ' +
            'bossEncounters for this region.';
      throw new ContentValidationError(
        `bossEncounters is enabled for region "${region}" but ${detail}`,
      );
    }
  }
}

/**
 * Region, encounter-pool and travel invariants.
 *
 * Split out of `validateContentSet` for the same reason `validateBossContent`
 * is: the admin panel validates a *candidate* content set held in memory with
 * exactly the rules the bot enforces at boot, and a focused function is what a
 * per-rule test can aim at.
 *
 * Every check here is fatal. The theme is that a region pool is the only thing
 * standing between a player and an empty hunt, so anything that could make one
 * silently under-deliver — a typo'd slug, a species withdrawn with its pack, a
 * weight of zero — has to stop the boot rather than shrink a bucket nobody
 * notices for a week.
 */
export function validateRegionContent(content: LoadedContent): void {
  const { regions, expansions, species, items, tables, speciesOrigin } = content;
  const travel = tables.travel;

  // A content set with **no** region files at all is legitimate, not broken.
  // It is the pre-travel deployment, the appearance-sync tool's working
  // directory, and any partial candidate the admin panel assembles — the same
  // reasoning that makes `bosses.json` optional on disk. Travel is simply
  // inert: `buildTravelCatalog` finds no destinations and the Locations screen
  // has nothing to show. Every rule below is about the *shape of a region set*
  // and has nothing to say about a set that does not exist, so requiring a
  // starting region here would turn an optional directory into a mandatory one
  // by the back door. That the *shipped* content always has its regions is
  // asserted in `tests/unit/regionContent.test.ts`, which is the right place
  // for an invariant about what we ship rather than what the loader accepts.
  if (regions.length === 0) return;

  const duplicateRegion = regions.map((r) => r.id).find((id, i, a) => a.indexOf(id) !== i);
  if (duplicateRegion) {
    throw new ContentValidationError(
      `Duplicate region id: ${duplicateRegion}. Each region may be defined by exactly ` +
        'one file (a core file in content/regions/ or one expansion pack).',
    );
  }

  // Rule 5: exactly one starting region, and it must be the one the database
  // column defaults to. Two sources of truth are fine as long as they agree;
  // silently disagreeing would spawn players outside the region the game
  // believes they are in.
  const starting = regions.filter((r) => r.starting);
  if (starting.length !== 1) {
    throw new ContentValidationError(
      `Exactly one region must be marked "starting": true (found ${starting.length}` +
        `${starting.length > 0 ? `: ${starting.map((r) => r.id).join(', ')}` : ''}). ` +
        `It is where every new player begins and where travel always returns to.`,
    );
  }
  const startingRegion = starting[0]!;
  if (startingRegion.id !== DEFAULT_REGION) {
    throw new ContentValidationError(
      `Region "${startingRegion.id}" is marked as the starting region, but the ` +
        `players.current_region column defaults to "${DEFAULT_REGION}". Change ` +
        'DEFAULT_REGION in src/modules/locations/regions.ts and add a migration, ' +
        'or move the "starting" flag.',
    );
  }
  if (!startingRegion.enabled) {
    throw new ContentValidationError(
      `The starting region "${startingRegion.id}" must be enabled — every player is in it.`,
    );
  }

  const speciesBySlug = new Map(species.map((s) => [s.slug, s]));
  const expansionById = new Map(expansions.map((e) => [e.id, e]));
  const itemSlugs = new Set(items.map((i) => i.slug));

  // `REGION_EXCLUSIVE_TAG` is shared with the hunt's global fallback, which
  // refuses to draw a tagged species. The two enforcement points have to name
  // the same string, so neither owns it — see `modules/locations/regions.ts`.
  const exclusiveAppearances = new Map<string, string[]>();

  for (const region of regions) {
    // Rule: an enabled region must actually have somewhere to draw from. A
    // region with no pool is a destination a player pays to reach and then
    // hunts nothing in, which looks exactly like a broken feature.
    if (region.enabled && region.encounterPool.length === 0) {
      throw new ContentValidationError(
        `Region "${region.id}" is enabled but defines no encounterPool. An enabled ` +
          'region must list at least one species, or be disabled until it has content.',
      );
    }

    const seen = new Set<string>();
    for (const entry of region.encounterPool) {
      if (seen.has(entry.species)) {
        throw new ContentValidationError(
          `Region "${region.id}" lists species "${entry.species}" in its encounterPool twice.`,
        );
      }
      seen.add(entry.species);

      // Rule 3: weights. The schema already rejects zero, negative and
      // fractional values; this catches the one case it cannot see, which is
      // an entry that inherits a species whose own weight is somehow unusable.
      if (entry.weight !== undefined && (!Number.isInteger(entry.weight) || entry.weight <= 0)) {
        throw new ContentValidationError(
          `Region "${region.id}" gives species "${entry.species}" a weight of ` +
            `${entry.weight}; encounter weights must be positive integers.`,
        );
      }

      const found = speciesBySlug.get(entry.species);
      if (!found) {
        // Rule 7: distinguish "you typed it wrong" from "that pack is off".
        // Same fatal outcome, very different fix, so the message must say which.
        const origin = speciesOrigin[entry.species];
        const pack = origin ? expansionById.get(origin) : undefined;
        if (pack && !pack.enabled) {
          throw new ContentValidationError(
            `Region "${region.id}" references species "${entry.species}", which belongs ` +
              `to the disabled expansion "${pack.id}". Enable the expansion in ` +
              `content/expansions/${pack.id}/expansion.json, or remove her from the pool.`,
          );
        }
        // Rule 1: unknown species reference.
        throw new ContentValidationError(
          `Region "${region.id}" references unknown species slug: ${entry.species}`,
        );
      }

      if (region.enabled && found.tags.includes(REGION_EXCLUSIVE_TAG)) {
        const list = exclusiveAppearances.get(entry.species) ?? [];
        list.push(region.id);
        exclusiveAppearances.set(entry.species, list);
      }
    }

    for (const itemSlug of region.shopItems) {
      if (!itemSlugs.has(itemSlug)) {
        throw new ContentValidationError(
          `Region "${region.id}".shopItems references unknown item slug: ${itemSlug}`,
        );
      }
    }
  }

  // Rule 6: a region-exclusive species belongs to exactly one place. Counted
  // across *enabled* regions only, because a disabled region is not a place a
  // player can be — a species listed in one live region and one unreleased one
  // is not yet in two places.
  for (const [slug, regionIds] of exclusiveAppearances) {
    if (regionIds.length > 1) {
      throw new ContentValidationError(
        `Species "${slug}" is tagged "${REGION_EXCLUSIVE_TAG}" but appears in the ` +
          `encounter pools of ${regionIds.length} enabled regions ` +
          `(${regionIds.join(', ')}). Drop the tag if she is meant to be shared, ` +
          'or remove her from all but one pool.',
      );
    }
  }

  if (!travel.enabled) return;

  // Rule 4: pass/route → region references. The schemas already close the
  // region ids to the canonical set and tie routes to declared passes; what
  // only this layer can see is whether the *content set* actually defines the
  // regions those routes sell.
  const regionById = new Map(regions.map((r) => [r.id, r]));
  for (const route of travel.routes) {
    const region = regionById.get(route.regionId);
    if (!region) {
      throw new ContentValidationError(
        `travel.routes defines a route to region "${route.regionId}", which no region ` +
          'file defines. Add content/regions/<id>.json, or ship the expansion that ' +
          'introduces it.',
      );
    }
  }
  for (const pass of travel.passes) {
    for (const regionId of pass.grantsRoutes) {
      if (!regionById.has(regionId)) {
        throw new ContentValidationError(
          `travel.passes["${pass.id}"] grants a route to region "${regionId}", which ` +
            'no region file defines.',
        );
      }
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

  // The check above sees only the *loaded* registry — core plus every enabled
  // pack — so it already catches an enabled pack colliding with anything. The
  // gap it cannot see is a **disabled** pack, whose species are deliberately
  // absent from that list. `speciesOrigin` carries them anyway, precisely so
  // this check is possible: a collision hiding inside a switched-off pack
  // validates clean for months and then fails, or silently overwrites, on the
  // day somebody flips `enabled`.
  const loadedSlugs = new Set(species.map((s) => s.slug));
  const disabledExpansions = new Set(
    content.expansions.filter((e) => !e.enabled).map((e) => e.id),
  );
  for (const [packSlug, expansionId] of Object.entries(content.speciesOrigin)) {
    if (!disabledExpansions.has(expansionId)) continue;
    if (loadedSlugs.has(packSlug)) {
      throw new ContentValidationError(
        `Duplicate species slug "${packSlug}": defined by the disabled expansion ` +
          `"${expansionId}" and also by loaded content. Species ids are globally unique ` +
          'across core and every expansion, enabled or not — enabling that pack would ' +
          'collide.',
      );
    }
  }

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

  validateRegionContent(content);
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

  /**
   * Boss reward tables are optional on disk for the same reason and under the
   * same conditions as `bosses.json`. The two are only meaningful together:
   * `validateBossContent` rejects a boss whose table is absent, so a missing
   * file can only coexist with an absent roster.
   */
  const bossRewardsPath = path.join(contentDir, 'bossRewards.json');
  const bossRewards = fs.existsSync(bossRewardsPath)
    ? parseJsonFile(bossRewardsPath, BossRewardsFileSchema)
    : [];

  const { regions, expansions, expansionSpecies, speciesOrigin } = readExpansionPacks(contentDir);

  return {
    items: itemsFile.items,
    species: [...species, ...expansionSpecies],
    tables,
    bosses,
    bossRewards,
    regions,
    expansions,
    speciesOrigin,
  };
}

/** What one discovery pass over `content/regions/` + `content/expansions/` found. */
export interface ExpansionScan {
  regions: RegionContent[];
  expansions: ExpansionContent[];
  /** Species from *enabled* packs only, ready to merge into the registry. */
  expansionSpecies: SpeciesContent[];
  /** Every expansion species' origin, disabled packs included. */
  speciesOrigin: Record<string, string>;
}

/**
 * Discovers core region files and expansion packs, and folds enabled packs'
 * species into the registry.
 *
 * Two directories, one shape of answer:
 *
 *   - `content/regions/*.json` — core regions. Waifu Valley is a real file
 *     here with a real, explicitly listed encounter pool, not an implicit
 *     "everything that isn't somewhere else". Modelling the starting region
 *     the same way as every other one is what lets the hunt fall back to a
 *     *curated* pool instead of to the whole species table.
 *   - `content/expansions/<pack>/` — packs. A directory is only a pack if it
 *     contains `expansion.json`; anything else is a hard error naming the
 *     folder, which is what stops content that was sitting on disk unloaded
 *     from becoming live the moment discovery shipped.
 *
 * A **disabled** pack contributes its manifest and nothing else: no species,
 * no region, no shop rows. Its species slugs are still recorded in
 * `speciesOrigin` so validation can tell "that pack is off" from "you typed
 * the slug wrong", which are the same failure with completely different fixes.
 *
 * Both directories are optional on disk. A deployment with neither loads with
 * empty lists and travel stays inert — the pre-travel behavior, preserved.
 */
export function readExpansionPacks(contentDir: string): ExpansionScan {
  const regions: RegionContent[] = [];
  const expansions: ExpansionContent[] = [];
  const expansionSpecies: SpeciesContent[] = [];
  const speciesOrigin: Record<string, string> = {};

  const regionsDir = path.join(contentDir, 'regions');
  if (fs.existsSync(regionsDir)) {
    for (const file of listJsonFiles(regionsDir)) {
      regions.push(parseJsonFile(path.join(regionsDir, file), RegionContentSchema));
    }
  }

  const expansionsDir = path.join(contentDir, 'expansions');
  if (!fs.existsSync(expansionsDir)) {
    return { regions, expansions, expansionSpecies, speciesOrigin };
  }

  const packDirs = fs
    .readdirSync(expansionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const dirName of packDirs) {
    const packDir = path.join(expansionsDir, dirName);
    const manifestPath = path.join(packDir, 'expansion.json');
    if (!fs.existsSync(manifestPath)) {
      throw new ContentValidationError(
        `content/expansions/${dirName}/ has no expansion.json. Every directory under ` +
          'content/expansions/ must declare itself with a manifest — add one with ' +
          '"enabled": false to keep the pack on disk without activating it.',
      );
    }
    const manifest = parseJsonFile(manifestPath, ExpansionContentSchema);
    expansions.push(manifest);

    // Species are read from a *disabled* pack too, but only so their slugs can
    // be recorded. Reading them also means a disabled pack's files stay
    // schema-validated, so re-enabling it is never a leap into the dark.
    const packSpeciesDir = path.join(packDir, 'species');
    const packSpecies = fs.existsSync(packSpeciesDir)
      ? listJsonFiles(packSpeciesDir).flatMap((f) =>
          parseJsonFile(path.join(packSpeciesDir, f), SpeciesFileSchema),
        )
      : [];
    for (const s of packSpecies) {
      // Checked across *every* pack, enabled or not. Species ids are globally
      // unique by rule, and a collision hiding inside a switched-off pack is
      // the worst kind: it validates clean for months and then fails — or
      // worse, silently overwrites — on the day somebody flips `enabled`.
      const owner = speciesOrigin[s.slug];
      if (owner) {
        throw new ContentValidationError(
          `Duplicate species slug "${s.slug}": defined by both expansion "${owner}" and ` +
            `expansion "${manifest.id}". Species ids are globally unique across core and ` +
            'every expansion, enabled or not.',
        );
      }
      speciesOrigin[s.slug] = manifest.id;
    }

    if (!manifest.enabled) continue;

    expansionSpecies.push(...packSpecies);

    const regionPath = path.join(packDir, 'region.json');
    if (fs.existsSync(regionPath)) {
      regions.push(parseJsonFile(regionPath, RegionContentSchema));
    } else if (manifest.regionId) {
      throw new ContentValidationError(
        `Expansion "${manifest.id}" declares regionId "${manifest.regionId}" but ships ` +
          `no region.json. Add content/expansions/${dirName}/region.json.`,
      );
    }
  }

  return { regions, expansions, expansionSpecies, speciesOrigin };
}

/** Sorted list of species JSON filenames (basenames) in a species directory. */
export function listSpeciesFiles(speciesDir: string): string[] {
  return listJsonFiles(speciesDir);
}

/** Sorted `.json` basenames in a directory. Sorted so loads are reproducible. */
function listJsonFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/**
 * Warns about enabled species that no enabled region's pool lists.
 *
 * Be precise about what this means, because it is worse than it sounds: such a
 * species is, for practical purposes, **unobtainable**. The hunt only reaches
 * the global species table when *no* region pool covers the rolled rarity at
 * all, and the shipped Waifu Valley pool covers every rarity — so an unpooled
 * species is not "rarer", she simply never appears. That is almost always what
 * has happened when someone adds a species to `content/species/` and forgets
 * the region file.
 *
 * Still a warning rather than a failure, and deliberately so: failing the boot
 * would mean a content author cannot land a Waifumon and her artwork in one
 * commit and her pool entry in the next, turning a five-second fix into a
 * production outage. The message therefore has to carry the weight the
 * severity does not — it names the count, lists the slugs, and says the word
 * "unobtainable" rather than the reassuring "fallback".
 */
function warnOnUnpooledSpecies(
  species: SpeciesContent[],
  regions: RegionContent[],
  logger: Logger,
): void {
  if (regions.length === 0) return;
  const pooled = new Set(
    regions.filter((r) => r.enabled).flatMap((r) => r.encounterPool.map((e) => e.species)),
  );
  const orphans = species.filter((s) => s.enabled && !pooled.has(s.slug)).map((s) => s.slug);
  if (orphans.length === 0) return;
  logger.warn(
    { tag: 'regions/unpooled-species', count: orphans.length, slugs: orphans },
    `${orphans.length} enabled species are in no enabled region's encounter pool and are ` +
      'therefore UNOBTAINABLE — no hunt can draw them. Add them to a region file in ' +
      `content/regions/ or to an expansion's region.json. Affected: ${orphans.join(', ')}`,
  );
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
  warnOnUnpooledSpecies(validatedSpecies, content.regions, logger);

  logger.info(
    {
      items: content.items.length,
      species: validatedSpecies.length,
      bosses: validatedBosses.length,
      bossRewardTables: content.bossRewards.length,
      regions: content.regions.filter((r) => r.enabled).length,
      expansions: content.expansions.filter((e) => e.enabled).length,
    },
    'content loaded and validated',
  );
  return { ...content, species: validatedSpecies, bosses: validatedBosses };
}
