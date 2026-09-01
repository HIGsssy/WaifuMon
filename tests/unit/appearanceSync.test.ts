/**
 * The milestone-appearance synchroniser.
 *
 * Two properties carry the whole tool, and most of this file defends one or the
 * other:
 *
 *   **Artwork leads.** An appearance exists in content only if its PNG exists
 *   on disk. The alternative — pre-populating all five levels everywhere — is
 *   trivially easy and produces hundreds of "artwork missing" warnings that
 *   train everyone to ignore the warning channel.
 *
 *   **It never edits what an author wrote.** It appends. An appearance that is
 *   already there is copied through byte-identical no matter what is in it, so
 *   running the tool on a pack somebody is midway through tuning is safe.
 *
 * Everything runs against a temp content tree, so no test can touch the repo's
 * real packs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatSyncReport,
  levelMilestones,
  runAppearanceSync,
  STANDARD_MILESTONE,
} from '../../src/tools/appearanceSync';

let root: string;
let contentDir: string;
let assetsDir: string;

/** A minimal but schema-valid species. */
function species(slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    name: slug,
    rarity: 'N',
    archetype: 'demi-human',
    baseCaptureRate: null,
    description: '',
    tags: [],
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: `waifumon/${slug}/standard.png`,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    ...extra,
  };
}

function writePack(file: string, entries: unknown[]): void {
  fs.writeFileSync(
    path.join(contentDir, 'species', file),
    `${JSON.stringify(entries, null, 2)}\n`,
    'utf8',
  );
}

function readPack(file: string): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(contentDir, 'species', file), 'utf8')) as Array<
    Record<string, unknown>
  >;
}

/** Creates `assets/waifumon/<slug>/<id>.png` for each id. */
function art(slug: string, ...appearanceIds: string[]): void {
  const dir = path.join(assetsDir, 'waifumon', slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const id of appearanceIds) fs.writeFileSync(path.join(dir, `${id}.png`), 'png');
}

function appearancesOf(file: string, slug: string): Array<Record<string, unknown>> | undefined {
  const found = readPack(file).find((s) => s.slug === slug);
  return found?.appearances as Array<Record<string, unknown>> | undefined;
}

