/**
 * Coordinator-side glue between Discord handlers and the `GameEventBus`.
 *
 * Handlers are the only layer that knows both (a) that a gameplay
 * transaction committed and (b) who the player is in Discord terms. So this
 * is where events are minted and emitted — always *after* the write, never
 * inside it.
 *
 * `emitEvents` never throws: a subscriber failure (a Discord outage, a
 * missing permission, a bug in the Activity Feed) must never turn a
 * successful hunt/capture/claim into an error for the player.
 */
import type {
  GameEventDescriptor,
  GameEventSource,
} from '../modules/events/gameEvents';
import { emitGameEvents } from '../modules/events/gameEvents';
import type { AppContext, PlayerInteraction, Provisioned } from './types';
import { ownerFromInteraction } from './userDisplay';

/** Build the "who / where" envelope for events raised by this interaction. */
export function eventSourceFrom(
  interaction: PlayerInteraction,
  prov: Provisioned,
): GameEventSource {
  const owner = ownerFromInteraction(interaction);
  return {
    guildId: interaction.guildId ?? '',
    guildDbId: prov.guildDbId,
    playerId: prov.playerId,
    playerName: owner.displayName,
    playerMention: owner.mention,
    channelId: interaction.channelId ?? null,
  };
}

/**
 * Post-commit emission. Swallows everything — `emitGameEvents` already
 * isolates each subscriber, and this second guard covers the envelope-build
 * path itself.
 */
export async function emitEvents(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  descriptors: readonly GameEventDescriptor[],
  occurredAt: Date = new Date(),
): Promise<void> {
  if (descriptors.length === 0) return;
  try {
    await emitGameEvents(ctx.events, eventSourceFrom(interaction, prov), descriptors, occurredAt);
  } catch (err) {
    ctx.logger.warn({ err }, 'failed to emit game events');
  }
}
