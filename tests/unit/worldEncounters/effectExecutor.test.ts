/**
 * Effect executor tests — every effect type routes through the right service
 * with the right arguments, and soft-fail branches (insufficient funds,
 * missing buddy, unknown item) never throw.
 *
 * The executor is a thin dispatch table over the currency/inventory/
 * progression/collection services; we exercise it here with fakes so a
 * regression to a wrong service call is caught cheaply, without a DB.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEffectExecutor } from '../../../src/modules/worldEncounters/effectExecutor';
import type { Effect } from '../../../src/modules/worldEncounters/types';
import { InsufficientFundsError, InsufficientItemsError } from '../../../src/shared/errors';

function makeExecutor(overrides: Partial<{
  waifubux: number;
  essence: number;
  energy: number;
  itemLookup: Map<string, number>;
  buddyExists: boolean;
}> = {}) {
  const waifubux = overrides.waifubux ?? 1000;
  const essence = overrides.essence ?? 500;
  const energy = overrides.energy ?? 5;
  const itemLookup = overrides.itemLookup ?? new Map([['basic_charm', 1]]);
  const buddyExists = overrides.buddyExists ?? true;

  const state = {
    waifubux,
    essence,
    energy,
    grants: [] as Array<{ kind: string; args: unknown[] }>,
  };

  const currency = {
    grantWaifubux: vi.fn(async (_tx: unknown, _p: number, n: number) => {
      state.waifubux += n;
      state.grants.push({ kind: 'grantWaifubux', args: [n] });
      return {} as never;
    }),
    spendWaifubux: vi.fn(async (_tx: unknown, _p: number, n: number) => {
      if (state.waifubux < n) throw new InsufficientFundsError(n, state.waifubux);
      state.waifubux -= n;
      state.grants.push({ kind: 'spendWaifubux', args: [n] });
      return {} as never;
    }),
    grantEssence: vi.fn(async (_tx: unknown, _p: number, n: number) => {
      state.essence += n;
      state.grants.push({ kind: 'grantEssence', args: [n] });
      return {} as never;
    }),
    spendEssence: vi.fn(async (_tx: unknown, _p: number, n: number) => {
      if (state.essence < n) throw new InsufficientFundsError(n, state.essence);
      state.essence -= n;
      state.grants.push({ kind: 'spendEssence', args: [n] });
      return {} as never;
    }),
    setHuntEnergy: vi.fn(async (_tx: unknown, _p: number, n: number) => {
      state.energy = n;
      state.grants.push({ kind: 'setHuntEnergy', args: [n] });
      return {} as never;
    }),
    lockCurrencies: vi.fn(),
    getBalances: vi.fn(),
  };

  const inventory = {
    addItem: vi.fn(async (_tx: unknown, _p: number, id: number, q: number) => {
      state.grants.push({ kind: 'addItem', args: [id, q] });
      return q;
    }),
    consumeItem: vi.fn(async (_tx: unknown, _p: number, id: number, q: number) => {
      state.grants.push({ kind: 'consumeItem', args: [id, q] });
      return q;
    }),
    getInventory: vi.fn(),
    getQuantity: vi.fn(),
    countCaptureItems: vi.fn(),
  };

  const progression = {
    grantXp: vi.fn(async (_tx: unknown, _p: number, opts: { xpDelta: number }) => {
      state.grants.push({ kind: 'grantPlayerXp', args: [opts.xpDelta] });
      return { xpDelta: opts.xpDelta } as never;
    }),
  };

  const collection = {
    awardWaifuXp: vi.fn(async (_tx: unknown, _p: number, _w: number, xp: number) => {
      if (!buddyExists) return null;
      state.grants.push({ kind: 'awardWaifuXp', args: [xp] });
      return { xpGranted: xp } as never;
    }),
  };

  // Fake tx supporting only .select().from(table).where(cond) and
  // .select().from(table).where(cond).limit(n). The executor calls the
  // currency/items columns paths we care about; we route by which table
  // symbol carries currency-shaped keys.
  const tx = {
    select() {
      return {
        from(table: unknown) {
          const anyTable = table as { [key: string]: unknown };
          const isCurrency =
            'waifubux' in anyTable || 'essence' in anyTable || 'huntEnergy' in anyTable;
          return {
            where(_cond: unknown) {
              if (isCurrency) {
                return Promise.resolve([
                  { waifubux: state.waifubux, essence: state.essence, huntEnergy: state.energy },
                ]);
              }
              // Items lookup returns the first known slug's id. Tests set
              // their own effect slugs and know which resolves.
              const entries = [...itemLookup.entries()];
              const payload = entries.length > 0 ? [{ id: entries[0]![1] }] : [];
              return Promise.resolve(payload);
            },
          };
        },
      };
    },
  };

  const executor = createEffectExecutor({
    currency: currency as never,
    inventory: inventory as never,
    progression: progression as never,
    collection: collection as never,
  });

  const ctx = { playerId: 1, buddyWaifuId: buddyExists ? 42 : null, encounterId: 99 };
  return { executor, ctx, tx: tx as never, state, mocks: { currency, inventory, progression, collection } };
}

describe('effect executor — grants', () => {
  it('waifubux_gain routes through currency.grantWaifubux', async () => {
    const t = makeExecutor();
    const result = await t.executor.apply(t.tx, t.ctx, [
      { type: 'waifubux_gain', amount: 200 } as Effect,
    ]);
    expect(t.mocks.currency.grantWaifubux).toHaveBeenCalledWith(t.tx, 1, 200);
    expect(result.applied[0]!.amount).toBe(200);
  });

  it('essence_gain routes through currency.grantEssence', async () => {
    const t = makeExecutor();
    await t.executor.apply(t.tx, t.ctx, [{ type: 'essence_gain', amount: 50 } as Effect]);
    expect(t.mocks.currency.grantEssence).toHaveBeenCalledWith(t.tx, 1, 50);
  });

  it('player_xp routes through progression.grantXp', async () => {
    const t = makeExecutor();
    await t.executor.apply(t.tx, t.ctx, [{ type: 'player_xp', amount: 75 } as Effect]);
    expect(t.mocks.progression.grantXp).toHaveBeenCalled();
    const call = t.mocks.progression.grantXp.mock.calls[0]!;
    expect(call[2]).toMatchObject({ xpDelta: 75, eventType: 'world_encounter', refId: 99 });
  });

  it('buddy_xp routes through collection.awardWaifuXp when a buddy is set', async () => {
    const t = makeExecutor();
    await t.executor.apply(t.tx, t.ctx, [{ type: 'buddy_xp', amount: 30 } as Effect]);
    expect(t.mocks.collection.awardWaifuXp).toHaveBeenCalledWith(t.tx, 1, 42, 30);
  });

  it('buddy_xp is a no-op when there is no buddy', async () => {
    const t = makeExecutor({ buddyExists: false });
    const t2 = { ...t, ctx: { ...t.ctx, buddyWaifuId: null } };
    const result = await t2.executor.apply(t2.tx, t2.ctx, [{ type: 'buddy_xp', amount: 30 } as Effect]);
    expect(t2.mocks.collection.awardWaifuXp).not.toHaveBeenCalled();
    expect(result.applied[0]!.applied).toBe(false);
  });
});

describe('effect executor — losses', () => {
  it('waifubux_loss caps at balance without throwing', async () => {
    const t = makeExecutor({ waifubux: 50 });
    const result = await t.executor.apply(t.tx, t.ctx, [
      { type: 'waifubux_loss', amount: 200 } as Effect,
    ]);
    expect(result.applied[0]!.amount).toBe(50);
    expect(result.applied[0]!.reason).toBe('capped_at_balance');
  });

  it('waifubux_loss_percent applies the cap after the percent', async () => {
    const t = makeExecutor({ waifubux: 2000 });
    const result = await t.executor.apply(t.tx, t.ctx, [
      { type: 'waifubux_loss_percent', percent: 0.5, maxAmount: 500 } as Effect,
    ]);
    // 50% of 2000 = 1000, capped to 500.
    expect(result.applied[0]!.amount).toBe(500);
  });

  it('waifubux_loss_percent is a soft no-op when balance is 0', async () => {
    const t = makeExecutor({ waifubux: 0 });
    const result = await t.executor.apply(t.tx, t.ctx, [
      { type: 'waifubux_loss_percent', percent: 0.5 } as Effect,
    ]);
    expect(result.applied[0]!.applied).toBe(false);
    expect(result.applied[0]!.reason).toBe('no_balance');
  });

  it('energy_loss caps at zero and reports capped_at_zero', async () => {
    const t = makeExecutor({ energy: 1 });
    const result = await t.executor.apply(t.tx, t.ctx, [
      { type: 'energy_loss', amount: 5 } as Effect,
    ]);
    expect(t.mocks.currency.setHuntEnergy).toHaveBeenCalledWith(t.tx, 1, 0);
    expect(result.applied[0]!.amount).toBe(1);
    expect(result.applied[0]!.reason).toBe('capped_at_zero');
  });
});

describe('effect executor — follow-ups', () => {
  it('trigger_encounter emits a follow-up rather than mutating state', async () => {
    const t = makeExecutor();
    const result = await t.executor.apply(t.tx, t.ctx, [
      { type: 'trigger_encounter', encounterSlug: 'follow_up' } as Effect,
    ]);
    expect(result.followUps).toContainEqual({
      kind: 'trigger_encounter',
      payload: { encounterSlug: 'follow_up' },
    });
    // No monetary side effects.
    expect(t.state.grants.filter((g) => g.kind.includes('grant') || g.kind.includes('spend'))).toHaveLength(0);
  });

  it('open_vendor emits a follow-up carrying the vendor key', async () => {
    const t = makeExecutor();
    const result = await t.executor.apply(t.tx, t.ctx, [
      { type: 'open_vendor', vendorKey: 'wandering_merchant' } as Effect,
    ]);
    expect(result.followUps).toContainEqual({
      kind: 'open_vendor',
      payload: { vendorKey: 'wandering_merchant' },
    });
  });
});
