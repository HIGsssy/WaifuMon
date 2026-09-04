/**
 * WorldEncounterService — the public facade for the encounter system.
 *
 * Two audiences:
 *
 *   1. Gameplay callers (Hunt, Travel, Discord button handler): fire a
 *      selection roll → present the resulting encounter → resolve a
 *      chosen option.
 *   2. Admin surfaces (server-rendered panel, HTTP API): CRUD + preview +
 *      single-roll simulation.
 *
 * Everything is transactional at the resolution boundary: `resolveChoice`
 * opens one `db.transaction()`, locks the active row (`SELECT … FOR UPDATE`),
 * checks it is still pending, applies effects, writes history, sets the
 * cooldown row, and flips the row to `resolved` — every failure rolls back
 * together, so a second click on the same button sees the row in `resolved`
 * and returns idempotently.
 */
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  activeWorldEncounters,
  playerWaifus,
  players,
  species,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import { defaultRng, type Rng } from '../../shared/random';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { ProgressionService } from '../progression/progressionService';
import type { CollectionService } from '../collection/collectionService';
import type { BuddyBonusService } from '../buddyBonus/buddyBonusService';
import { currentSeductivePower } from '../power/seductivePower';
import { resolveRace } from '../cards/race';
import { AppError, PlayerNotFoundError } from '../../shared/errors';
import { selectEncounter } from './engine';
import { rollCheck, computeChance } from './checkResolver';
import { createEffectExecutor, type EffectExecutor, type AppliedEffect, type FollowUp } from './effectExecutor';
import { hydrateEncounter } from './hydrate';
import type { WorldEncounterVendorService } from './vendorService';
import type {
  WildEncounterSpawn,
  WildEncounterSpawner,
} from '../encounters/wildEncounterSpawner';
import {
  createWorldEncounterRepository,
  type WorldEncounterRepository,
} from './worldEncounterRepository';
import type {
  BuddyProfile,
  CheckResolution,
  EncounterCheckContext,
  LoadedChoice,
  LoadedEncounter,
  Requirements,
} from './types';

/** Config knobs read from the loaded content snapshot. */
export interface WorldEncounterConfig {
  huntChance: number;
  travelChance: number;
  /** Default encounter expiration if the definition doesn't override it. */
  defaultExpirySeconds: number;
}

export const DEFAULT_WORLD_ENCOUNTER_CONFIG: WorldEncounterConfig = {
  huntChance: 0,
  travelChance: 0,
  defaultExpirySeconds: 10 * 60,
};

export class WorldEncounterError extends AppError {
  constructor(code: string, message: string, userMessage?: string) {
    super(code, message, userMessage);
  }
}

export class ActiveWorldEncounterError extends WorldEncounterError {
  constructor(public readonly activeId: number) {
    super(
      'active_world_encounter',
      `Player already has a pending encounter (${activeId})`,
      'You already have an encounter open. Finish it before starting another.',
    );
  }
}

export class WorldEncounterExpiredError extends WorldEncounterError {
  constructor() {
    super(
      'world_encounter_expired',
      'This encounter has expired.',
      'This encounter has expired — nothing was consumed.',
    );
  }
}

export class WorldEncounterResolvedError extends WorldEncounterError {
  constructor() {
    super(
      'world_encounter_resolved',
      'This encounter has already been resolved.',
      'You already picked a choice for this encounter.',
    );
  }
}

export class WorldEncounterChoiceMissingError extends WorldEncounterError {
  constructor() {
    super(
      'world_encounter_choice_missing',
      'That choice is no longer available.',
      'That choice is no longer available.',
    );
  }
}

export class WorldEncounterChoiceForbiddenError extends WorldEncounterError {
  constructor(public readonly reason: string) {
    super(
      'world_encounter_choice_forbidden',
      `That choice is unavailable (${reason}).`,
      `That choice is unavailable — ${reason}.`,
    );
  }
}

export interface TryRollOpts {
  playerId: number;
  playerLevel: number;
  guildId: number | null;
  channelId: string | null;
  regionId: string;
  now?: Date;
  /** Uniform in [0, 1) — override for tests. */
  rng?: Rng;
}

