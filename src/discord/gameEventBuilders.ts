/**
 * Descriptor builders — the translation layer between service result shapes
 * and the `GameEvent` catalog.
 *
 * Kept out of the render code on purpose: these are pure-ish (one optional
 * name lookup) and unit-testable, and they keep every handler's emission
 * block down to "build descriptors, emit descriptors".
 */
import type { AppearanceUnlockRef } from '../modules/appearance/appearanceService';
import { crossedAffectionStage } from '../modules/collection/affectionStages';
import type { CareTickSummary } from '../modules/care/careService';
import type { CaptureAttemptResult } from '../modules/capture/captureService';
import type { HuntResult } from '../modules/hunt/huntService';
import type { CareExitReason, GameEventDescriptor } from '../modules/events/gameEvents';
import { gameEvent } from '../modules/events/gameEvents';
import { rarityAtLeast } from '../modules/capture/captureMath';
import type { Rarity } from '../db/schema';
import type { AppContext, Provisioned } from './types';

/**
 * How a copy is named in **public** narration: her nickname when she has one,
 * her species name otherwise.
 *
 * Deliberately not the collection UI's `displayName`, which renders
 * "Nickname (Species)" — that parenthetical is useful when a player is
 * scanning their own list, and noise in a log line someone else is reading.
 * Every public producer goes through here so the log stays consistent.
 */
export function publicWaifuName(entry: {
  waifu: { nickname: string | null };
  species: { name: string };
}): string {
  return entry.waifu.nickname?.trim() || entry.species.name;
}

/** Nickname when set, species name otherwise. */
export function careTargetName(summary: CareTickSummary): string | null {
  const target = summary.target;
  if (!target) return null;
  return publicWaifuName(target);
}

/** Look up a display name for an owned waifu; never throws. */
async function ownedWaifuName(
  ctx: AppContext,
  playerId: number,
  waifuId: number,
): Promise<string> {
  try {
    return publicWaifuName(await ctx.services.collection.getOwned(playerId, waifuId));
  } catch {
    return 'their Waifumon';
  }
}

/** `PLAYER_LEVEL_UP` per level crossed. */
export function levelUpDescriptors(
  levelUps: readonly { toLevel: number; rewardLabels: readonly string[] }[],
): GameEventDescriptor[] {
  return levelUps.map((lu) =>
    gameEvent('PLAYER_LEVEL_UP', { level: lu.toLevel, rewardLabels: lu.rewardLabels }),
  );
}

/**
 * `WAIFU_APPEARANCE_UNLOCKED` per newly-earned cosmetic.
 *
 * Deliberately generic: the payload is the shared progression-notification
 * shape (name, requirement, rarity badge, `assetId`), so a future
 * evolution / achievement / gift toast reuses this exact pattern instead of
 * growing a parallel pipeline.
 *
 * `waifuName` is passed in rather than looked up — every caller already has the
 * copy in hand, and a cosmetic toast must not cost a query on a hunt path.
 */
export function appearanceUnlockDescriptors(
  unlocks: readonly AppearanceUnlockRef[],
  waifuName: string,
): GameEventDescriptor[] {
  return unlocks.map((unlock) =>
    gameEvent('WAIFU_APPEARANCE_UNLOCKED', {
      waifuId: unlock.waifuId,
      waifuName,
      speciesSlug: unlock.speciesSlug,
      appearanceId: unlock.appearanceId,
      appearanceName: unlock.name,
      assetId: unlock.assetId,
      cosmeticRarity: unlock.cosmeticRarity,
      unlockLabel: unlock.unlockLabel,
      source: unlock.source,
    }),
  );
}

/**
 * Buddy XP/affection consequences shared by the hunt and Care Mode paths:
 * a level-up line and, when a named affection threshold was crossed, a
 * milestone line.
 */
function buddyProgressDescriptors(input: {
  buddyName: string;
  waifuId: number;
  fromLevel: number;
  toLevel: number;
  affectionAfter: number;
  affectionGained: number;
  /** Cosmetic unlocks the same XP produced. Narrated after the level line. */
  newAppearances?: readonly AppearanceUnlockRef[] | undefined;
}): GameEventDescriptor[] {
  const out: GameEventDescriptor[] = [];
  if (input.toLevel > input.fromLevel) {
    out.push(
      gameEvent('BUDDY_LEVEL_UP', {
        waifuId: input.waifuId,
        buddyName: input.buddyName,
        level: input.toLevel,
      }),
    );
  }
  const stage = crossedAffectionStage(
    input.affectionAfter - input.affectionGained,
    input.affectionAfter,
  );
  if (stage) {
    out.push(
      gameEvent('AFFECTION_MILESTONE', {
        waifuId: input.waifuId,
        buddyName: input.buddyName,
        affection: input.affectionAfter,
        stage: stage.name,
      }),
    );
  }
  out.push(...appearanceUnlockDescriptors(input.newAppearances ?? [], input.buddyName));
  return out;
}