function sync(options: { dryRun?: boolean } = {}) {
  return runAppearanceSync({ contentDir, assetsDir, ...options });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-sync-'));
  contentDir = path.join(root, 'content');
  assetsDir = path.join(root, 'assets');
  fs.mkdirSync(path.join(contentDir, 'species'), { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // The tool reads the real items/tables files so its level ceiling and its
  // validation are the ones the bot actually enforces.
  fs.copyFileSync(path.resolve('content/items.json'), path.join(contentDir, 'items.json'));
  fs.copyFileSync(path.resolve('content/tables.json'), path.join(contentDir, 'tables.json'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('content pack discovery', () => {
  it('discovers every JSON pack in the directory, not a known list', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    writePack('placeholders.json', [species('neko_barista')]);
    art('alley_catgirl', 'standard', 'level_10');
    art('neko_barista', 'standard', 'level_10');

    const plan = sync();

    expect(plan.files.map((f) => f.file).sort()).toEqual([
      'species/placeholders.json',
      'species/starter.json',
    ]);
  });

  it('picks up a content pack whose name it has never seen', () => {
    // The point of the whole discovery design: adding a new expansion pack
    // requires no change to this tool and no configuration anywhere.
    writePack('winterexpansion.json', [species('frost_valkyrie')]);
    art('frost_valkyrie', 'standard', 'level_10', 'level_20', 'level_30');

    const plan = sync();

    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.file).toBe('species/winterexpansion.json');
    expect(appearancesOf('winterexpansion.json', 'frost_valkyrie')?.map((a) => a.id)).toEqual([
      'standard',
      'level_10',
      'level_20',
      'level_30',
    ]);
  });

  it('leaves each species in the pack it was already defined in', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    writePack('placeholders.json', [species('neko_barista')]);
    art('alley_catgirl', 'standard', 'level_10');
    art('neko_barista', 'standard', 'level_10');

    sync();

    expect(readPack('starter.json').map((s) => s.slug)).toEqual(['alley_catgirl']);
    expect(readPack('placeholders.json').map((s) => s.slug)).toEqual(['neko_barista']);
  });
});

describe('artwork-driven synchronisation', () => {
  it('writes no appearances array when only the standard art exists', () => {
    // A species with no catalog resolves to an implicit standard entry at read
    // time. Materialising that array would be pure churn for zero behaviour
    // change, on every species in the game.
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard');

    const plan = sync();

    expect(plan.totals.appearances).toBe(0);
    expect(appearancesOf('starter.json', 'alley_catgirl')).toBeUndefined();
  });

  it('materialises standard alongside the first level milestone', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10');

    sync();

    expect(appearancesOf('starter.json', 'alley_catgirl')).toEqual([
      { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
      { id: 'level_10', name: 'Level 10', sortOrder: 10, unlock: { type: 'level', atLevel: 10 } },
    ]);
  });

  it('adds every milestone whose artwork is present', () => {
    writePack('starter.json', [species('cyber_shrine_maiden')]);
    art('cyber_shrine_maiden', 'standard', 'level_10', 'level_20', 'level_30', 'level_40', 'level_50');

    sync();

    expect(appearancesOf('starter.json', 'cyber_shrine_maiden')?.map((a) => a.id)).toEqual([
      'standard',
      'level_10',
      'level_20',
      'level_30',
      'level_40',
      'level_50',
    ]);
  });

  it('adds nothing for a milestone whose PNG is absent', () => {
    // The scenario the tool exists for: artwork is produced incrementally, and
    // content must not run ahead of it.
    writePack('starter.json', [species('cyber_shrine_maiden')]);
    art('cyber_shrine_maiden', 'standard', 'level_10', 'level_20');

    sync();

    const ids = appearancesOf('starter.json', 'cyber_shrine_maiden')?.map((a) => a.id);
    expect(ids).toEqual(['standard', 'level_10', 'level_20']);
    expect(ids).not.toContain('level_30');
    expect(ids).not.toContain('level_40');
    expect(ids).not.toContain('level_50');
  });

  it('picks up a milestone the moment its artwork lands', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10');
    sync();

    art('alley_catgirl', 'level_20');
    const plan = sync();

    expect(plan.totals.appearances).toBe(1);
    expect(appearancesOf('starter.json', 'alley_catgirl')?.map((a) => a.id)).toEqual([
      'standard',
      'level_10',
      'level_20',
    ]);
  });
});

describe('preserving authored metadata', () => {
  const customLevel20 = {
    id: 'level_20',
    name: 'Midnight Bloom',
    description: 'A darker cut of her usual silhouette.',
    flavorText: 'Prepared for the annual shrine celebration.',
    cosmeticRarity: 'seasonal',
    introducedVersion: 'v1.3',
    unlockLabel: 'Train her to Level 20',
    tags: ['seasonal', 'night'],
    sortOrder: 25,
    assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'midnight_bloom' },
    unlock: { type: 'level', atLevel: 20 },
  };

  it('leaves a customised appearance byte-identical', () => {
    writePack('starter.json', [
      species('alley_catgirl', {
        appearances: [STANDARD_MILESTONE, customLevel20],
      }),
    ]);
    art('alley_catgirl', 'standard', 'level_10', 'level_20');

    sync();

    const list = appearancesOf('starter.json', 'alley_catgirl');
    expect(list?.find((a) => a.id === 'level_20')).toEqual(customLevel20);
  });

  it('extends an existing array without disturbing what is in it', () => {
    writePack('starter.json', [
      species('alley_catgirl', { appearances: [STANDARD_MILESTONE, customLevel20] }),
    ]);
    art('alley_catgirl', 'standard', 'level_10', 'level_20', 'level_30');

    sync();

    const list = appearancesOf('starter.json', 'alley_catgirl') ?? [];
    // The two authored entries keep their positions; new ones are appended.
    expect(list[0]).toEqual(STANDARD_MILESTONE);
    expect(list[1]).toEqual(customLevel20);
    expect(list.slice(2).map((a) => a.id)).toEqual(['level_10', 'level_30']);
  });

  it('does not add a second owned entry when the default is authored under another id', () => {
    // Two `owned` entries is a validation error — a fresh capture would have no
    // unambiguous thing to wear. The tool must notice an existing default even
    // when it is not called "standard".
    const customDefault = { id: 'base_look', name: 'Base', sortOrder: 0, unlock: { type: 'owned' } };
    writePack('starter.json', [
      species('alley_catgirl', { appearances: [customDefault] }),
    ]);
    art('alley_catgirl', 'standard', 'level_10');

    sync();

    const list = appearancesOf('starter.json', 'alley_catgirl') ?? [];
    expect(list.filter((a) => (a.unlock as { type: string }).type === 'owned')).toHaveLength(1);
    expect(list.map((a) => a.id)).toEqual(['base_look', 'level_10']);
  });

  it('is idempotent — a second run changes nothing', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10', 'level_20');

    sync();
    const afterFirst = fs.readFileSync(path.join(contentDir, 'species', 'starter.json'), 'utf8');

    const plan = sync();
    const afterSecond = fs.readFileSync(path.join(contentDir, 'species', 'starter.json'), 'utf8');

    expect(plan.totals.appearances).toBe(0);
    expect(afterSecond).toBe(afterFirst);
  });
});

