/**
 * Equipment onboarding button handlers (`onb:*`) and the Equipment overview.
 *
 * A custom id carries only the flow name and, for `adv`, the step whose button
 * was pressed. It never names a player, an instance or a stat: every handler
 * acts on `prov.playerId` and the service recomputes the player's state before
 * doing anything, so a stale, replayed or forged button can at worst repaint
 * the screen the clicking player is actually on.
 */
import type { ButtonInteraction } from 'discord.js';
import { respondEphemeral } from '../ephemeralSession';
import { buildOnboardingView } from '../onboardingPresenter';
import { equipmentHomeArtwork } from './waifumonEquipment';
import type { AppContext, Provisioned } from '../types';
import type { EquipmentOnboardingView } from '../../modules/onboarding/equipmentOnboardingService';
import { EQUIPMENT_ONBOARDING_FLOW, isEquipmentOnboardingStep } from '../../modules/onboarding/vocabulary';
import { AppError } from '../../shared/errors';

const STALE = 'That button no longer works.';
const MALFORMED = 'That button is malformed — re-run /waifumon.';

type Action = 'open' | 'adv' | 'done';

async function run(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
  action: Action,
): Promise<void> {
  const service = ctx.services.equipmentOnboarding;
  if (!service) {
    await respondEphemeral(interaction, STALE);
    return;
  }
  if (args[0] !== EQUIPMENT_ONBOARDING_FLOW) {
    await respondEphemeral(interaction, MALFORMED);
    return;
  }
  const step = args[1];
  if (action === 'adv' && !isEquipmentOnboardingStep(step)) {
    await respondEphemeral(interaction, MALFORMED);
    return;
  }

  try {
    let view: EquipmentOnboardingView;
    switch (action) {
      case 'open':
        view = await service.open(prov.playerId);
        break;
      case 'adv':
        view = await service.advance(prov.playerId, step as Parameters<typeof service.advance>[1]);
        break;
      case 'done':
        view = await service.complete(prov.playerId);
        break;
    }
    // A finished player lands on the Equipment home, picture included.
    const artwork = view.kind === 'overview' ? await equipmentHomeArtwork(ctx, prov.playerId, view.stats) : null;
    await respondEphemeral(interaction, buildOnboardingView(ctx, view, service.content(), artwork));
  } catch (err) {
    if (err instanceof AppError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }
}

/** `onb|open|equipment` — the menu's Begin/Resume: show the current screen. */
export function handleOnboardingOpen(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  return run(ctx, i, prov, args, 'open');
}

/** `onb|adv|equipment|<fromStep>` — a step's button. */
export function handleOnboardingAdvance(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  return run(ctx, i, prov, args, 'adv');
}

/** `onb|done|equipment` — "Gear up": the atomic completion. */
export function handleOnboardingComplete(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  return run(ctx, i, prov, args, 'done');
}
