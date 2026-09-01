/**
 * BuddyBonusService — the one place that answers "what is this player's active
 * Buddy Bonus?".
 *
 * Every gameplay system goes through this rather than reaching into species
 * JSON itself, so there is exactly one definition of which copy is the Buddy,
 * one place ownership is resolved, and one place the bonus is read from
 * content. Nothing here is keyed by species: it looks up whatever bonus the
 * equipped Buddy's species happens to author, and a species with no
 * `buddyBonus` simply resolves to `null`.
 *
 * **Nothing is stored in the database.** The bonus lives in the loaded content
 * snapshot and is joined to the player through the species slug already on the
 * `species` row, so there is no table to migrate and no copy of species JSON to
 * keep in sync. Content is read through a `getContent` closure, matching the
 * appearance / boss / travel services, so an admin "Reload Content" republishes
 * retuned bonuses without a restart.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { players, playerWaifus, species, type SpeciesRow } from '../../db/schema';
import { resolveRace } from '../cards/race';
import type { LoadedContent, SpeciesContent } from '../content/schemas';
import {
  buddyBonusPercent,
  type BuddyBonus,
  type BuddyBonusEffectId,
  type BuddyBonusSubject,
} from './buddyBonusEffects';

/** The bonus in force for a player right now, plus who is granting it. */
export interface ActiveBuddyBonus {
  bonus: BuddyBonus;
  /** The owned copy that is equipped — not the species id. */
  buddyWaifuId: number;
  speciesSlug: string;
  speciesName: string;
}

/** The minimum a species must expose to be tested against a target. */
export interface BonusSpeciesRef {
  id?: number;
  slug: string;
  archetype: string;
  affinity: string;
  rarity: string;
}

export interface BuddyBonusService {
  /**
   * The equipped Buddy's bonus, or `null` when no Buddy is equipped, the
   * pointer is stale, or her species authors no bonus. The only source of
   * Buddy Bonus effects in the game.
   */
  getActiveBuddyBonus(tx: DbOrTx, playerId: number): Promise<ActiveBuddyBonus | null>;
  /**
   * Percentage for an **untargeted** effect (every effect but `capture_chance`
   * and `encounter_weight`). 0 when no Buddy, or a different effect.
   */
  percentFor(tx: DbOrTx, playerId: number, effectId: BuddyBonusEffectId): Promise<number>;
  /**
   * Percentage for a **targeted** effect, tested against one species.
   * Ownership is queried only when the bonus actually targets ownership.
   */
  percentForSpecies(
    tx: DbOrTx,
    playerId: number,
    effectId: BuddyBonusEffectId,
    speciesRef: BonusSpeciesRef,
  ): Promise<number>;
  /** Match subject for one species, resolving ownership only when asked. */
  subjectFor(
    tx: DbOrTx,
    playerId: number,
    speciesRef: BonusSpeciesRef,
    opts?: { resolveOwnership?: boolean },
  ): Promise<BuddyBonusSubject>;
  /** Which of these species ids the player holds at least one active copy of. */
  ownedSpeciesIds(tx: DbOrTx, playerId: number, speciesIds: number[]): Promise<Set<number>>;
  /**
   * Content lookup by slug. Read-only and synchronous — no player, no
   * database, no live Buddy slot.
   *
   * Two callers, both of which already know *which* Waifumon they mean:
   * display surfaces printing a species' bonus, and Boss Encounters, which
   * resolve `boss_reward_gain` from the copy a participation committed rather
   * than from whoever is equipped when the encounter resolves.
   */
  bonusForSpeciesSlug(slug: string): BuddyBonus | null;
}

export interface BuddyBonusServiceDeps {
  getContent: () => LoadedContent;
}

