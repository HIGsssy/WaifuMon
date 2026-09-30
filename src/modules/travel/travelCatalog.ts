/**
 * The read-only projection of region + travel content that every travel
 * service and screen reads from.
 *
 * Built once per content snapshot (and rebuilt by the admin panel's Reload
 * Content, because the services take a `getContent()` closure rather than a
 * destructured value). Nothing here touches the database — it answers "what
 * does content say about this destination", never "what does this player own".
 */
import { DEFAULT_REGION, isRegion, regionLabel, type Region } from '../locations/regions';
import type {
  KeyItemRecipeConfig,
  LoadedContent,
  RegionContent,
  TravelKeyItemRouteConfig,
  TravelPassConfig,
  TravelRouteConfig,
} from '../content/schemas';

/** A released destination, with the content that gates and prices it. */
export interface DestinationDefinition {
  region: RegionContent;
  /**
   * How this destination is reached.
   *
   * `'starting'` is Waifu Valley: always reachable, never bought, and the
   * reason it has no `player_unlocked_routes` row. `'route'` is a purchase
   * against a pass. `'key_item'` is holding a permanent key item — the
   * Assteroid Belt and its Transporter Beacon — which is checked on every
   * trip and never consumed; route rows are ignored for these destinations.
   */
  access: 'starting' | 'route' | 'key_item';
  /** The key-item gate. Non-null exactly when `access` is `'key_item'`. */
  keyItem: {
    gate: TravelKeyItemRouteConfig;
    name: string;
    emoji: string | null;
    /** The recipe that builds the key, if content defines one. */
    recipe: KeyItemRecipeConfig | null;
  } | null;
  /** Null for the starting region. */
  route: TravelRouteConfig | null;
  /** The pass a route stamps onto. Null for the starting region. */
  pass: TravelPassConfig | null;
  /**
   * True when buying `pass` for the first time also grants this route. That is
   * what makes "buy the Caravan Pass" and "unlock Twin Peeks" one purchase and
   * one price rather than two, without hard-coding either id in a service.
   */
  grantedByPassPurchase: boolean;
  /** Total cost of reaching this destination from nothing, in `currency`. */
  price: number;
  currency: 'waifubux' | 'essence';
  /**
   * The stricter of the pass's and the route's level gates, or a key-item
   * gate's own. Null means no level requirement at all — nothing is compared
   * and nothing is shown — which only a key-item gate can express.
   */
  requiredLevel: number | null;
}

export interface TravelCatalog {
  enabled: boolean;
  /** Every *enabled* region, starting region first, then by `order` then id. */
  destinations: DestinationDefinition[];
  passes: TravelPassConfig[];
  startingRegion: Region;
  get(regionId: string): DestinationDefinition | null;
  getPass(passId: string): TravelPassConfig | null;
  /** Player-facing name, falling back to the id-derived label. */
  label(regionId: string): string;
}

/**
 * Projects a content snapshot into the travel catalog.
 *
 * Disabled regions are dropped here rather than filtered at each call site,
 * which is what makes "unreleased destinations are hidden" a property of the
 * catalog instead of a rule five screens have to remember. A region that is
 * disabled is not merely un-buyable: it does not exist as far as travel is
 * concerned, so a stale button naming it fails with "nowhere by that name".
 */
export function buildTravelCatalog(content: LoadedContent): TravelCatalog {
  const travel = content.tables.travel;
  const routeByRegion = new Map(travel.routes.map((r) => [r.regionId, r]));
  const passById = new Map<string, TravelPassConfig>(travel.passes.map((p) => [p.id, p]));
  const keyGateByRegion = new Map(travel.keyItemRoutes.map((g) => [g.regionId, g]));

  const destinations: DestinationDefinition[] = content.regions
    .filter((region) => region.enabled)
    .map((region) => {
      if (region.id === DEFAULT_REGION) {
        return {
          region,
          access: 'starting' as const,
          keyItem: null,
          route: null,
          pass: null,
          grantedByPassPurchase: false,
          price: 0,
          currency: 'waifubux' as const,
          requiredLevel: 1,
        };
      }
      const gate = keyGateByRegion.get(region.id);
      if (gate) {
        const item = content.items.find((i) => i.slug === gate.keyItem);
        const recipe = content.tables.keyItemRecipes.find((r) => r.output === gate.keyItem) ?? null;
        return {
          region,
          access: 'key_item' as const,
          keyItem: {
            gate,
            name: item?.name ?? gate.keyItem,
            emoji: item?.emoji ?? null,
            recipe,
          },
          route: null,
          pass: null,
          grantedByPassPurchase: false,
          // The construction cost, so any surface that prints a price for
          // a locked destination prints the real one.
          price: recipe?.waifubux ?? 0,
          currency: 'waifubux' as const,
          requiredLevel: gate.requiredLevel,
        };
      }
      const route = routeByRegion.get(region.id) ?? null;
      const pass = route ? (passById.get(route.passId) ?? null) : null;
      const grantedByPassPurchase = pass ? pass.grantsRoutes.includes(region.id) : false;
      // A destination the pass itself covers costs the pass price; one that is
      // stamped on later costs its own fee. Content decides which by whether
      // the region appears in `grantsRoutes`, so adding a paid destination is
      // a JSON edit and adding a free one is the same JSON edit.
      const price = grantedByPassPurchase ? (pass?.price ?? 0) : (route?.price ?? 0);
      const currency = grantedByPassPurchase
        ? (pass?.currency ?? 'waifubux')
        : (route?.currency ?? 'waifubux');
      return {
        region,
        access: 'route' as const,
        keyItem: null,
        route,
        pass,
        grantedByPassPurchase,
        price,
        currency,
        requiredLevel: Math.max(pass?.requiredLevel ?? 1, route?.requiredLevel ?? 1),
      };
    })
    .sort((a, b) => {
      if (a.region.id === DEFAULT_REGION) return -1;
      if (b.region.id === DEFAULT_REGION) return 1;
      return a.region.order - b.region.order || a.region.id.localeCompare(b.region.id);
    });

  const byId = new Map<string, DestinationDefinition>(destinations.map((d) => [d.region.id, d]));

  return {
    enabled: travel.enabled,
    destinations,
    passes: travel.passes,
    startingRegion: DEFAULT_REGION,
    get: (regionId) => byId.get(regionId) ?? null,
    getPass: (passId) => passById.get(passId) ?? null,
    label: (regionId) => byId.get(regionId)?.region.name ?? regionLabel(regionId),
  };
}

/** Narrows a stored column value to a canonical region, defaulting on garbage. */
export function toRegion(value: string | null | undefined): Region {
  return isRegion(value) ? value : DEFAULT_REGION;
}
