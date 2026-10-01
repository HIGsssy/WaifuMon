/**
 * World-encounter vendor — the minimal abstraction that makes the Wandering
 * Merchant work today and lets richer future vendors (randomised inventories,
 * region-scoped stock, unusual currencies) grow on top without a schema
 * change.
 *
 * A vendor has two shapes:
 *
 *   * A **definition** ({@link worldEncounterVendors}) authored by content:
 *     stable `vendorKey`, a display name, and a `stockTemplateJson`
 *     describing what a shopper *may* find in an instance.
 *   * An **instance** ({@link worldEncounterVendorInstances}) bound to one
 *     `active_world_encounters` row: the frozen stock the player actually
 *     sees, mutated as they buy.
 *
 * Every purchase runs in one transaction:
 *
 *   1. `SELECT … FOR UPDATE` on the instance row — serialises concurrent
 *      buys and a double-click on the same button.
 *   2. Validate the requested slug is in-stock and the player can afford it,
 *      re-reading both from the locked row and from the player's currency
 *      row that {@link CurrencyService} locks internally.
 *   3. Decrement stock, spend currency, add item — all under the same tx.
 *   4. Return the applied snapshot.
 *
 * The transaction is opened by the caller (Discord button handler / API
 * route), so vendor purchases can compose with encounter resolution when we
 * later fold "buy inside a choice" into the effect executor.
 */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  activeWorldEncounters,
  items,
  worldEncounterVendorInstances,
  worldEncounterVendors,
  type WorldEncounterVendorInstanceRow,
  type WorldEncounterVendorRow,
} from '../../db/schema';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import { AppError } from '../../shared/errors';
import type { SeedMode } from './seed';

/**
 * One purchasable line as it appears in the authored template and in a
 * generated instance. `remaining` starts equal to `quantity` on
 * instantiation; a template omits it.
 */
export const VendorStockEntrySchema = z.object({
  itemSlug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'itemSlug must be lowercase snake_case'),
  quantity: z.number().int().positive().max(999),
  price: z.number().int().positive().max(1_000_000),
  currency: z.enum(['waifubux', 'essence']),
});
export type VendorStockEntry = z.infer<typeof VendorStockEntrySchema>;

export const VendorStockInstanceEntrySchema = VendorStockEntrySchema.extend({
  remaining: z.number().int().nonnegative(),
});
export type VendorStockInstanceEntry = z.infer<typeof VendorStockInstanceEntrySchema>;

export const VendorStockTemplateSchema = z.array(VendorStockEntrySchema).max(20);
export type VendorStockTemplate = z.infer<typeof VendorStockTemplateSchema>;

export const VendorStockInstanceSchema = z.array(VendorStockInstanceEntrySchema).max(20);
export type VendorStockInstance = z.infer<typeof VendorStockInstanceSchema>;

/* ─────────────────────── Errors ─────────────────────── */

export class VendorNotFoundError extends AppError {
  constructor(vendorKey: string) {
    super(
      'VENDOR_NOT_FOUND',
      `Vendor "${vendorKey}" is not defined.`,
      'This merchant is not available.',
    );
  }
}

export class VendorInstanceNotFoundError extends AppError {
  constructor() {
    super(
      'VENDOR_INSTANCE_NOT_FOUND',
      'No open vendor for this encounter.',
      'This merchant has already packed up.',
    );
  }
}

export class VendorStockUnavailableError extends AppError {
  constructor(slug: string) {
    super(
      'VENDOR_STOCK_UNAVAILABLE',
      `Item "${slug}" is not available at this vendor.`,
      'That item is not stocked here.',
    );
  }
}

export class VendorOutOfStockError extends AppError {
  constructor(slug: string) {
    super(
      'VENDOR_OUT_OF_STOCK',
      `Item "${slug}" is sold out at this vendor.`,
      'Sold out — check back another time.',
    );
  }
}

export class VendorKeyTakenError extends AppError {
  constructor(vendorKey: string) {
    super(
      'VENDOR_KEY_TAKEN',
      `Vendor "${vendorKey}" already exists.`,
      'A vendor with that key already exists.',
    );
  }
}

export class VendorInUseError extends AppError {
  constructor(vendorKey: string, encounterSlugs: readonly string[]) {
    super(
      'VENDOR_IN_USE',
      `Vendor "${vendorKey}" is opened by ${encounterSlugs.join(', ')}.`,
      'Encounters still open this vendor — point them at another vendor first.',
    );
  }
}

/* ─────────────────────── Admin authoring ─────────────────────── */

/**
 * The authored fields of a vendor, as the Portal's vendor editor saves them.
 *
 * `stock` is exactly {@link VendorStockTemplateSchema} — the shape the runtime
 * instantiates and the content package carries — so an admin write can never
 * produce a template the engine or an import would read differently.
 *
 * `vendorKey` is not part of an update: instances reference a vendor by key
 * with no foreign key, so renaming one would orphan every open shop.
 */
