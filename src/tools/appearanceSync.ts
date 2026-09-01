/**
 * Milestone-appearance synchroniser — an **authoring tool**, not runtime code.
 *
 * Artwork production is about to scale from a handful of cards to a milestone
 * set per species (`standard`, `level_10` … `level_50`). Hand-writing those
 * JSON entries is the kind of work that is individually trivial and collectively
 * a source of typos, drift and missed species. This closes the loop: an artist
 * drops a PNG, the tool writes the entry that names it.
 *
 * ### The one rule that shapes everything here
 *
 * **Artwork leads; content follows.** An appearance is only ever added when its
 * PNG already exists on disk. Pre-populating all five levels for every species
 * would be one line of code and exactly the wrong thing — the loader warns and
 * drops an appearance whose art is missing, so a mass-populate would trade a
 * few minutes of typing for hundreds of recurring boot warnings that everyone
 * learns to ignore. A tool that manufactures noise is worse than no tool.
 *
 * ### It is a synchroniser, never a formatter
 *
 * It adds missing entries. It does not normalise, reorder, re-sort, or
 * "correct" anything an author wrote. An appearance that already exists is
 * copied through untouched, whatever is in it. That is what makes it safe to
 * run on a content pack somebody is halfway through hand-tuning.
 *
 * ### Why raw JSON rather than parsed content
 *
 * `SpeciesContentSchema` applies defaults — `cosmeticRarity: 'standard'`,
 * `sortOrder: 100`, `tags: []`, `enabled: true`, and more. Parsing a file and
 * writing the result back would stamp all of those onto all fifty species and
 * turn a two-line addition into a two-thousand-line diff. So the mutation works
 * on raw `JSON.parse` output, and the schema is used for what it is good at:
 * confirming the *candidate* would load before any of it reaches disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  listSpeciesSources,
  readContentFiles,
  resolveAssetPath,
  validateContentSet,
} from '../modules/content/loader';
import { appearanceRelativePathForSpecies, defaultAssetId } from '../modules/appearance/appearanceContent';
import {
  DEFAULT_APPEARANCE_ID,
  SpeciesFileSchema,
  type AppearanceUnlock,
} from '../modules/content/schemas';
import { ContentValidationError } from '../shared/errors';

// ── The milestone set ───────────────────────────────────────────────────────

/**
 * Waifu levels that get a milestone appearance.
 *
 * Every value is checked against `waifuProgression.maxLevel` at runtime rather
 * than trusted: the ceiling lives in `tables.json` and is a balance knob, so a
 * milestone that is legal today can stop being legal after a tuning change.
 * When that happens the tool skips it and says so — it never writes content the
 * loader would refuse.
 */
export const MILESTONE_LEVELS = [10, 20, 30, 40, 50] as const;

/** A canonical appearance record, exactly as it is written into a content pack. */
export interface MilestoneDefinition {
  id: string;
  name: string;
  sortOrder: number;
  unlock: AppearanceUnlock;
}

/** `sortOrder` mirrors the level, so the gallery reads bottom-to-top by rank. */
function levelMilestone(level: number): MilestoneDefinition {
  return {
    id: `level_${level}`,
    name: `Level ${level}`,
    sortOrder: level,
    unlock: { type: 'level', atLevel: level },
  };
}

/** The default entry. `sortOrder: 0` puts her first in every gallery. */
export const STANDARD_MILESTONE: MilestoneDefinition = {
  id: DEFAULT_APPEARANCE_ID,
  name: 'Standard',
  sortOrder: 0,
  unlock: { type: 'owned' },
};

/** Level milestones only — `standard` is handled separately everywhere. */
export function levelMilestones(): MilestoneDefinition[] {
  return MILESTONE_LEVELS.map(levelMilestone);
}

// ── Plan shapes ─────────────────────────────────────────────────────────────

export interface SpeciesPlan {
  slug: string;
  /** Appearance ids that will be appended, in gallery order. */
  added: string[];
  /**
   * True when this species had no explicit catalog and one is being written for
   * the first time — the canonical `standard` entry rides along.
   */
  materializedArray: boolean;
  /** Milestones whose art exists but whose level is above `maxLevel`. */
  skippedAboveMaxLevel: string[];
}

export interface FilePlan {
  /**
   * Content-relative path, e.g. `species/starter.json` or
   * `expansions/twin_peaks/species/locals.json`. Species never move between
   * files, so this is a stable identity — and it has to be a path rather than
   * a basename, because two expansion packs may each ship a `locals.json`.
   */
  file: string;
  species: SpeciesPlan[];
  /**
   * True when the file on disk is not already in the canonical
   * `JSON.stringify(_, null, 2)` shape, so writing it will reformat more than
   * the addition. Surfaced rather than silently done.
   */
  reformats: boolean;
}