export interface TryTravelRollOpts extends TryRollOpts {
  originRegionId: string;
  destinationRegionId: string;
}

export interface EncounterActivation {
  activeId: number;
  encounter: LoadedEncounter;
  buddy: BuddyProfile | null;
  buddyBonusPercent: number;
  /** Convenience: per-choice availability + preview chance for the UI. */
  choiceViews: ChoiceView[];
}

export interface ChoiceView {
  choice: LoadedChoice;
  available: boolean;
  unavailableReason: string | null;
  previewChance: number;
}

export interface ResolveChoiceOpts {
  activeId: number;
  playerId: number;
  choiceId: number;
  now?: Date;
  rng?: Rng;
}

export interface Resolution {
  encounter: LoadedEncounter;
  choice: LoadedChoice;
  check: CheckResolution;
  effectsApplied: AppliedEffect[];
  followUps: FollowUp[];
  chainedEncounterSlug: string | null;
  /**
   * If this resolution opened a chained encounter (via a `trigger_encounter`
   * follow-up or `chainedEncounterSlug`), the id of the pending row the
   * Continue button consumes. Null when there is nothing to continue.
   */
  continuationActiveId: number | null;
  /**
   * Present when the resolution opened a vendor. Discord picks up the id and
   * paints the vendor UI on the same ephemeral.
   */
  vendorInstance: {
    instanceId: number;
    vendorKey: string;
  } | null;
  /**
   * Present when a `trigger_waifumon_encounter` effect fired.
   *
   * `status` is the spawner's own answer, carried through rather than
   * flattened, because all four outcomes are things a player should be told
   * apart: she appeared, she was already waiting (a replayed click), she
   * could not appear because the player is mid-encounter with someone else,
   * or the authored species does not exist. Discord narrates each
   * differently and only paints a button for the first two.
   */
  wildEncounter: {
    status: WildEncounterSpawn['status'];
    encounterId: number | null;
    speciesSlug: string | null;
    speciesName: string | null;
    blockedByEncounterId: number | null;
  } | null;
  /**
   * Set when this encounter interrupted a journey — i.e. `source === 'travel'`.
   * Null for a hunt encounter.
   *
   * The destination is **already committed**: `travelService.travel()` runs and
   * commits before the travel-encounter roll fires, so by the time a player
   * sees this encounter their map has already moved. That is what makes
   * "Continue Journey" pure navigation rather than a second travel
   * transaction — there is nothing left to charge, gate, or move.
   *
   * A chained continuation copies `source` and both region columns from its
   * parent row, so this survives to the end of a chain and the button can
   * reappear at the chain's terminal resolution.
   */
  journey: { destinationRegionId: string | null } | null;
}

export interface WorldEncounterServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  progression: ProgressionService;
  collection: CollectionService;
  buddyBonus: BuddyBonusService | null;
  getConfig: () => WorldEncounterConfig;
  /** Waifu max level, from content. Used by SP formula guard. */
  getMaxWaifuLevel: () => number;
  rng?: Rng;
  /**
   * Optional vendor service — when present, an `open_vendor` follow-up
   * atomically materialises a vendor instance bound to the active encounter
   * so the Discord layer only has to paint it.
   */
  vendor?: WorldEncounterVendorService | undefined;
  /**
   * Optional wild-encounter spawner — when present, a
   * `trigger_waifumon_encounter` follow-up spawns a real, capturable wild
   * encounter inside the resolution transaction. Absent, the follow-up stays
   * the informational marker it was before Phase 2 closed, which is what a
   * deployment without the hunt/capture graph wired should do.
   */
  wildEncounters?: WildEncounterSpawner | undefined;
}

/**
 * Buddy Bonus effect id keyed here so a rename lands in one place. Added to
 * the registry in {@link BUDDY_BONUS_EFFECT_IDS} — a species that authors
 * `buddyBonus.effectId: "encounter_check_bonus"` grants a flat +N% to every
 * SP check her buddy takes.
 */
const CHECK_BONUS_EFFECT_ID = 'encounter_check_bonus' as const;

