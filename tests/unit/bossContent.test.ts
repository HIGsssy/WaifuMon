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
  BossRewardsFileSchema,
  type BossContent,
  type BossRewardTable,
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
  for (const file of ['items.json', 'tables.json', 'bosses.json', 'bossRewards.json']) {
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

function readRewards(contentDir: string): BossRewardTable[] {
  return JSON.parse(fs.readFileSync(path.join(contentDir, 'bossRewards.json'), 'utf8'));
}

function writeRewards(contentDir: string, tables: unknown): void {
  fs.writeFileSync(
    path.join(contentDir, 'bossRewards.json'),
    `${JSON.stringify(tables, null, 2)}\n`,
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

  it('points every boss at a reward table that exists in bossRewards.json', () => {
    const ids = content.bossRewards.map((t) => t.id);
    for (const boss of content.bosses) {
      expect(ids, boss.id).toContain(boss.rewardTable);
    }
  });

  it('keeps reward tables out of tables.json entirely', () => {
    // Boss loot is independently editable in its own file. A `rewardTables`
    // key surviving in `tables.json` would be silently ignored, which is worse
    // than absent — an operator would edit it and see nothing change.
    expect(content.tables.bossEncounters).not.toHaveProperty('rewardTables');
  });

  it('names only canonical, enabled items in every shipped reward table', () => {
    // The loader *tolerates* a retired reward item; shipped content should
    // never lean on that tolerance, which is what this asserts.
    const enabled = new Set(content.items.filter((i) => i.enabled).map((i) => i.slug));
    for (const table of content.bossRewards) {
      for (const group of table.groups) {
        for (const entry of group.entries) expect(enabled).toContain(entry.itemId);
      }
    }
  });

  it('has at least one drawable boss for every enabled region', () => {
    const tables = new Map(content.bossRewards.map((t) => [t.id, t]));
    for (const region of content.tables.bossEncounters.regions) {
      expect(
        content.bosses.some(
          (b) => b.enabled && b.region === region && tables.get(b.rewardTable)?.enabled,
        ),
      ).toBe(true);
    }
  });

  it('ships the documented timings', () => {
    const cfg = content.tables.bossEncounters;
    expect(cfg.scoutingMinutes).toBe(30);
    expect(cfg.downtimeMinutesMin).toBe(10);
    expect(cfg.downtimeMinutesMax).toBe(35);
    expect(cfg.attacksPerParticipation).toBe(10);
    expect(cfg.performanceMinPercent).toBe(85);
    expect(cfg.performanceMaxPercent).toBe(115);
  });

  it('ships the documented rapid-response brackets, sized to the window', () => {
    const cfg = content.tables.bossEncounters;
    expect(cfg.responseBrackets).toEqual([
      { withinMinutes: 10, bonus: 0.05 },
      { withinMinutes: 20, bonus: 0.02 },
    ]);
    // The last bracket must land inside the window, or the final tier is dead
    // configuration.
    expect(cfg.responseBrackets.at(-1)!.withinMinutes).toBeLessThan(cfg.scoutingMinutes);
  });

  it('ships a cycle of roughly 40-65 minutes', () => {
    const cfg = content.tables.bossEncounters;
    expect(cfg.scoutingMinutes + cfg.downtimeMinutesMin).toBe(40);
    expect(cfg.scoutingMinutes + cfg.downtimeMinutesMax).toBe(65);
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
  // Everything is defaulted now that payouts live in their own file, so the
  // minimal tuning block is genuinely empty.
  const minimal = {};

  it('defaults the wheel, timings and brackets to the shipped values', () => {
    const parsed = BossEncountersConfigSchema.parse(minimal);
    expect(parsed.scoutingMinutes).toBe(30);
    expect(parsed.downtimeMinutesMin).toBe(10);
    expect(parsed.downtimeMinutesMax).toBe(35);
    expect(parsed.affinityWheel.dominant).toBe('switch');
    expect(parsed.responseBrackets).toEqual([
      { withinMinutes: 10, bonus: 0.05 },
      { withinMinutes: 20, bonus: 0.02 },
    ]);
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

  it('ignores a stray rewardTables key rather than accepting it as config', () => {
    // Payouts moved to `content/bossRewards.json`. The tuning block strips the
    // key, which is what the shipped-content test above asserts is gone.
    const parsed = BossEncountersConfigSchema.parse({ ...minimal, rewardTables: { t1: {} } });
    expect(parsed).not.toHaveProperty('rewardTables');
  });

  it('accepts an enabled config with no reward map, because there is no map', () => {
    expect(() => BossEncountersConfigSchema.parse({ enabled: true })).not.toThrow();
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

  it('rejects a reward entry naming an item that does not exist', () => {
    const { contentDir } = contentCopy();
    const rewards = readRewards(contentDir);
    rewards[0]!.groups[0]!.entries[0]!.itemId = 'cherries';
    writeRewards(contentDir, rewards);
    expect(() => validateCopy(contentDir)).toThrow(/unknown item slug: cherries/);
  });

  it('names the group and table when a reward entry is invalid', () => {
    const { contentDir } = contentCopy();
    const rewards = readRewards(contentDir);
    rewards[0]!.groups[1]!.entries[0]!.itemId = 'legendary_contract';
    writeRewards(contentDir, rewards);
    expect(() => validateCopy(contentDir)).toThrow(
      /bossRewards\["standard-scouting-v1"\]\.groups\["rare-bonus"\]/,
    );
  });

  it('names the known tables when a boss points at a missing one', () => {
    const { contentDir } = contentCopy();
    const bosses = JSON.parse(
      fs.readFileSync(path.join(contentDir, 'bosses.json'), 'utf8'),
    ) as BossContent[];
    bosses[0]!.rewardTable = 'nope-v1';
    writeBosses(contentDir, bosses);
    // Actionable: the message says where to add it and what already exists.
    expect(() => validateCopy(contentDir)).toThrow(/content\/bossRewards\.json/);
    expect(() => validateCopy(contentDir)).toThrow(/standard-scouting-v1/);
  });

  it('rejects a disabled reward table that leaves a region undrawable', () => {
    const { contentDir } = contentCopy();
    const rewards = readRewards(contentDir);
    rewards[0]!.enabled = false;
    writeRewards(contentDir, rewards);
    expect(() => validateCopy(contentDir)).toThrow(
      /points at a disabled reward table|disabled reward table/,
    );
    // And it names the table to re-enable, not just the region.
    expect(() => validateCopy(contentDir)).toThrow(/standard-scouting-v1/);
  });

  it('accepts a disabled reward table while another keeps the region drawable', () => {
    const { contentDir } = contentCopy();
    const rewards = readRewards(contentDir);
    // A second, enabled table; move one boss onto it, then switch the first off.
    rewards.push({ ...rewards[0]!, id: 'backup-v1', enabled: true });
    rewards[0]!.enabled = false;
    writeRewards(contentDir, rewards);
    const bosses = JSON.parse(
      fs.readFileSync(path.join(contentDir, 'bosses.json'), 'utf8'),
    ) as BossContent[];
    bosses[0]!.rewardTable = 'backup-v1';
    writeBosses(contentDir, bosses);
    expect(() => validateCopy(contentDir)).not.toThrow();
  });

  it('rejects a bossRewards file with duplicate table ids', () => {
    const { contentDir } = contentCopy();
    const rewards = readRewards(contentDir);
    writeRewards(contentDir, [...rewards, rewards[0]]);
    expect(() => validateCopy(contentDir)).toThrow(/two tables with id/);
  });

  it('loads an empty reward list when bossRewards.json is absent', () => {
    const { contentDir } = contentCopy();
    fs.rmSync(path.join(contentDir, 'bossRewards.json'));
    writeBosses(contentDir, []);
    const tables = readTables(contentDir);
    (tables.bossEncounters as Record<string, unknown>).enabled = false;
    writeTables(contentDir, tables);
    expect(readContentFiles(contentDir).bossRewards).toEqual([]);
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

  it('picks up an on-disk reward edit on the next load, with no restart needed', () => {
    // `bossRewards.json` is read by `readContentFiles`, which is what the admin
    // panel's Reload Content calls — the same rule `bosses.json` follows, and
    // the reason payouts do not live in `tables.json` (whose values are
    // captured by service closures at construction).
    const { contentDir } = contentCopy();
    const before = readContentFiles(contentDir).bossRewards[0]!;
    expect(before.groups[0]!.entries[0]!.enabled).toBe(true);

    const rewards = readRewards(contentDir);
    rewards[0]!.groups[0]!.entries[0]!.enabled = false;
    rewards[0]!.buddyXp = 99;
    writeRewards(contentDir, rewards);

    const after = readContentFiles(contentDir).bossRewards[0]!;
    expect(after.groups[0]!.entries[0]!.enabled).toBe(false);
    expect(after.buddyXp).toBe(99);
  });

  it('rejects an invalid reward edit so a bad reload cannot land', () => {
    const { contentDir } = contentCopy();
    const rewards = readRewards(contentDir);
    rewards[0]!.groups[0]!.entries[0]!.weight = 0;
    writeRewards(contentDir, rewards);
    expect(() => readContentFiles(contentDir)).toThrow(/bossRewards\.json/);
  });

  it('parses the shipped bossRewards.json against its own schema', () => {
    const { contentDir } = contentCopy();
    const result = BossRewardsFileSchema.safeParse(readRewards(contentDir));
    expect(result.success).toBe(true);
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
