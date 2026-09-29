/**
 * Key-item recipes — turn in components and WaifuBux, receive one permanent
 * key item. The Transporter Beacon (which gates the Assteroid Belt) is the
 * first and currently only recipe.
 *
 * Everything reuses the ordinary item plumbing: components and the output are
 * rows in `items` with category `key`, owned through `player_inventory`, and
 * granted by the same reward systems as everything else. What this module adds
 * is the recipe itself (`tables.keyItemRecipes`) and one transactional
 * operation, `construct`, which follows the Shop's money-path shape exactly:
 *
 *   lock the currency row (serializes this player's clicks) → validate every
 *   component and the output-not-yet-owned rule *before* charging → deduct
 *   WaifuBux conditionally → consume each component conditionally → grant the
 *   output → audit row — all inside one `db.transaction`.
 *
 * The output is a `key` item with `max_owned = 1`, which `inventory.addItem`
 * enforces inside its own upsert. That is the database-level backstop under
 * the application check: a second construction that somehow slipped past the
 * currency lock would fail on the grant, and the whole transaction — the
 * WaifuBux and the components with it — would roll back.
 */
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { items, keyItemConstructions, playerInventory } from '../../db/schema';
import {
  ItemOwnershipLimitError,
  KeyItemAlreadyOwnedError,
  KeyItemComponentsMissingError,
  KeyItemRecipeNotFoundError,
} from '../../shared/errors';
import type { KeyItemRecipeConfig, LoadedContent } from '../content/schemas';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';

export interface RecipeItemRef {
  slug: string;
  name: string;
  emoji: string | null;
}

export interface RecipeComponentProgress extends RecipeItemRef {
  required: number;
  /** Held right now. May exceed `required`; only `required` is consumed. */
  owned: number;
  complete: boolean;
  /** Where to look, from content. Empty when the author gave none. */
  hint: string;
}

export interface RecipeProgress {
  recipeId: string;
  output: RecipeItemRef;
  /** Already built — the recipe is done and construction would refuse. */
  outputOwned: boolean;
  components: RecipeComponentProgress[];
  waifubux: { required: number; owned: number; complete: boolean };
  /** Every component and the WaifuBux are in hand, and the output is not. */
  ready: boolean;
}

export interface ConstructOutcome {
  recipeId: string;
  output: RecipeItemRef;
  consumed: { slug: string; name: string; quantity: number }[];
  waifubuxSpent: number;
  balanceAfter: number;
}

export interface KeyItemService {
  /** Read-only: what the player holds against the recipe. */
  getProgress(playerId: number, recipeId: string): Promise<RecipeProgress>;
  /** Build the output. Transactional — see the module comment. */
  construct(playerId: number, recipeId: string): Promise<ConstructOutcome>;
}

export interface KeyItemServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  /** Read through a closure so a content reload retunes recipes live. */
  getContent: () => LoadedContent;
}

/**
 * The pure progress rule — what the Locations screen renders and what
 * `construct` refuses on, from the same inputs. `itemRef` resolves a slug to a
 * display name; `owned` is quantity by slug.
 */
export function evaluateRecipe(
  recipe: KeyItemRecipeConfig,
  itemRef: (slug: string) => RecipeItemRef,
  owned: ReadonlyMap<string, number>,
  waifubux: number,
): RecipeProgress {
  const outputOwned = (owned.get(recipe.output) ?? 0) > 0;
  const components = recipe.inputs.map((input) => {
    const have = owned.get(input.item) ?? 0;
    return {
      ...itemRef(input.item),
      required: input.quantity,
      owned: have,
      complete: have >= input.quantity,
      hint: input.hint,
    };
  });
  const bux = { required: recipe.waifubux, owned: waifubux, complete: waifubux >= recipe.waifubux };
  return {
    recipeId: recipe.id,
    output: itemRef(recipe.output),
    outputOwned,
    components,
    waifubux: bux,
    ready: !outputOwned && bux.complete && components.every((c) => c.complete),
  };
}

/** "Quantum Stabilizer 1/2, Phase Coupler 0/1" — the short list of what is short. */
export function describeMissing(progress: RecipeProgress): string {
  return progress.components
    .filter((c) => !c.complete)
    .map((c) => `${c.name} ${c.owned}/${c.required}`)
    .join(', ');
}

