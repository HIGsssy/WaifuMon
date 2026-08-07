/**
 * AppearanceService — the gallery, the selection, and the unlock bookkeeping.
 *
 * **This file is the cosmetic firewall.** It deliberately imports no gameplay
 * service: not progression, not battle, not affinity, not care, not capture,
 * not collection. It reads `player_waifus.level` (to decide a level gate) and
 * writes exactly two columns — `variant` (the selected appearance) and
 * `seen_appearances` (notification bookkeeping) — plus an audit row. There is
 * no code path from choosing artwork to a stat, an XP grant, an affection tick,
 * an evolution step, or a capture roll, and the import list is what keeps it
 * that way. `tests/unit/appearanceService.test.ts` asserts the import boundary
 * so a future edit cannot quietly cross it.
 *
 * Unlock state is **derived** (`appearanceRules.isUnlocked`), never persisted.
 * What *is* persisted is whether the player has been told, which is what stops
 * a Level-40 copy from firing six toasts the first time milestone artwork
 * ships. Two writers keep it current:
 *
 *   - `syncUnlocks`, called inside the caller's transaction by every path that
 *     can raise a waifu's level (capture, essence investment, buddy hunts,
 *     Care Mode ticks);
 *   - `listAppearances`, which acknowledges on read, so a player who levels
 *     past a milestone *before* the artwork exists still gets the notification
 *     the first time they open the gallery. That is what makes retroactive
 *     content adds free — no cron, no backfill.
 *
 * Assets never leave here as paths: every payload carries `AssetId` only.
 */
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  playerProgressionEvents,
  playerWaifus,
  species as speciesTable,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import {
  AppearanceLockedError,
  AppearanceNotFoundError,
  WaifuAlreadyReleasedError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { AssetId, CosmeticRarity, LoadedContent, SpeciesContent } from '../content/schemas';
import {
  appearanceForVariant,
  resolveAppearances,
  type AppearanceSpecies,
  type ResolvedAppearance,
} from './appearanceContent';
import { detectNewlyUnlocked, isAppearanceUnlocked } from './appearanceRules';

/** Audit vocabulary for `player_progression_events.event_type`. */
export const APPEARANCE_UNLOCK_EVENT = 'appearance_unlock';

/**
 * Why an appearance became available. Drives wording, not behaviour.
 * `content_add` is the retroactive case: the copy already met the requirement
 * when the artwork shipped.
 */
export type AppearanceUnlockSource = 'owned' | 'level' | 'content_add';

/**
 * One appearance as a *player* sees it: the authored metadata plus this
 * copy's state. Never carries a path, URL, or file extension.
 */
export interface AppearanceView {
  id: string;
  name: string;
  description: string | null;
  flavorText: string | null;
  cosmeticRarity: CosmeticRarity;
  introducedVersion: string | null;
  assetId: AssetId;
  /** Structured requirement, for clients that want to render it themselves. */
  unlock: ResolvedAppearance['unlock'];
  /** Human-readable requirement — shown on locked *and* unlocked tiles. */
  unlockLabel: string;
  isUnlocked: boolean;
  isSelected: boolean;
}

export interface AppearanceGallery {
  appearances: AppearanceView[];
  /** The appearance id currently stored on `player_waifus.variant`. */
  selected: string;
}

/**
 * The minimum a renderer needs to announce one unlock. `assetId` is embedded
 * so a Discord toast, an activity-feed line, or a Portal notification can show
 * the artwork without a second lookup.
 */
export interface AppearanceUnlockRef {
  waifuId: number;
  speciesSlug: string;
  appearanceId: string;
  name: string;
  assetId: AssetId;
  cosmeticRarity: CosmeticRarity;
  unlockLabel: string;
  source: AppearanceUnlockSource;
}

export interface SelectAppearanceResult {
  waifu: PlayerWaifuRow;
  appearance: AppearanceView;
}

export interface AppearanceService {
  /**
   * The full gallery for one owned copy — locked entries included, each with
   * its requirement. Acknowledges any newly-unlocked entries as a side effect
   * (transactional), which is the retroactive-content path.
   */
  listAppearances(playerId: number, waifuId: number): Promise<AppearanceGallery>;
  /**
   * Point `player_waifus.variant` at a different appearance. Validates
   * ownership, that the appearance exists, and that it is unlocked. Writes one
   * column and nothing else.
   */
  selectAppearance(
    playerId: number,
    waifuId: number,
    appearanceId: string,
  ): Promise<SelectAppearanceResult>;
  /**
   * Detect + acknowledge inside the caller's transaction. Called by every path
   * that can raise a copy's level, and by the capture path for the `owned`
   * default. Returns only the unlocks worth announcing (the default appearance
   * is acknowledged silently — nobody wants a toast for "you own her").
   */
  syncUnlocks(
    tx: DbOrTx,
    waifu: PlayerWaifuRow,
    species?: SpeciesRow | AppearanceSpecies,
    source?: AppearanceUnlockSource,
  ): Promise<AppearanceUnlockRef[]>;
  /**
   * Append to `seen_appearances` and write one audit row per unlock.
   * Idempotent: ids already present are dropped, so a double call is a no-op.
   */
  acknowledgeUnlocks(
    tx: DbOrTx,
    waifu: PlayerWaifuRow,
    speciesSlug: string,
    appearances: readonly ResolvedAppearance[],
    source: AppearanceUnlockSource,
  ): Promise<AppearanceUnlockRef[]>;
  /** The appearance a copy is currently wearing. Pure lookup, no query. */
  currentAppearance(
    species: SpeciesRow | AppearanceSpecies,
    variant: string | null | undefined,
  ): ResolvedAppearance;
  /** The species' catalog, resolved and ordered. Pure lookup, no query. */
  catalogFor(species: SpeciesRow | AppearanceSpecies): ResolvedAppearance[];
  /** Content-snapshot lookup by slug; null when the species is unknown. */
  speciesContent(slug: string): SpeciesContent | null;
}

export interface AppearanceServiceDeps {
  db: Db;
  /**
   * Read at call time, never captured — the admin panel republishes the
   * snapshot on "Save + Reload", and a gallery must reflect artwork that just
   * shipped without a restart.
   */
  getContent: () => LoadedContent;
}

/**
 * A seeded `species` row carries no appearance catalog (the catalog is content,
 * not database state), so anything holding a row is upgraded to the authored
 * species before resolution. Falling back to the row itself keeps the function
 * total: a species missing from the snapshot still renders its implicit
 * `standard` appearance rather than throwing.
 */
function toAppearanceSpecies(
  species: SpeciesRow | AppearanceSpecies,
  lookup: (slug: string) => SpeciesContent | null,
): AppearanceSpecies {
  if ('appearances' in species && species.appearances !== undefined) {
    return species as AppearanceSpecies;
  }
  const authored = lookup(species.slug);
  if (authored) return authored;
  return {
    slug: species.slug,
    contentRating: species.contentRating as AppearanceSpecies['contentRating'],
    appearances: undefined,
  };
}

export function createAppearanceService(deps: AppearanceServiceDeps): AppearanceService {
  const { db, getContent } = deps;

  const speciesContent = (slug: string): SpeciesContent | null =>
    getContent().species.find((s) => s.slug === slug) ?? null;

  const asAppearanceSpecies = (species: SpeciesRow | AppearanceSpecies): AppearanceSpecies =>
    toAppearanceSpecies(species, speciesContent);

  const catalogFor = (species: SpeciesRow | AppearanceSpecies): ResolvedAppearance[] =>
    resolveAppearances(asAppearanceSpecies(species));

  const currentAppearance = (
    species: SpeciesRow | AppearanceSpecies,
    variant: string | null | undefined,
  ): ResolvedAppearance => appearanceForVariant(asAppearanceSpecies(species), variant);

  function toRef(
    waifuId: number,
    speciesSlug: string,
    appearance: ResolvedAppearance,
    source: AppearanceUnlockSource,
  ): AppearanceUnlockRef {
    return {
      waifuId,
      speciesSlug,
      appearanceId: appearance.id,
      name: appearance.name,
      assetId: appearance.assetId,
      cosmeticRarity: appearance.cosmeticRarity,
      unlockLabel: appearance.unlockLabel,
      source,
    };
  }

  /** Loads the owned copy and its species row, or throws the usual 404s. */
  async function loadOwned(
    tx: DbOrTx,
    playerId: number,
    waifuId: number,
    lock = false,
  ): Promise<{ waifu: PlayerWaifuRow; species: SpeciesRow }> {
    const base = tx
      .select({ waifu: playerWaifus, species: speciesTable })
      .from(playerWaifus)
      .innerJoin(speciesTable, eq(playerWaifus.speciesId, speciesTable.id))
      .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)));
    const [row] = lock ? await base.for('update', { of: playerWaifus }) : await base;
    if (!row) throw new WaifuNotOwnedError(waifuId);
    if (row.waifu.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
    return row;
  }

  async function acknowledgeUnlocks(
    tx: DbOrTx,
    waifu: PlayerWaifuRow,
    speciesSlug: string,
    appearances: readonly ResolvedAppearance[],
    source: AppearanceUnlockSource,
  ): Promise<AppearanceUnlockRef[]> {
    const seen = new Set(waifu.seenAppearances ?? []);
    const fresh = appearances.filter((a) => !seen.has(a.id));
    if (fresh.length === 0) return [];

    const nextSeen = [...seen, ...fresh.map((a) => a.id)];
    await tx
      .update(playerWaifus)
      .set({ seenAppearances: nextSeen })
      .where(eq(playerWaifus.id, waifu.id));
    // Keep the caller's in-hand row consistent with the write, so a second
    // `syncUnlocks` in the same transaction is genuinely idempotent.
    waifu.seenAppearances = nextSeen;

    // The default appearance is marked seen but never logged: "she came
    // wearing her own artwork" explains nothing, and one such row per capture
    // would be pure noise in a log whose job is explaining progression. Only
    // appearances that were *earned* are audit-worthy.
    const auditable = fresh.filter((a) => a.unlock.type !== 'owned');
    if (auditable.length > 0) {
      // `xpDelta: 0` — the audit log is shared with XP grants, and an
      // appearance unlock is explicitly worth no XP. `refId` points at the
      // owned copy so an investigation can join back to it.
      await tx.insert(playerProgressionEvents).values(
        auditable.map((appearance) => ({
          playerId: waifu.playerId,
          eventType: APPEARANCE_UNLOCK_EVENT,
          xpDelta: 0,
          refId: waifu.id,
          metadata: {
            waifuId: waifu.id,
            speciesSlug,
            appearanceId: appearance.id,
            appearanceName: appearance.name,
            assetId: appearance.assetId,
            cosmeticRarity: appearance.cosmeticRarity,
            unlockLabel: appearance.unlockLabel,
            source,
          } satisfies Record<string, unknown>,
        })),
      );
    }

    return fresh.map((a) => toRef(waifu.id, speciesSlug, a, source));
  }

  async function syncUnlocks(
    tx: DbOrTx,
    waifu: PlayerWaifuRow,
    species?: SpeciesRow | AppearanceSpecies,
    source: AppearanceUnlockSource = 'level',
  ): Promise<AppearanceUnlockRef[]> {
    let resolvedSpecies = species;
    if (!resolvedSpecies) {
      const [row] = await tx
        .select()
        .from(speciesTable)
        .where(eq(speciesTable.id, waifu.speciesId));
      // A waifu whose species vanished cannot be styled; silently skipping is
      // right here — this runs inside a gameplay transaction and must never
      // fail a capture or a level-up over cosmetics.
      if (!row) return [];
      resolvedSpecies = row;
    }

    const appearanceSpecies = asAppearanceSpecies(resolvedSpecies);
    const catalog = resolveAppearances(appearanceSpecies);
    const fresh = detectNewlyUnlocked(
      catalog,
      { level: waifu.level },
      waifu.seenAppearances ?? [],
    );
    if (fresh.length === 0) return [];

    const acknowledged = await acknowledgeUnlocks(
      tx,
      waifu,
      appearanceSpecies.slug,
      fresh,
      source,
    );
    // The default appearance is acknowledged so it never re-fires, but it is
    // not announced: "you unlocked the look she already came in" is noise.
    return acknowledged.filter((ref) => {
      const appearance = fresh.find((a) => a.id === ref.appearanceId);
      return appearance != null && appearance.unlock.type !== 'owned';
    });
  }

  return {
    speciesContent,
    catalogFor,
    currentAppearance,
    acknowledgeUnlocks,
    syncUnlocks,

    async listAppearances(playerId, waifuId) {
      const { waifu, species } = await loadOwned(db, playerId, waifuId);
      const appearanceSpecies = asAppearanceSpecies(species);
      const catalog = resolveAppearances(appearanceSpecies);
      const ctx = { level: waifu.level };

      // Retroactive-unlock path (plan §2.4, on-read): artwork that shipped
      // after this copy already met its requirement is acknowledged the first
      // time the gallery is opened. Cheap — a query only when something is
      // genuinely new — and it means no reconciler job exists to fall behind.
      const fresh = detectNewlyUnlocked(catalog, ctx, waifu.seenAppearances ?? []);
      if (fresh.length > 0) {
        await db.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(playerWaifus)
            .where(eq(playerWaifus.id, waifuId))
            .for('update');
          if (!locked || locked.releasedAt != null) return;
          // Re-detect under the lock: a concurrent level-up may have
          // acknowledged some of these already.
          const stillFresh = detectNewlyUnlocked(
            catalog,
            { level: locked.level },
            locked.seenAppearances ?? [],
          );
          if (stillFresh.length === 0) return;
          await acknowledgeUnlocks(
            tx,
            locked,
            appearanceSpecies.slug,
            stillFresh,
            'content_add',
          );
        });
      }

      const selected = currentAppearance(species, waifu.variant).id;
      return {
        selected,
        appearances: catalog.map((appearance) => ({
          id: appearance.id,
          name: appearance.name,
          description: appearance.description,
          flavorText: appearance.flavorText,
          cosmeticRarity: appearance.cosmeticRarity,
          introducedVersion: appearance.introducedVersion,
          assetId: appearance.assetId,
          unlock: appearance.unlock,
          unlockLabel: appearance.unlockLabel,
          isUnlocked: isAppearanceUnlocked(appearance, ctx),
          isSelected: appearance.id === selected,
        })),
      };
    },

    async selectAppearance(playerId, waifuId, appearanceId) {
      return db.transaction(async (tx) => {
        const { waifu, species } = await loadOwned(tx, playerId, waifuId, true);
        const appearanceSpecies = asAppearanceSpecies(species);
        const catalog = resolveAppearances(appearanceSpecies);

        const target = catalog.find((a) => a.id === appearanceId);
        if (!target) throw new AppearanceNotFoundError(appearanceId, appearanceSpecies.slug);
        if (!isAppearanceUnlocked(target, { level: waifu.level })) {
          throw new AppearanceLockedError(appearanceId, target.unlockLabel);
        }

        // The one write. `variant` and nothing else — no level, no xp, no
        // affection, no favorite flag. The integration suite diffs the row.
        const [updated] = await tx
          .update(playerWaifus)
          .set({ variant: appearanceId })
          .where(eq(playerWaifus.id, waifuId))
          .returning();

        return {
          waifu: updated!,
          appearance: {
            id: target.id,
            name: target.name,
            description: target.description,
            flavorText: target.flavorText,
            cosmeticRarity: target.cosmeticRarity,
            introducedVersion: target.introducedVersion,
            assetId: target.assetId,
            unlock: target.unlock,
            unlockLabel: target.unlockLabel,
            isUnlocked: true,
            isSelected: true,
          },
        };
      });
    },
  };
}