/**
 * `CARE_TICK_APPLIED` (internal) plus any buddy level-up / affection
 * milestone the ticks produced. Empty when no ticks were credited.
 */
export function careTickDescriptors(summary: CareTickSummary): GameEventDescriptor[] {
  if (summary.ticksProcessed <= 0) return [];
  const buddyName = careTargetName(summary);
  const waifuId = summary.target?.waifu.id ?? null;
  const out: GameEventDescriptor[] = [
    gameEvent('CARE_TICK_APPLIED', {
      waifuId,
      buddyName,
      ticksProcessed: summary.ticksProcessed,
      energyGained: summary.energyGained,
      waifuXpGained: summary.waifuXpGained,
      affectionGained: summary.affectionGained,
    }),
  ];
  if (buddyName && waifuId != null && summary.target) {
    out.push(
      ...buddyProgressDescriptors({
        buddyName,
        waifuId,
        fromLevel: summary.fromLevel ?? summary.target.waifu.level,
        toLevel: summary.toLevel ?? summary.target.waifu.level,
        affectionAfter: summary.target.waifu.affection,
        affectionGained: summary.affectionGained,
        newAppearances: summary.newAppearances,
      }),
    );
  }
  return out;
}

/** `PLAYER_ENTERED_CARE`, plus any ticks the start call credited first. */
export function careEnterDescriptors(summary: CareTickSummary): GameEventDescriptor[] {
  const buddyName = careTargetName(summary);
  const waifuId = summary.target?.waifu.id;
  if (!buddyName || waifuId == null) return careTickDescriptors(summary);
  return [
    ...careTickDescriptors(summary),
    gameEvent('PLAYER_ENTERED_CARE', { waifuId, buddyName }),
  ];
}

/** `CARE_BUDDY_CHANGED` (internal) — Care Mode stayed on, the target moved. */
export function careChangedDescriptors(summary: CareTickSummary): GameEventDescriptor[] {
  const buddyName = careTargetName(summary);
  const waifuId = summary.target?.waifu.id;
  if (!buddyName || waifuId == null) return careTickDescriptors(summary);
  return [
    ...careTickDescriptors(summary),
    gameEvent('CARE_BUDDY_CHANGED', { waifuId, buddyName }),
  ];
}

/**
 * `PLAYER_LEFT_CARE`, plus any ticks credited on the way out. Empty when the
 * player wasn't in Care Mode — `stopped` is the service's own "this call
 * cleared the care fields" flag, so a no-op leave stays silent.
 */
export function careLeaveDescriptors(
  summary: CareTickSummary,
  reason: CareExitReason,
): GameEventDescriptor[] {
  if (!summary.stopped) return careTickDescriptors(summary);
  return [
    ...careTickDescriptors(summary),
    gameEvent('PLAYER_LEFT_CARE', {
      waifuId: summary.target?.waifu.id ?? null,
      buddyName: careTargetName(summary),
      reason,
    }),
  ];
}

/**
 * What a lazy `care.applyPending` produced. Two outcomes matter:
 *   - ticks were credited → internal `CARE_TICK_APPLIED` (+ any buddy
 *     milestones), so the Trainer Profile refreshes in place;
 *   - the service self-healed a broken Care Mode (the target was released
 *     underneath) → `PLAYER_LEFT_CARE` with `reason: 'auto_stop'`, so the
 *     Trainer Profile is taken down rather than left pointing at nothing.
 */
export function carePendingDescriptors(summary: CareTickSummary): GameEventDescriptor[] {
  if (summary.stopped) return careLeaveDescriptors(summary, 'auto_stop');
  return careTickDescriptors(summary);
}

/**
 * Everything one `hunt()` call produced: the Care Mode exit it forced, the
 * hunt-session boundary it crossed, the roll outcome, and any progression.
 */
