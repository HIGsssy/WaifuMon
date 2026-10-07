/**
 * Admin item grant — hand any ordinary inventory item to a player.
 *
 * This is a **production** support tool (compensation, lost-item fixes), not a
 * staging cheat: it is deliberately independent of `ENABLE_TEST_ADMIN_CONTROLS`
 * and of `stagingTestControlsService`, which refuses to exist in production.
 * The caller (`/waifumon-admin player grant-item`) owns authorization and
 * presentation; everything that decides whether a grant may land lives here.
 *
 * ## What is grantable
 *
 * Every enabled row in `items` that is owned through `player_inventory` —
 * capture charms, consumables, salvage, key items and their components,
 * materials and cosmetics. One generic path, `inventory.addItem`, with no
 * per-item special cases. `equipment` is the single excluded category: the
 * schema reserves it, V1 gives it no mechanics, and the content loader already
 * refuses reward tables that award it for the same reason.
 *
 * Key items need no special handling because they have none: they are ordinary
 * `player_inventory` rows whose uniqueness is `items.max_owned`, enforced
 * inside `addItem`'s own upsert. Granting one never consumes anything, writes
 * no `key_item_constructions` or route-purchase row, and cannot create a
 * second copy. (Owning the Transporter Beacon *is* the Assteroid Belt
 * entitlement, so granting it does open that destination — that is what the
 * item means, not a side effect of this path.)
 *
 * ## Atomicity
 *
 * Validation, the inventory upsert and the audit row share one
 * `db.transaction`, so a grant is recorded exactly when it lands and a failure
 * anywhere leaves neither. The audit row reuses `player_progression_events`
 * with {@link ADMIN_ACTION_EVENT}, the same vocabulary the other admin tools
 * write.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  items,
  playerInventory,
  playerProgressionEvents,
  players,
  type ItemCategory,
} from '../../db/schema';
import { AppError, ItemOwnershipLimitError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { InventoryService } from '../inventory/inventoryService';
import { ADMIN_ACTION_EVENT } from './adminActionAudit';

/** Per-invocation ceiling, so a fat-fingered extra zero is refused rather than executed. */
export const ADMIN_MAX_ITEM_GRANT = 1_000;

/** `metadata.action` for the audit row this module writes. */
export const ADMIN_GRANT_ITEM_ACTION = 'grant_item';

/** Categories that are not ordinary inventory items — see the module comment. */
export const ADMIN_UNGRANTABLE_CATEGORIES: readonly ItemCategory[] = ['equipment'];

/** Discord's hard limit on autocomplete results. */
export const ITEM_AUTOCOMPLETE_LIMIT = 25;

/** A grant the tool refuses. `userMessage` is written for the admin and safe to show. */
export class AdminItemGrantError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, message);
  }
}

/** The one rule for "may an admin grant this", shared by the grant and the autocomplete. */
export function isAdminGrantableItem(item: { category: string; enabled: boolean }): boolean {
  return (
    item.enabled && !(ADMIN_UNGRANTABLE_CATEGORIES as readonly string[]).includes(item.category)
  );
}

/**
 * Autocomplete search over the item catalogue: matches display name or slug,
 * best matches first (name prefix, slug prefix, name substring, slug
 * substring), never a disabled or ungrantable item, never more than `limit`.
 */
export function searchGrantableItems<
  T extends { slug: string; name: string; category: string; enabled: boolean },
