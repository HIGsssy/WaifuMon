import { notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { items, regionEncounterPools, regionShopItems, species } from '../../db/schema';
import type { Logger } from '../../shared/logger';
import type { LoadedContent } from './schemas';

export interface SeedSummary {
  items: number;
  species: number;
  disabledItems: number;
  disabledSpecies: number;
  /** Region → species rows written for enabled regions. */
  regionPoolEntries: number;
  /** Region → item rows written for enabled regions. */
  regionShopEntries: number;
}

/**
 * Upserts content by slug: new slugs insert, existing slugs update mutable
 * fields, and DB slugs missing from JSON are flagged disabled (never deleted —
 * owned waifus must keep their species row). Idempotent.
 */
export async function seedContent(db: Db, content: LoadedContent, logger: Logger): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    for (const item of content.items) {
      const mutable = {
        name: item.name,
        category: item.category,
        captureModifier: item.captureModifier,
        captureBonus: item.captureBonus,
        captureRarities: item.captureRarities,
        isGuaranteedCapture: item.isGuaranteedCapture,
        purchasable: item.purchasable,
        buyPrice: item.buyPrice,
        priceCurrency: item.priceCurrency,
        dailyStockLimit: item.dailyStockLimit,
        effectType: item.effectType,
        effectConfig: (item.effectConfig ?? null) as Record<string, unknown> | null,
        description: item.description,
        emoji: item.emoji,
        enabled: item.enabled,
      };
      await tx
        .insert(items)
        .values({ slug: item.slug, ...mutable })
        .onConflictDoUpdate({ target: items.slug, set: mutable });
    }

    const itemSlugs = content.items.map((i) => i.slug);
    const disabledItems = await tx
      .update(items)
      .set({ enabled: false })
      .where(notInArray(items.slug, itemSlugs))
      .returning({ slug: items.slug });

    for (const s of content.species) {
      await tx
        .insert(species)
        .values({
          slug: s.slug,
          name: s.name,
          rarity: s.rarity,
          archetype: s.archetype,
          baseCaptureRate: s.baseCaptureRate,
          description: s.description,
          tags: s.tags,
          contentRating: s.contentRating,
          affinity: s.affinity,
          imagePath: s.imagePath,
          enabled: s.enabled,
          eventKey: s.eventKey,
          perSpeciesWeight: s.perSpeciesWeight,
        })
        .onConflictDoUpdate({
          target: species.slug,
          set: {
            name: s.name,
            rarity: s.rarity,
            archetype: s.archetype,
            baseCaptureRate: s.baseCaptureRate,
            description: s.description,
            tags: s.tags,
            contentRating: s.contentRating,
            affinity: s.affinity,
            imagePath: s.imagePath,
            enabled: s.enabled,
            eventKey: s.eventKey,
            perSpeciesWeight: s.perSpeciesWeight,
          },
        });
    }

    const speciesSlugs = content.species.map((s) => s.slug);
    const disabledSpecies = await tx
      .update(species)
      .set({ enabled: false })
      .where(notInArray(species.slug, speciesSlugs))
      .returning({ slug: species.slug });

    // ── Region membership ──────────────────────────────────────────────
    //
    // Both region tables are rebuilt from scratch on every seed rather than
    // upserted, and that is deliberate. They hold no player state whatsoever —
    // every row is a pure projection of the region files — so "delete and
    // re-insert" is both correct and the only way removals propagate. Species
    // and items get the opposite treatment (upsert, then disable the missing)
    // precisely because rows there are pointed at by owned waifus and
    // inventories and must never disappear.
    //
    // Inside the same transaction as the species upserts, so a pool can
    // reference a species this very seed introduced, and so a reader never
    // observes a half-rebuilt pool.
    const speciesIdBySlug = new Map(
      (await tx.select({ id: species.id, slug: species.slug }).from(species)).map((r) => [
        r.slug,
        r.id,
      ]),
    );
    const itemIdBySlug = new Map(
      (await tx.select({ id: items.id, slug: items.slug }).from(items)).map((r) => [
        r.slug,
        r.id,
      ]),
    );

    await tx.delete(regionEncounterPools);
    await tx.delete(regionShopItems);

    let regionPoolEntries = 0;
    let regionShopEntries = 0;
    for (const region of content.regions) {
      // A disabled region is unreleased content: seeding its pool would let a
      // hunt query reach a place the Locations screen refuses to show.
      if (!region.enabled) continue;

      const poolRows = region.encounterPool.flatMap((entry) => {
        const speciesId = speciesIdBySlug.get(entry.species);
        if (speciesId === undefined) return [];
        // An entry that names no weight inherits the species' own authoring
        // default, so "the usual rates here" needs no numbers in the file.
        const fallback = content.species.find((s) => s.slug === entry.species);
        const weight = entry.weight ?? Math.max(1, fallback?.perSpeciesWeight ?? 1);
        return [{ regionId: region.id, speciesId, weight }];
      });
      if (poolRows.length > 0) {
        await tx.insert(regionEncounterPools).values(poolRows);
        regionPoolEntries += poolRows.length;
      }

      const shopRows = region.shopItems.flatMap((itemSlug) => {
        const itemId = itemIdBySlug.get(itemSlug);
        return itemId === undefined ? [] : [{ regionId: region.id, itemId }];
      });
      if (shopRows.length > 0) {
        await tx.insert(regionShopItems).values(shopRows);
        regionShopEntries += shopRows.length;
      }
    }

    const summary: SeedSummary = {
      items: content.items.length,
      species: content.species.length,
      disabledItems: disabledItems.length,
      disabledSpecies: disabledSpecies.length,
      regionPoolEntries,
      regionShopEntries,
    };
    logger.info(summary, 'content seeded');
    return summary;
  });
}
