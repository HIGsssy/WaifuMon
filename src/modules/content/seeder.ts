import { notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { items, species } from '../../db/schema';
import type { Logger } from '../../shared/logger';
import type { LoadedContent } from './schemas';

export interface SeedSummary {
  items: number;
  species: number;
  disabledItems: number;
  disabledSpecies: number;
}

/**
 * Upserts content by slug: new slugs insert, existing slugs update mutable
 * fields, and DB slugs missing from JSON are flagged disabled (never deleted —
 * owned waifus must keep their species row). Idempotent.
 */
export async function seedContent(db: Db, content: LoadedContent, logger: Logger): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    for (const item of content.items) {
      await tx
        .insert(items)
        .values({
          slug: item.slug,
          name: item.name,
          category: item.category,
          captureModifier: item.captureModifier,
          isGuaranteedCapture: item.isGuaranteedCapture,
          purchasable: item.purchasable,
          buyPrice: item.buyPrice,
          dailyStockLimit: item.dailyStockLimit,
          description: item.description,
          emoji: item.emoji,
          enabled: item.enabled,
        })
        .onConflictDoUpdate({
          target: items.slug,
          set: {
            name: item.name,
            category: item.category,
            captureModifier: item.captureModifier,
            isGuaranteedCapture: item.isGuaranteedCapture,
            purchasable: item.purchasable,
            buyPrice: item.buyPrice,
            dailyStockLimit: item.dailyStockLimit,
            description: item.description,
            emoji: item.emoji,
            enabled: item.enabled,
          },
        });
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

    const summary: SeedSummary = {
      items: content.items.length,
      species: content.species.length,
      disabledItems: disabledItems.length,
      disabledSpecies: disabledSpecies.length,
    };
    logger.info(summary, 'content seeded');
    return summary;
  });
}