>(catalogue: readonly T[], query: string, limit = ITEM_AUTOCOMPLETE_LIMIT): T[] {
  const q = query.trim().toLowerCase();
  // "energy drink" should find `energy_drink` by key as well as by name.
  const slugQ = q.replace(/[\s-]+/g, '_');
  const ranked: { item: T; rank: number }[] = [];
  for (const item of catalogue) {
    if (!isAdminGrantableItem(item)) continue;
    const name = item.name.toLowerCase();
    const slug = item.slug.toLowerCase();
    let rank: number;
    if (q.length === 0) rank = 0;
    else if (name.startsWith(q)) rank = 0;
    else if (slug.startsWith(slugQ)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if (slug.includes(slugQ)) rank = 3;
    else continue;
    ranked.push({ item, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.item);
}

/** Who ran the command and where. Identifiers only. */
export interface AdminItemGrantActor {
  adminDiscordId: string;
  targetDiscordId: string;
  guildId: string;
  /** The Discord interaction, so an audit row can be tied back to one command. */
  interactionId?: string | undefined;
}

export interface AdminItemGrantInput {
  playerId: number;
  /** Stable item key (`items.slug`). */
  itemSlug: string;
  quantity: number;
  actor: AdminItemGrantActor;
}

export interface AdminItemGrantResult {
  item: { slug: string; name: string; category: string; emoji: string | null };
  quantity: number;
  before: number;
  after: number;
}

export interface AdminItemGrantDeps {
  db: Db;
  inventory: InventoryService;
  logger: Logger;
}

export async function grantItemToPlayer(
  deps: AdminItemGrantDeps,
  input: AdminItemGrantInput,
): Promise<AdminItemGrantResult> {
  const { db, inventory, logger } = deps;
  const { playerId, itemSlug, quantity, actor } = input;

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new AdminItemGrantError(
      'ADMIN_GRANT_INVALID_QUANTITY',
      '**Quantity** must be a whole number of 1 or more.',
    );
  }
  if (quantity > ADMIN_MAX_ITEM_GRANT) {
    throw new AdminItemGrantError(
      'ADMIN_GRANT_QUANTITY_TOO_LARGE',
      `**Quantity** is capped at **${ADMIN_MAX_ITEM_GRANT}** per command.`,
    );
  }

  const result = await db.transaction(async (tx) => {
    const [player] = await tx.select({ id: players.id }).from(players).where(eq(players.id, playerId));
    if (!player) {
      throw new AdminItemGrantError(
        'ADMIN_GRANT_PLAYER_NOT_FOUND',
        'That player does not have a Waifumon account.',
      );
    }

    const [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
    if (!item) {
      throw new AdminItemGrantError(
        'ADMIN_GRANT_ITEM_NOT_FOUND',
        'That item is not in the current item catalogue — pick one from the suggestions.',
      );
    }
    if (!item.enabled) {
      throw new AdminItemGrantError(
        'ADMIN_GRANT_ITEM_DISABLED',
        `**${item.name}** is disabled and cannot be granted.`,
      );
    }
    if (!isAdminGrantableItem(item)) {
      throw new AdminItemGrantError(
        'ADMIN_GRANT_ITEM_NOT_GRANTABLE',
        `**${item.name}** is ${item.category}, which is not an ordinary inventory item and cannot be granted here.`,
      );
    }
    if (item.maxOwned != null && quantity > item.maxOwned) {
      throw new AdminItemGrantError(
        'ADMIN_GRANT_OVER_OWNERSHIP_LIMIT',
        `**${item.name}** is limited to **${item.maxOwned}** per player — nothing was granted.`,
      );
    }

    let after: number;
    try {
      after = await inventory.addItem(tx, playerId, item.id, quantity);
    } catch (err) {
      if (!(err instanceof ItemOwnershipLimitError)) throw err;
      // `addItem` wrote nothing. Its own message is addressed to the holder,
      // so restate it for the admin, with what the player actually has.
      const [held] = await tx
        .select({ quantity: playerInventory.quantity })
        .from(playerInventory)
        .where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, item.id)));
      throw new AdminItemGrantError(
        'ADMIN_GRANT_OVER_OWNERSHIP_LIMIT',
        `**${item.name}** is limited to **${item.maxOwned}** per player and they already hold ` +
          `**${held?.quantity ?? 0}** — nothing was granted.`,
      );
    }
    // The upsert returns the post-grant quantity under its own row lock, so
    // this is exact even against a concurrent grant or use.
    const before = after - quantity;

    await tx.insert(playerProgressionEvents).values({
      playerId,
      eventType: ADMIN_ACTION_EVENT,
      xpDelta: 0,
      metadata: {
        action: ADMIN_GRANT_ITEM_ACTION,
        adminDiscordId: actor.adminDiscordId,
        targetDiscordId: actor.targetDiscordId,
        guildId: actor.guildId,
        before,
        after,
        amount: quantity,
        itemSlug: item.slug,
        itemId: item.id,
        itemCategory: item.category,
        ...(actor.interactionId ? { interactionId: actor.interactionId } : {}),
      },
    });

    return {
      item: { slug: item.slug, name: item.name, category: item.category, emoji: item.emoji },
      quantity,
      before,
      after,
    } satisfies AdminItemGrantResult;
  });

  // After commit, so the line is never written for a grant that rolled back.
  logger.warn(
    {
      tag: 'admin/player-action',
      action: ADMIN_GRANT_ITEM_ACTION,
      result: 'granted',
      adminDiscordId: actor.adminDiscordId,
      targetDiscordId: actor.targetDiscordId,
      guildId: actor.guildId,
      interactionId: actor.interactionId,
      playerId,
      itemSlug: result.item.slug,
      amount: quantity,
      before: result.before,
      after: result.after,
    },
    'admin granted an item to a player',
  );
  return result;
}
