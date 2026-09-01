/**
 * AdminContentService — the only writer of the JSON content files. These
 * tests assert the safety contract: validate first, back up, write atomically,
 * and never leave the original file in a state the bot would refuse to boot on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdminValidationError,
  assertSafeRelativeAssetPath,
  resolveWithinRoot,
} from '../../src/modules/content/adminContentService';
import {
  createAdminFixture,
  validItemInput,
  validSpeciesInput,
  type AdminFixture,
} from '../helpers/adminFixtures';

let f: AdminFixture;

beforeEach(() => {
  f = createAdminFixture();
});
afterEach(() => {
  f.cleanup();
});

describe('reading content', () => {
  it('reads every species file without applying the loader’s auto-disable', () => {
    const raw = f.service.readRaw();
    expect(raw.species.length).toBeGreaterThan(40);
    expect(raw.speciesFiles.map((g) => g.file)).toContain('species/starter.json');
    // The fixture has art for exactly one species, yet nothing is disabled on
    // read — auto-disable is a load-time projection, not a content edit.
    expect(raw.species.every((s) => s.enabled)).toBe(true);
  });

  it('summarises species by rarity, affinity and file', () => {
    const summary = f.service.getContentSummary();
    expect(summary.speciesTotal).toBe(f.service.readRaw().species.length);
    expect(summary.byRarity.find((r) => r.rarity === 'N')?.total).toBeGreaterThan(0);
    expect(summary.byAffinity.find((a) => a.affinity === 'switch')?.count).toBeGreaterThan(0);
    expect(summary.highlights.some((h) => h.label === 'Session timeout')).toBe(true);
  });
});

describe('validateContent', () => {
  it('passes on the shipped content and reports missing-art warnings', () => {
    const report = f.service.validateContent();
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.summary?.itemsTotal).toBeGreaterThan(0);
    // Only alley_catgirl has art in the fixture assets root.
    expect(report.warnings.some((w) => w.includes('image'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('alley_catgirl'))).toBe(false);
  });

  it('reports a broken cross-reference as an error, not a warning', () => {
    const tables = f.readTables() as Record<string, Record<string, unknown>>;
    (tables.dailyPackage as { items: Record<string, number> }).items.ghost_item = 1;
    fs.writeFileSync(
      path.join(f.contentDir, 'tables.json'),
      JSON.stringify(tables, null, 2),
      'utf8',
    );
    const report = f.service.validateContent();
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('ghost_item');
  });

  it('warns when a weighted table totals zero and when a rarity bucket is empty', () => {
    f.service.saveTablesSection('hunt', {
      ...f.service.readRaw().tables.hunt,
      resultTable: [{ kind: 'encounter', weight: 0 }],
      rarityTable: [
        { rarity: 'N', weight: 10 },
        { rarity: 'EX', weight: 5 },
      ],
    });
    const warnings = f.service.validateContent().warnings;
    expect(warnings.some((w) => w.includes('hunt.resultTable') && w.includes('0'))).toBe(true);
    expect(warnings.some((w) => w.includes('"EX"') && w.includes('0 enabled species'))).toBe(true);
  });
});

describe('species writes', () => {
  it('creates a species in the default file, backing up nothing on a new file', () => {
    const result = f.service.createSpecies(validSpeciesInput());
    expect(result.file).toBe('species/custom.json');
    expect(result.backup).toBeNull();
    expect(f.readSpecies('custom.json')).toHaveLength(1);
    expect(f.service.findSpecies('test_admin_waifu')?.file).toBe('species/custom.json');
  });

  it('rejects a duplicate slug and writes nothing', () => {
    const before = f.readSpecies('starter.json');
    expect(() => f.service.createSpecies(validSpeciesInput({ slug: 'alley_catgirl' }))).toThrow(
      AdminValidationError,
    );
    expect(f.readSpecies('starter.json')).toEqual(before);
    expect(fs.existsSync(path.join(f.contentDir, 'species', 'custom.json'))).toBe(false);
  });

  it.each([
    ['rarity', { rarity: 'MEGA' }],
    ['affinity', { affinity: 'chaotic' }],
    ['contentRating', { contentRating: 'wholesome' }],
    ['baseCaptureRate', { baseCaptureRate: 2 }],
    ['slug', { slug: 'Not A Slug' }],
  ])('rejects an invalid %s on update', (field, override) => {
    const before = f.readSpecies('starter.json');
    let error: AdminValidationError | undefined;
    try {
      f.service.updateSpecies(
        'alley_catgirl',
        validSpeciesInput({ slug: 'alley_catgirl', ...override }),
      );
    } catch (err) {
      error = err as AdminValidationError;
    }
    expect(error).toBeInstanceOf(AdminValidationError);
    expect(error?.issues.join(' ')).toContain(field);
    expect(f.readSpecies('starter.json')).toEqual(before);
  });

  it.each([
    ['../../../etc/passwd.png'],
    ['/etc/passwd.png'],
    ['waifumon/../../secret.png'],
    ['https://evil.example/x.png'],
    ['waifumon\\slug\\standard.png'],
  ])('rejects unsafe imagePath %s', (imagePath) => {
    expect(() => f.service.createSpecies(validSpeciesInput({ imagePath }))).toThrow(
      AdminValidationError,
    );
    expect(fs.existsSync(path.join(f.contentDir, 'species', 'custom.json'))).toBe(false);
  });

  it('updates a species in place and backs the original file up', () => {
    const result = f.service.updateSpecies(
      'alley_catgirl',
      validSpeciesInput({ slug: 'alley_catgirl', name: 'Renamed Catgirl', rarity: 'SR' }),
    );
    expect(result.file).toBe('species/starter.json');
    expect(result.backup).toMatch(/^backups\/species-starter-\d{8}-\d{6}\.json$/);
    expect(f.service.findSpecies('alley_catgirl')?.species.name).toBe('Renamed Catgirl');
    // The backup still holds the pre-edit value.
    const backup = JSON.parse(
      fs.readFileSync(path.join(f.contentDir, result.backup!), 'utf8'),
    ) as { slug: string; name: string }[];
    expect(backup.find((s) => s.slug === 'alley_catgirl')?.name).toBe('Alley Catgirl');
  });

  it('toggles enabled in the JSON file and keeps the file valid', () => {
    const { enabled } = f.service.toggleSpeciesEnabled('alley_catgirl');
    expect(enabled).toBe(false);
    const onDisk = f.readSpecies('starter.json') as { slug: string; enabled: boolean }[];
    expect(onDisk.find((s) => s.slug === 'alley_catgirl')?.enabled).toBe(false);
    expect(f.service.validateContent().ok).toBe(true);

    expect(f.service.toggleSpeciesEnabled('alley_catgirl').enabled).toBe(true);
  });

  it('leaves no temp file behind after a rejected write', () => {
    expect(() => f.service.createSpecies(validSpeciesInput({ rarity: 'nope' }))).toThrow();
    const stray = fs
      .readdirSync(path.join(f.contentDir, 'species'))
      .filter((n) => n.includes('.tmp'));
    expect(stray).toEqual([]);
  });
});

describe('item writes', () => {
  it('creates and updates items through the shipped schema', () => {
    f.service.createItem(validItemInput());
    expect(f.service.findItem('test_admin_item')?.name).toBe('Test Admin Item');

    f.service.updateItem('test_admin_item', validItemInput({ name: 'Renamed Item' }));
    expect(f.service.findItem('test_admin_item')?.name).toBe('Renamed Item');
    expect(f.backups().some((b) => b.startsWith('items-'))).toBe(true);
  });

  it('rejects a duplicate slug and schema violations', () => {
    const before = f.readItems();
    expect(() => f.service.createItem(validItemInput({ slug: 'basic_charm' }))).toThrow(
      AdminValidationError,
    );
    // shop_regions on an item with no price violates the item schema's invariant.
    expect(() =>
      f.service.createItem(
        validItemInput({ category: 'capture', shopRegions: ['waifu-valley'], buyPrice: null }),
      ),
    ).toThrow(AdminValidationError);
    expect(() => f.service.createItem(validItemInput({ category: 'weapon' }))).toThrow(
      AdminValidationError,
    );
    expect(f.readItems()).toEqual(before);
  });

  it('lists references and refuses to rename a referenced item', () => {
    expect(f.service.findItemReferences('basic_charm')).toContain('hunt.itemFind');
    expect(f.service.findItemReferences('basic_charm')).toContain('dailyPackage.items');

    let error: AdminValidationError | undefined;
    try {
      f.service.updateItem(
        'basic_charm',
        validItemInput({ slug: 'renamed_charm', name: 'Basic Charm', category: 'capture' }),
      );
    } catch (err) {
      error = err as AdminValidationError;
    }
    expect(error?.issues.join(' ')).toContain('still referenced by');
    expect(f.service.findItem('basic_charm')).toBeDefined();
  });

  it('allows disabling a referenced item instead of deleting it', () => {
    const { enabled } = f.service.toggleItemEnabled('basic_charm');
    expect(enabled).toBe(false);
    expect(f.service.validateContent().ok).toBe(true);
    expect(
      f.service.validateContent().warnings.some((w) => w.includes('disabled item "basic_charm"')),
    ).toBe(true);
  });
});

describe('tables writes', () => {
  it('saves a single section without disturbing the rest of the file', () => {
    const before = f.readTables();
    f.service.saveTablesSection('session', { inactiveTimeoutMinutes: 90 });
    const after = f.readTables();
    expect((after.session as { inactiveTimeoutMinutes: number }).inactiveTimeoutMinutes).toBe(90);
    expect(after.hunt).toEqual(before.hunt);
    expect(after.progression).toEqual(before.progression);
    expect(f.backups().some((b) => b.startsWith('tables-'))).toBe(true);
  });

  it('rejects an unknown section and a schema-invalid section', () => {
    const before = f.readTables();
    expect(() => f.service.saveTablesSection('nonsense', {})).toThrow(AdminValidationError);
    expect(() => f.service.saveTablesSection('session', { inactiveTimeoutMinutes: -5 })).toThrow(
      AdminValidationError,
    );
    expect(() => f.service.saveTablesSection('hunt', { cooldownSeconds: 5 })).toThrow(
      AdminValidationError,
    );
    expect(f.readTables()).toEqual(before);
  });

  it('rejects a hunt table that references an unknown item slug', () => {
    const before = f.readTables();
    const hunt = f.service.readRaw().tables.hunt;
    let error: AdminValidationError | undefined;
    try {
      f.service.saveTablesSection('hunt', {
        ...hunt,
        itemFind: { sub: [{ slug: 'ghost_charm', weight: 10, minQty: 1, maxQty: 1 }] },
      });
    } catch (err) {
      error = err as AdminValidationError;
    }
    expect(error?.issues.join(' ')).toContain('ghost_charm');
    expect(f.readTables()).toEqual(before);
  });

  it('rejects an entirely malformed tables document', () => {
    const before = f.readTables();
    expect(() => f.service.saveTables({ nope: true })).toThrow(AdminValidationError);
    expect(f.readTables()).toEqual(before);
  });
});

describe('path safety helpers', () => {
  it('accepts a normal relative asset path', () => {
    expect(() =>
      assertSafeRelativeAssetPath(f.assetsDir, 'waifumon/alley_catgirl/standard.png'),
    ).not.toThrow();
  });

  it('confines resolveWithinRoot to its root', () => {
    expect(resolveWithinRoot(f.assetsDir, 'waifumon/x.png')).toContain('waifumon');
    expect(resolveWithinRoot(f.assetsDir, '../secret.txt')).toBeNull();
    expect(resolveWithinRoot(f.assetsDir, '..')).toBeNull();
  });
});

/**
 * The admin panel edits the species the bot actually loads — which, since
 * expansion packs landed, means core content *plus* every enabled pack. The
 * two halves of that have to hold together: a pack that is live must be
 * editable, and a pack that is switched off must be invisible, or the panel
 * becomes a way to arm content nobody decided to ship.
 */
