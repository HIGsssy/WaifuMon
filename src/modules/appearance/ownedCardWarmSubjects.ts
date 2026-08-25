/**
 * "Whose cards, and which copies?" — the two queries owned-card warming needs.
 *
 * Kept out of `ownedCardWarm.ts` so the planner stays a pure function of its
 * inputs: every decision that module makes can be tested by handing it three
 * objects, with no database anywhere near it.
 *
 * Not on `CollectionService` either, deliberately. `listOwned` is paginated to
 * 25 because it was written for Discord select menus, and a warm wants the
 * whole collection at once; reaching for it would mean either a page loop that
 * re-counts on every iteration, or widening a gameplay service's contract for a
 * cache warmer's convenience. Two narrow reads are the smaller thing.
 *
 * Both read only what `ownedCardRequest` consumes — level, worn appearance,
 * species slug — plus the copy id a warm dedupes and logs by.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { playerWaifus, species } from '../../db/schema';
import type { OwnedCardWarmSubject } from './ownedCardWarm';

/**
 * Every active copy a player owns, oldest first.
 *
 * Soft-released copies are excluded by the same `releasedAt IS NULL` filter the
 * rest of the collection surface uses: a released Waifumon is not in the grid,
 * so warming her card would render an image nothing can request.
 *
 * Unbounded on purpose — a collection is tens of rows, not thousands, and a
 * partial warm would silently leave the tail of a grid cold.
 */
export async function listOwnedWarmSubjects(
  db: Db,
  playerId: number,
): Promise<OwnedCardWarmSubject[]> {
  const rows = await db
    .select({
      id: playerWaifus.id,
      level: playerWaifus.level,
      variant: playerWaifus.variant,
      slug: species.slug,
    })
    .from(playerWaifus)
    .innerJoin(species, eq(playerWaifus.speciesId, species.id))
    .where(and(eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)))
    .orderBy(asc(playerWaifus.id));

  return rows.map((row) => ({
    waifu: { id: row.id, level: row.level, variant: row.variant },
    species: { slug: row.slug },
  }));
}

/**
 * Players who own at least one active copy, lowest id first.
 *
 * Only for `cards:warm --all-players`. Nothing at runtime enumerates players:
 * a warm that touches everyone is an explicit operator decision, never
 * something startup or a request may trigger.
 */
export async function listPlayersWithOwnedCards(db: Db): Promise<number[]> {
  const rows = await db
    .selectDistinct({ playerId: playerWaifus.playerId })
    .from(playerWaifus)
    .where(isNull(playerWaifus.releasedAt))
    .orderBy(sql`${playerWaifus.playerId} asc`);

  return rows.map((row) => row.playerId);
}