export interface SyncPlan {
  files: FilePlan[];
  totals: { files: number; species: number; appearances: number };
  /** Milestones skipped because `tables.json` puts them out of reach. */
  skipped: Array<{ slug: string; appearanceId: string; atLevel: number; maxLevel: number }>;
}

export interface SyncOptions {
  contentDir: string;
  assetsDir: string;
}

// ── Discovery and inspection ────────────────────────────────────────────────

interface RawSpecies {
  slug?: unknown;
  appearances?: unknown;
  [key: string]: unknown;
}

interface RawPack {
  file: string;
  absolutePath: string;
  species: RawSpecies[];
  /** Byte-for-byte original, used to preserve line endings and detect churn. */
  original: string;
}

function readPack(source: { file: string; absolutePath: string }): RawPack {
  const { file, absolutePath } = source;
  const original = fs.readFileSync(absolutePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch (err) {
    throw new ContentValidationError(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ContentValidationError(`${file}: expected an array of species`);
  }
  return { file, absolutePath, species: parsed as RawSpecies[], original };
}

/**
 * Every species file the bot would load: `content/species/` plus the species
 * directory of each **enabled** expansion pack.
 *
 * Delegates to the loader's own scan rather than globbing again, so a pack is
 * picked up by the tool and the bot on identical terms and neither can drift.
 * That shared scan is also what keeps a *disabled* pack out: its files are
 * discovered but filtered, so the synchroniser will not write milestone
 * appearances into content that is switched off — and will not quietly arm it
 * by leaving the pack looking maintained.
 *
 * Adding `winterexpansion.json`, or a whole new pack, requires no change here
 * and no configuration anywhere.
 */
function readAllPacks(contentDir: string): RawPack[] {
  const speciesDir = path.join(contentDir, 'species');
  if (!fs.existsSync(speciesDir)) {
    throw new ContentValidationError(`Species content directory missing: ${speciesDir}`);
  }
  const sources = listSpeciesSources(contentDir);
  if (sources.length === 0) {
    throw new ContentValidationError(`No species JSON files found in ${speciesDir}`);
  }
  return sources.map(readPack);
}

/**
 * Refuses to write when one slug is defined in more than one pack.
 *
 * `validateContentSet` already rejects duplicate slugs, but only by name — and
 * a tool that is about to edit files needs to say *which* files, because the
 * failure mode it prevents is writing the same appearance into two places and
 * leaving the author to work out which copy is real.
 */
function assertNoDuplicateSlugs(packs: RawPack[]): void {
  const filesBySlug = new Map<string, string[]>();
  for (const pack of packs) {
    for (const species of pack.species) {
      if (typeof species.slug !== 'string') continue;
      const files = filesBySlug.get(species.slug) ?? [];
      files.push(pack.file);
      filesBySlug.set(species.slug, files);
    }
  }

  const duplicates = [...filesBySlug.entries()].filter(([, files]) => files.length > 1);
  if (duplicates.length === 0) return;

  const detail = duplicates
    .map(([slug, files]) => `  "${slug}" appears in: ${files.join(', ')}`)
    .join('\n');
  throw new ContentValidationError(
    `Duplicate species slug across content packs — aborting without writing:\n${detail}\n` +
      'A species must be defined in exactly one pack. Remove the extra copy and re-run.',
  );
}

/** Does the appearance PNG exist beside the species' own image on disk? */
function artworkExists(
  assetsDir: string,
  imagePath: string | null,
  slug: string,
  appearanceId: string,
): boolean {
  // Art lives beside the species' `imagePath` — the same convention the loader
  // and the runtime resolver use, so a pack keeps its artwork organised under
  // `expansions/<pack>/<slug>/` while core species stay under `waifumon/<slug>/`.
  // Falls back to the canonical `waifumon/<slug>/` only when a species has no
  // usable `imagePath` yet (malformed draft content the loader would reject).
  const relative =
    imagePath !== null
      ? appearanceRelativePathForSpecies(imagePath, appearanceId)
      : `${defaultAssetId(slug, appearanceId).kind}/${slug}/${appearanceId}.png`;
  try {
    return fs.existsSync(resolveAssetPath(assetsDir, relative));
  } catch {
    // Path traversal, which a well-formed slug cannot produce. Treated as
    // missing, matching how the loader handles the same case.
    return false;
  }
}

function existingAppearances(species: RawSpecies): RawSpecies[] | null {
  const list = species.appearances;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list as RawSpecies[];
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Works out what would change, touching nothing.
 *
 * Every decision is made here so `--dry-run` and a real run share one code
 * path: dry-run is the same computation with the write step skipped, never a
 * second implementation that can disagree with the first.
 */
export function planAppearanceSync(options: SyncOptions): {
  plan: SyncPlan;
  packs: RawPack[];
  updated: Map<string, RawSpecies[]>;
} {
  const { contentDir, assetsDir } = options;

  // Duplicate slugs are checked *first*, before the loader's own validation.
  // `validateContentSet` also rejects them, but it reports only the slug —
  // and a tool that is about to edit files has to name the files, because
  // "which of these two copies is the real one?" is the actual question. The
  // generic error would otherwise win the race and swallow the useful one.
  const packs = readAllPacks(contentDir);
  assertNoDuplicateSlugs(packs);

  // Then fail on content that does not already load. A synchroniser that writes
  // into a broken content set turns one problem into two.
  const current = readContentFiles(contentDir);
  validateContentSet(current);
  const maxLevel = current.tables.waifuProgression.maxLevel;

  const milestones = levelMilestones();
  const filePlans: FilePlan[] = [];
  const skipped: SyncPlan['skipped'] = [];
  /** file → the species array to write, present only for files that change. */
  const updated = new Map<string, RawSpecies[]>();

  for (const pack of packs) {
    const speciesPlans: SpeciesPlan[] = [];
    const nextSpecies: RawSpecies[] = [];
    let packChanged = false;

    for (const species of pack.species) {
      const slug = typeof species.slug === 'string' ? species.slug : null;
      if (!slug) {
        nextSpecies.push(species);
        continue;
      }

      const authored = existingAppearances(species);
      const authoredIds = new Set(
        (authored ?? [])
          .map((a) => a.id)
          .filter((id): id is string => typeof id === 'string'),
      );
      const imagePath = typeof species.imagePath === 'string' ? species.imagePath : null;

      const skippedHere: string[] = [];
      const toAdd: MilestoneDefinition[] = [];

      for (const milestone of milestones) {
        if (authoredIds.has(milestone.id)) continue;
        if (!artworkExists(assetsDir, imagePath, slug, milestone.id)) continue;

        // The ceiling is a balance value, so it is checked rather than assumed.
        // Writing an unreachable gate would fail `validateContentSet` on the
        // next boot — better to skip it here and say why.
        const atLevel = milestone.unlock.type === 'level' ? milestone.unlock.atLevel : 0;
        if (atLevel > maxLevel) {
          skippedHere.push(milestone.id);
          skipped.push({ slug, appearanceId: milestone.id, atLevel, maxLevel });
          continue;
        }
        toAdd.push(milestone);
      }

      if (toAdd.length === 0) {
        nextSpecies.push(species);
        if (skippedHere.length > 0) {
          speciesPlans.push({
            slug,
            added: [],
            materializedArray: false,
            skippedAboveMaxLevel: skippedHere,
          });
        }
        continue;
      }

      // The schema demands exactly one `owned` entry once a catalog exists. A
      // species that already has one — under *any* id, because an author may
      // have named the default something else — keeps it. Adding a second
      // would make "which one does a fresh capture wear?" a coin flip, and is
      // precisely the mistake this branch exists to avoid.
      const hasOwned = (authored ?? []).some(
        (a) => (a.unlock as { type?: unknown } | undefined)?.type === 'owned',
      );

      const additions: MilestoneDefinition[] = [];
      const materializedArray = authored === null;
      if (materializedArray && !hasOwned) additions.push(STANDARD_MILESTONE);
      additions.push(...toAdd);

      // Appended, never inserted. `resolveAppearances` orders the gallery by
      // `sortOrder` then `id`, so array position carries no meaning at runtime
      // — which makes appending both the smallest possible diff and correct.
      const nextAppearances = [...(authored ?? []), ...additions];
      nextSpecies.push({ ...species, appearances: nextAppearances });
      packChanged = true;

      speciesPlans.push({
        slug,
        added: additions.map((a) => a.id),
        materializedArray,
        skippedAboveMaxLevel: skippedHere,
      });
    }

    if (packChanged) {
      updated.set(pack.file, nextSpecies);
      filePlans.push({
        file: pack.file,
        species: speciesPlans.filter((s) => s.added.length > 0),
        reformats: !isCanonicallyFormatted(pack.original),
      });
    } else if (speciesPlans.length > 0) {
      // Nothing to write, but there is something to report (skipped levels).
      filePlans.push({ file: pack.file, species: [], reformats: false });
    }
  }

  const reportable = filePlans.filter((f) => f.species.length > 0);
  const plan: SyncPlan = {
    files: reportable,
    totals: {
      files: reportable.length,
      species: reportable.reduce((sum, f) => sum + f.species.length, 0),
      appearances: reportable.reduce(
        (sum, f) => sum + f.species.reduce((n, s) => n + s.added.length, 0),
        0,
      ),
    },
    skipped,
  };

  return { plan, packs, updated };
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Every content file in this repo is `JSON.stringify(_, null, 2)` + newline. */
function serialize(value: unknown, useCrlf: boolean): string {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  return useCrlf ? json.replace(/\n/g, '\r\n') : json;
}

function isCanonicallyFormatted(original: string): boolean {
  try {
    const normalized = original.replace(/\r\n/g, '\n');
    return normalized === `${JSON.stringify(JSON.parse(original), null, 2)}\n`;
  } catch {
    return false;
  }
}

/**
 * Writes one pack: temp file → re-parse and re-validate the bytes that actually
 * landed → rename into place. The original is only replaced once its
 * replacement has been read back off disk and proved to still be valid content,
 * so an interrupted or malformed write cannot leave a corrupt content pack
 * behind.
 *
 * Line endings are carried over from the original. Every file in this repo is
 * CRLF; normalising them to LF would turn a two-line addition into a
 * whole-file diff on every author's machine.
 */
function writePack(pack: RawPack, species: RawSpecies[]): void {
  const useCrlf = pack.original.includes('\r\n');
  const contents = serialize(species, useCrlf);
  const tmp = `${pack.absolutePath}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    const roundTrip = SpeciesFileSchema.safeParse(JSON.parse(fs.readFileSync(tmp, 'utf8')));
    if (!roundTrip.success) {
      throw new ContentValidationError(
        `${pack.file}: the file this tool was about to write does not validate — ` +
          'nothing was changed. This is a bug in the synchroniser.',
      );
    }
    fs.renameSync(tmp, pack.absolutePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort — the original file was never touched */
    }
    throw err;
  }
}

/**
 * Plans, validates the candidate content set, and writes.
 *
 * The candidate is validated *as a whole* before anything is written, using the
 * loader's own rules — so a run either leaves every pack consistent or leaves
 * every pack alone. There is no state in which half the packs have been
 * updated.
 */
export function runAppearanceSync(options: SyncOptions & { dryRun?: boolean }): SyncPlan {
  const { plan, packs, updated } = planAppearanceSync(options);
  if (updated.size === 0) return plan;

  // Re-validate the whole set the way the bot will see it at boot.
  const candidateSpecies = packs.flatMap((pack) => {
    const next = updated.get(pack.file) ?? pack.species;
    const parsed = SpeciesFileSchema.safeParse(next);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new ContentValidationError(`${pack.file} would not validate:\n${detail}`);
    }
    return parsed.data;
  });

  const current = readContentFiles(options.contentDir);
  validateContentSet({ ...current, species: candidateSpecies });

  if (options.dryRun) return plan;

  for (const pack of packs) {
    const next = updated.get(pack.file);
    if (next) writePack(pack, next);
  }
  return plan;
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** The concise, grouped report the CLI prints. */
export function formatSyncReport(plan: SyncPlan, options: { dryRun?: boolean } = {}): string {
  const lines: string[] = [];

  for (const file of plan.files) {
    lines.push(file.file);
    for (const species of file.species) {
      lines.push(`  ${species.slug}`);
      for (const id of species.added) lines.push(`    + ${id}`);
    }
    if (file.reformats) {
      lines.push('    (note: this pack is not in the standard 2-space format and will be reflowed)');
    }
    lines.push('');
  }

  if (plan.totals.appearances === 0) {
    lines.push('No appearance changes needed.');
  } else {
    const verb = options.dryRun ? 'Would update' : 'Updated';
    lines.push(`${verb} ${plan.totals.files} file${plan.totals.files === 1 ? '' : 's'}`);
    lines.push(`${verb} ${plan.totals.species} species`);
    lines.push(
      `${options.dryRun ? 'Would add' : 'Added'} ${plan.totals.appearances} appearance` +
        `${plan.totals.appearances === 1 ? '' : 's'}`,
    );
  }

  for (const skip of plan.skipped) {
    lines.push(
      `Skipped ${skip.slug} / ${skip.appearanceId}: unlocks at level ${skip.atLevel}, ` +
        `above waifuProgression.maxLevel (${skip.maxLevel}).`,
    );
  }

  return lines.join('\n');
}
