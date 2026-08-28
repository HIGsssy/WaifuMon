/**
 * Boss content — the shipped ten, and every validation rule that protects them.
 *
 * The invalid cases are written against a *throwaway copy* of the real content
 * tree (the `createAdminFixture` pattern) so they exercise the shipped schemas
 * and cross-references without ever writing to `content/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadContent,
  readContentFiles,
  validateBossAssets,
  validateBossContent,
  validateContentSet,
} from '../../src/modules/content/loader';
import {
  BossContentSchema,
  BossEncountersConfigSchema,
  type BossContent,
} from '../../src/modules/content/schemas';
import { ContentValidationError } from '../../src/shared/errors';
import { AFFINITIES } from '../../src/db/schema';
import { REGIONS } from '../../src/modules/bosses/regions';
import { silentLogger } from '../helpers/testDb';
import { ASSETS_DIR, CONTENT_DIR, loadShippedContent } from '../helpers/fixtures';

const logger = silentLogger();
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A writable copy of the real content tree, plus an empty assets root. */
function contentCopy(): { contentDir: string; assetsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-boss-'));
  tempRoots.push(root);
  const contentDir = path.join(root, 'content');
  const assetsDir = path.join(root, 'assets');
  fs.mkdirSync(path.join(contentDir, 'species'), { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const file of ['items.json', 'tables.json', 'bosses.json']) {
    fs.copyFileSync(path.join(CONTENT_DIR, file), path.join(contentDir, file));
  }
  for (const file of fs.readdirSync(path.join(CONTENT_DIR, 'species'))) {
    if (file.endsWith('.json')) {
      fs.copyFileSync(
        path.join(CONTENT_DIR, 'species', file),
        path.join(contentDir, 'species', file),
      );
    }
  }
  return { contentDir, assetsDir };
}

function writeBosses(contentDir: string, bosses: unknown): void {
  fs.writeFileSync(
    path.join(contentDir, 'bosses.json'),
    `${JSON.stringify(bosses, null, 2)}\n`,
    'utf8',
  );
}

function readTables(contentDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(contentDir, 'tables.json'), 'utf8'));
}

function writeTables(contentDir: string, tables: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(contentDir, 'tables.json'),
    `${JSON.stringify(tables, null, 2)}\n`,
    'utf8',
  );
}

/** Read a candidate content set and run the full cross-file validation on it. */
function validateCopy(contentDir: string): void {
  validateContentSet(readContentFiles(contentDir));
}

// ── shipped content ─────────────────────────────────────────────────────────

