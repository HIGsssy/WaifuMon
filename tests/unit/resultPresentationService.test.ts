/**
 * ResultPresentationService cache behaviour, against a controllable fake
 * database so load timing can be driven precisely.
 *
 *   - reads are cached for the TTL; a change made by another process shows up
 *     once the TTL passes;
 *   - a write through this service is visible to this process at once — even
 *     when a load that started *before* the write finishes after it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client';
import { createResultPresentationService } from '../../src/modules/resultPresentation/resultPresentationService';
import { seededRng } from '../../src/shared/random';
import { createLogger } from '../../src/shared/logger';

interface Row {
  id: number;
  presentationKey: string;
  enabled: boolean;
  weight: number;
  flavorText: string | null;
  artworkPath: string | null;
  artworkMode: string;
  createdAt: Date;
  updatedAt: Date;
}

function row(id: number, flavorText: string): Row {
  return {
    id,
    presentationKey: 'hunt.item_find',
    enabled: true,
    weight: 1,
    flavorText,
    artworkPath: null,
    artworkMode: 'none',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * A db whose enabled-variant load returns `table` as it is *when the load is
 * released*. `hold()` makes the next load wait for `release()`.
 */
function fakeDb() {
  const table: Row[] = [];
  let loads = 0;
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => {
            loads++;
            const snapshot = [...table];
            if (gate) await gate.promise;
            return snapshot;
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Omit<Row, 'id' | 'createdAt' | 'updatedAt'>) => ({
        returning: async () => {
          const created = { ...row(table.length + 100, ''), ...values };
          table.push(created);
          return [created];
        },
      }),
    }),
  } as unknown as Db;
  return {
    db,
    table,
    loads: () => loads,
    hold() {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => (open = resolve));
      gate = { promise, open: () => { gate = null; open(); } };
    },
    release() {
      gate?.open();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

const logger = createLogger('fatal');

describe('cache', () => {
  it('serves cached reads within the TTL and sees external changes after it', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const fake = fakeDb();
    const svc = createResultPresentationService({ db: fake.db, logger, ttlMs: 5_000, rng: seededRng(1) });

    expect(await svc.getEnabledVariants('hunt.item_find')).toEqual([]);
    fake.table.push(row(1, 'external'));

    vi.advanceTimersByTime(4_000);
    expect(await svc.getEnabledVariants('hunt.item_find')).toEqual([]);
    expect(fake.loads()).toBe(1);

    vi.advanceTimersByTime(1_001);
    const after = await svc.getEnabledVariants('hunt.item_find');
    expect(after.map((v) => v.flavorText)).toEqual(['external']);
    expect(fake.loads()).toBe(2);
  });

  it('shows a local write immediately', async () => {
    const fake = fakeDb();
    const svc = createResultPresentationService({ db: fake.db, logger, ttlMs: 60_000, rng: seededRng(1) });
    expect(await svc.getEnabledVariants('hunt.item_find')).toEqual([]);
    await svc.createVariant({ presentationKey: 'hunt.item_find', flavorText: 'mine' });
    expect((await svc.getEnabledVariants('hunt.item_find')).map((v) => v.flavorText)).toEqual(['mine']);
  });

  it('never caches a load that was already running when a local write landed', async () => {
    const fake = fakeDb();
    const svc = createResultPresentationService({ db: fake.db, logger, ttlMs: 60_000, rng: seededRng(1) });

    fake.hold();
    const stale = svc.getEnabledVariants('hunt.item_find'); // snapshot: empty table
    await svc.createVariant({ presentationKey: 'hunt.item_find', flavorText: 'written' });
    fake.release();
    expect(await stale).toEqual([]);

    // The next read must not be served from the stale snapshot.
    const fresh = await svc.getEnabledVariants('hunt.item_find');
    expect(fresh.map((v) => v.flavorText)).toEqual(['written']);
  });
});
