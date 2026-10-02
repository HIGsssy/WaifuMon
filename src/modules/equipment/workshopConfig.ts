/**
 * Patch's Workshop configuration — salvage yields and fabrication recipes.
 *
 * Deployed content (`content/equipment/workshop.json`), read by the content
 * loader and followed live through `getContent()`, exactly like the affix
 * catalogue. Not database content and not admin-editable in V1: retuning is a
 * deploy, so every surface (Discord, Portal) reads the same numbers from one
 * place and none of them hardcodes a cost or a yield.
 *
 * ## Salvage yields
 *
 * Components per dismantled copy, **by rarity only** — a terrible roll and a
 * perfect roll of the same rarity are worth the same. A rarity with no entry
 * cannot be dismantled at all: there is no default, and nothing is ever
 * "treated as SR".
 *
 * ## Recipes
 *
 * A recipe guarantees a rarity and charges Components + WaifuBux. The rarity
 * must be one random Equipment can roll (`N` / `R` / `SR` — the rarities with
 * affix pools), because fabrication goes through the normal random-reward
 * path. The slot is the player's choice at fabrication time, not part of the
 * recipe.
 *
 * ## The loop must be a sink
 *
 * Validation refuses a recipe whose Component cost does not exceed the salvage
 * yield of the copy it makes: otherwise fabricate → dismantle would print
 * Components. Dismantling never pays WaifuBux, so the WaifuBux side cannot
 * loop at all.
 *
 * Kept free of database imports so the content loader can validate the file.
 */
import { z } from 'zod';
import { RARITIES } from '../../db/schema';
import { EQUIPMENT_AFFIX_RARITIES } from './affixCatalogue';
import { EQUIPMENT_KEY_MAX_LENGTH, EQUIPMENT_KEY_PATTERN } from './vocabulary';

/** Relative to the content directory. */
export const EQUIPMENT_WORKSHOP_FILE = 'equipment/workshop.json';
export const EQUIPMENT_WORKSHOP_FILE_FORMAT = 'waifumon-equipment-workshop' as const;
export const EQUIPMENT_WORKSHOP_FILE_VERSION = 1 as const;

/** Rarities a recipe may guarantee — exactly those random Equipment can roll. */
export const WORKSHOP_RECIPE_RARITIES = EQUIPMENT_AFFIX_RARITIES;

/** Sanity ceilings, not tuning. */
const MAX_YIELD = 10_000;
const MAX_COMPONENT_COST = 100_000;
const MAX_WAIFUBUX_COST = 10_000_000;

export const WorkshopRecipeSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(EQUIPMENT_KEY_MAX_LENGTH)
      .regex(EQUIPMENT_KEY_PATTERN, 'key must be lowercase snake_case'),
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(200).optional(),
    rarity: z.enum(WORKSHOP_RECIPE_RARITIES),
    componentCost: z.number().int().min(1).max(MAX_COMPONENT_COST),
    waifubuxCost: z.number().int().min(0).max(MAX_WAIFUBUX_COST),
    enabled: z.boolean(),
  })
  .strict();
export type WorkshopRecipe = z.infer<typeof WorkshopRecipeSchema>;

export const EquipmentWorkshopFileSchema = z
  .object({
    format: z.literal(EQUIPMENT_WORKSHOP_FILE_FORMAT),
    version: z.literal(EQUIPMENT_WORKSHOP_FILE_VERSION),
    salvageYields: z
      .record(z.string(), z.number().int().min(1).max(MAX_YIELD))
      .superRefine((yields, ctx) => {
        for (const rarity of Object.keys(yields)) {
          if (!(RARITIES as readonly string[]).includes(rarity)) {
            ctx.addIssue({ code: 'custom', path: [rarity], message: `unknown rarity "${rarity}"` });
          }
        }
      }),
    recipes: z.array(WorkshopRecipeSchema).max(20),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, recipe] of file.recipes.entries()) {
      if (seen.has(recipe.key)) {
        ctx.addIssue({ code: 'custom', path: ['recipes', index, 'key'], message: `duplicate recipe key "${recipe.key}"` });
      }
      seen.add(recipe.key);
      const salvage = file.salvageYields[recipe.rarity];
      if (salvage !== undefined && recipe.componentCost <= salvage) {
        ctx.addIssue({
          code: 'custom',
          path: ['recipes', index, 'componentCost'],
          message:
            `must exceed the ${recipe.rarity} salvage yield (${salvage}), ` +
            'or fabricating and dismantling would create Components',
        });
      }
    }
  });
export type EquipmentWorkshopFile = z.infer<typeof EquipmentWorkshopFileSchema>;

/** The validated configuration as the Workshop reads it. */
export interface WorkshopConfig {
  /** Components per dismantled copy, by rarity. A missing rarity cannot be dismantled. */
  salvageYields: Readonly<Record<string, number>>;
  recipes: readonly WorkshopRecipe[];
}

export function workshopConfigFromFile(file: EquipmentWorkshopFile): WorkshopConfig {
  return { salvageYields: { ...file.salvageYields }, recipes: [...file.recipes] };
}

/** Components a copy of `rarity` dismantles for, or null when that rarity is not salvageable. */
export function salvageYieldOf(config: WorkshopConfig | null, rarity: string): number | null {
  if (!config) return null;
  return Object.hasOwn(config.salvageYields, rarity) ? config.salvageYields[rarity]! : null;
}

/** Salvageable rarities in ladder order, with their yields. */
export function salvageYieldList(config: WorkshopConfig | null): { rarity: string; components: number }[] {
  if (!config) return [];
  return RARITIES.filter((r) => Object.hasOwn(config.salvageYields, r)).map((rarity) => ({
    rarity,
    components: config.salvageYields[rarity]!,
  }));
}
