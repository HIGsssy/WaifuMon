/**
 * WildEncounterSpawner — the one way anything other than a hunt roll puts a
 * wild Waifumon in front of a player.
 *
 * A hunt reaches a wild encounter by spending Energy, honouring a cooldown and
 * rolling the result table. Everything *else* that wants to say "a wild
 * Waifumon appears" — a World Encounter choice, a quest step, a used item, a
 * seasonal event, an exploration find, a deity's favour — wants only the last
 * step of that: an `encounters` row the existing capture flow can pick up.
 * Before this module the only way to get one was to go through the hunt, which
 * would have meant charging Energy and re-rolling the species the caller had
 * already chosen.
 *
 * So this is deliberately *not* a second hunt. It does no capture math, no
 * rarity math and no reward math: it writes one row and hands it back, and
 * every subsequent click (charm selection, capture attempt, Let Her Go) runs
 * through {@link CaptureService} exactly as a hunted encounter does. The whole
 * point is that the encounter is indistinguishable from a hunted one the
 * moment it exists.
 *
 * ## Invariants
 *
 * 1. **Server-authoritative.** The caller passes a species *slug*; the row is
 *    written from the `species` table, never from anything a client sent.
 *    Disabled species are refused.
 * 2. **Idempotent.** `(origin.kind, origin.ref)` is a unique key in the
 *    database (partial index — hunted rows are exempt). A replayed spawn —
 *    a double-clicked Continue, a retried job — returns the encounter the
 *    first call created rather than a second one. This is enforced by the
 *    index, not by a read-then-write check, so it holds under concurrency.
 * 3. **Respects the one-active-encounter rule.** The same
 *    `encounters_active_player_uq` partial index that stops a player holding
 *    two hunted encounters applies here. A player already mid-encounter gets
 *    `blocked` and the caller decides how to narrate it — the spawner never
 *    silently discards the encounter the player is already in.
 * 4. **Costs nothing unless asked.** Hunt Energy is spent only when
 *    `consumeHuntEnergy` is set, and no cooldown is stamped either way.
 *    A scripted spawn is a reward, not a hunt.
 *
 * ## Transactions
 *
 * `createWildEncounter` accepts an optional `tx`. World Encounter resolution
 * passes the transaction it is already in, so the spawn commits or rolls back
 * with the choice that caused it — there is no window in which the effects
 * were applied but the Waifumon never appeared. Callers with no transaction of
 * their own get one opened for them.
 */
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  encounters,
  species,
  type EncounterRow,
  type SpeciesRow,
  type WildEncounterOriginKind,
} from '../../db/schema';
import type { CurrencyService } from '../currency/currencyService';
import { isUniqueViolation } from '../../shared/errors';
import type { Logger } from '../../shared/logger';

/**
 * What caused this spawn. `ref` is the causing subsystem's own identifier —
 * for a World Encounter, the `active_world_encounters.id` that resolved — and
 * together with `kind` it is the idempotency key.
 *
 * A caller with genuinely nothing stable to key on may pass `ref: null`, which
 * opts out of replay protection. Prefer not to: without a ref, a retry spawns
 * a second encounter (or, more likely, is refused by the one-active-encounter
 * rule with a confusing `blocked`).
 */
export interface WildEncounterOrigin {
  kind: WildEncounterOriginKind;
  ref: string | null;
}

export interface CreateWildEncounterOptions {
  playerId: number;
  /**
   * The species to spawn. Omit to let the injected picker choose, which draws
   * from the same region/rarity pools a hunt does — see
   * {@link WildEncounterSpawnerDeps.pickSpecies}.
   */
  speciesSlug?: string | undefined;
  /** Discord channel the encounter belongs to, mirroring the hunt's column. */
  channelId: string;
  /** Snapshot of where she was met. Nothing reads it back to decide anything. */
  regionId?: string | null | undefined;
  origin: WildEncounterOrigin;
  /** Player level, for the fallback species picker. Ignored when a slug is given. */
  playerLevel?: number | undefined;
  /** Defaults to the hunt's own encounter expiry. */
  expirySeconds?: number | undefined;
  /** Defaults to 3, matching a hunted encounter. */
  maxAttempts?: number | undefined;
  /**
   * Spend one Hunt Energy for this spawn. Off by default: a scripted
   * encounter is something the game gave the player, not something they paid
   * for. Set it only where the design explicitly says the spawn costs Energy.
   */
  consumeHuntEnergy?: boolean | undefined;
  /** Join an in-flight transaction instead of opening one. */
  tx?: DbOrTx | undefined;
  now?: Date | undefined;
}

