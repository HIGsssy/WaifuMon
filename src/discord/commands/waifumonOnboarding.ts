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
import type { AppContext, Provisioned } from '../types';
import type { EquipmentOnboardingView } from '../../modules/onboarding/equipmentOnboardingService';
import { EQUIPMENT_ONBOARDING_FLOW, isEquipmentOnboardingStep } from '../../modules/onboarding/vocabulary';
import { AppError } from '../../shared/errors';

const STALE = 'That button no longer works.';
const MALFORMED = 'That button is malformed — re-run /waifumon.';

type Action = 'open' | 'adv' | 'done' | 'view';

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
      case 'view':
        view = await service.overview(prov.playerId);
        break;
    }
    await respondEphemeral(interaction, buildOnboardingView(ctx, view, service.content()));
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

/** `onb|view|equipment` — the read-only Equipment overview, unlocked players only. */
export function handleEquipmentOverview(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  return run(ctx, i, prov, args, 'view');
}
