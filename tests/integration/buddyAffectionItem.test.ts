/**
 * `buddy_affection_gain` — flat-Affection consumables, against real Postgres.
 *
 * The effect is small; the two things worth pinning are not:
 *
 *   1. **The item never does its own arithmetic.** The award goes through
 *      `CollectionService.awardBuddyAffection`, which is where the
 *      `affection_gain` Buddy Bonus is applied — the same multiply, the same
 *      effect id and the same reporting rule the per-hunt award uses. A test
 *      that only checked "+50 landed" would pass just as happily against an
 *      item handler that wrote the column itself and silently skipped every
 *      bonus in the game.
 *
 *   2. **A refusal is free.** No Buddy equipped means no award and no
 *      consumption — the item is a gift for somebody, and with nobody there
 *      the only honest outcome is to hand it back.
 *
 * The item is inserted here rather than shipped in `content/items.json`: the
 * effect is the deliverable, and building it from a row proves it is genuinely
 * content-drivable — a new Affection consumable needs no code change.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { items, playerInventory, playerWaifus, players, species } from '../../src/db/schema';
import { formatItemUseResult } from '../../src/discord/commands/waifumon';
import {
  formatBuddyAffectionGain,
  effectSummary,
  formatItemEffectsInline,
} from '../../src/modules/items/itemEffects';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { ItemHasNoEffectError, NoActiveBuddyError } from '../../src/shared/errors';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let buddySlug: string;

const SLUG = 'test_love_letter';
const BASE = 50;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-buddy-affection', 'u-1'));
  buddySlug = app.content.species.find((s) => s.enabled)!.slug;
});
afterAll(async () => {
  await t.cleanup();
});

/** Insert (or re-point) the consumable under test with a given config. */
async function defineItem(effectConfig: Record<string, unknown>): Promise<number> {
  await t.db.delete(items).where(eq(items.slug, SLUG));
  const [row] = await t.db
    .insert(items)
    .values({
      slug: SLUG,
      name: 'Love Letter',
      category: 'consumable',
      description: 'A folded note, still warm.',
      effectType: 'buddy_affection_gain',
      effectConfig,
      enabled: true,
    })
    .returning();
  return row!.id;
}

async function grant(itemId: number, qty: number): Promise<void> {
  await app.inventory.addItem(t.db, playerId, itemId, qty);
}

/** Point the shipped content entry's Buddy Bonus at `bonus`, or remove it. */
const shipped = new Map<string, BuddyBonus | undefined>();
function authorBonus(slug: string, bonus: BuddyBonus | null): void {
  const entry = app.content.species.find((s) => s.slug === slug)!;
  if (!shipped.has(slug)) shipped.set(slug, entry.buddyBonus);
  if (bonus) entry.buddyBonus = bonus;
  else delete entry.buddyBonus;
}
function restoreBonuses(): void {
  for (const [slug, bonus] of shipped) {
    const entry = app.content.species.find((s) => s.slug === slug)!;
    if (bonus) entry.buddyBonus = bonus;
    else delete entry.buddyBonus;
  }
  shipped.clear();
}

/** An owned copy of the bonus-carrying species, equipped as the Buddy. */
async function equipBuddy(): Promise<number> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, buddySlug));
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: row!.id, affection: 0 });
  await app.collection.setBuddy(playerId, waifu.id);
  return waifu.id;
}

const affectionOf = async (waifuId: number): Promise<number> => {
  const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
  return row!.affection;
};

const quantityOf = async (itemId: number): Promise<number> =>
  app.inventory.getQuantity(playerId, itemId);

beforeEach(async () => {
  restoreBonuses();
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
});