/**
 * Every way a spawn can end. Deliberately a result rather than an exception
 * for the non-error cases: "she is already here" and "you are already in an
 * encounter" are both normal states a caller renders, not failures.
 */
export type WildEncounterSpawn =
  /** A new row was written. */
  | { status: 'created'; encounter: EncounterRow; species: SpeciesRow }
  /** This `(kind, ref)` had already spawned — the original is returned. */
  | { status: 'existing'; encounter: EncounterRow; species: SpeciesRow }
  /** The player is mid-encounter with someone else; nothing was written. */
  | { status: 'blocked'; reason: 'active_encounter'; activeEncounterId: number }
  /** Nothing to spawn: the slug is unknown/disabled, or no pool has a species. */
  | { status: 'unavailable'; reason: 'unknown_species' | 'no_species_available' }
  /** `consumeHuntEnergy` was set and the player had none. */
  | { status: 'unavailable'; reason: 'insufficient_energy' };

export interface WildEncounterSpawner {
  createWildEncounter(opts: CreateWildEncounterOptions): Promise<WildEncounterSpawn>;
  /**
   * Read one spawned (or hunted) encounter back, scoped to its owner. The
   * `playerId` argument is not optional on purpose: every caller reaching this
   * from a Discord custom id must prove ownership, and making the scope part
   * of the signature is what stops one being forgotten.
   */
  getPlayerEncounter(
    playerId: number,
    encounterId: number,
    now?: Date,
  ): Promise<{ encounter: EncounterRow; species: SpeciesRow } | null>;
}