export async function huntDescriptors(
  ctx: AppContext,
  prov: Provisioned,
  result: HuntResult,
): Promise<GameEventDescriptor[]> {
  const out: GameEventDescriptor[] = [];

  // Hunting always exits Care Mode — the Trainer Profile has to come down.
  if (result.careExit) {
    out.push(...careLeaveDescriptors(result.careExit, 'hunt'));
  }

  // Housekeeping sweep of an abandoned session, then the new session opening.
  const { session } = result;
  if (session.closedPreviousReason) {
    const tracked = ctx.huntSessions.close(prov.playerId);
    const location =
      tracked?.location ??
      ctx.huntSessions.fallbackLocation(
        prov.playerId,
        session.previousLastHuntAt ?? session.at,
      );
    out.push(
      gameEvent('PLAYER_COMPLETED_HUNT', { location, reason: session.closedPreviousReason }),
    );
  }
  if (session.opened) {
    const location = ctx.huntSessions.open(prov.playerId, session.at);
    out.push(gameEvent('PLAYER_STARTED_HUNT', { location }));
  }

  switch (result.kind) {
    case 'encounter':
      out.push(
        gameEvent('PLAYER_ENCOUNTER', {
          encounterId: result.encounter.id,
          speciesName: result.species.name,
          rarity: result.species.rarity as Rarity,
        }),
      );
      break;
    case 'item_find':
    case 'rare_item_find':
      out.push(
        gameEvent('PLAYER_FOUND_ITEM', {
          itemSlug: result.item.slug,
          itemName: result.item.name,
          quantity: result.quantity,
          rare: result.kind === 'rare_item_find',
        }),
      );
      break;
    case 'waifubux_find':
      out.push(
        gameEvent('PLAYER_FOUND_WAIFUBUX', {
          amount: result.amount,
          balanceAfter: result.balanceAfter,
        }),
      );
      break;
    case 'essence_find':
      out.push(
        gameEvent('PLAYER_FOUND_ESSENCE', {
          amount: result.amount,
          balanceAfter: result.balanceAfter,
        }),
      );
      break;
    case 'flavor':
      break;
  }

  out.push(...levelUpDescriptors(result.levelUps));

  const award = result.buddyAward;
  if (
    award &&
    (award.toLevel > award.fromLevel ||
      award.affectionGranted > 0 ||
      award.newAppearances.length > 0)
  ) {
    const buddyName = await ownedWaifuName(ctx, prov.playerId, award.waifu.id);
    out.push(
      ...buddyProgressDescriptors({
        buddyName,
        waifuId: award.waifu.id,
        fromLevel: award.fromLevel,
        toLevel: award.toLevel,
        affectionAfter: award.waifu.affection,
        affectionGained: award.affectionGranted,
        newAppearances: award.newAppearances,
      }),
    );
  }

  return out;
}

/**
 * Everything one capture attempt produced.
 *
 * `PLAYER_CAPTURE_FAILED` fires only when the encounter actually ends
 * (`escape`). A mid-run resisted attempt is not "she slipped away" — the
 * player still has charms left — and narrating every miss would drown the
 * feed. The retryable case is still visible to the player, ephemerally.
 *
 * SR+ successes are emitted with `major` visibility; the Activity Feed
 * suppresses them so the existing rich embed remains the single public
 * announcement for a rare catch.
 */
export async function captureDescriptors(
  ctx: AppContext,
  prov: Provisioned,
  result: CaptureAttemptResult,
): Promise<GameEventDescriptor[]> {
  const out: GameEventDescriptor[] = [];
  const rarity = result.species.rarity as Rarity;

  if (result.outcome === 'success') {
    const rich = rarityAtLeast(rarity, ctx.content.tables.capture.announceMinRarity);
    out.push(
      gameEvent(
        'PLAYER_CAPTURE_SUCCESS',
        {
          speciesName: result.species.name,
          rarity,
          isDuplicate: result.isDuplicate,
          waifuId: result.newWaifu?.id ?? null,
        },
        rich ? 'major' : 'normal',
      ),
    );
  } else if (result.outcome === 'escape') {
    out.push(
      gameEvent('PLAYER_CAPTURE_FAILED', {
        speciesName: result.species.name,
        rarity,
        attempts: result.attempt.attemptNumber,
      }),
    );
  }

  out.push(...levelUpDescriptors(result.levelUps));

  // Cosmetics a brand-new copy already qualifies for. Normally empty — the
  // default appearance is acknowledged silently — so this costs a name lookup
  // only when a species ships extra day-one artwork.
  if (result.newAppearances.length > 0 && result.newWaifu) {
    const name = await ownedWaifuName(ctx, prov.playerId, result.newWaifu.id);
    out.push(...appearanceUnlockDescriptors(result.newAppearances, name));
  }

  // Collection milestone: only worth a query when this capture was a new dex
  // entry, which is the only way the collection can become complete.
  if (result.outcome === 'success' && result.isNewDex) {
    try {
      const dex = await ctx.services.collection.getDexStats(prov.playerId);
      if (dex.totalSpecies > 0 && dex.distinctSpecies >= dex.totalSpecies) {
        out.push(
          gameEvent('COLLECTION_COMPLETED', {
            distinctSpecies: dex.distinctSpecies,
            totalSpecies: dex.totalSpecies,
          }),
        );
      }
    } catch (err) {
      ctx.logger.warn({ err, playerId: prov.playerId }, 'dex-completion check failed');
    }
  }

  return out;
}
