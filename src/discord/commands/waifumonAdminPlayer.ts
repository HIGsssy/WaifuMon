/**
 * `/waifumon-admin player …` — live-testing helpers.
 *
 * These exist so a trusted admin can prepare an account for a Discord smoke
 * test (top up Essence, hand over charms, refill energy) without opening a
 * psql session. They are **support tooling, not a player feature**, and they
 * are written to be boring and hard to misuse:
 *
 *   - the target is always an explicit `user` option; there is no "me" default,
 *     so a mis-typed command can never silently enrich the person running it;
 *   - every grant is capped per invocation (see the constants below), so a
 *     fat-fingered extra zero is refused rather than executed;
 *   - energy is clamped to the target's own configured maximum — the same
 *     number gameplay uses — so this cannot manufacture a bigger tank than the
 *     economy allows;
 *   - every action writes an audit row naming the admin who ran it;
 *   - replies are ephemeral, so a balance change is never broadcast.
 *
 * Permission model matches the rest of `/waifumon-admin`: the command carries
 * `ManageGuild` default member permissions, and each handler re-checks that at
 * runtime. The re-check is deliberate — Discord's default-permission gate is a
 * *default*, editable per-guild in Server Settings, and these handlers move
 * balances. Nothing here changes economy rules for normal play.
 */
import {
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import { items, playerProgressionEvents } from '../../db/schema';
import type { AppContext } from '../types';
import { ADMIN_ACTION_EVENT } from '../../modules/admin/adminActionAudit';
import {
  ADMIN_GRANT_ITEM_ACTION,
  ADMIN_MAX_ITEM_GRANT,
  AdminItemGrantError,
  grantItemToPlayer,
  searchGrantableItems,
} from '../../modules/admin/adminItemGrantService';
import { AppError } from '../../shared/errors';

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

/** Per-invocation grant ceilings. Deliberately low: this is test prep. */
export const ADMIN_MAX_ESSENCE_GRANT = 10_000;
export const ADMIN_MAX_CHARM_GRANT = 1_000;
export { ADMIN_MAX_ITEM_GRANT };

/** Audit vocabulary for `player_progression_events.event_type` — shared with the Portal. */
export { ADMIN_ACTION_EVENT };

/** Charms an admin may hand out, as Discord command choices. */
export const ADMIN_CHARM_CHOICES = [
  { name: 'Basic Charm', value: 'basic_charm' },
  { name: 'Silk Charm', value: 'silk_charm' },
  { name: 'Velvet Charm', value: 'velvet_charm' },
  { name: 'Prismatic Charm', value: 'prismatic_charm' },
  { name: 'Mythic Contract', value: 'mythic_contract' },
] as const;

const ALLOWED_CHARM_SLUGS: readonly string[] = ADMIN_CHARM_CHOICES.map((c) => c.value);

/**
 * Runtime permission gate. Returns true when the caller may proceed; otherwise
 * it has already answered the interaction.
 */
async function ensureAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Admin tools only work inside a server.', ...EPHEMERAL });
    return false;
  }
  const allowed = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
  if (!allowed) {
    await interaction.reply({
      content: 'You need **Manage Server** to use the Waifumon admin tools.',
      ...EPHEMERAL,
    });
    return false;
  }
  return true;
}

interface ResolvedTarget {
  playerId: number;
  discordUserId: string;
  mention: string;
}

/**
 * Resolve the explicit `user` option to a player row, provisioning one if the
 * target has never played — preparing a *fresh* account is the main reason
 * this tooling exists. Returns null after answering when the target is
 * unusable (a bot, or an unresolvable user).
 */
async function resolveTarget(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<ResolvedTarget | null> {
  const user = interaction.options.getUser('user', true);
  if (user.bot) {
    await interaction.reply({ content: 'Bots do not have Waifumon accounts.', ...EPHEMERAL });
    return null;
  }
  const guild = await ctx.services.guilds.ensureGuild(interaction.guildId!);
  const player = await ctx.services.players.ensurePlayer(guild.id, user.id);
  return { playerId: player.id, discordUserId: user.id, mention: `<@${user.id}>` };
}

/**
 * Validate an amount that Discord *should* already have constrained. The
 * option carries min/max, but those are client-side hints on a mutating
 * command, so the server re-checks rather than trusting them.
 */
function validateAmount(
  amount: number,
  max: number,
  label: string,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(amount) || amount < 1) {
    return { ok: false, error: `**${label}** must be a whole number of 1 or more.` };
  }
  if (amount > max) {
    return { ok: false, error: `**${label}** is capped at **${max}** per command.` };
  }
  return { ok: true };
}

/**
 * One audit row per action, plus a log line. Written inside the caller's
 * transaction so an action is never recorded unless it actually landed.
 *
 * Reuses `player_progression_events` — the same generic audit table the
 * appearance system writes to — with `xpDelta: 0`, so no migration is needed
 * to make admin actions traceable.
 */