export const VendorDefinitionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  stock: VendorStockTemplateSchema.default([]),
});
export type VendorDefinitionInput = z.infer<typeof VendorDefinitionInputSchema>;

export const NewVendorDefinitionSchema = VendorDefinitionInputSchema.extend({
  vendorKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'vendorKey must be lowercase snake_case'),
});
export type NewVendorDefinition = z.infer<typeof NewVendorDefinitionSchema>;

/**
 * Rules the schema cannot express, as `{ path, message }` issues (the Portal's
 * field-issue shape).
 *
 *   - Every stocked item must exist — `purchase` refuses unknown items, so an
 *     unknown slug is a line nobody can ever buy.
 *   - An item may be stocked once. `purchase` finds the *first* line for a
 *     slug, so a second line for the same item could never be bought.
 */
export function vendorStockIssues(
  stock: VendorStockTemplate,
  itemSlugs: ReadonlySet<string>,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const seen = new Set<string>();
  stock.forEach((entry, i) => {
    if (!itemSlugs.has(entry.itemSlug)) {
      issues.push({ path: `/stock/${i}/itemSlug`, message: `Unknown item "${entry.itemSlug}".` });
    }
    if (seen.has(entry.itemSlug)) {
      issues.push({
        path: `/stock/${i}/itemSlug`,
        message: `"${entry.itemSlug}" is already stocked; each item may appear once.`,
      });
    }
    seen.add(entry.itemSlug);
  });
  return issues;
}

/* ─────────────────────── Service ─────────────────────── */

export interface VendorInstance {
  id: number;
  activeEncounterId: number;
  vendorKey: string;
  name: string;
  description: string;
  stock: VendorStockInstance;
  closed: boolean;
}

export interface VendorPurchaseResult {
  itemSlug: string;
  quantity: number;
  price: number;
  currency: 'waifubux' | 'essence';
  remaining: number;
  balanceAfter: number;
}

export interface WorldEncounterVendorService {
  /** Look up (or 404) a vendor by its authored key. Definition only, no stock. */
  getDefinition(vendorKey: string): Promise<WorldEncounterVendorRow | null>;
  /**
   * Every authored vendor, for the admin editor's vendor selector. Definitions
   * only — no instance, no stock, nothing player-specific.
   */
  listDefinitions(): Promise<WorldEncounterVendorRow[]>;
  /**
   * Admin authoring. Definitions only: an open shop keeps the stock it was
   * instantiated with, so an edit here reaches the *next* visit, never a
   * player mid-purchase. Callers validate with {@link vendorStockIssues}.
   */
  createDefinition(input: NewVendorDefinition): Promise<WorldEncounterVendorRow>;
  /** Null when no vendor has that key. The key itself is immutable. */
  updateDefinition(
    vendorKey: string,
    input: VendorDefinitionInput,
  ): Promise<WorldEncounterVendorRow | null>;
  /** False when no vendor has that key. Callers refuse vendors still in use. */
  deleteDefinition(vendorKey: string): Promise<boolean>;
  /** Create or fetch the vendor instance for one active encounter. Idempotent. */
  openForEncounter(
    tx: DbOrTx,
    activeEncounterId: number,
    vendorKey: string,
  ): Promise<VendorInstance>;
  /**
   * Read the instance for one active encounter, **scoped to its owner**.
   *
   * `playerId` is required because every caller reaches this from a Discord
   * custom id, and a custom id is a string the client controls: without the
   * scope, `encv:open:<someone else's id>` would repaint another player's
   * shop — their stock, their remaining counts. A mismatched owner is
   * indistinguishable from a missing instance, so the answer never confirms
   * that the id exists.
   *
   * Never mutates.
   */
  getForEncounter(
    playerId: number,
    activeEncounterId: number,
  ): Promise<VendorInstance | null>;
  /**
   * Buy one line. Runs as a single transaction: the caller may leave the tx
   * off to let the service open its own, or pass one it already holds.
   */
  purchase(
    playerId: number,
    activeEncounterId: number,
    itemSlug: string,
  ): Promise<VendorPurchaseResult>;
  /** Mark the instance closed — a cosmetic flag; nothing enforces it yet. */
  close(tx: DbOrTx, activeEncounterId: number): Promise<void>;
}

export interface WorldEncounterVendorServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
}

/**
 * Template → concrete instance. Today: a copy with `remaining = quantity`.
 * Randomisation and region-scoped stock plug in here — call sites do not
 * care whether the vendor is deterministic or seeded.
 */
export function instantiateStock(template: VendorStockTemplate): VendorStockInstance {
  return template.map((entry) => ({ ...entry, remaining: entry.quantity }));
}

