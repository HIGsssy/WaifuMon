/**
 * World-encounter Discord command handlers.
 *
 * Two entry points:
 *
 *   1. `handleWorldEncounterChoose` — the button handler behind
 *      `encw:choose`. Resolves the chosen option through
 *      {@link WorldEncounterService.resolveChoice}, paints the outcome.
 *   2. `maybeTriggerHuntEncounter` / `maybeTriggerTravelEncounter` — helpers
 *      called from the hunt and travel commands to decide whether to
 *      substitute an interactive encounter for the standard flow.
 *
 * All rendering delegates to {@link worldEncounterPresenter}; nothing here
 * knows how to build an embed. All state changes go through the service.
 */
import type { ButtonInteraction } from 'discord.js';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { respondEphemeral } from '../ephemeralSession';
import {
  buildEncounterPresent,
  buildEncounterResolved,
} from '../worldEncounterPresenter';
import { buildVendorPresent } from '../worldEncounterVendorPresenter';
import type {
  EncounterActivation,
} from '../../modules/worldEncounters/worldEncounterService';
import {
  ActiveWorldEncounterError,
} from '../../modules/worldEncounters/worldEncounterService';
import { AppError } from '../../shared/errors';

/** Resolve a choice on the player's currently-pending encounter. */
export async function handleWorldEncounterChoose(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const service = ctx.services.worldEncounter;
  if (!service) {
    await respondEphemeral(interaction, 'That button no longer works.');
    return;
  }
  const activeId = Number(args[0] ?? '');
  const choiceId = Number(args[1] ?? '');
  if (!Number.isFinite(activeId) || !Number.isFinite(choiceId)) {
    await respondEphemeral(interaction, 'That button is malformed — re-run /waifumon.');
    return;
  }

  try {
    const resolution = await service.resolveChoice({
      activeId,
      playerId: prov.playerId,
      choiceId,
    });
    // Re-fetch the activation for its snapshot fields (buddy, choiceViews are
    // stale after resolution but we only need the encounter to render outcome).
    const activation: EncounterActivation = {
      activeId,
      encounter: resolution.encounter,
      buddy: null,
      buddyBonusPercent: 0,
      choiceViews: [],
    };
    const view = buildEncounterResolved(ctx, activation, resolution);
    await respondEphemeral(interaction, view);
  } catch (err) {
    if (err instanceof AppError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }
}

/**
 * Continue button — consumes a pending chained continuation created by a
 * previous encounter's resolution and paints the next encounter. Every
 * state check is server-side: the button carries only the id, and a
 * missing/mismatched row degrades cleanly to a stale-button message.
 */
export async function handleWorldEncounterContinue(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const service = ctx.services.worldEncounter;
  if (!service) {
    await respondEphemeral(interaction, 'That button no longer works.');
    return;
  }
  const activeId = Number(args[0] ?? '');
  if (!Number.isFinite(activeId)) {
    await respondEphemeral(interaction, 'That button is malformed — re-run /waifumon.');
    return;
  }
  const activation = await service.getActivationById(activeId, prov.playerId);
  if (!activation) {
    await respondEphemeral(interaction, 'This continuation has already been consumed or expired.');
    return;
  }
  const view = buildEncounterPresent(ctx, activation);
  await respondEphemeral(interaction, view);
}

/**
 * Vendor button — one row per stocked item. Runs one transactional
 * purchase and repaints the vendor UI with the new balance and remaining
 * stock. Double-clicks lose the row lock in the vendor service and
 * surface a plain "out of stock" or "insufficient funds".
 */
export async function handleWorldEncounterVendorBuy(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const vendor = ctx.services.worldEncounterVendor;
  if (!vendor) {
    await respondEphemeral(interaction, 'That merchant is no longer open.');
    return;
  }
  const activeId = Number(args[0] ?? '');
  const slug = args[1] ?? '';
  if (!Number.isFinite(activeId) || slug.length === 0) {
    await respondEphemeral(interaction, 'That button is malformed — re-run /waifumon.');
    return;
  }
  try {
    const result = await vendor.purchase(prov.playerId, activeId, slug);
    const summary = `Bought **${result.itemSlug}** for ${result.price} ${
      result.currency === 'essence' ? '✨ Essence' : '💰 WB'
    }. Balance: ${result.balanceAfter}. Remaining: ${result.remaining}.`;
    // Repaint the vendor UI so the row reflects the new stock/balance.
    const opened = await vendor.getForEncounter(activeId);
    if (opened) {
      await respondEphemeral(interaction, buildVendorPresent(opened, summary));
    } else {
      await respondEphemeral(interaction, summary);
    }
  } catch (err) {
    if (err instanceof AppError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }
}

/**
 * Open shop button — repaints the ephemeral with the vendor UI for a
 * previously-opened instance. Refuses cleanly if the instance is gone.
 */
export async function handleWorldEncounterVendorOpen(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const vendor = ctx.services.worldEncounterVendor;
  if (!vendor) {
    await respondEphemeral(interaction, 'That merchant is no longer open.');
    return;
  }
  const activeId = Number(args[0] ?? '');
  if (!Number.isFinite(activeId)) {
    await respondEphemeral(interaction, 'That button is malformed — re-run /waifumon.');
    return;
  }
  const opened = await vendor.getForEncounter(activeId);
  if (!opened || opened.activeEncounterId !== activeId) {
    await respondEphemeral(interaction, 'That merchant has packed up.');
    return;
  }
  await respondEphemeral(interaction, buildVendorPresent(opened));
  // Silence unused warning when the vendor service is present but the
  // player-scoped view of it never needs the auth context here.
  void prov;
}

/**
 * Called from the hunt handler after `hunt.hunt()` returns a non-encounter
 * result. When the roll fires, presents the encounter ephemerally and
 * returns `true`; the caller then skips its normal find embed.
 *
 * The world-encounter feature must never block a hunt: any error here is
 * logged and swallowed. The hunt result is already committed.
 */
export async function maybeTriggerHuntEncounter(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  opts: {
    playerLevel: number;
    regionId: string;
  },
): Promise<boolean> {
  const service = ctx.services.worldEncounter;
  if (!service) return false;
  try {
    const activation = await service.tryRollForHunt({
      playerId: prov.playerId,
      playerLevel: opts.playerLevel,
      guildId: prov.guildDbId,
      channelId: interaction.channelId ?? null,
      regionId: opts.regionId,
    });
    if (!activation) return false;
    const view = buildEncounterPresent(ctx, activation);
    await respondEphemeral(interaction, view);
    return true;
  } catch (err) {
    if (err instanceof ActiveWorldEncounterError) {
      // A prior pending encounter is still open: skip so the standard hunt
      // result renders and the player is not confused by two open flows.
      return false;
    }
    ctx.logger.warn({ err, tag: 'world-encounter/hunt-roll' }, 'world encounter hunt roll failed');
    return false;
  }
}

/**
 * Called from the travel handler after `travel.travel()` succeeds. Same
 * idempotency posture as `maybeTriggerHuntEncounter`: a failure never
 * corrupts a completed travel.
 */
export async function maybeTriggerTravelEncounter(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  opts: {
    playerLevel: number;
    originRegionId: string;
    destinationRegionId: string;
  },
): Promise<boolean> {
  const service = ctx.services.worldEncounter;
  if (!service) return false;
  try {
    const activation = await service.tryRollForTravel({
      playerId: prov.playerId,
      playerLevel: opts.playerLevel,
      guildId: prov.guildDbId,
      channelId: interaction.channelId ?? null,
      regionId: opts.destinationRegionId,
      originRegionId: opts.originRegionId,
      destinationRegionId: opts.destinationRegionId,
    });
    if (!activation) return false;
    const view = buildEncounterPresent(ctx, activation);
    await respondEphemeral(interaction, view);
    return true;
  } catch (err) {
    if (err instanceof ActiveWorldEncounterError) return false;
    ctx.logger.warn(
      { err, tag: 'world-encounter/travel-roll' },
      'world encounter travel roll failed',
    );
    return false;
  }
}