async function recordAdminAction(
  ctx: AppContext,
  tx: Parameters<Parameters<AppContext['db']['transaction']>[0]>[0],
  input: {
    playerId: number;
    action: string;
    adminDiscordId: string;
    targetDiscordId: string;
    guildId: string;
    before: number;
    after: number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(playerProgressionEvents).values({
    playerId: input.playerId,
    eventType: ADMIN_ACTION_EVENT,
    xpDelta: 0,
    metadata: {
      action: input.action,
      adminDiscordId: input.adminDiscordId,
      targetDiscordId: input.targetDiscordId,
      guildId: input.guildId,
      before: input.before,
      after: input.after,
      ...(input.detail ?? {}),
    },
  });
  ctx.logger.warn(
    {
      tag: 'admin/player-action',
      action: input.action,
      adminDiscordId: input.adminDiscordId,
      targetDiscordId: input.targetDiscordId,
      guildId: input.guildId,
      playerId: input.playerId,
      before: input.before,
      after: input.after,
      ...(input.detail ?? {}),
    },
    'admin adjusted a player account',
  );
}

/** Uniform confirmation so every action reports the same four facts. */
function confirmation(input: {
  emoji: string;
  action: string;
  mention: string;
  before: number;
  after: number;
  unit: string;
}): string {
  const delta = input.after - input.before;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return (
    `${input.emoji} **${input.action}** · ${input.mention}\n` +
    `${input.unit}: **${input.before}** → **${input.after}** (${sign})`
  );
}

/** /waifumon-admin player energy — set Hunt Energy (defaults to their max). */
export async function handleAdminPlayerEnergy(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await ensureAdmin(interaction))) return;
  const target = await resolveTarget(ctx, interaction);
  if (!target) return;

  const { player, currencies } = await ctx.services.players.getProfile(target.playerId);
  // The player's own cap, from the same helper gameplay uses — this tool tops
  // a tank up, it never enlarges one.
  const maxEnergy = ctx.services.progression.computeMaxEnergy(player.level);
  const requested = interaction.options.getInteger('amount', false);
  const value = requested ?? maxEnergy;

  if (!Number.isInteger(value) || value < 0) {
    await interaction.reply({
      content: '**Energy** must be a whole number of 0 or more.',
      ...EPHEMERAL,
    });
    return;
  }
  if (value > maxEnergy) {
    await interaction.reply({
      content: `**Energy** for that player is capped at **${maxEnergy}** (their level ${player.level} maximum).`,
      ...EPHEMERAL,
    });
    return;
  }

  const before = currencies.huntEnergy;
  await ctx.db.transaction(async (tx) => {
    await ctx.services.currency.setHuntEnergy(tx, target.playerId, value);
    await recordAdminAction(ctx, tx, {
      playerId: target.playerId,
      action: 'set_energy',
      adminDiscordId: interaction.user.id,
      targetDiscordId: target.discordUserId,
      guildId: interaction.guildId!,
      before,
      after: value,
      detail: { maxEnergy, explicit: requested != null },
    });
  });

  await interaction.reply({
    content: confirmation({
      emoji: '⚡',
      action: requested == null ? 'Energy reset' : 'Energy set',
      mention: target.mention,
      before,
      after: value,
      unit: 'Hunt Energy',
    }),
    ...EPHEMERAL,
  });
}

/** /waifumon-admin player essence — grant Essence. */
export async function handleAdminPlayerEssence(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await ensureAdmin(interaction))) return;

  const amount = interaction.options.getInteger('amount', true);
  const check = validateAmount(amount, ADMIN_MAX_ESSENCE_GRANT, 'Amount');
  if (!check.ok) {
    await interaction.reply({ content: check.error, ...EPHEMERAL });
    return;
  }
  const target = await resolveTarget(ctx, interaction);
  if (!target) return;

  const { currencies } = await ctx.services.players.getProfile(target.playerId);
  const before = currencies.essence;
  let after = before;
  await ctx.db.transaction(async (tx) => {
    const row = await ctx.services.currency.grantEssence(tx, target.playerId, amount);
    after = row.essence;
    await recordAdminAction(ctx, tx, {
      playerId: target.playerId,
      action: 'grant_essence',
      adminDiscordId: interaction.user.id,
      targetDiscordId: target.discordUserId,
      guildId: interaction.guildId!,
      before,
      after,
      detail: { amount },
    });
  });

  await interaction.reply({
    content: confirmation({
      emoji: '✨',
      action: `Granted ${amount} Essence`,
      mention: target.mention,
      before,
      after,
      unit: 'Essence',
    }),
    ...EPHEMERAL,
  });
}

