/**
 * Ephemeral gameplay responses (Gameplay UX Redesign, phase 2).
 *
 * `respondEphemeral(interaction, view)` is the *only* way gameplay screens
 * reach the player. It replaces the Rev 4 public "session board": every menu,
 * hunt, encounter, capture outcome, shop, inventory, collection and care
 * screen is now private to the player who triggered it.
 *
 * Response strategy (Discord's rules, not ours):
 *   - Slash command / modal submit, un-answered  → `reply(..., Ephemeral)`.
 *   - Button / select, un-answered               → `update(...)` — edits the
 *     ephemeral message the control lives on, so navigation replaces in place
 *     instead of stacking. Each click carries a fresh interaction token, so
 *     the 15-minute window is never a practical limit.
 *   - Already deferred                           → `editReply(...)`.
 *   - Already replied                            → `followUp(..., Ephemeral)`,
 *     for the "main view first, short status note second" pattern.
 *
 * Stale tokens / deleted messages are swallowed: a player who dismissed their
 * ephemeral view must never see an "interaction failed" pill, and gameplay
 * state has already been committed by the time we paint.
 *
 * The public channel is now reserved for exactly two things, neither of which
 * goes through here: the rare-capture rich embed and (phase 3) the Trainer
 * Profile.
 */
import {
  MessageFlags,
  type BaseMessageOptions,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { isStaleInteractionError } from './ui';

/**
 * Payload shape reused across every screen. Accepts anything a reply/edit
 * would accept — including the readonly types coming out of `editReply(...)`
 * call sites — and is normalized before it reaches discord.js.
 */
export type SessionPayload = Pick<
  BaseMessageOptions,
  'content' | 'embeds' | 'components' | 'files'
>;

/** Interactions that can drive an ephemeral paint. */
export type SessionInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

const EPHEMERAL_FLAG = { flags: MessageFlags.Ephemeral } as const;

/**
 * Fill in every field so an edit clears whatever the previous screen left
 * behind (a stale embed, a stale button row, a stale card image).
 */
function normalize(payload: SessionPayload): BaseMessageOptions {
  return {
    content: payload.content ?? '',
    embeds: payload.embeds ?? [],
    components: payload.components ?? [],
    files: payload.files ?? [],
  };
}

function isComponent(
  interaction: SessionInteraction,
): interaction is ButtonInteraction | StringSelectMenuInteraction {
  return interaction.isButton?.() === true || interaction.isStringSelectMenu?.() === true;
}

/**
 * Paint `view` privately for the player who triggered `interaction`.
 * A bare string is shorthand for a content-only view (errors, cooldowns,
 * refusals, short confirmations).
 */
export async function respondEphemeral(
  interaction: SessionInteraction,
  view: SessionPayload | string,
): Promise<void> {
  const body = typeof view === 'string' ? normalize({ content: view }) : normalize(view);
  try {
    if (interaction.replied) {
      await (interaction as ChatInputCommandInteraction).followUp({
        ...(body as InteractionReplyOptions),
        ...EPHEMERAL_FLAG,
      });
      return;
    }
    if (interaction.deferred) {
      await (interaction as ChatInputCommandInteraction).editReply(body);
      return;
    }
    if (isComponent(interaction)) {
      // Navigation: replace the ephemeral the control lives on. The ephemeral
      // flag is inherited, so it stays private without re-declaring it.
      await interaction.update(body);
      return;
    }
    await (interaction as ChatInputCommandInteraction).reply({
      ...(body as InteractionReplyOptions),
      ...EPHEMERAL_FLAG,
    });
  } catch (err) {
    if (!isStaleInteractionError(err)) throw err;
  }
}

/**
 * Paint `view` privately as a **new** ephemeral message, never as an edit of
 * the message the control lives on.
 *
 * This is the variant for a button that sits on a **public** message.
 * {@link respondEphemeral} answers an un-replied component with
 * `interaction.update()`, which is right for the whole rest of the game —
 * every other button in Waifumon lives on an already-ephemeral screen, and
 * updating navigates it in place instead of stacking a new one. On a public
 * message that same call edits the *public* message, replacing it with
 * player-specific content for everybody.
 *
 * The Boss Encounter announcement's **Commit Buddy** button is the one control
 * in the game that lives in public, so it is the one caller that needs this.
 * Anything else that grows a public button needs it too — reach for this
 * whenever the answer to "whose message is this control on?" is "the
 * channel's".
 *
 * Stale tokens are swallowed on the same reasoning as `respondEphemeral`: by
 * the time we paint, the gameplay write has already committed.
 */
export async function replyEphemeral(
  interaction: SessionInteraction,
  view: SessionPayload | string,
): Promise<void> {
  const body = typeof view === 'string' ? normalize({ content: view }) : normalize(view);
  try {
    if (interaction.replied || interaction.deferred) {
      await (interaction as ChatInputCommandInteraction).followUp({
        ...(body as InteractionReplyOptions),
        ...EPHEMERAL_FLAG,
      });
      return;
    }
    await (interaction as ChatInputCommandInteraction).reply({
      ...(body as InteractionReplyOptions),
      ...EPHEMERAL_FLAG,
    });
  } catch (err) {
    if (!isStaleInteractionError(err)) throw err;
  }
}