describe('safety', () => {
  it('aborts without writing when a slug appears in two packs', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    writePack('winterexpansion.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10');

    expect(() => sync()).toThrow(/Duplicate species slug/);

    // Neither copy was touched.
    expect(appearancesOf('starter.json', 'alley_catgirl')).toBeUndefined();
    expect(appearancesOf('winterexpansion.json', 'alley_catgirl')).toBeUndefined();
  });

  it('names the slug and every file containing it', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    writePack('winterexpansion.json', [species('alley_catgirl')]);

    expect(() => sync()).toThrow(/alley_catgirl/);
    expect(() => sync()).toThrow(/starter\.json/);
    expect(() => sync()).toThrow(/winterexpansion\.json/);
  });

  it('writes nothing in dry-run mode', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10', 'level_20');
    const before = fs.readFileSync(path.join(contentDir, 'species', 'starter.json'), 'utf8');

    const plan = sync({ dryRun: true });

    expect(fs.readFileSync(path.join(contentDir, 'species', 'starter.json'), 'utf8')).toBe(before);
    // …but it still reports exactly what a real run would do: the materialised
    // default plus both milestones whose art is present.
    expect(plan.totals.appearances).toBe(3);
    expect(plan.files[0]?.species[0]?.added).toEqual(['standard', 'level_10', 'level_20']);
  });

  it('skips a milestone above waifuProgression.maxLevel rather than writing it', () => {
    // Lower the ceiling the way a balance change would, and the milestone whose
    // art exists becomes unreachable content the loader would reject.
    const tablesPath = path.join(contentDir, 'tables.json');
    const tables = JSON.parse(fs.readFileSync(tablesPath, 'utf8')) as {
      waifuProgression: { maxLevel: number };
    };
    tables.waifuProgression.maxLevel = 25;
    fs.writeFileSync(tablesPath, `${JSON.stringify(tables, null, 2)}\n`, 'utf8');

    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10', 'level_20', 'level_30');

    const plan = sync();

    expect(appearancesOf('starter.json', 'alley_catgirl')?.map((a) => a.id)).toEqual([
      'standard',
      'level_10',
      'level_20',
    ]);
    expect(plan.skipped).toEqual([
      { slug: 'alley_catgirl', appearanceId: 'level_30', atLevel: 30, maxLevel: 25 },
    ]);
  });

  it('confirms every shipped milestone is legal against the real tables.json', () => {
    // The milestone set is only correct relative to a balance value. If someone
    // lowers maxLevel below 50, this fails here rather than at the next boot.
    const tables = JSON.parse(fs.readFileSync(path.join(contentDir, 'tables.json'), 'utf8')) as {
      waifuProgression: { maxLevel: number };
    };
    for (const milestone of levelMilestones()) {
      const atLevel = milestone.unlock.type === 'level' ? milestone.unlock.atLevel : 0;
      expect(atLevel).toBeLessThanOrEqual(tables.waifuProgression.maxLevel);
    }
  });

  it('preserves the file’s line endings rather than normalising them', () => {
    const crlf = `${JSON.stringify([species('alley_catgirl')], null, 2)}\n`.replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(contentDir, 'species', 'starter.json'), crlf, 'utf8');
    art('alley_catgirl', 'standard', 'level_10');

    sync();

    const written = fs.readFileSync(path.join(contentDir, 'species', 'starter.json'), 'utf8');
    expect(written.includes('\r\n')).toBe(true);
    expect(written.replace(/\r\n/g, '\n').includes('\n\n')).toBe(false);
  });

  it('produces content the loader accepts', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10', 'level_50');
    sync();

    // The same call the bot makes at boot. If the tool ever writes something
    // invalid, this is where it shows up.
    expect(() => sync()).not.toThrow();
  });
});

describe('reporting', () => {
  it('groups by file and species', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    writePack('winterexpansion.json', [species('frost_valkyrie')]);
    art('alley_catgirl', 'standard', 'level_10', 'level_20');
    art('frost_valkyrie', 'standard', 'level_10');

    const report = formatSyncReport(sync({ dryRun: true }), { dryRun: true });

    expect(report).toContain('starter.json');
    expect(report).toContain('  alley_catgirl');
    expect(report).toContain('    + level_10');
    expect(report).toContain('    + level_20');
    expect(report).toContain('winterexpansion.json');
    expect(report).toContain('  frost_valkyrie');
    // 3 for alley (standard + two levels) + 2 for frost (standard + one level).
    expect(report).toContain('Would add 5 appearances');
    expect(report).toContain('Would update 2 files');
  });

  it('says so plainly when there is nothing to do', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard');

    expect(formatSyncReport(sync())).toBe('No appearance changes needed.');
  });
});

