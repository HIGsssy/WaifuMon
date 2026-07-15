import { MessageFlags, type RepliableInteraction } from 'discord.js';
import { AppError } from '../shared/errors';
import type { Logger } from '../shared/logger';

const GENERIC_MESSAGE = 'Something went wrong, nothing was consumed.';

/**
 * One error boundary for every command/button handler: log structured, answer
 * the user ephemerally. All state-changing flows are transactional, so a
 * thrown error genuinely means no partial state.
 */
export async function replyWithError(
  logger: Logger,
  interaction: RepliableInteraction,
  err: unknown,
): Promise<void> {
  const userMessage = err instanceof AppError ? err.userMessage : GENERIC_MESSAGE;
  if (err instanceof AppError) {
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
    logger.warn({ err: replyErr }, 'failed to deliver error reply (token expired?)');
  }
}