describe('expansion pack species', () => {
  function writeExpansion(
    id: string,
    opts: { enabled: boolean; slug: string; file?: string },
  ): string {
    const dir = path.join(f.contentDir, 'expansions', id);
    fs.mkdirSync(path.join(dir, 'species'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'expansion.json'),
      JSON.stringify({ id, name: id, enabled: opts.enabled }, null, 2),
    );
    const file = opts.file ?? 'locals.json';
    fs.writeFileSync(
      path.join(dir, 'species', file),
      JSON.stringify([validSpeciesInput({ slug: opts.slug })], null, 2),
    );
    return `expansions/${id}/species/${file}`;
  }

  it('reads species from an enabled pack, keyed by content-relative path', () => {
    const key = writeExpansion('twin_peaks', { enabled: true, slug: 'ridge_waitress' });
    const raw = f.service.readRaw();

    expect(raw.speciesFiles.map((g) => g.file)).toContain(key);
    expect(raw.species.map((s) => s.slug)).toContain('ridge_waitress');
    const group = raw.speciesFiles.find((g) => g.file === key)!;
    expect(group.expansionId).toBe('twin_peaks');
  });

  it('hides species from a disabled pack entirely', () => {
    const key = writeExpansion('shelved', { enabled: false, slug: 'shelved_girl' });
    const raw = f.service.readRaw();

    expect(raw.speciesFiles.map((g) => g.file)).not.toContain(key);
    expect(raw.species.map((s) => s.slug)).not.toContain('shelved_girl');
    expect(f.service.findSpecies('shelved_girl')).toBeUndefined();
    expect(f.service.listSpeciesFileNames()).not.toContain(key);
  });

  it('edits a pack species back into its own file, not into core content', () => {
    const key = writeExpansion('twin_peaks', { enabled: true, slug: 'ridge_waitress' });
    const found = f.service.findSpecies('ridge_waitress');
    expect(found?.file).toBe(key);

    const result = f.service.updateSpecies('ridge_waitress', {
      ...found!.species,
      name: 'Renamed In Pack',
    });
    expect(result.file).toBe(key);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(f.contentDir, key), 'utf8'),
    ) as Array<{ slug: string; name: string }>;
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.name).toBe('Renamed In Pack');
    expect(f.readSpecies('starter.json').length).toBeGreaterThan(0);
  });

  it('validates a pack edit against the whole merged registry', () => {
    // A pack species renamed onto a core slug must be refused — the panel now
    // holds both halves of the registry, so it is the layer that can see it.
    writeExpansion('twin_peaks', { enabled: true, slug: 'ridge_waitress' });
    const found = f.service.findSpecies('ridge_waitress')!;
    expect(() =>
      f.service.updateSpecies('ridge_waitress', { ...found.species, slug: 'alley_catgirl' }),
    ).toThrow(AdminValidationError);
  });

  it('appends a new species into an existing enabled pack file', () => {
    const key = writeExpansion('twin_peaks', { enabled: true, slug: 'ridge_waitress' });
    f.service.createSpecies(validSpeciesInput({ slug: 'ridge_mechanic' }), key);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(f.contentDir, key), 'utf8'),
    ) as Array<{ slug: string }>;
    expect(onDisk.map((s) => s.slug)).toEqual(['ridge_waitress', 'ridge_mechanic']);
  });

  it('refuses to create into a disabled pack', () => {
    // The orphan guard, at the write end: a crafted `__file` must not be able
    // to drop a species into content that is switched off.
    const key = writeExpansion('shelved', { enabled: false, slug: 'shelved_girl' });
    expect(() => f.service.createSpecies(validSpeciesInput({ slug: 'sneaky' }), key)).toThrow(
      AdminValidationError,
    );
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(f.contentDir, key), 'utf8'),
    ) as Array<{ slug: string }>;
    expect(onDisk.map((s) => s.slug)).toEqual(['shelved_girl']);
  });

  it.each([
    ['../escape.json'],
    ['species/../../escape.json'],
    ['/etc/passwd.json'],
    ['expansions/nonexistent/species/x.json'],
  ])('refuses the out-of-bounds create target %s', (target) => {
    expect(() => f.service.createSpecies(validSpeciesInput({ slug: 'sneaky' }), target)).toThrow(
      AdminValidationError,
    );
  });
});