describe('flat affection gain', () => {
  it('grants the configured amount to the active buddy and consumes one item', async () => {
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 2);
    const buddyId = await equipBuddy();

    const result = await app.itemUse.use(playerId, SLUG);

    expect(result.kind).toBe('buddy_affection_gain');
    if (result.kind !== 'buddy_affection_gain') throw new Error('unreachable');
    expect(result.baseAffection).toBe(BASE);
    expect(result.affectionGained).toBe(BASE);
    expect(result.affectionAfter).toBe(BASE);
    expect(result.affectionBonus).toBeNull();
    expect(await affectionOf(buddyId)).toBe(BASE);
    expect(await quantityOf(itemId)).toBe(1);
  });

  it('adds to existing affection rather than replacing it', async () => {
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    const buddyId = await equipBuddy();
    await t.db.update(playerWaifus).set({ affection: 120 }).where(eq(playerWaifus.id, buddyId));

    await app.itemUse.use(playerId, SLUG);
    expect(await affectionOf(buddyId)).toBe(120 + BASE);
  });

  it('pays whoever is equipped at the moment of use, not at grant time', async () => {
    // The item names no target and stores none; a Buddy switch between the
    // grant and the use has to move the award with it.
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    const first = await equipBuddy();
    const second = await equipBuddy();

    await app.itemUse.use(playerId, SLUG);
    expect(await affectionOf(second)).toBe(BASE);
    expect(await affectionOf(first)).toBe(0);
  });
});

describe('the affection_gain Buddy Bonus applies', () => {
  it('scales the item award by the equipped buddy’s percentage', async () => {
    // The worked example from the spec: 50 base, +20%, 60 final.
    authorBonus(buddySlug, {
      name: 'Open Heart',
      flavorText: '+20% Affection gained.',
      effectId: 'affection_gain',
      value: 20,
    });
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    const buddyId = await equipBuddy();

    const result = await app.itemUse.use(playerId, SLUG);
    if (result.kind !== 'buddy_affection_gain') throw new Error('unreachable');

    expect(result.baseAffection).toBe(50);
    expect(result.affectionGained).toBe(60);
    expect(result.affectionAfter).toBe(60);
    expect(await affectionOf(buddyId)).toBe(60);
  });

  it('reports both the base and the final gain, plus the bonus that moved it', async () => {
    authorBonus(buddySlug, {
      name: 'Open Heart',
      flavorText: '+20% Affection gained.',
      effectId: 'affection_gain',
      value: 20,
    });
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    await equipBuddy();

    const result = await app.itemUse.use(playerId, SLUG);
    if (result.kind !== 'buddy_affection_gain') throw new Error('unreachable');
    expect(result.affectionBonus).toMatchObject({
      name: 'Open Heart',
      effectId: 'affection_gain',
      value: 20,
      baseValue: 50,
      finalValue: 60,
    });
  });

  it('leaves the bonus unreported when it did not change the number', async () => {
    // A bonus for a different effect must not be announced next to an award it
    // had nothing to do with — the same rule `awardBuddyOnHunt` follows.
    authorBonus(buddySlug, {
      name: 'Training Montage',
      flavorText: '+100% Buddy XP.',
      effectId: 'buddy_xp_gain',
      value: 100,
    });
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    await equipBuddy();

    const result = await app.itemUse.use(playerId, SLUG);
    if (result.kind !== 'buddy_affection_gain') throw new Error('unreachable');
    expect(result.affectionGained).toBe(BASE);
    expect(result.affectionBonus).toBeNull();
  });

  it('rounds a fractional result rather than flooring it away', async () => {
    // `applyPercentModifierInt` rounds, so a small percentage on a small award
    // still does something. 5 at +10% is 5.5 → 6, not 5.
    authorBonus(buddySlug, {
      name: 'Soft Word',
      flavorText: '+10% Affection gained.',
      effectId: 'affection_gain',
      value: 10,
    });
    const itemId = await defineItem({ amount: 5 });
    await grant(itemId, 1);
    await equipBuddy();

    const result = await app.itemUse.use(playerId, SLUG);
    if (result.kind !== 'buddy_affection_gain') throw new Error('unreachable');
    expect(result.affectionGained).toBe(6);
  });
});