export function createWorldEncounterService(deps: WorldEncounterServiceDeps) {
  const rng = deps.rng ?? defaultRng();
  const repo: WorldEncounterRepository = createWorldEncounterRepository(deps.db);
  const executor: EffectExecutor = createEffectExecutor({
    currency: deps.currency,
    inventory: deps.inventory,
    progression: deps.progression,
    collection: deps.collection,
  });

  /* ─────────────────── Player + buddy snapshot ─────────────────── */

  async function loadBuddyProfile(
    tx: DbOrTx,
    playerId: number,
  ): Promise<BuddyProfile | null> {
    const [player] = await tx.select().from(players).where(eq(players.id, playerId));
    if (!player) throw new PlayerNotFoundError(playerId);
    if (player.buddyWaifuId == null) return null;
    const [pair] = await tx
      .select({ waifu: playerWaifus, species })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(eq(playerWaifus.id, player.buddyWaifuId));
    if (!pair || pair.waifu.releasedAt != null) return null;
    return buddyProfileFrom(pair.waifu, pair.species);
  }

  function buddyProfileFrom(waifu: PlayerWaifuRow, sp: SpeciesRow): BuddyProfile {
    const level = waifu.level;
    const currentSp = safeCurrentSp(waifu.baseSp, level, deps.getMaxWaifuLevel());
    const raceTags = extractRaceTags(sp);
    return {
      waifuId: waifu.id,
      speciesSlug: sp.slug,
      speciesName: sp.name,
      level,
      affinity: sp.affinity,
      baseSp: waifu.baseSp,
      currentSp,
      rarity: sp.rarity,
      raceTags,
    };
  }

  /**
   * The buddy's "race tags" — a superset that carries anything a choice
   * requirement or check advantage might want to match against. We include:
   *
   *   - the resolved {@link RaceCode} (e.g. `valkyrie`, `android`, `spirit`)
   *   - the raw archetype
   *   - every string tag on `species.tags`
   *
   * Race is not yet a first-class enum in the schema, so this pragmatic
   * combined list is what encounter authors and tests key off. When a
   * canonical `species.race` column lands, this shrinks to the first entry.
   */
  function extractRaceTags(sp: SpeciesRow): string[] {
    const race = resolveRace({ slug: sp.slug, archetype: sp.archetype });
    const tags = new Set<string>([race]);
    if (sp.archetype) tags.add(sp.archetype);
    const raw = sp.tags;
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry === 'string' && entry.length > 0) tags.add(entry);
      }
    }
    return [...tags];
  }

  function safeCurrentSp(baseSp: number, level: number, maxLevel: number): number {
    // Older test data may hold baseSp=0; the SP formula throws below 1. We
    // clamp defensively — an invalid stored SP is an invisible number for the
    // encounter, not a runtime crash on click.
    try {
      const safeBase = baseSp >= 1 ? baseSp : 1;
      const safeLevel = Math.min(Math.max(1, level), maxLevel);
      return currentSeductivePower(safeBase, safeLevel, maxLevel);
    } catch {
      return baseSp;
    }
  }

  /* ─────────────────── Selection roll ─────────────────── */

  async function tryRollForHunt(opts: TryRollOpts): Promise<EncounterActivation | null> {
    const cfg = deps.getConfig();
    if (cfg.huntChance <= 0) return null;
    const optRng = opts.rng ?? rng;
    if (optRng.next() >= cfg.huntChance) return null;
    return rollAndActivate({ ...opts, source: 'hunt' });
  }

  async function tryRollForTravel(opts: TryTravelRollOpts): Promise<EncounterActivation | null> {
    const cfg = deps.getConfig();
    if (cfg.travelChance <= 0) return null;
    const optRng = opts.rng ?? rng;
    if (optRng.next() >= cfg.travelChance) return null;
    return rollAndActivate({ ...opts, source: 'travel' });
  }

  async function rollAndActivate(
    opts: TryRollOpts & { source: 'hunt' | 'travel'; originRegionId?: string; destinationRegionId?: string },
  ): Promise<EncounterActivation | null> {
    const now = opts.now ?? new Date();
    const cooldownIds = await repo.getCooldownEncounterIds(opts.playerId, now);
    const chosen = await selectEncounter(repo, opts.rng ?? rng, {
      playerId: opts.playerId,
      playerLevel: opts.playerLevel,
      source: opts.source,
      regionId: opts.regionId,
      fromRegion: opts.originRegionId ?? null,
      toRegion: opts.destinationRegionId ?? null,
      cooldownIds,
    });
    if (!chosen) return null;
    return deps.db.transaction(async (tx) => {
      // If the player picked up a pending encounter in a parallel action, the
      // partial unique index fires. We surface it as ActiveWorldEncounterError
      // so the Discord layer can decide (re-show the pending row vs skip).
      try {
        const expiresAt = new Date(now.getTime() + deps.getConfig().defaultExpirySeconds * 1000);
        const active = await repo.insertActive(tx, {
          playerId: opts.playerId,
          encounterId: chosen.id,
          source: opts.source,
          regionId: opts.regionId,
          originRegionId: opts.originRegionId ?? null,
          destinationRegionId: opts.destinationRegionId ?? null,
          guildId: opts.guildId,
          channelId: opts.channelId,
          contextJson: {},
          expiresAt,
        });
        const buddy = await loadBuddyProfile(tx, opts.playerId);
        const buddyBonusPercent =
          (await deps.buddyBonus?.percentFor(tx, opts.playerId, CHECK_BONUS_EFFECT_ID)) ?? 0;
        return {
          activeId: active.id,
          encounter: chosen,
          buddy,
          buddyBonusPercent,
          choiceViews: buildChoiceViews(chosen, {
            playerId: opts.playerId,
            playerLevel: opts.playerLevel,
            buddy,
            buddyBonusPercent,
          }),
        };
      } catch (err) {
        if (isUniquePendingViolation(err)) {
          const existing = await repo.getPendingForPlayer(opts.playerId);
          if (existing) throw new ActiveWorldEncounterError(existing.id);
        }
        throw err;
      }
    });
  }

  function isUniquePendingViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: string }).code;
    return code === '23505';
  }

  /* ─────────────────── Choice availability ─────────────────── */

  function isChoiceAvailable(
    choice: LoadedChoice,
    ctx: EncounterCheckContext,
  ): { available: boolean; reason: string | null } {
    const r = choice.requirements;
    if (r.affinity && (!ctx.buddy || ctx.buddy.affinity !== r.affinity)) {
      return { available: false, reason: `Requires ${r.affinity} affinity` };
    }
    if (r.raceAny && r.raceAny.length > 0) {
      const has = ctx.buddy && r.raceAny.some((tag) => ctx.buddy!.raceTags.includes(tag));
      if (!has) return { available: false, reason: `Requires ${r.raceAny.join('/')}` };
    }
    if (r.minPlayerLevel && ctx.playerLevel < r.minPlayerLevel) {
      return { available: false, reason: `Requires trainer level ${r.minPlayerLevel}` };
    }
    if (r.minBuddyLevel && (!ctx.buddy || ctx.buddy.level < r.minBuddyLevel)) {
      return { available: false, reason: `Requires buddy level ${r.minBuddyLevel}` };
    }
    // `requiresItem` needs the inventory table, which the resolve path re-
    // checks with a lock. Here we approve optimistically and rely on the
    // consume_item effect to fail-soft if the item is gone.
    return { available: true, reason: null };
  }

  function buildChoiceViews(
    encounter: LoadedEncounter,
    ctx: EncounterCheckContext,
  ): ChoiceView[] {
    return encounter.choices.map((choice) => {
      const { available, reason } = isChoiceAvailable(choice, ctx);
      const preview = computeChance(choice.check, ctx);
      return { choice, available, unavailableReason: reason, previewChance: preview.chance };
    });
  }

  /* ─────────────────── Resolution ─────────────────── */

  async function resolveChoice(opts: ResolveChoiceOpts): Promise<Resolution> {
    const now = opts.now ?? new Date();
    const useRng = opts.rng ?? rng;
    return deps.db.transaction(async (tx) => {
      const active = await repo.getActiveById(tx, opts.activeId);
      if (!active) throw new WorldEncounterResolvedError();
      if (active.playerId !== opts.playerId) throw new WorldEncounterChoiceMissingError();
      if (active.status === 'resolved') throw new WorldEncounterResolvedError();
      if (active.status === 'expired' || active.expiresAt.getTime() <= now.getTime()) {
        if (active.status !== 'expired') await repo.markExpired(tx, active.id);
        throw new WorldEncounterExpiredError();
      }

      const loaded = await repo.loadById(tx, active.encounterId);
      if (!loaded) throw new WorldEncounterResolvedError();
      const encounter = hydrateEncounter(loaded);
      const choice = encounter.choices.find((c) => c.id === opts.choiceId);
      if (!choice) throw new WorldEncounterChoiceMissingError();

      const buddy = await loadBuddyProfile(tx, opts.playerId);
      const [playerRow] = await tx
        .select({ level: players.level })
        .from(players)
        .where(eq(players.id, opts.playerId));
      const playerLevel = playerRow?.level ?? 1;
      const buddyBonusPercent =
        (await deps.buddyBonus?.percentFor(tx, opts.playerId, CHECK_BONUS_EFFECT_ID)) ?? 0;
      const ctx: EncounterCheckContext = { playerId: opts.playerId, playerLevel, buddy, buddyBonusPercent };

      const availability = isChoiceAvailable(choice, ctx);
      if (!availability.available) {
        throw new WorldEncounterChoiceForbiddenError(availability.reason ?? 'requirements not met');
      }

      const check = rollCheck(choice.check, ctx, useRng);
      const effectsToApply = check.success ? choice.successEffects : choice.failureEffects;
      const application = await executor.apply(
        tx,
        { playerId: opts.playerId, buddyWaifuId: buddy?.waifuId ?? null, encounterId: encounter.id },
        effectsToApply,
      );

      const cooldownSeconds = encounter.cooldownSeconds;
      if (cooldownSeconds > 0) {
        await repo.upsertCooldown(
          tx,
          opts.playerId,
          encounter.id,
          new Date(now.getTime() + cooldownSeconds * 1000),
        );
      }

      const chainedSlug = encounter.chainedEncounterSlug;
      const followUps = application.followUps.slice();
      if (chainedSlug) {
        followUps.push({ kind: 'trigger_encounter', payload: { encounterSlug: chainedSlug } });
      }

      // Pick the first `trigger_encounter` follow-up (whether it came from an
      // effect or the encounter's own `chainedEncounterSlug`) and materialise
      // it as a pending continuation row. Doing it here means the Continue
      // button is a pure repaint — the row already exists — and a
      // double-click races on the partial unique index the same way a fresh
      // hunt would.
      let continuationActiveId: number | null = null;
      const chainFollowUp = followUps.find((f) => f.kind === 'trigger_encounter');
      if (chainFollowUp) {
        const nextSlug = String(
          (chainFollowUp.payload as { encounterSlug?: string }).encounterSlug ?? '',
        );
        if (nextSlug.length > 0 && nextSlug !== encounter.slug) {
          const nextLoaded = await repo.loadBySlug(nextSlug);
          if (nextLoaded) {
            // Insert continuation *after* the parent is flipped to `resolved`
            // below — that ordering avoids the partial unique index blocking
            // the parent-and-child transition. We hold the id for later.
            continuationActiveId = -1; // sentinel set below
          }
        }
      }

      // Vendor: if the executor produced an `open_vendor` follow-up, spin up
      // the instance now so a Discord repaint has the id ready and every
      // stock decrement is a transactional purchase.
      let vendorInstance: Resolution['vendorInstance'] = null;
      if (deps.vendor) {
        const vendorFollowUp = followUps.find((f) => f.kind === 'open_vendor');
        if (vendorFollowUp) {
          const vendorKey = String(
            (vendorFollowUp.payload as { vendorKey?: string }).vendorKey ?? '',
          );
          if (vendorKey.length > 0) {
            try {
              const opened = await deps.vendor.openForEncounter(tx, active.id, vendorKey);
              vendorInstance = { instanceId: opened.id, vendorKey: opened.vendorKey };
            } catch (err) {
              // Vendor key that isn't wired doesn't break the resolution —
              // the follow-up survives so the Discord layer can render a
              // "vendor unavailable" hint.
              if (err instanceof AppError && err.code !== 'VENDOR_NOT_FOUND') throw err;
            }
          }
        }
      }

      // Wild Waifumon: a `trigger_waifumon_encounter` follow-up spawns a real
      // capturable encounter rather than a line of flavour text. It happens
      // inside this transaction so the encounter and the choice that caused it
      // commit together, and it is keyed on this active row's id — so a
      // replayed Continue click finds the encounter the first one made rather
      // than spawning a second Waifumon.
      let wildEncounter: Resolution['wildEncounter'] = null;
      if (deps.wildEncounters) {
        const wildFollowUp = followUps.find((f) => f.kind === 'trigger_waifumon_encounter');
        if (wildFollowUp) {
          const speciesSlug = (wildFollowUp.payload as { speciesSlug?: string }).speciesSlug;
          const spawn = await deps.wildEncounters.createWildEncounter({
            playerId: opts.playerId,
            ...(speciesSlug ? { speciesSlug } : {}),
            // The world encounter knows the channel it was presented in; a
            // spawned Waifumon belongs to the same conversation.
            channelId: active.channelId ?? '',
            regionId: active.regionId,
            playerLevel,
            origin: { kind: 'world_encounter', ref: String(active.id) },
            // A World Encounter reward never costs Hunt Energy — the player
            // already spent whatever the encounter itself asked of them.
            consumeHuntEnergy: false,
            tx,
            now,
          });
          wildEncounter =
            spawn.status === 'created' || spawn.status === 'existing'
              ? {
                  status: spawn.status,
                  encounterId: spawn.encounter.id,
                  speciesSlug: spawn.species.slug,
                  speciesName: spawn.species.name,
                  blockedByEncounterId: null,
                }
              : {
                  status: spawn.status,
                  encounterId: null,
                  speciesSlug: speciesSlug ?? null,
                  speciesName: null,
                  blockedByEncounterId:
                    spawn.status === 'blocked' ? spawn.activeEncounterId : null,
                };
        }
      }

      const resolution: Record<string, unknown> = {
        choiceId: choice.id,
        success: check.success,
        chance: check.chance,
        roll: check.roll,
        followUps,
        effectsApplied: application.applied,
        vendorInstance,
        wildEncounter,
      };
      await repo.markResolved(tx, active.id, choice.id, resolution);
      await repo.insertHistory(tx, {
        playerId: opts.playerId,
        encounterId: encounter.id,
        choiceId: choice.id,
        source: active.source as 'hunt' | 'travel',
        regionId: active.regionId,
        success: choice.check.type === 'none' ? null : check.success,
        effectsAppliedJson: application.applied as unknown as Record<string, unknown>[],
        startedAt: active.startedAt,
      });

      // Insert the chained continuation now — parent is `resolved`, so the
      // partial unique index will accept the new pending row.
      if (continuationActiveId === -1 && chainFollowUp) {
        const nextSlug = String(
          (chainFollowUp.payload as { encounterSlug?: string }).encounterSlug ?? '',
        );
        const nextLoaded = await repo.loadBySlug(nextSlug);
        if (nextLoaded) {
          const expiresAt = new Date(
            now.getTime() + deps.getConfig().defaultExpirySeconds * 1000,
          );
          const nextRow = await repo.insertActive(tx, {
            playerId: opts.playerId,
            encounterId: nextLoaded.encounter.id,
            source: active.source as 'hunt' | 'travel',
            regionId: active.regionId,
            originRegionId: active.originRegionId,
            destinationRegionId: active.destinationRegionId,
            guildId: active.guildId,
            channelId: active.channelId,
            contextJson: { continuedFrom: encounter.slug },
            expiresAt,
            continuationOfId: active.id,
          });
          continuationActiveId = nextRow.id;
        } else {
          continuationActiveId = null;
        }
      }

      return {
        encounter,
        choice,
        check,
        effectsApplied: application.applied,
        followUps,
        chainedEncounterSlug: chainedSlug,
        continuationActiveId,
        vendorInstance,
        wildEncounter,
        // Read off the active row, never off anything the client sent.
        journey:
          active.source === 'travel'
            ? { destinationRegionId: active.destinationRegionId }
            : null,
      };
    });
  }

  /* ─────────────────── Preview (no side effects) ─────────────────── */

  async function preview(
    encounterSlug: string,
    ctx: PreviewContext,
  ): Promise<{ encounter: LoadedEncounter; choiceViews: ChoiceView[] }> {
    const row = await repo.loadBySlug(encounterSlug);
    if (!row) throw new WorldEncounterChoiceMissingError();
    const encounter = hydrateEncounter(row);
    const previewCtx: EncounterCheckContext = {
      playerId: 0,
      playerLevel: ctx.playerLevel,
      buddy: ctx.buddy,
      buddyBonusPercent: ctx.buddyBonusPercent ?? 0,
    };
    return { encounter, choiceViews: buildChoiceViews(encounter, previewCtx) };
  }

  /* ─────────────────── Retrieval helpers ─────────────────── */

  async function getPendingForPlayer(playerId: number): Promise<EncounterActivation | null> {
    const active = await repo.getPendingForPlayer(playerId);
    if (!active) return null;
    return activationFor(playerId, active);
  }

  async function activationFor(
    playerId: number,
    active: import('../../db/schema').ActiveWorldEncounterRow,
  ): Promise<EncounterActivation | null> {
    const loaded = await repo.loadById(active.encounterId);
    if (!loaded) return null;
    const encounter = hydrateEncounter(loaded);
    const buddy = await loadBuddyProfile(deps.db, playerId);
    const buddyBonusPercent =
      (await deps.buddyBonus?.percentFor(deps.db, playerId, CHECK_BONUS_EFFECT_ID)) ?? 0;
    const [playerRow] = await deps.db
      .select({ level: players.level })
      .from(players)
      .where(eq(players.id, playerId));
    return {
      activeId: active.id,
      encounter,
      buddy,
      buddyBonusPercent,
      choiceViews: buildChoiceViews(encounter, {
        playerId,
        playerLevel: playerRow?.level ?? 1,
        buddy,
        buddyBonusPercent,
      }),
    };
  }

  /**
   * Fetch a specific pending activation by id. Used by the Continue button:
   * a chained encounter's row is written during resolution and this is the
   * lookup the button uses to paint it. Refuses if the row belongs to a
   * different player.
   */
  async function getActivationById(
    activeId: number,
    playerId: number,
  ): Promise<EncounterActivation | null> {
    const [row] = await deps.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.id, activeId));
    if (!row) return null;
    if (row.playerId !== playerId) return null;
    if (row.status !== 'pending') return null;
    return activationFor(playerId, row);
  }

  /**
   * Travel context for a *resolved* encounter, for the Continue Journey
   * button. Returns null when the row is missing, belongs to someone else, or
   * did not come from travel.
   *
   * The caller passes only the active-encounter id; the destination comes from
   * the row. A forged or borrowed id therefore cannot tell the application
   * where to put the player — the worst it can do is fail this lookup.
   *
   * Deliberately does not require a particular status: this resumes a screen
   * and moves nothing, so being lenient costs nothing and keeps a
   * double-clicked button quiet.
   */
  async function getJourneyContext(
    activeId: number,
    playerId: number,
  ): Promise<{ destinationRegionId: string | null } | null> {
    const row = await repo.getActiveById(deps.db, activeId);
    if (!row) return null;
    if (row.playerId !== playerId) return null;
    if (row.source !== 'travel') return null;
    return { destinationRegionId: row.destinationRegionId };
  }

  async function saveMessageId(activeId: number, messageId: string): Promise<void> {
    await deps.db.transaction((tx) => repo.updateActiveMessage(tx, activeId, messageId));
  }

  return {
    tryRollForHunt,
    tryRollForTravel,
    resolveChoice,
    preview,
    getPendingForPlayer,
    getActivationById,
    getJourneyContext,
    saveMessageId,
    repo,
    executor,
  };
}

export interface PreviewContext {
  playerLevel: number;
  buddy: BuddyProfile | null;
  buddyBonusPercent?: number;
}

export type WorldEncounterService = ReturnType<typeof createWorldEncounterService>;