export function createBuddyBonusService(deps: BuddyBonusServiceDeps): BuddyBonusService {
  const { getContent } = deps;

  /**
   * Deliberately un-memoized. The corpus is a few hundred entries and a lookup
   * happens a handful of times per player action, so the scan is free — while a
   * cache would have to guess when the snapshot changed, and an admin reload or
   * a test editing the snapshot in place would then read a stale bonus.
   */
  function contentSpecies(slug: string): SpeciesContent | undefined {
    return getContent().species.find((s) => s.slug === slug);
  }

  function bonusForSpeciesSlug(slug: string): BuddyBonus | null {
    return (contentSpecies(slug)?.buddyBonus as BuddyBonus | undefined) ?? null;
  }

  async function ownedSpeciesIds(
    tx: DbOrTx,
    playerId: number,
    speciesIds: number[],
  ): Promise<Set<number>> {
    if (speciesIds.length === 0) return new Set();
    const rows = await tx
      .selectDistinct({ speciesId: playerWaifus.speciesId })
      .from(playerWaifus)
      .where(
        and(
          eq(playerWaifus.playerId, playerId),
          isNull(playerWaifus.releasedAt),
          inArray(playerWaifus.speciesId, [...new Set(speciesIds)]),
        ),
      );
    return new Set(rows.map((r) => r.speciesId));
  }

  async function subjectFor(
    tx: DbOrTx,
    playerId: number,
    speciesRef: BonusSpeciesRef,
    opts: { resolveOwnership?: boolean } = {},
  ): Promise<BuddyBonusSubject> {
    // Race prefers the authored `race` in content (the `species` table carries
    // only `archetype`), then the archetype bridge, then the default — the
    // same order the card renderer resolves it in.
    const authored = contentSpecies(speciesRef.slug);
    const owned =
      opts.resolveOwnership && speciesRef.id !== undefined
        ? (await ownedSpeciesIds(tx, playerId, [speciesRef.id])).has(speciesRef.id)
        : false;
    return {
      race: resolveRace({
        slug: speciesRef.slug,
        race: authored?.race ?? null,
        archetype: speciesRef.archetype,
      }),
      affinity: speciesRef.affinity,
      rarity: speciesRef.rarity,
      owned,
    };
  }

  async function getActiveBuddyBonus(
    tx: DbOrTx,
    playerId: number,
  ): Promise<ActiveBuddyBonus | null> {
    const [player] = await tx
      .select({ buddyWaifuId: players.buddyWaifuId })
      .from(players)
      .where(eq(players.id, playerId));
    const buddyId = player?.buddyWaifuId;
    if (!buddyId) return null;

    const [row] = await tx
      .select({ slug: species.slug, name: species.name, releasedAt: playerWaifus.releasedAt })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(eq(playerWaifus.id, buddyId), eq(playerWaifus.playerId, playerId)));
    // A dangling or soft-released pointer reads as "no buddy". The pointer is
    // deliberately *not* healed here: this service is read-only, and
    // CollectionService already clears it on the paths that own that state.
    if (!row || row.releasedAt != null) return null;

    const bonus = bonusForSpeciesSlug(row.slug);
    if (!bonus) return null;
    return { bonus, buddyWaifuId: buddyId, speciesSlug: row.slug, speciesName: row.name };
  }

  return {
    getActiveBuddyBonus,
    ownedSpeciesIds,
    subjectFor,
    bonusForSpeciesSlug,

    async percentFor(tx, playerId, effectId) {
      const active = await getActiveBuddyBonus(tx, playerId);
      return buddyBonusPercent(active?.bonus, effectId);
    },

    async percentForSpecies(tx, playerId, effectId, speciesRef) {
      const active = await getActiveBuddyBonus(tx, playerId);
      if (!active || active.bonus.effectId !== effectId) return 0;
      const subject = await subjectFor(tx, playerId, speciesRef, {
        resolveOwnership: active.bonus.target?.type === 'ownership',
      });
      return buddyBonusPercent(active.bonus, effectId, subject);
    },
  };
}

/**
 * One species' authored bonus, straight from a content snapshot.
 *
 * The display-side counterpart to the service: UI surfaces already hold
 * `ctx.content` and a species slug, and printing a bonus needs neither a
 * player nor a query. Returns `null` for a species that authors none.
 */
export function findBuddyBonus(content: LoadedContent, slug: string): BuddyBonus | null {
  const authored = content.species.find((s) => s.slug === slug);
  return (authored?.buddyBonus as BuddyBonus | undefined) ?? null;
}

/** Adapter for the `species` table row shape, which every caller already holds. */
export function speciesRefFromRow(row: SpeciesRow): BonusSpeciesRef {
  return {
    id: row.id,
    slug: row.slug,
    archetype: row.archetype,
    affinity: row.affinity,
    rarity: row.rarity,
  };
}