function parseTemplate(raw: unknown): VendorStockTemplate {
  const parsed = VendorStockTemplateSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function parseInstance(raw: unknown): VendorStockInstance {
  const parsed = VendorStockInstanceSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function createWorldEncounterVendorService(
  deps: WorldEncounterVendorServiceDeps,
): WorldEncounterVendorService {
  async function getDefinition(vendorKey: string): Promise<WorldEncounterVendorRow | null> {
    const [row] = await deps.db
      .select()
      .from(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, vendorKey));
    return row ?? null;
  }

  async function listDefinitions(): Promise<WorldEncounterVendorRow[]> {
    return deps.db.select().from(worldEncounterVendors).orderBy(worldEncounterVendors.vendorKey);
  }

  async function createDefinition(input: NewVendorDefinition): Promise<WorldEncounterVendorRow> {
    // `vendor_key` is UNIQUE: the conflict target makes a taken key a no-op
    // at the database, with no read-then-write race.
    const [row] = await deps.db
      .insert(worldEncounterVendors)
      .values({
        vendorKey: input.vendorKey,
        name: input.name,
        description: input.description,
        stockTemplateJson: input.stock as unknown as Record<string, unknown>[],
      })
      .onConflictDoNothing({ target: worldEncounterVendors.vendorKey })
      .returning();
    if (!row) throw new VendorKeyTakenError(input.vendorKey);
    return row;
  }

  async function updateDefinition(
    vendorKey: string,
    input: VendorDefinitionInput,
  ): Promise<WorldEncounterVendorRow | null> {
    const [row] = await deps.db
      .update(worldEncounterVendors)
      .set({
        name: input.name,
        description: input.description,
        stockTemplateJson: input.stock as unknown as Record<string, unknown>[],
        updatedAt: sql`now()`,
      })
      .where(eq(worldEncounterVendors.vendorKey, vendorKey))
      .returning();
    return row ?? null;
  }

  async function deleteDefinition(vendorKey: string): Promise<boolean> {
    const rows = await deps.db
      .delete(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, vendorKey))
      .returning({ id: worldEncounterVendors.id });
    return rows.length > 0;
  }

  function toVendorInstance(
    def: WorldEncounterVendorRow,
    row: WorldEncounterVendorInstanceRow,
  ): VendorInstance {
    return {
      id: row.id,
      activeEncounterId: row.activeEncounterId,
      vendorKey: row.vendorKey,
      name: def.name,
      description: def.description,
      stock: parseInstance(row.stockJson),
      closed: row.closedAt != null,
    };
  }

  async function openForEncounter(
    tx: DbOrTx,
    activeEncounterId: number,
    vendorKey: string,
  ): Promise<VendorInstance> {
    const [def] = await tx
      .select()
      .from(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, vendorKey));
    if (!def) throw new VendorNotFoundError(vendorKey);

    // Unique index makes this idempotent — a second open picks up the same row.
    const [existing] = await tx
      .select()
      .from(worldEncounterVendorInstances)
      .where(eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId));
    if (existing) return toVendorInstance(def, existing);

    const template = parseTemplate(def.stockTemplateJson);
    const stock = instantiateStock(template);
    const [inserted] = await tx
      .insert(worldEncounterVendorInstances)
      .values({
        activeEncounterId,
        vendorKey,
        stockJson: stock as unknown as Record<string, unknown>[],
      })
      .returning();
    if (!inserted) throw new Error('openForEncounter: no row returned');
    return toVendorInstance(def, inserted);
  }

  async function getForEncounter(
    playerId: number,
    activeEncounterId: number,
  ): Promise<VendorInstance | null> {
    // One join rather than two reads: the ownership test and the instance
    // lookup have to be the same query, or a caller could be tempted to skip
    // the second half.
    const [row] = await deps.db
      .select({ instance: worldEncounterVendorInstances })
      .from(worldEncounterVendorInstances)
      .innerJoin(
        activeWorldEncounters,
        eq(activeWorldEncounters.id, worldEncounterVendorInstances.activeEncounterId),
      )
      .where(
        and(
          eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId),
          eq(activeWorldEncounters.playerId, playerId),
        ),
      );
    if (!row) return null;
    const def = await getDefinition(row.instance.vendorKey);
    if (!def) return null;
    return toVendorInstance(def, row.instance);
  }

  async function purchase(
    playerId: number,
    activeEncounterId: number,
    itemSlug: string,
  ): Promise<VendorPurchaseResult> {
    return deps.db.transaction(async (tx) => {
      const [instanceRow] = await tx
        .select()
        .from(worldEncounterVendorInstances)
        .where(eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId))
        .for('update');
      if (!instanceRow) throw new VendorInstanceNotFoundError();

      const [active] = await tx
        .select({
          playerId: activeWorldEncounters.playerId,
          status: activeWorldEncounters.status,
        })
        .from(activeWorldEncounters)
        .where(eq(activeWorldEncounters.id, activeEncounterId));
      if (!active) throw new VendorInstanceNotFoundError();
      if (active.playerId !== playerId) throw new VendorInstanceNotFoundError();
      // Vendor stays open even after the parent encounter resolves — the
      // player is free to browse a Wandering Merchant after picking her.

      const stock = parseInstance(instanceRow.stockJson);
      const entry = stock.find((s) => s.itemSlug === itemSlug);
      if (!entry) throw new VendorStockUnavailableError(itemSlug);
      if (entry.remaining <= 0) throw new VendorOutOfStockError(itemSlug);

      const [item] = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.slug, itemSlug), eq(items.enabled, true)));
      if (!item) throw new VendorStockUnavailableError(itemSlug);

      // Spend the currency — the currency service handles insufficient funds.
      const balanceAfter =
        entry.currency === 'waifubux'
          ? (await deps.currency.spendWaifubux(tx, playerId, entry.price)).waifubux
          : (await deps.currency.spendEssence(tx, playerId, entry.price)).essence;

      await deps.inventory.addItem(tx, playerId, item.id, 1);

      const newStock = stock.map((s) =>
        s.itemSlug === itemSlug ? { ...s, remaining: s.remaining - 1 } : s,
      );
      await tx
        .update(worldEncounterVendorInstances)
        .set({ stockJson: newStock as unknown as Record<string, unknown>[] })
        .where(eq(worldEncounterVendorInstances.id, instanceRow.id));

      return {
        itemSlug,
        quantity: 1,
        price: entry.price,
        currency: entry.currency,
        remaining: entry.remaining - 1,
        balanceAfter,
      };
    });
  }

  async function close(tx: DbOrTx, activeEncounterId: number): Promise<void> {
    await tx
      .update(worldEncounterVendorInstances)
      .set({ closedAt: sql`now()` })
      .where(eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId));
  }

  return {
    getDefinition,
    listDefinitions,
    createDefinition,
    updateDefinition,
    deleteDefinition,
    openForEncounter,
    getForEncounter,
    purchase,
    close,
  };
}