export interface WildEncounterSpawnerDeps {
  db: Db;
  currency: CurrencyService;
  logger: Logger;
  /** Hunt's encounter expiry, so a spawned encounter lives exactly as long. */
  getDefaultExpirySeconds: () => number;
  /**
   * Species picker for spawns that name no species. Wired to the hunt
   * service's own region/rarity pool draw, so "a wild Waifumon appears" means
   * the same distribution the player would have met by hunting here — without
   * this module re-implementing any of that math. Absent, a spawn with no
   * slug reports `no_species_available`.
   */
  pickSpecies?:
    | ((
        tx: DbOrTx,
        playerId: number,
        playerLevel: number,
        regionId: string | null,
      ) => Promise<SpeciesRow | null>)
    | undefined;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export function createWildEncounterSpawner(
  deps: WildEncounterSpawnerDeps,
): WildEncounterSpawner {
  /** Find the row a previous identical spawn wrote, if any. */
  async function findByOrigin(
    tx: DbOrTx,
    origin: WildEncounterOrigin,
  ): Promise<EncounterRow | null> {
    if (origin.ref == null) return null;
    const [row] = await tx
      .select()
      .from(encounters)
      .where(and(eq(encounters.originKind, origin.kind), eq(encounters.originRef, origin.ref)));
    return row ?? null;
  }

  async function loadSpeciesById(tx: DbOrTx, id: number): Promise<SpeciesRow | null> {
    const [row] = await tx.select().from(species).where(eq(species.id, id));
    return row ?? null;
  }

  async function run(
    tx: DbOrTx,
    opts: CreateWildEncounterOptions,
    now: Date,
  ): Promise<WildEncounterSpawn> {
    // 1. Replay check. Cheap, and covers the overwhelmingly common
    //    double-click case without touching the insert path at all. The
    //    unique index below is what makes it correct under concurrency.
    const replay = await findByOrigin(tx, opts.origin);
    if (replay) {
      const sp = await loadSpeciesById(tx, replay.speciesId);
      if (sp) return { status: 'existing', encounter: replay, species: sp };
      // A species deleted out from under a spawned row is a content problem,
      // not a reason to spawn a second encounter.
      return { status: 'unavailable', reason: 'unknown_species' };
    }

    // 2. One-active-encounter rule, with the same lazy expiry a hunt does.
    const [active] = await tx
      .select()
      .from(encounters)
      .where(and(eq(encounters.playerId, opts.playerId), eq(encounters.state, 'active')))
      .for('update');
    if (active) {
      if (active.expiresAt.getTime() <= now.getTime()) {
        await tx
          .update(encounters)
          .set({ state: 'expired', resolvedAt: now })
          .where(eq(encounters.id, active.id));
      } else {
        return { status: 'blocked', reason: 'active_encounter', activeEncounterId: active.id };
      }
    }

    // 3. Resolve the species server-side. A slug the caller supplied is a
    //    lookup key, never a source of stats.
    let picked: SpeciesRow | null = null;
    if (opts.speciesSlug) {
      const [row] = await tx
        .select()
        .from(species)
        .where(and(eq(species.slug, opts.speciesSlug), eq(species.enabled, true)));
      if (!row) return { status: 'unavailable', reason: 'unknown_species' };
      picked = row;
    } else if (deps.pickSpecies) {
      picked = await deps.pickSpecies(
        tx,
        opts.playerId,
        opts.playerLevel ?? 1,
        opts.regionId ?? null,
      );
    }
    if (!picked) return { status: 'unavailable', reason: 'no_species_available' };

    // 4. Energy, only when the caller explicitly asked for it to cost some.
    if (opts.consumeHuntEnergy) {
      const balances = await deps.currency.lockCurrencies(tx, opts.playerId);
      if (balances.huntEnergy < 1) {
        return { status: 'unavailable', reason: 'insufficient_energy' };
      }
      await deps.currency.setHuntEnergy(tx, opts.playerId, balances.huntEnergy - 1);
    }

    const expiresAt = new Date(
      now.getTime() + (opts.expirySeconds ?? deps.getDefaultExpirySeconds()) * 1000,
    );

    try {
      const [inserted] = await tx
        .insert(encounters)
        .values({
          playerId: opts.playerId,
          speciesId: picked.id,
          channelId: opts.channelId,
          state: 'active',
          attemptCount: 0,
          maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          expiresAt,
          regionId: opts.regionId ?? null,
          originKind: opts.origin.kind,
          originRef: opts.origin.ref,
        })
        .returning();
      if (!inserted) throw new Error('createWildEncounter: no row returned');
      return { status: 'created', encounter: inserted, species: picked };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race. Which index decided it tells us what to report — and
      // both answers are states the caller already knows how to render.
      const raced = await findByOrigin(tx, opts.origin);
      if (raced) {
        const sp = await loadSpeciesById(tx, raced.speciesId);
        if (sp) return { status: 'existing', encounter: raced, species: sp };
      }
      const [other] = await tx
        .select()
        .from(encounters)
        .where(and(eq(encounters.playerId, opts.playerId), eq(encounters.state, 'active')));
      if (other) {
        return { status: 'blocked', reason: 'active_encounter', activeEncounterId: other.id };
      }
      throw err;
    }
  }

  async function createWildEncounter(
    opts: CreateWildEncounterOptions,
  ): Promise<WildEncounterSpawn> {
    const now = opts.now ?? new Date();
    const outcome = opts.tx
      ? await run(opts.tx, opts, now)
      : await deps.db.transaction((tx) => run(tx, opts, now));
    if (outcome.status === 'unavailable') {
      deps.logger.warn(
        {
          tag: 'wild-encounter/spawn-unavailable',
          playerId: opts.playerId,
          originKind: opts.origin.kind,
          originRef: opts.origin.ref,
          speciesSlug: opts.speciesSlug ?? null,
          reason: outcome.reason,
        },
        'wild encounter spawn produced nothing',
      );
    }
    return outcome;
  }

  async function getPlayerEncounter(
    playerId: number,
    encounterId: number,
    now: Date = new Date(),
  ): Promise<{ encounter: EncounterRow; species: SpeciesRow } | null> {
    const [row] = await deps.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.id, encounterId), eq(encounters.playerId, playerId)));
    if (!row) return null;
    if (row.state !== 'active') return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    const sp = await loadSpeciesById(deps.db, row.speciesId);
    if (!sp) return null;
    return { encounter: row, species: sp };
  }

  return { createWildEncounter, getPlayerEncounter };
}
