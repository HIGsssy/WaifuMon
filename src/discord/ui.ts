/**
 * Small UI helpers for the ephemeral navigation model.
 *
 * `respondScreen` lets a handler paint the *same* ephemeral message when it is
 * invoked from a button (menu-driven navigation) and reply fresh when invoked
 * from a slash command (first-touch entry). Sub-screens include a Back button
 * built by `backButton()` so navigation is reversible without stacking new
 * ephemeral messages.
 *
 * Stale-interaction handling: Discord returns 10062 (Unknown interaction) or
 * 10008 (Unknown message) once the token/message ages out. Callers should
 * catch those via `isStaleInteractionError` and fall back to a fresh
 * ephemeral note, or just log and drop.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  type BaseMessageOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
} from 'discord.js';
import type { PlayerInteraction } from './types';
import { buildCustomId } from './types';

const EPHEMERAL_FLAG = { flags: MessageFlags.Ephemeral } as const;

export type ScreenPayload = Pick<BaseMessageOptions, 'content' | 'embeds' | 'components' | 'files'>;

/**
 * Paint an ephemeral screen.
 * - Buttons: edit the message in place (deferred → editReply; otherwise update).
 * - Slash commands: reply fresh with the Ephemeral flag.
 * Existing files on the message are cleared unless `files` is explicitly set.
 */
export async function respondScreen(
  interaction: PlayerInteraction,
  payload: ScreenPayload,
): Promise<void> {
  const normalized: ScreenPayload = {
    content: payload.content ?? '',
    embeds: payload.embeds ?? [],
    components: payload.components ?? [],
    files: payload.files ?? [],
  };
  if (interaction.isButton()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(normalized as InteractionEditReplyOptions);
    } else {
      await interaction.update(normalized as InteractionUpdateOptions);
    }
    return;
  }
  await interaction.reply({ ...(normalized as InteractionReplyOptions), ...EPHEMERAL_FLAG });
}

export function backButton(label = '⟵ Back to menu'): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildCustomId('menu', 'back'))
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary);
}

/** Attaches a single-row `[Back]` action row alongside any extras (extras first). */
export function withBackRow(
  extraRows: readonly ActionRowBuilder<ButtonBuilder>[] = [],
  backLabel?: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    ...extraRows,
    new ActionRowBuilder<ButtonBuilder>().addComponents(backButton(backLabel)),
  ];
}

const STALE_CODES = new Set<number | string>([
  10008, // Unknown Message
  10062, // Unknown Interaction
  40060, // Interaction already acknowledged
]);

export function isStaleInteractionError(err: unknown): boolean {
  return err instanceof DiscordAPIError && STALE_CODES.has(err.code as number | string);
}
