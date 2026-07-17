/**
 * Public single-message session board (Rev 4 UI model).
 *
 * `paintSession(ctx, interaction, prov, payload)` is the *only* way real
 * gameplay screens (menu, profile, daily, hunt, encounter, capture, shop,
 * inventory, collection, inspect, buddy) reach Discord. It routes every
 * navigation into one public channel message per (player, channel), so
 * navigation edits in place instead of stacking ephemeral responses.
 *
 * Ephemeral responses are reserved for:
 *   - errors, cooldowns, insufficient-resource messages
 *   - PlayChannelGuard rejections (handled in the dispatcher)
 *   - session-owner mismatches ("this is X's session")
 *   - stale-session notices
 *   - release / duplicate-convert / other destructive confirmations
 *   - admin responses
 *
 * The rare-capture announcement (§9 / SR+) still posts to the configured
 * announce channel — it is *not* the session board.
 */
import {
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  type BaseMessageOptions,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { WaifumonSessionRow } from '../db/schema';
import { isStaleInteractionError } from './ui';
import type { AppContext, Provisioned } from './types';
import { ownerFromInteraction, type OwnerIdentity } from './userDisplay';

/**
 * Payload shape reused across every screen. We accept anything a Discord
 * reply/edit would accept — including the readonly types coming out of
 * `interaction.editReply(...)` call sites — and normalize to a plain
 * `BaseMessageOptions` before handing it to discord.js.
 */
export type SessionPayload = Pick<BaseMessageOptions, 'content' | 'embeds' | 'components' | 'files'>;

/** Interactions that can drive a session paint. Modal submits allowed too. */
export type SessionInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

const EPHEMERAL_FLAG = { flags: MessageFlags.Ephemeral } as const;

function normalize(payload: SessionPayload): BaseMessageOptions {
  const out: BaseMessageOptions = {};
  out.content = payload.content ?? '';
  out.embeds = payload.embeds ?? [];
  out.components = payload.components ?? [];
  out.files = payload.files ?? [];
  return out;
}

/**
 * Decorate every session-board embed with the owner identity so multiple
 * players' public boards in the same channel are visually distinguishable:
 *   - `setAuthor(...)` on the first embed (replaced only if not already set),
 *   - a "Hunter: <@id>" prefix in that embed's description,
 *   - a "Only <name> can use these controls" note appended to the footer.
 *
 * If the payload had no embeds we synthesize a minimal owner header embed so
 * even content-only paints (release, brief transitions) carry identity.
 */
function decorateWithOwner(
  embeds: readonly unknown[],
  owner: OwnerIdentity,
): EmbedBuilder[] {
  const controlNote = `Only ${owner.displayName} can use these controls · /waifumon starts your own session`;
  const authorName = `🎴 ${owner.displayName}'s Waifumon`;
  if (embeds.length === 0) {
    return [
      new EmbedBuilder()
        .setColor(0xff6fa5)
        .setAuthor({ name: authorName })
        .setDescription(`**Hunter:** ${owner.mention}`)
        .setFooter({ text: controlNote }),
    ];
  }
  const out: EmbedBuilder[] = [];
  embeds.forEach((raw, idx) => {
    if (!(raw instanceof EmbedBuilder)) {
      // Foreign embed (plain APIEmbed / JSONEncodable). Leave it alone.
      out.push(raw as unknown as EmbedBuilder);
      return;
    }
    if (idx === 0) {
      if (!raw.data.author) raw.setAuthor({ name: authorName });
      const desc = raw.data.description ?? '';
      if (!desc.startsWith('**Hunter:**') && !desc.includes(`Hunter:** ${owner.mention}`)) {
        raw.setDescription(`**Hunter:** ${owner.mention}${desc ? `\n\n${desc}` : ''}`);
      }
      const existingFooter = raw.data.footer?.text ?? '';
      if (!existingFooter.includes('can use these controls')) {
        const combined = existingFooter ? `${existingFooter} · ${controlNote}` : controlNote;
        raw.setFooter({ text: combined });
      }
    }
    out.push(raw);
  });
  return out;
}

function isComponent(
  interaction: SessionInteraction,
): interaction is ButtonInteraction | StringSelectMenuInteraction {
  return interaction.isButton?.() || interaction.isStringSelectMenu?.();
}

function isModal(interaction: SessionInteraction): interaction is ModalSubmitInteraction {
  return interaction.isModalSubmit?.() === true;
}

function isCommand(
  interaction: SessionInteraction,
): interaction is ChatInputCommandInteraction {
  return interaction.isChatInputCommand?.() === true;
}

/**
 * The heart of the model: paint `payload` onto the player's public session
 * message in the current channel. Creates the message on first touch, edits
 * it in place afterwards, and falls back to a fresh send if the old message
 * is unreachable. Always acknowledges the interaction so Discord doesn't show
 * a red "interaction failed" pill.
 */
export async function paintSession(
  ctx: AppContext,
  interaction: SessionInteraction,
  prov: Provisioned,
  payload: SessionPayload,
): Promise<WaifumonSessionRow> {
  const channelId = interaction.channelId;
  if (!channelId) {
    // Should be unreachable — PlayChannelGuard already required a guild channel.
    await replyEphemeral(interaction, 'Waifumon needs a channel context~');
    throw new Error('paintSession without channelId');
  }
  // Resolve owner identity from the live interaction — the dispatcher's
  // session-owner check has already ensured only the owner reaches here — and
  // refresh the cached display name on the session row so foreign-click
  // rejections can name them without a Discord round-trip.
  const owner = ownerFromInteraction(interaction);

  // Slash-command entry retires an expired public board *before* we upsert
  // the session row. We do a read-only lookup, and if the previous board has
  // gone quiet past the inactivity timeout, we (best-effort) edit that old
  // message into a "Session Ended" note with disabled components and clear
  // `message_id` so the paint below takes the fresh-send path.
  if (isCommand(interaction)) {
    const existing = await ctx.services.session.findByPlayerAndChannel(
      prov.playerId,
      channelId,
    );
    if (existing && existing.messageId && ctx.services.session.isExpired(existing)) {
      const channelForCleanup = getTextChannel(interaction);
      if (channelForCleanup) {
        await finalizeExpiredBoard(
          ctx,
          channelForCleanup,
          existing.messageId,
          existing.ownerDisplayName ?? owner.displayName,
        );
      }
      await ctx.services.session.endSession(existing.id);
    }
  }

  const session = await ctx.services.session.ensureSession(
    prov.guildDbId,
    prov.playerId,
    channelId,
    owner.displayName,
  );

  // Decorate the payload with owner identity before we hand it to Discord.
  const decoratedEmbeds = decorateWithOwner(payload.embeds ?? [], owner);
  const body = normalize({ ...payload, embeds: decoratedEmbeds });

  // Fast path: a button/select clicked on the session message itself. This is
  // the common case for real gameplay navigation.
  if (isComponent(interaction)) {
    const clickedMessageId = (interaction as ButtonInteraction).message?.id ?? null;
    if (
      session.messageId &&
      clickedMessageId &&
      clickedMessageId === session.messageId &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      try {
        await interaction.update(body);
        await ctx.services.session.touch(session.id);
        return session;
      } catch (err) {
        if (!isStaleInteractionError(err)) throw err;
        // fallthrough: message gone or token dead — try to re-send.
      }
    }
    if (
      session.messageId &&
      clickedMessageId &&
      clickedMessageId === session.messageId &&
      (interaction.deferred || interaction.replied)
    ) {
      // Handler chose to defer (e.g. long capture attempt). editReply targets
      // the same session message because the deferral was against it.
      try {
        await (interaction as ButtonInteraction).editReply(body);
        await ctx.services.session.touch(session.id);
        return session;
      } catch (err) {
        if (!isStaleInteractionError(err)) throw err;
      }
    }
  }

  // Slow path: slash command, modal submit, or a stale/foreign component
  // click. Reach into the channel and edit-or-send the session message.
  const channel = getTextChannel(interaction);
  let newMessageId: string | null = session.messageId;
  if (channel) {
    if (session.messageId) {
      try {
        await channel.messages.edit(session.messageId, body);
      } catch (err) {
        if (isMissingMessageError(err)) {
          // Old message deleted — send a fresh one.
          try {
            const sent = await channel.send(body);
            newMessageId = sent.id;
            await ctx.services.session.setMessageId(session.id, newMessageId);
          } catch (sendErr) {
            ctx.logger.warn({ err: sendErr }, 'session board: send fallback failed');
          }
        } else {
          ctx.logger.warn({ err }, 'session board: edit failed');
        }
      }
    } else {
      try {
        const sent = await channel.send(body);
        newMessageId = sent.id;
        await ctx.services.session.setMessageId(session.id, newMessageId);
      } catch (err) {
        ctx.logger.warn({ err }, 'session board: initial send failed');
      }
    }
  } else {
    ctx.logger.warn({ channelId }, 'session board: channel is not text-based');
  }

  // Acknowledge the triggering interaction so Discord doesn't error out.
  await acknowledgeSecondary(interaction, channel ? undefined : 'Session paint failed~');
  await ctx.services.session.touch(session.id);
  return { ...session, messageId: newMessageId };
}

/**
 * Ephemeral reply for errors, cooldowns, denied clicks, stale sessions,
 * confirmations, and admin responses. Never mutates the session board.
 */
export async function respondEphemeral(
  interaction: SessionInteraction,
  payload: SessionPayload | string,
): Promise<void> {
  const body: BaseMessageOptions =
    typeof payload === 'string'
      ? { content: payload }
      : normalize(payload);
  try {
    if (interaction.replied || interaction.deferred) {
      await (interaction as ChatInputCommandInteraction).followUp({
        ...(body as import('discord.js').InteractionReplyOptions),
        ...EPHEMERAL_FLAG,
      });
    } else {
      await (interaction as ChatInputCommandInteraction).reply({
        ...(body as import('discord.js').InteractionReplyOptions),
        ...EPHEMERAL_FLAG,
      });
    }
  } catch (err) {
    if (!isStaleInteractionError(err)) throw err;
  }
}

/** Rejection copy for cross-user clicks (spec §5). */
export function ownerRejection(ownerDiscordUserId: string): string {
  return `This is <@${ownerDiscordUserId}>'s Waifumon session. Run \`/waifumon\` to start your own.`;
}

/** Copy used when we can't find or edit the referenced session. */
export const STALE_SESSION_MESSAGE =
  'This session is no longer active — run `/waifumon` to open a fresh board.';

// ─────────────────────────── internals ───────────────────────────

function getTextChannel(interaction: Interaction): GuildTextBasedChannel | null {
  const ch = interaction.channel as unknown;
  if (!ch || typeof ch !== 'object') return null;
  if (!('send' in ch)) return null;
  return ch as GuildTextBasedChannel;
}

/**
 * Best-effort edit of an expired public board into a terminal "Session
 * Ended" state with no components. Failures (message deleted, permission
 * lost, …) are logged and swallowed — the caller still clears `message_id`
 * so the DB view is consistent even if the Discord side couldn't be updated.
 */
async function finalizeExpiredBoard(
  ctx: AppContext,
  channel: GuildTextBasedChannel,
  oldMessageId: string,
  ownerDisplayName: string,
): Promise<void> {
  const endedEmbed = new EmbedBuilder()
    .setColor(0x808080)
    .setAuthor({ name: `🎴 ${ownerDisplayName}'s Waifumon` })
    .setTitle(`🎴 ${ownerDisplayName}'s Waifumon Hunt — Session Ended`)
    .setDescription('This session went quiet. Run `/waifumon` to start a fresh hunt.')
    .setFooter({ text: 'Old buttons no longer work — a new board has been posted below.' });
  try {
    await channel.messages.edit(oldMessageId, {
      content: '',
      embeds: [endedEmbed],
      components: [],
      files: [],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    if (isMissingMessageError(err)) {
      ctx.logger.info(
        { oldMessageId, channelId: channel.id },
        'expired board: old message already gone — nothing to finalize',
      );
      return;
    }
    ctx.logger.warn(
      { err, oldMessageId, channelId: channel.id },
      'expired board: failed to edit old message into ended state',
    );
  }
}

function isMissingMessageError(err: unknown): boolean {
  return err instanceof DiscordAPIError && err.code === 10008;
}

/**
 * Best-effort acknowledgement for the paint-through-channel path. Buttons
 * prefer `deferUpdate` (silent); everything else replies with a tiny
 * ephemeral note that self-clears from the user's chat.
 */
async function acknowledgeSecondary(
  interaction: SessionInteraction,
  errorNote?: string,
): Promise<void> {
  try {
    if (interaction.replied) return;
    if (interaction.deferred) {
      // Ephemeral note that stays hidden.
      await (interaction as ChatInputCommandInteraction).editReply({
        content: errorNote ?? '💫',
      });
      return;
    }
    if (isComponent(interaction) || isModal(interaction)) {
      try {
        await (interaction as ButtonInteraction).deferUpdate();
        return;
      } catch (err) {
        if (!isStaleInteractionError(err)) throw err;
        return;
      }
    }
    if (isCommand(interaction)) {
      await interaction.reply({
        content: errorNote ?? '💫 Session opened above~',
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    if (isStaleInteractionError(err)) return;
    throw err;
  }
}

async function replyEphemeral(interaction: SessionInteraction, content: string): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await (interaction as ChatInputCommandInteraction).followUp({
        content,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await (interaction as ChatInputCommandInteraction).reply({
        content,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    if (!isStaleInteractionError(err)) throw err;
  }
}