describe('shipped bosses', () => {
  const content = loadShippedContent();

  it('ships exactly ten definitions', () => {
    expect(content.bosses).toHaveLength(10);
  });

  it('ships exactly two bosses per affinity', () => {
    for (const affinity of AFFINITIES) {
      const matching = content.bosses.filter((b) => b.affinity === affinity);
      expect(matching, `affinity ${affinity}`).toHaveLength(2);
    }
  });

  it('gives every boss a unique id', () => {
    const ids = content.bosses.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('enables every shipped boss and puts them all in a canonical region', () => {
    for (const boss of content.bosses) {
      expect(boss.enabled).toBe(true);
      expect(REGIONS).toContain(boss.region);
    }
  });

  it('gives every boss all four pieces of player-facing text', () => {
    for (const boss of content.bosses) {
      for (const field of [
        'description',
        'scoutingText',
        'repelledText',
        'unchallengedText',
      ] as const) {
        expect(boss[field].length, `${boss.id}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('points every boss at a reward table that exists', () => {
    const tables = content.tables.bossEncounters.rewardTables;
    for (const boss of content.bosses) {
      expect(Object.keys(tables), boss.id).toContain(boss.rewardTable);
    }
  });

  it('ships standard-scouting-v1 with the documented payouts', () => {
    const table = content.tables.bossEncounters.rewardTables['standard-scouting-v1'];
    expect(table).toBeDefined();
    expect(table!.buddyXp).toBe(15);
    expect(table!.jackpot).toEqual({ slug: 'mythic_contract', quantity: 1, chance: 0.0025 });
    // Weights sum to 10,000 so each one reads directly as a basis-point share —
    // the same convention `affectionGifts.lootTable` uses.
    expect(table!.minorItems.reduce((sum, e) => sum + e.weight, 0)).toBe(10_000);
  });

  it('names only canonical, enabled items in every shipped reward table', () => {
    // The loader *tolerates* a disabled reward item; shipped content should
    // never lean on that tolerance, which is what this asserts.
    const enabled = new Set(content.items.filter((i) => i.enabled).map((i) => i.slug));
    for (const table of Object.values(content.tables.bossEncounters.rewardTables)) {
      for (const entry of table.minorItems) expect(enabled).toContain(entry.slug);
      if (table.jackpot) expect(enabled).toContain(table.jackpot.slug);
    }
  });

  it('has at least one enabled boss for every enabled region', () => {
    for (const region of content.tables.bossEncounters.regions) {
      expect(content.bosses.some((b) => b.enabled && b.region === region)).toBe(true);
    }
  });

  it('ships the documented timings', () => {
    const cfg = content.tables.bossEncounters;
    expect(cfg.scoutingMinutes).toBe(60);
    expect(cfg.downtimeMinutesMin).toBe(120);
    expect(cfg.downtimeMinutesMax).toBe(300);
    expect(cfg.attacksPerParticipation).toBe(10);
    expect(cfg.performanceMinPercent).toBe(85);
    expect(cfg.performanceMaxPercent).toBe(115);
  });
});

// ── per-entry schema ────────────────────────────────────────────────────────

describe('boss definition schema', () => {
  const valid: Record<string, unknown> = {
    id: 'test_boss',
    name: 'Test Boss',
    affinity: 'dominant',
    region: 'waifu-valley',
    enabled: true,
    artwork: 'bosses/test.webp',
    rewardTable: 'standard-scouting-v1',
    scoutingText: 'It arrives.',
    repelledText: 'It leaves.',
    unchallengedText: 'It shrugs.',
    description: 'A test.',
  };

  it('accepts a well-formed definition', () => {
    expect(BossContentSchema.parse(valid).id).toBe('test_boss');
  });

  it('rejects a non-canonical affinity', () => {
    expect(() => BossContentSchema.parse({ ...valid, affinity: 'tsundere' })).toThrow();
  });

  it('rejects a non-canonical region', () => {
    expect(() => BossContentSchema.parse({ ...valid, region: 'neon-city' })).toThrow();
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent-directory escape', '../../secrets.webp'],
    ['a nested escape', 'bosses/../../secrets.webp'],
    ['a Windows drive letter', 'C:/secrets.webp'],
    ['a backslash separator', 'bosses\\test.webp'],
  ])('rejects %s in artwork', (_label, artwork) => {
    expect(() => BossContentSchema.parse({ ...valid, artwork })).toThrow();
  });

  it('allows artwork to be omitted entirely', () => {
    const { artwork: _omitted, ...withoutArtwork } = valid;
    expect(BossContentSchema.parse(withoutArtwork).artwork).toBeNull();
  });

  it.each(['scoutingText', 'repelledText', 'unchallengedText', 'description'])(
    'requires %s',
    (field) => {
      expect(() => BossContentSchema.parse({ ...valid, [field]: '   ' })).toThrow();
    },
  );

  it('rejects an unknown key rather than ignoring it', () => {
    // A misspelled `repelledText` would otherwise ship as missing prose.
    expect(() => BossContentSchema.parse({ ...valid, repeledText: 'oops' })).toThrow();
  });
});

// ── tuning block ────────────────────────────────────────────────────────────

describe('bossEncounters config schema', () => {
  const minimal = {
    rewardTables: {
      't1': {
        version: 'v1',
        buddyXp: 10,
        minorItems: [{ slug: 'basic_charm', quantity: 1, weight: 1 }],
      },
    },
  };

  it('defaults the wheel, timings and brackets to the shipped values', () => {
    const parsed = BossEncountersConfigSchema.parse(minimal);
    expect(parsed.scoutingMinutes).toBe(60);
    expect(parsed.affinityWheel.dominant).toBe('switch');
    expect(parsed.responseBrackets).toHaveLength(2);
  });

  it('rejects a downtime band whose max is below its min', () => {
    expect(() =>
      BossEncountersConfigSchema.parse({
        ...minimal,
        downtimeMinutesMin: 300,
        downtimeMinutesMax: 120,
      }),
    ).toThrow();
  });

  it('rejects unsorted response brackets', () => {
    expect(() =>
      BossEncountersConfigSchema.parse({
        ...minimal,
        responseBrackets: [
          { withinMinutes: 30, bonus: 0.02 },
          { withinMinutes: 15, bonus: 0.05 },
        ],
      }),
    ).toThrow();
  });

  it('rejects a bracket that reaches past the scouting window', () => {
    expect(() =>
      BossEncountersConfigSchema.parse({
        ...minimal,
        scoutingMinutes: 60,
        responseBrackets: [{ withinMinutes: 90, bonus: 0.05 }],
      }),
    ).toThrow();
  });

  it('rejects an empty reward-table map while enabled', () => {
    expect(() => BossEncountersConfigSchema.parse({ enabled: true, rewardTables: {} })).toThrow();
  });

  it('rejects a jackpot chance above the hard cap', () => {
    expect(() =>
      BossEncountersConfigSchema.parse({
        rewardTables: {
          t1: {
            ...minimal.rewardTables.t1,
            jackpot: { slug: 'mythic_contract', chance: 0.5 },
          },
        },
      }),
    ).toThrow();
  });

  it('allows the same item at two different quantities', () => {
    // "2× Basic Charm" and "3× Basic Charm" are two drops, not a duplicate.
    expect(() =>
      BossEncountersConfigSchema.parse({
        rewardTables: {
          t1: {
            version: 'v1',
            buddyXp: 0,
            minorItems: [
              { slug: 'basic_charm', quantity: 2, weight: 1 },
              { slug: 'basic_charm', quantity: 3, weight: 1 },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  it('rejects the identical drop listed twice', () => {
    expect(() =>
      BossEncountersConfigSchema.parse({
        rewardTables: {
          t1: {
            version: 'v1',
            buddyXp: 0,
            minorItems: [
              { slug: 'basic_charm', quantity: 2, weight: 1 },
              { slug: 'basic_charm', quantity: 2, weight: 5 },
            ],
          },
        },
      }),
    ).toThrow();
  });
});

// ── cross-file validation ───────────────────────────────────────────────────

describe('cross-file boss validation', () => {
  it('accepts the shipped content set unchanged', () => {
    const { contentDir } = contentCopy();
    expect(() => validateCopy(contentDir)).not.toThrow();
  });

  it('rejects duplicate boss ids', () => {
    const { contentDir } = contentCopy();
    const bosses = JSON.parse(
      fs.readFileSync(path.join(contentDir, 'bosses.json'), 'utf8'),
    ) as BossContent[];
    writeBosses(contentDir, [...bosses, { ...bosses[0] }]);
    expect(() => validateCopy(contentDir)).toThrow(/Duplicate boss id: oh_pwincess/);
  });

  it('rejects a boss pointing at a reward table that does not exist', () => {
    const { contentDir } = contentCopy();
    const bosses = JSON.parse(
      fs.readFileSync(path.join(contentDir, 'bosses.json'), 'utf8'),
    ) as BossContent[];
    bosses[0]!.rewardTable = 'legendary-scouting-v9';
    writeBosses(contentDir, bosses);
    expect(() => validateCopy(contentDir)).toThrow(/unknown reward table: legendary-scouting-v9/);
  });

  it('rejects a reward table naming an item that does not exist', () => {
    const { contentDir } = contentCopy();
    const tables = readTables(contentDir);
    const boss = tables.bossEncounters as Record<string, unknown>;
    (boss.rewardTables as Record<string, { minorItems: { slug: string }[] }>)[
      'standard-scouting-v1'
    ]!.minorItems[0]!.slug = 'cherries';
    writeTables(contentDir, tables);
    expect(() => validateCopy(contentDir)).toThrow(/unknown item slug: cherries/);
  });

  it('allows a reward table naming a disabled item', () => {
    // Deliberately *not* fatal, unlike the affection-gift loot table. A boss
    // reward is resolved from the live `items` row inside the payout
    // transaction, so a disabled item is still deliverable — whereas a gift
    // freezes its slug at generation time and could mint something
    // unclaimable. Disabling rather than deleting is the admin panel's
    // documented affordance, and it has to keep working for any item a boss
    // happens to drop; the panel raises a warning instead.
    const { contentDir } = contentCopy();
    const items = JSON.parse(fs.readFileSync(path.join(contentDir, 'items.json'), 'utf8')) as {
      items: { slug: string; enabled: boolean }[];
    };
    items.items.find((i) => i.slug === 'basic_charm')!.enabled = false;
    fs.writeFileSync(
      path.join(contentDir, 'items.json'),
      `${JSON.stringify(items, null, 2)}\n`,
      'utf8',
    );
    expect(() => validateCopy(contentDir)).not.toThrow();
  });

  it('accepts a content set that carries no boss content at all', () => {
    // `bosses.json` is optional on disk, so a set without it is a legitimate
    // configuration — an appearance-sync working directory and an admin-panel
    // candidate set both look like this. Rejecting it would make an optional
    // file mandatory by the back door.
    const { contentDir } = contentCopy();
    writeBosses(contentDir, []);
    expect(() => validateCopy(contentDir)).not.toThrow();
  });

  it('rejects an enabled region whose authored bosses are all disabled', () => {
    const { contentDir } = contentCopy();
    const bosses = (
      JSON.parse(fs.readFileSync(path.join(contentDir, 'bosses.json'), 'utf8')) as BossContent[]
    ).map((b) => ({ ...b, enabled: false }));
    writeBosses(contentDir, bosses);
    expect(() => validateCopy(contentDir)).toThrow(/no enabled boss belongs to it/);
  });

  it('allows an empty boss roster when the feature is switched off', () => {
    const { contentDir } = contentCopy();
    writeBosses(contentDir, []);
    const tables = readTables(contentDir);
    (tables.bossEncounters as Record<string, unknown>).enabled = false;
    writeTables(contentDir, tables);
    expect(() => validateCopy(contentDir)).not.toThrow();
  });

  it('loads with no bosses at all when bosses.json is absent', () => {
    const { contentDir } = contentCopy();
    fs.rmSync(path.join(contentDir, 'bosses.json'));
    const tables = readTables(contentDir);
    (tables.bossEncounters as Record<string, unknown>).enabled = false;
    writeTables(contentDir, tables);
    expect(readContentFiles(contentDir).bosses).toEqual([]);
  });

  it('rejects a jackpot slug that does not exist', () => {
    const { contentDir } = contentCopy();
    const tables = readTables(contentDir);
    const cfg = tables.bossEncounters as Record<string, unknown>;
    (cfg.rewardTables as Record<string, { jackpot: { slug: string } }>)[
      'standard-scouting-v1'
    ]!.jackpot.slug = 'legendary_contract';
    writeTables(contentDir, tables);
    expect(() => validateCopy(contentDir)).toThrow(/jackpot references unknown item slug/);
  });

  it('is callable on its own for a candidate set', () => {
    const content = loadShippedContent();
    expect(() => validateBossContent(content)).not.toThrow();
    expect(() =>
      validateBossContent({ ...content, bosses: [content.bosses[0]!, content.bosses[0]!] }),
    ).toThrow(ContentValidationError);
  });
});

// ── artwork degradation ─────────────────────────────────────────────────────

describe('missing artwork degrades rather than disabling the boss', () => {
  it('nulls the path and keeps the boss enabled', () => {
    const content = loadShippedContent();
    const checked = validateBossAssets(content.bosses, ASSETS_DIR, logger);
    // No boss artwork ships yet, so every entry degrades — and every entry
    // stays enabled and fully playable.
    expect(checked).toHaveLength(content.bosses.length);
    for (const boss of checked) {
      expect(boss.enabled).toBe(true);
      expect(boss.artwork).toBeNull();
    }
  });

  it('keeps the path when the file is actually present', () => {
    const { assetsDir } = contentCopy();
    fs.mkdirSync(path.join(assetsDir, 'bosses'), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'bosses', 'present.webp'), 'not-really-a-webp');
    const boss = BossContentSchema.parse({
      id: 'present_boss',
      name: 'Present',
      affinity: 'primal',
      region: 'waifu-valley',
      artwork: 'bosses/present.webp',
      rewardTable: 'standard-scouting-v1',
      scoutingText: 'x',
      repelledText: 'x',
      unchallengedText: 'x',
      description: 'x',
    });
    expect(validateBossAssets([boss], assetsDir, logger)[0]!.artwork).toBe(
      'bosses/present.webp',
    );
  });

  it('a full load of the shipped tree still yields ten usable bosses', () => {
    const loaded = loadContent(CONTENT_DIR, ASSETS_DIR, logger);
    expect(loaded.bosses.filter((b) => b.enabled)).toHaveLength(10);
  });
});