describe('no active buddy', () => {
  it('rejects the use and consumes nothing', async () => {
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    // No buddy equipped — beforeEach cleared the pointer.

    await expect(app.itemUse.use(playerId, SLUG)).rejects.toBeInstanceOf(NoActiveBuddyError);
    expect(await quantityOf(itemId)).toBe(1);
  });

  it('names the item and says nothing was used', async () => {
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    const err = await app.itemUse.use(playerId, SLUG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoActiveBuddyError);
    expect((err as NoActiveBuddyError).userMessage).toContain('Love Letter');
    expect((err as NoActiveBuddyError).userMessage).toMatch(/nothing was used/i);
  });

  it('rejects when the buddy pointer aims at a released copy', async () => {
    // `resolveActiveBuddy` reads a soft-released copy as "no buddy", so the
    // use refuses rather than paying Affection to somebody the player no
    // longer has.
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    const buddyId = await equipBuddy();
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, buddyId));

    await expect(app.itemUse.use(playerId, SLUG)).rejects.toBeInstanceOf(NoActiveBuddyError);
    expect(await quantityOf(itemId)).toBe(1);
    // The dangling pointer is deliberately NOT cleared by this path.
    // `resolveActiveBuddy` attempts the self-heal, but the refusal throws and
    // rolls the whole transaction back — the heal with it. That is the right
    // trade: atomicity of the item use is the guarantee worth keeping, and a
    // refusal is a poor excuse to commit an unrelated write. The player is not
    // stuck either way, because every read of the buddy applies the same
    // "released reads as none" rule.
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player!.buddyWaifuId).toBe(buddyId);
    expect(await app.collection.getBuddy(playerId)).toBeNull();
  });
});