/** A bootstrap vendor definition — the authored fields only. */
export type SeedVendor = Pick<WorldEncounterVendorRow, 'vendorKey' | 'name' | 'description'> & {
  stock: VendorStockTemplate;
};

/** The bootstrap vendor catalogue. Defaults for missing vendors, not an enforced definition. */
export const SEED_VENDORS: readonly SeedVendor[] = [
  {
    vendorKey: 'wandering_merchant',
    name: 'The Wandering Merchant',
    description:
      'A hooded merchant offering rare curiosities to travellers she meets on the road.',
    stock: [
      { itemSlug: 'basic_charm', quantity: 3, price: 150, currency: 'waifubux' },
      { itemSlug: 'silk_charm', quantity: 1, price: 900, currency: 'waifubux' },
    ],
  },
];

export interface SeedVendorOptions {
  /**
   * `insert-missing` (default, startup): an existing vendor key is left
   * exactly as it is. `reset` (test fixtures): an existing key is overwritten
   * from the catalogue. Same semantics as {@link seedWorldEncounters}.
   */
  mode?: SeedMode;
  /** The definitions to seed. Defaults to {@link SEED_VENDORS}. */
  catalogue?: readonly SeedVendor[];
}

/**
 * Seed the bootstrap vendor catalogue, per vendor key. Idempotent in either
 * mode; a key that is not in the catalogue is never touched.
 */
export async function seedWorldEncounterVendors(
  db: Db,
  { mode = 'insert-missing', catalogue = SEED_VENDORS }: SeedVendorOptions = {},
): Promise<void> {
  for (const entry of catalogue) {
    const values = {
      vendorKey: entry.vendorKey,
      name: entry.name,
      description: entry.description,
      stockTemplateJson: entry.stock as unknown as Record<string, unknown>[],
    };

    if (mode === 'insert-missing') {
      // `vendor_key` is UNIQUE, so the conflict target makes an existing
      // vendor a no-op at the database — no read-then-write race, no UPDATE.
      await db
        .insert(worldEncounterVendors)
        .values(values)
        .onConflictDoNothing({ target: worldEncounterVendors.vendorKey });
      continue;
    }

    const [existing] = await db
      .select({ id: worldEncounterVendors.id })
      .from(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, entry.vendorKey));

    if (existing) {
      await db
        .update(worldEncounterVendors)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(worldEncounterVendors.id, existing.id));
    } else {
      await db.insert(worldEncounterVendors).values(values);
    }
  }
}