/** /waifumon-admin player charms — grant capture charms. */
export async function handleAdminPlayerCharms(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await ensureAdmin(interaction))) return;

  const slug = interaction.options.getString('charm', true);
  if (!ALLOWED_CHARM_SLUGS.includes(slug)) {
    await interaction.reply({ content: `**${slug}** is not a grantable charm.`, ...EPHEMERAL });
    return;
  }
  const amount = interaction.options.getInteger('amount', true);
  const check = validateAmount(amount, ADMIN_MAX_CHARM_GRANT, 'Amount');
  if (!check.ok) {
    await interaction.reply({ content: check.error, ...EPHEMERAL });
    return;
  }

  const [item] = await ctx.db.select().from(items).where(eq(items.slug, slug));
  if (!item) {
    await interaction.reply({
      content: `**${slug}** is not in the current content set.`,
      ...EPHEMERAL,
    });
    return;
  }

  const target = await resolveTarget(ctx, interaction);
  if (!target) return;

  const before = await ctx.services.inventory.getQuantity(target.playerId, item.id);
  let after = before;
  await ctx.db.transaction(async (tx) => {
    after = await ctx.services.inventory.addItem(tx, target.playerId, item.id, amount);
    await recordAdminAction(ctx, tx, {
      playerId: target.playerId,
      action: 'grant_charms',
      adminDiscordId: interaction.user.id,
      targetDiscordId: target.discordUserId,
      guildId: interaction.guildId!,
      before,
      after,
      detail: { amount, itemSlug: slug, itemId: item.id },
    });
  });

  await interaction.reply({
    content: confirmation({
      emoji: '🎴',
      action: `Granted ${amount} × ${item.name}`,
      mention: target.mention,
      before,
      after,
      unit: item.name,
    }),
    ...EPHEMERAL,
  });
}

/** Autocomplete label: the player-facing name, with the category to tell near-names apart. */
function grantItemChoiceName(item: { name: string; category: string }): string {
  return `${item.name} · ${item.category}`.slice(0, 100);
}

/**
 * Autocomplete for `/waifumon-admin player grant-item` — searches the live
 * content catalogue by display name or key and submits the stable item slug.
 * Read-only, and silent for anyone who could not run the command anyway.
 */
export async function handleAdminGrantItemAutocomplete(
  ctx: AppContext,
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const allowed = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
  if (!allowed || focused.name !== 'item') {
    await interaction.respond([]);
    return;
  }
  const matches = searchGrantableItems(ctx.content.items, String(focused.value));
  await interaction.respond(
    matches.map((item) => ({ name: grantItemChoiceName(item), value: item.slug })),
  );
}

/**
 * /waifumon-admin player grant-item — grant any ordinary inventory item.
 *
 * A production support tool, so it differs from the live-testing helpers above
 * in two ways: it never provisions an account (granting to someone who has
 * never played is far more likely a mis-picked user than an intent), and it
 * acknowledges the interaction *before* the grant, so a command whose token has
 * already died fails without granting instead of granting without answering.
 * The rules themselves live in `grantItemToPlayer`.
 */
export async function handleAdminPlayerGrantItem(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await ensureAdmin(interaction))) return;

  const user = interaction.options.getUser('user', true);
  if (user.bot) {
    await interaction.reply({ content: 'Bots do not have Waifumon accounts.', ...EPHEMERAL });
    return;
  }
  const itemSlug = interaction.options.getString('item', true).trim();
  const quantity = interaction.options.getInteger('quantity', false) ?? 1;
  const check = validateAmount(quantity, ADMIN_MAX_ITEM_GRANT, 'Quantity');
  if (!check.ok) {
    await interaction.reply({ content: check.error, ...EPHEMERAL });
    return;
  }

  await interaction.deferReply(EPHEMERAL);

  const context = {
    tag: 'admin/player-action',
    action: ADMIN_GRANT_ITEM_ACTION,
    adminDiscordId: interaction.user.id,
    targetDiscordId: user.id,
    guildId: interaction.guildId!,
    interactionId: interaction.id,
    itemSlug,
    amount: quantity,
  };

  let content: string;
  try {
    const playerId = await ctx.services.players.findPlayerId(interaction.guildId!, user.id);
    if (playerId == null) {
      throw new AdminItemGrantError(
        'ADMIN_GRANT_PLAYER_NOT_FOUND',
        `<@${user.id}> has not started Waifumon in this server — nothing was granted.`,
      );
    }
    const granted = await grantItemToPlayer(
      { db: ctx.db, inventory: ctx.services.inventory, logger: ctx.logger },
      {
        playerId,
        itemSlug,
        quantity,
        actor: {
          adminDiscordId: interaction.user.id,
          targetDiscordId: user.id,
          guildId: interaction.guildId!,
          interactionId: interaction.id,
        },
      },
    );
    content = confirmation({
      emoji: granted.item.emoji ?? '🎁',
      action: `Granted ${granted.quantity} × ${granted.item.name}`,
      mention: `<@${user.id}>`,
      before: granted.before,
      after: granted.after,
      unit: granted.item.name,
    });
  } catch (err) {
    if (err instanceof AppError) {
      ctx.logger.warn(
        { ...context, result: 'refused', code: err.code },
        'admin item grant refused',
      );
      content = err.userMessage;
    } else {
      // Never surface SQL or internals; the transaction rolled back.
      ctx.logger.error({ ...context, result: 'failed', err }, 'admin item grant failed');
      content = 'Something went wrong — nothing was granted.';
    }
  }
  await interaction.editReply({ content });
}
