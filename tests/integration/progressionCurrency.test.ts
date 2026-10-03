/**
 * The progression currency against a real database: editable display
 * metadata on a stable key, integer balances that cannot go negative, grants
 * and spends that are transactional, ledgered and idempotent, and no way for
 * inventory or shop flows to reach the balance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  items,
  playerProgressionBalances,
  progressionCurrencies,
  progressionCurrencyLedger,
} from '../../src/db/schema';
import {
  createProgressionCurrencyService,
  formatProgressionAmount,
  type ProgressionCurrencyService,
} from '../../src/modules/progressionCurrency/progressionCurrencyService';
import {
  InsufficientProgressionCurrencyError,
  PlayerNotFoundError,
  ProgressionCurrencyDisabledError,
  ProgressionCurrencyInvalidError,
  ProgressionCurrencyNotFoundError,
  ProgressionCurrencyRequestConflictError,
  ProgressionCurrencyStaleError,
} from '../../src/shared/errors';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const KEY = 'ascension_currency';
let t: TestDb;
let app: App;
let currencies: ProgressionCurrencyService;
let users = 0;
const newPlayer = async () => (await provisionPlayer(app, 'g-prog', `u-${++users}`)).playerId;
const change = (playerId: number, amount: number, extra: Record<string, unknown> = {}) => ({
  playerId,
  currencyKey: KEY,
  amount,
  reason: 'test',
  ...extra,
});

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  currencies = createProgressionCurrencyService(t.db);
});
afterAll(async () => {
  await t.cleanup();
});

describe('metadata', () => {
  it('ships one currency under a stable key with working display names', async () => {
    const list = await currencies.list();
    expect(list.map((c) => c.key)).toEqual([KEY]);
    expect(list[0]).toMatchObject({ enabled: true, revision: 1 });
    expect(list[0]!.singularName).not.toBe(list[0]!.pluralName);
  });

  it('renames the currency without changing its key, and uses singular and plural names', async () => {
    const before = (await currencies.get(KEY))!;
    const updated = await currencies.updateMetadata(
      KEY,
      {
        metadata: { singularName: 'Star Shard', pluralName: 'Star Shards', description: 'Shiny.', icon: '✨', enabled: true },
        expectedRevision: before.revision,
      },
      'admin-1',
    );
    expect(updated).toMatchObject({
      key: KEY,
      singularName: 'Star Shard',
      pluralName: 'Star Shards',
      icon: '✨',
      revision: before.revision + 1,
      updatedBy: 'admin-1',
    });
    expect(formatProgressionAmount(updated!, 1)).toBe('✨ 1 Star Shard');
    expect(formatProgressionAmount(updated!, 12)).toBe('✨ 12 Star Shards');
    expect(formatProgressionAmount({ ...updated!, icon: null }, 0)).toBe('0 Star Shards');
    expect((await currencies.list()).map((c) => c.key)).toEqual([KEY]);
  });

  it('keeps balances attached to the key across a rename', async () => {
    const playerId = await newPlayer();
    await currencies.grant(t.db, change(playerId, 7));
    const current = (await currencies.get(KEY))!;
    await currencies.updateMetadata(
      KEY,
      { metadata: { singularName: 'Ember', pluralName: 'Embers', enabled: true }, expectedRevision: current.revision },
      null,
    );
    expect(await currencies.getBalance(playerId, KEY)).toBe(7);
  });

  it('cannot change the key: it is not an editable field', async () => {
    const current = (await currencies.get(KEY))!;
    for (const field of ['key', 'currencyKey']) {
      await expect(
        currencies.updateMetadata(
          KEY,
          {
            metadata: { singularName: 'A', pluralName: 'As', enabled: true, [field]: 'renamed' },
            expectedRevision: current.revision,
          },
          null,
        ),
      ).rejects.toBeInstanceOf(ProgressionCurrencyInvalidError);
    }
    expect((await currencies.get(KEY))!.revision).toBe(current.revision);
    expect(await currencies.get('renamed')).toBeNull();
  });

  it('refuses a stale save, an empty name and an unknown key', async () => {
    const current = (await currencies.get(KEY))!;
    const metadata = { singularName: 'A', pluralName: 'As', enabled: true };
    await expect(
      currencies.updateMetadata(KEY, { metadata, expectedRevision: current.revision - 1 }, null),
    ).rejects.toBeInstanceOf(ProgressionCurrencyStaleError);
    await expect(
      currencies.updateMetadata(KEY, { metadata: { ...metadata, singularName: '  ' }, expectedRevision: current.revision }, null),
    ).rejects.toBeInstanceOf(ProgressionCurrencyInvalidError);
    expect(await currencies.updateMetadata('nope', { metadata, expectedRevision: 1 }, null)).toBeNull();
  });
});

describe('balances', () => {
  it('is zero for a player who has never been granted any, with no row', async () => {
    const playerId = await newPlayer();
    expect(await currencies.getBalance(playerId, KEY)).toBe(0);
    const rows = await t.db.select().from(playerProgressionBalances).where(eq(playerProgressionBalances.playerId, playerId));
    expect(rows).toEqual([]);
  });

  it('grants and spends, writing one ledger row per change', async () => {
    const playerId = await newPlayer();
    expect((await currencies.grant(t.db, change(playerId, 30, { sourceRef: 'dungeon_run:1' }))).balance).toBe(30);
    expect((await currencies.spend(t.db, change(playerId, 12))).balance).toBe(18);
    expect(await currencies.getBalance(playerId, KEY)).toBe(18);
    const ledger = await t.db
      .select()
      .from(progressionCurrencyLedger)
      .where(eq(progressionCurrencyLedger.playerId, playerId))
      .orderBy(progressionCurrencyLedger.id);
    expect(ledger.map((l) => [l.delta, l.balanceAfter, l.sourceRef])).toEqual([
      [30, 30, 'dungeon_run:1'],
      [-12, 18, null],
    ]);
  });

  it('refuses an overspend, leaves the balance alone and writes no ledger row', async () => {
    const playerId = await newPlayer();
    await currencies.grant(t.db, change(playerId, 5));
    await expect(currencies.spend(t.db, change(playerId, 6))).rejects.toBeInstanceOf(InsufficientProgressionCurrencyError);
    await expect(currencies.spend(t.db, change(await newPlayer(), 1))).rejects.toBeInstanceOf(
      InsufficientProgressionCurrencyError,
    );
    expect(await currencies.getBalance(playerId, KEY)).toBe(5);
    const ledger = await t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId));
    expect(ledger).toHaveLength(1);
  });

  it('accepts only positive integers', async () => {
    const playerId = await newPlayer();
    for (const amount of [0, -3, 1.5, Number.NaN, 2_000_000_000]) {
      await expect(currencies.grant(t.db, change(playerId, amount))).rejects.toBeInstanceOf(RangeError);
      await expect(currencies.spend(t.db, change(playerId, amount))).rejects.toBeInstanceOf(RangeError);
    }
    expect(await currencies.getBalance(playerId, KEY)).toBe(0);
  });

  it('cannot be driven negative even by a direct write', async () => {
    const playerId = await newPlayer();
    await currencies.grant(t.db, change(playerId, 1));
    await expect(
      t.db
        .update(playerProgressionBalances)
        .set({ balance: -1 })
        .where(eq(playerProgressionBalances.playerId, playerId)),
    ).rejects.toThrow();
  });

  it('never goes negative under concurrent spends', async () => {
    const playerId = await newPlayer();
    await currencies.grant(t.db, change(playerId, 100));
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => t.db.transaction((tx) => currencies.spend(tx, change(playerId, 40)))),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await currencies.getBalance(playerId, KEY)).toBe(20);
  });

  it('loses no grant under concurrency, including the first for a player', async () => {
    const playerId = await newPlayer();
    await Promise.all(
      Array.from({ length: 8 }, () => t.db.transaction((tx) => currencies.grant(tx, change(playerId, 5)))),
    );
    expect(await currencies.getBalance(playerId, KEY)).toBe(40);
  });

  it('rolls back with the surrounding transaction', async () => {
    const playerId = await newPlayer();
    await expect(
      t.db.transaction(async (tx) => {
        await currencies.grant(tx, change(playerId, 50));
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await currencies.getBalance(playerId, KEY)).toBe(0);
    const ledger = await t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId));
    expect(ledger).toEqual([]);
  });

  it('replays a repeated request key instead of paying twice, and refuses a reused key for a different change', async () => {
    const playerId = await newPlayer();
    const first = await currencies.grant(t.db, change(playerId, 9, { requestKey: 'run-1-extract' }));
    const again = await currencies.grant(t.db, change(playerId, 9, { requestKey: 'run-1-extract' }));
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, balance: 9, ledgerId: first.ledgerId });
    await expect(currencies.grant(t.db, change(playerId, 10, { requestKey: 'run-1-extract' }))).rejects.toBeInstanceOf(
      ProgressionCurrencyRequestConflictError,
    );
    const racing = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.db.transaction((tx) => currencies.grant(tx, change(playerId, 4, { requestKey: 'run-2-extract' }))),
      ),
    );
    expect(racing.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await currencies.getBalance(playerId, KEY)).toBe(13);
  });

  it('refuses an unknown currency and an unknown player', async () => {
    const playerId = await newPlayer();
    await expect(currencies.grant(t.db, { ...change(playerId, 1), currencyKey: 'doubloons' })).rejects.toBeInstanceOf(
      ProgressionCurrencyNotFoundError,
    );
    await expect(currencies.grant(t.db, change(999_999, 1))).rejects.toBeInstanceOf(PlayerNotFoundError);
  });

  it('pays nothing while the currency is disabled, but still lets a balance be spent', async () => {
    const playerId = await newPlayer();
    await currencies.grant(t.db, change(playerId, 10));
    await t.db.update(progressionCurrencies).set({ enabled: false }).where(eq(progressionCurrencies.currencyKey, KEY));
    try {
      await expect(currencies.grant(t.db, change(playerId, 1))).rejects.toBeInstanceOf(ProgressionCurrencyDisabledError);
      expect((await currencies.spend(t.db, change(playerId, 4))).balance).toBe(6);
    } finally {
      await t.db.update(progressionCurrencies).set({ enabled: true }).where(eq(progressionCurrencies.currencyKey, KEY));
    }
  });
});

describe('isolation from other resources', () => {
  it('is queryable independently of WaifuBux and moves no other balance', async () => {
    const playerId = await newPlayer();
    const before = await app.currency.getBalances(playerId);
    await currencies.grant(t.db, change(playerId, 25));
    await currencies.spend(t.db, change(playerId, 5));
    const after = await app.currency.getBalances(playerId);
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    await app.currency.grantWaifubux(t.db, playerId, 500);
    expect(await currencies.getBalance(playerId, KEY)).toBe(20);
  });

  it('is not an item: nothing in the item catalogue, a shop shelf or an inventory names it', async () => {
    const playerId = await newPlayer();
    await currencies.grant(t.db, change(playerId, 25));
    expect(app.content.items.some((i) => i.slug === KEY)).toBe(false);
    const [{ count }] = (await t.db.select({ count: sql<number>`count(*)::int` }).from(items).where(eq(items.slug, KEY))) as [
      { count: number },
    ];
    expect(count).toBe(0);
    expect((await app.shop.getCatalog()).some((entry) => JSON.stringify(entry).includes(KEY))).toBe(false);
    expect(await app.inventory.getInventory(playerId)).toEqual([]);
  });

  it('is written by exactly one module', () => {
    // The balance and ledger tables may be named only by the schema and the
    // service that owns them — no shop, inventory, Workshop or Discord file.
    const root = path.resolve(__dirname, '..', '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          if (/playerProgressionBalances|progressionCurrencyLedger|player_progression_balances/.test(source)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(['db/schema.ts', 'modules/progressionCurrency/progressionCurrencyService.ts']);
  });
});