describe('invalid configuration', () => {
  it.each([
    ['zero', { amount: 0 }],
    ['negative', { amount: -10 }],
    ['fractional', { amount: 2.5 }],
    ['missing', {}],
    ['wrong type', { amount: 'fifty' }],
    ['unknown extra field', { amount: 50, target: 'someone' }],
  ])('rejects a %s amount without consuming the item', async (_name, config) => {
    // The config is re-parsed from the jsonb column on every use, so a
    // hand-edited row is refused at use time rather than granting a NaN.
    const itemId = await defineItem(config);
    await grant(itemId, 1);
    await equipBuddy();

    await expect(app.itemUse.use(playerId, SLUG)).rejects.toBeInstanceOf(ItemHasNoEffectError);
    expect(await quantityOf(itemId)).toBe(1);
  });

  it('refuses a non-positive amount at the service layer too', async () => {
    // The schema is the outer guard; this is the inner one. A caller reaching
    // the award directly still cannot grant nothing and call it a gain.
    await equipBuddy();
    await expect(
      t.db.transaction((tx) => app.collection.awardBuddyAffection(tx, playerId, 0)),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('atomicity', () => {
  it('leaves inventory and affection consistent when the use fails mid-transaction', async () => {
    // Force a failure *after* the award by exhausting the stack: the item is
    // granted 0 copies, so `consumeItem` throws once the affection write has
    // already happened. Both must roll back together.
    const itemId = await defineItem({ amount: BASE });
    const buddyId = await equipBuddy();
    // No `grant()` — the player owns none.

    await expect(app.itemUse.use(playerId, SLUG)).rejects.toThrow();
    expect(await affectionOf(buddyId)).toBe(0);
    expect(await quantityOf(itemId)).toBe(0);
  });

  it('spends exactly one copy per use across repeated uses', async () => {
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 3);
    const buddyId = await equipBuddy();

    await app.itemUse.use(playerId, SLUG);
    await app.itemUse.use(playerId, SLUG);

    expect(await quantityOf(itemId)).toBe(1);
    expect(await affectionOf(buddyId)).toBe(BASE * 2);
  });

  it('two concurrent uses both land — neither award is lost', async () => {
    // The award is a read-modify-write under a row lock, so concurrent uses
    // serialize instead of one overwriting the other's total.
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 2);
    const buddyId = await equipBuddy();

    await Promise.all([app.itemUse.use(playerId, SLUG), app.itemUse.use(playerId, SLUG)]);

    expect(await affectionOf(buddyId)).toBe(BASE * 2);
    expect(await quantityOf(itemId)).toBe(0);
  });
});

describe('Care Mode affection is untouched', () => {
  // `careService` grants Affection on its own ticks, through its own code, and
  // this change did not go near it. Asserted here anyway because the refactor
  // that made room for the item award hoisted `resolveActiveBuddy` out of the
  // service object — and Care Mode's target is resolved from
  // `care_mode_waifu_id`, not from the Buddy pointer, which is exactly the
  // distinction a careless hoist could have blurred.
  it('still ticks affection onto the care target, not onto the buddy', async () => {
    const cfg = app.content.tables.energy.careMode;
    const [speciesRow] = await t.db.select().from(species).where(eq(species.slug, buddySlug));
    const buddy = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: speciesRow!.id,
      affection: 0,
    });
    const careTarget = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: speciesRow!.id,
      affection: 0,
    });
    await app.collection.setBuddy(playerId, buddy.id);

    const start = new Date();
    await app.care.start(playerId, careTarget.id, start);
    const later = new Date(start.getTime() + cfg.intervalMinutes * 60_000);
    const summary = await app.care.applyPending(playerId, later);

    expect(summary.ticksProcessed).toBe(1);
    expect(summary.affectionGained).toBe(cfg.affectionPerTick);
    expect(await affectionOf(careTarget.id)).toBe(cfg.affectionPerTick);
    // The equipped Buddy is a bystander to a care tick on somebody else.
    expect(await affectionOf(buddy.id)).toBe(0);

    await app.care.leave(playerId, later);
  });

  it('leaves an item award and a care tick independent of each other', async () => {
    const cfg = app.content.tables.energy.careMode;
    const [speciesRow] = await t.db.select().from(species).where(eq(species.slug, buddySlug));
    const buddy = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: speciesRow!.id,
      affection: 0,
    });
    await app.collection.setBuddy(playerId, buddy.id);

    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);

    // Care for the Buddy herself, so both paths target one copy and their
    // totals have to add rather than clobber.
    const start = new Date();
    await app.care.start(playerId, buddy.id, start);
    await app.itemUse.use(playerId, SLUG);
    const later = new Date(start.getTime() + cfg.intervalMinutes * 60_000);
    await app.care.applyPending(playerId, later);

    expect(await affectionOf(buddy.id)).toBe(BASE + cfg.affectionPerTick);
    await app.care.leave(playerId, later);
  });
});

describe('shared formatting', () => {
  it('describes the effect in one shared phrase', () => {
    expect(formatBuddyAffectionGain(50)).toBe('Gives your active Buddy +50 Affection');
  });

  it('renders the description from the item row, with no slug knowledge', () => {
    const line = formatItemEffectsInline({
      effectType: 'buddy_affection_gain',
      effectConfig: { amount: 50 },
    });
    expect(line).toBe('Effect: Gives your active Buddy +50 Affection');
    expect(effectSummary('buddy_affection_gain', { amount: 50 })).toBe('+50 Buddy Affection');
  });

  it('reports only the final gain when no bonus applied', async () => {
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    await equipBuddy();
    const result = await app.itemUse.use(playerId, SLUG);

    const line = formatItemUseResult(result);
    expect(line).toContain('+50 Affection');
    expect(line).not.toContain('Base:');
  });

  it('shows the base and the bonus when one moved the number', async () => {
    authorBonus(buddySlug, {
      name: 'Open Heart',
      flavorText: '+20% Affection gained.',
      effectId: 'affection_gain',
      value: 20,
    });
    const itemId = await defineItem({ amount: BASE });
    await grant(itemId, 1);
    await equipBuddy();
    const result = await app.itemUse.use(playerId, SLUG);

    const line = formatItemUseResult(result);
    expect(line).toContain('+60 Affection');
    expect(line).toContain('Base: 50');
    expect(line).toContain('Open Heart');
    expect(line).toContain('+20%');
  });
});
