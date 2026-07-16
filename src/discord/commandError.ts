import { MessageFlags, type RepliableInteraction } from 'discord.js';
import { AppError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import { isStaleInteractionError } from './ui';

const GENERIC_MESSAGE = 'Something went wrong, nothing was consumed.';
const STALE_MESSAGE = 'This screen expired — run `/waifumon` again~';

/**
 * One error boundary for every command/button handler: log structured, answer
 * the user ephemerally. All state-changing flows are transactional, so a
 * thrown error genuinely means no partial state.
 *
 * Stale-interaction errors (Discord 10008/10062/40060) either come from a
 * message we can no longer edit (in which case we try to reply fresh) or from
 * the interaction itself timing out (in which case there is nothing to say —
 * log and drop).
 */
export async function replyWithError(
  logger: Logger,
  interaction: RepliableInteraction,
  err: unknown,
): Promise<void> {
  const stale = isStaleInteractionError(err);
  const userMessage = stale
    ? STALE_MESSAGE
    : err instanceof AppError
      ? err.userMessage
      : GENERIC_MESSAGE;
  if (stale) {
    logger.info({ err: (err as Error).message }, 'stale interaction — token or message aged out');
  } else if (err instanceof AppError) {
    logger.info({ code: err.code, err: err.message }, 'interaction rejected');
  } else {
    logger.error({ err }, 'unhandled interaction error');
  }
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    // The interaction token itself is dead — nothing more we can do.
    if (isStaleInteractionError(replyErr)) {
      logger.info('failed to deliver error reply — interaction already dead');
    } else {
      logger.warn({ err: replyErr }, 'failed to deliver error reply');
    }
  }
}