/**
 * Expansion packs are species content like any other, so the synchroniser has
 * to reach them — but only the *enabled* ones. Writing milestone appearances
 * into a switched-off pack would be worse than not reaching it at all: it
 * leaves the pack looking maintained while none of it is live, and it edits
 * content nobody has decided to ship.
 */
describe('expansion pack discovery', () => {
  /** Writes a pack manifest plus one species file under content/expansions/. */
  function writeExpansion(
    id: string,
    opts: { enabled: boolean; file?: string; entries: unknown[] },
  ): void {
    const dir = path.join(contentDir, 'expansions', id);
    fs.mkdirSync(path.join(dir, 'species'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'expansion.json'),
      `${JSON.stringify({ id, name: id, enabled: opts.enabled }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'species', opts.file ?? 'locals.json'),
      `${JSON.stringify(opts.entries, null, 2)}\n`,
    );
  }

  it('syncs species inside an enabled pack', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10');
    writeExpansion('twin_peaks', { enabled: true, entries: [species('ridge_diner_waitress')] });
    art('ridge_diner_waitress', 'standard', 'level_10', 'level_20');

    const plan = sync();

    expect(plan.files.map((f) => f.file).sort()).toEqual([
      'expansions/twin_peaks/species/locals.json',
      'species/starter.json',
    ]);
    const written = JSON.parse(
      fs.readFileSync(
        path.join(contentDir, 'expansions', 'twin_peaks', 'species', 'locals.json'),
        'utf8',
      ),
    ) as Array<{ slug: string; appearances?: Array<{ id: string }> }>;
    expect(written[0]!.appearances?.map((a) => a.id)).toEqual([
      'standard',
      'level_10',
      'level_20',
    ]);
  });

  it('discovers expansion milestone art in the canonical waifumon tree', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard');
    const packSpecies = species('onsen_maid');
    writeExpansion('twin_peaks', { enabled: true, entries: [packSpecies] });
    art('onsen_maid', 'standard', 'level_10', 'level_20');

    sync();

    const written = JSON.parse(
      fs.readFileSync(
        path.join(contentDir, 'expansions', 'twin_peaks', 'species', 'locals.json'),
        'utf8',
      ),
    ) as Array<{ slug: string; appearances?: Array<{ id: string }> }>;
    expect(written[0]!.appearances?.map((a) => a.id)).toEqual(['standard', 'level_10', 'level_20']);
  });

  it('ignores obsolete expansion asset directories', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard');
    const packSpecies = species('onsen_maid');
    writeExpansion('twin_peaks', { enabled: true, entries: [packSpecies] });
    art('onsen_maid', 'standard');
    const obsolete = path.join(assetsDir, 'expansions', 'twin_peaks', 'onsen_maid');
    fs.mkdirSync(obsolete, { recursive: true });
    fs.writeFileSync(path.join(obsolete, 'level_10.png'), 'png');

    const plan = sync();

    expect(plan.files).toHaveLength(0);
  });

  it('does not touch a disabled pack', () => {
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10');
    writeExpansion('shelved', { enabled: false, entries: [species('shelved_girl')] });
    art('shelved_girl', 'standard', 'level_10', 'level_20');
    const before = fs.readFileSync(
      path.join(contentDir, 'expansions', 'shelved', 'species', 'locals.json'),
      'utf8',
    );

    const plan = sync();

    expect(plan.files.map((f) => f.file)).toEqual(['species/starter.json']);
    expect(
      fs.readFileSync(
        path.join(contentDir, 'expansions', 'shelved', 'species', 'locals.json'),
        'utf8',
      ),
    ).toBe(before);
  });

  it('keeps same-named files in different packs apart', () => {
    // The reason the plan key is a path and not a basename: two packs may each
    // ship a `locals.json`, and a basename key would collapse them into one
    // plan entry and write one pack's species into the other.
    writePack('starter.json', [species('alley_catgirl')]);
    art('alley_catgirl', 'standard', 'level_10');
    writeExpansion('pack_a', { enabled: true, entries: [species('girl_a')] });
    writeExpansion('pack_b', { enabled: true, entries: [species('girl_b')] });
    art('girl_a', 'standard', 'level_10');
    art('girl_b', 'standard', 'level_10');

    const plan = sync();

    expect(plan.files.map((f) => f.file).sort()).toEqual([
      'expansions/pack_a/species/locals.json',
      'expansions/pack_b/species/locals.json',
      'species/starter.json',
    ]);
    for (const [pack, slug] of [
      ['pack_a', 'girl_a'],
      ['pack_b', 'girl_b'],
    ] as const) {
      const written = JSON.parse(
        fs.readFileSync(
          path.join(contentDir, 'expansions', pack, 'species', 'locals.json'),
          'utf8',
        ),
      ) as Array<{ slug: string }>;
      expect(written.map((w) => w.slug)).toEqual([slug]);
    }
  });
});