export function createKeyItemService(deps: KeyItemServiceDeps): KeyItemService {
  const { db, currency, inventory } = deps;

  function recipes(): KeyItemRecipeConfig[] {
    return deps.getContent().tables.keyItemRecipes;
  }

  function requireRecipe(recipeId: string): KeyItemRecipeConfig {
    const recipe = recipes().find((r) => r.id === recipeId);
    if (!recipe) throw new KeyItemRecipeNotFoundError(recipeId);
    return recipe;
  }

  function slugsOf(recipe: KeyItemRecipeConfig): string[] {
    return [recipe.output, ...recipe.inputs.map((i) => i.item)];
  }

  /** Display names come from content, which is what the seeder wrote. */
  function itemRef(slug: string): RecipeItemRef {
    const item = deps.getContent().items.find((i) => i.slug === slug);
    return { slug, name: item?.name ?? slug, emoji: item?.emoji ?? null };
  }

  async function ownedBySlug(
    tx: DbOrTx,
    playerId: number,
    slugs: string[],
  ): Promise<Map<string, number>> {
    const rows = await tx
      .select({ slug: items.slug, quantity: playerInventory.quantity })
      .from(playerInventory)
      .innerJoin(items, eq(items.id, playerInventory.itemId))
      .where(
        and(
          eq(playerInventory.playerId, playerId),
          inArray(items.slug, slugs),
          gt(playerInventory.quantity, 0),
        ),
      );
    return new Map(rows.map((r) => [r.slug, r.quantity]));
  }

  return {
    async getProgress(playerId, recipeId) {
      const recipe = requireRecipe(recipeId);
      const [owned, balances] = await Promise.all([
        ownedBySlug(db, playerId, slugsOf(recipe)),
        currency.getBalances(playerId),
      ]);
      return evaluateRecipe(recipe, itemRef, owned, balances.waifubux);
    },

    async construct(playerId, recipeId) {
      const recipe = requireRecipe(recipeId);
      return db.transaction(async (tx) => {
        // Lock the currency row first, exactly as the Shop and travel do. This
        // serializes this player's concurrent construct clicks, so every read
        // below sees state nobody else can change underneath it.
        const balances = await currency.lockCurrencies(tx, playerId);

        const rows = await tx
          .select({ id: items.id, slug: items.slug })
          .from(items)
          .where(inArray(items.slug, slugsOf(recipe)));
        const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
        const outputId = idBySlug.get(recipe.output);
        if (outputId == null) throw new KeyItemRecipeNotFoundError(recipeId);

        // Validate everything before any write, via the same rule the screen
        // renders — so the message names exactly what the screen showed.
        const owned = await ownedBySlug(tx, playerId, slugsOf(recipe));
        const progress = evaluateRecipe(recipe, itemRef, owned, balances.waifubux);
        if (progress.outputOwned) {
          throw new KeyItemAlreadyOwnedError(recipeId, progress.output.name);
        }
        if (!progress.components.every((c) => c.complete)) {
          throw new KeyItemComponentsMissingError(
            recipeId,
            progress.output.name,
            describeMissing(progress),
          );
        }

        // Conditional deduct: `spendWaifubux` throws InsufficientFundsError
        // under its own `WHERE waifubux >= n`, rolling back with nothing spent.
        const balanceAfter =
          recipe.waifubux > 0
            ? (await currency.spendWaifubux(tx, playerId, recipe.waifubux)).waifubux
            : balances.waifubux;

        // Conditional decrements. The pre-check above already passed, so these
        // are the atomic backstop rather than the decision.
        const consumed: ConstructOutcome['consumed'] = [];
        for (const input of recipe.inputs) {
          const itemId = idBySlug.get(input.item);
          if (itemId == null) throw new KeyItemRecipeNotFoundError(recipeId);
          await inventory.consumeItem(tx, playerId, itemId, input.quantity);
          consumed.push({ slug: input.item, name: itemRef(input.item).name, quantity: input.quantity });
        }

        // The grant. `max_owned = 1` makes this the database's last word on
        // "one beacon per player": a duplicate that won every race above still
        // dies here, and takes the deduction and the components with it.
        try {
          await inventory.addItem(tx, playerId, outputId, 1);
        } catch (err) {
          if (err instanceof ItemOwnershipLimitError) {
            throw new KeyItemAlreadyOwnedError(recipeId, progress.output.name);
          }
          throw err;
        }

        await tx.insert(keyItemConstructions).values({
          playerId,
          recipeId,
          outputItemId: outputId,
          source: 'construct',
          waifubuxSpent: recipe.waifubux,
          inputs: recipe.inputs.map((i) => ({ slug: i.item, quantity: i.quantity })),
          balanceAfter,
        });

        return {
          recipeId,
          output: progress.output,
          consumed,
          waifubuxSpent: recipe.waifubux,
          balanceAfter,
        } satisfies ConstructOutcome;
      });
    },
  };
}
