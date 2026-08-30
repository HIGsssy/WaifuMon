/**
 * Slash-command definitions, registration, and the interaction dispatcher.
 * The dispatcher is the single wiring point for PlayChannelGuard: the guard
 * decision (a read-only allowlist lookup — it must not create rows) happens
 * before provisioning and before any handler, for commands and buttons alike.
 */
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
} from 'discord.js';
import type { Logger } from '../shared/logger';
import { replyWithError } from './commandError';
import {
  blockedMessage,
  decidePlayChannel,
  extractChannelInfo,
  type GuardChannelInfo,
} from './playChannelGuard';
import { parseCustomId, type ParsedCustomId } from './types';
import {
  ADMIN_CHARM_CHOICES,
  ADMIN_MAX_CHARM_GRANT,
  ADMIN_MAX_ESSENCE_GRANT,
} from './commands/waifumonAdminPlayer';

export function buildCommandDefinitions() {
  // Bare entry point — no subcommands, so `/waifumon` opens the splash/menu
  // directly (Discord requires a subcommand pick once any are added, so the
  // direct-action subcommands live on `/wm` instead).
  const waifumon = new SlashCommandBuilder()
    .setName('waifumon')
    .setDescription('Open Waifumon — daily splash on first launch, then the main menu');

  // Power-user direct-action commands. All also reachable via buttons on
  // the ephemeral menu opened by `/waifumon`.
  const wm = new SlashCommandBuilder()
    .setName('wm')
    .setDescription('Waifumon — direct actions')
    .addSubcommand((s) => s.setName('hunt').setDescription('Spend 1 energy to hunt for a Waifumon'))
    .addSubcommand((s) => s.setName('profile').setDescription('View your hunter profile'))
    .addSubcommand((s) => s.setName('daily').setDescription('Claim your daily rewards'))
    .addSubcommand((s) => s.setName('inventory').setDescription('View your items'))
    .addSubcommand((s) => s.setName('shop').setDescription('Buy capture charms with WaifuBux'))
    .addSubcommand((s) =>
      s.setName('collection').setDescription('Browse your captured Waifumon'),
    )
    .addSubcommand((s) =>
      s
        .setName('inspect')
        .setDescription('Inspect one of your Waifumon')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Nickname or species name')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('buddy')
        .setDescription('Show or set your active buddy')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Nickname or species name (leave blank to view current buddy)')
            .setRequired(false)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('appearance')
        .setDescription('Browse and choose a Waifumon’s look (cosmetic only)')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Nickname or species name')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('care')
        .setDescription('Start Care Mode — recover energy and train a Waifumon over time')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Which Waifumon to care for (defaults to your buddy)')
            .setRequired(false)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName('quests').setDescription('View and claim your daily quests'),
    );

  const admin = new SlashCommandBuilder()
    .setName('waifumon-admin')
    .setDescription('Waifumon server administration')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommandGroup((g) =>
      g
        .setName('allow-channel')
        .setDescription('Manage the play-channel allowlist')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Allow Waifumon in a channel')
            .addChannelOption((o) =>
              o
                .setName('channel')
                .setDescription('Channel to allow')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Remove a channel from the allowlist')
            .addChannelOption((o) =>
              o
                .setName('channel')
                .setDescription('Channel to remove')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true),
            ),
        )
        .addSubcommand((s) => s.setName('list').setDescription('List allowed play channels')),
    )
    // Live-testing helpers. Same ManageGuild gate as the rest of this command,
    // re-checked at runtime in the handlers — Discord's default-permission gate
    // is server-configurable, and these mutate balances.
    .addSubcommandGroup((g) =>
      g
        .setName('player')
        .setDescription('Live-testing: prepare a player account for a smoke test')
        .addSubcommand((s) =>
          s
            .setName('energy')
            .setDescription("Set a player's Hunt Energy (defaults to their max)")
            .addUserOption((o) =>
              o.setName('user').setDescription('Target player').setRequired(true),
            )
            .addIntegerOption((o) =>
              o
                .setName('amount')
                .setDescription('Energy to set — defaults to their max for level')
                .setRequired(false)
                .setMinValue(0),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('essence')
            .setDescription('Grant Essence to a player')
            .addUserOption((o) =>
              o.setName('user').setDescription('Target player').setRequired(true),
            )
            .addIntegerOption((o) =>
              o
                .setName('amount')
                .setDescription(`Essence to grant (1–${ADMIN_MAX_ESSENCE_GRANT})`)
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(ADMIN_MAX_ESSENCE_GRANT),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('charms')
            .setDescription('Grant capture charms to a player')
            .addUserOption((o) =>
              o.setName('user').setDescription('Target player').setRequired(true),
            )
            .addStringOption((o) =>
              o
                .setName('charm')
                .setDescription('Which charm to grant')
                .setRequired(true)
                .addChoices(
                  ...ADMIN_CHARM_CHOICES.map((c) => ({ name: c.name, value: c.value })),
                ),
            )
            .addIntegerOption((o) =>
              o
                .setName('amount')
                .setDescription(`How many (1–${ADMIN_MAX_CHARM_GRANT})`)
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(ADMIN_MAX_CHARM_GRANT),
            ),
        ),
    )
    // Boss Encounters (Stage 1). A subcommand *group* rather than loose
    // subcommands: six operations that only make sense together, and Discord
    // renders them as one namespaced set in the picker.
    .addSubcommandGroup((g) =>
      g
        .setName('boss')
        .setDescription('Configure and operate boss encounters')
        .addSubcommand((s) =>
          s
            .setName('set-channel')
            .setDescription('Set the dedicated Boss Encounter channel')
            .addChannelOption((o) =>
              o
                .setName('channel')
                .setDescription('Text channel that will host boss encounters')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('clear-channel')
            .setDescription('Clear the boss channel — stops scheduling new encounters'),
        )
        .addSubcommand((s) =>
          s
            .setName('status')
            .setDescription('Show the current encounter, the next appearance, and any warnings'),
        )
        .addSubcommand((s) =>
          s
            .setName('spawn')
            .setDescription('Force-spawn a boss for testing (does not consume the shuffle bag)')
            .addStringOption((o) =>
              o
                .setName('boss')
                .setDescription('Boss id from bosses.json — random enabled boss when omitted')
                .setRequired(false),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('end')
            .setDescription('End the active encounter now — committed trainers are still paid'),
        )
        .addSubcommand((s) =>
          s
            .setName('repair')
            .setDescription('Repost a missing announcement without creating a second encounter'),
        )
        .addSubcommand((s) =>
          s.setName('pause').setDescription('Pause boss scheduling for this server'),
        )
        .addSubcommand((s) =>
          s.setName('resume').setDescription('Resume boss scheduling and re-check the channel'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('set-announce-channel')
        .setDescription('Set the rare-capture announcement channel')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Text channel for announcements')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    );

  return [waifumon.toJSON(), wm.toJSON(), admin.toJSON()];
}

export async function registerCommands(
  token: string,
  clientId: string,
  guildId: string | undefined,
  logger: Logger,
): Promise<void> {
  const rest = new REST().setToken(token);
  const body = buildCommandDefinitions();
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    logger.info({ guildId, commands: body.length }, 'registered guild-scoped slash commands');
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    logger.info({ commands: body.length }, 'registered global slash commands');
  }
}

/** Routing key for a chat command: "name:sub" or "name:group:sub". */
export function commandKey(interaction: {
  commandName: string;
  options: {
    getSubcommandGroup(required?: boolean): string | null;
    getSubcommand(required?: boolean): string | null;
  };
}): string {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false) ?? 'menu';
  return group
    ? `${interaction.commandName}:${group}:${sub}`
    : `${interaction.commandName}:${sub}`;
}

/**
 * Dependencies are injected so the dispatch pipeline (guard → provision →
 * handler, in that order) is testable with stubbed interactions and without a
 * database.
 */
export interface DispatcherDeps {
  logger: Logger;
  /** Read-only: returns the guild's allowlist without creating any rows. */
  lookupAllowlist(discordGuildId: string): Promise<string[] | null>;
  /**
   * Read-only: the guild's dedicated Boss Encounter channel, if configured.
   *
   * Exempts that one channel from the *allowlist* rule so boss buttons work
   * without an admin also listing it as a play channel. Optional — a
   * deployment without bosses simply never supplies it, and the guard behaves
   * exactly as it did before.
   */
  lookupBossChannelId?(discordGuildId: string): Promise<string | null>;
  /** Ensures guild + player rows exist; only called after the guard allows. */
  provision(
    discordGuildId: string,
    discordUserId: string,
  ): Promise<{ guildDbId: number; playerId: number }>;
  /**
   * Read-only lookup: returns the player row's id if it exists, else null.
   * Used by autocomplete (which must never provision or write).
   */
  lookupPlayerId?(discordGuildId: string, discordUserId: string): Promise<number | null>;
  /** Chat handlers keyed by commandKey(); receive the provisioned ids. */
  commandHandlers: Record<
    string,
    (interaction: never, prov: { guildDbId: number; playerId: number }) => Promise<void>
  >;
  /** Component handlers keyed by "scope:action". */
  componentHandlers: Record<
    string,
    (
      interaction: never,
      prov: { guildDbId: number; playerId: number },
      args: string[],
    ) => Promise<void>
  >;
  /**
   * Autocomplete handlers keyed by commandKey(). Autocomplete bypasses the
   * PlayChannelGuard (it has no side effects and can't reveal anything the
   * user couldn't fetch via `/waifumon collection`) and is called with a
   * possibly-null playerId so unprovisioned users get an empty response.
   */
  autocompleteHandlers?: Record<
    string,
    (interaction: never, playerId: number | null) => Promise<void>
  >;
  /** Channel-info extraction — overridable so tests can pass plain objects. */
  extractChannelInfo?: (interaction: Interaction) => GuardChannelInfo;
}

export function createDispatcher(deps: DispatcherDeps) {
  const extract = deps.extractChannelInfo ?? extractChannelInfo;

  return async function dispatch(interaction: Interaction): Promise<void> {
    const isCommand = interaction.isChatInputCommand();
    const isButton = interaction.isButton();
    const isSelect = interaction.isStringSelectMenu();
    const isAutocomplete = interaction.isAutocomplete();
    const isModalSubmit = interaction.isModalSubmit();
    if (!isCommand && !isButton && !isSelect && !isAutocomplete && !isModalSubmit) return;

    // Autocomplete bypass: no side effects, no guard, no provision. Query
    // the read-only lookup and hand a possibly-null playerId to the handler.
    if (isAutocomplete) {
      try {
        const playerId =
          interaction.guildId && deps.lookupPlayerId
            ? await deps.lookupPlayerId(interaction.guildId, interaction.user.id)
            : null;
        const key = commandKey(interaction);
        const handler = deps.autocompleteHandlers?.[key];
        if (handler) {
          await handler(interaction as never, playerId);
        } else {
          await interaction.respond([]);
        }
      } catch (err) {
        deps.logger.warn({ err }, 'autocomplete failed');
        try {
          await interaction.respond([]);
        } catch (respErr) {
          deps.logger.warn({ err: respErr }, 'autocomplete recovery failed');
        }
      }
      return;
    }

    let parsed: ParsedCustomId | null = null;
    if (isButton || isSelect) {
      const result = parseCustomId((interaction as { customId: string }).customId);
      if (result === null) return; // not ours
      if (result === 'unknown_version') {
        await (interaction as { reply: (o: unknown) => Promise<unknown> }).reply({
          content: 'That button is from an older version — re-run /waifumon.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      parsed = result;
    }
    if (isModalSubmit) {
      const result = parseCustomId(interaction.customId);
      if (result === null) return;
      if (result === 'unknown_version') {
        await interaction.reply({
          content: 'That form is from an older version — re-run /waifumon.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      parsed = result;
    }

    try {
      // ── PlayChannelGuard: before provisioning, before any service call. ──
      const channelInfo = extract(interaction);
      const allowlist = interaction.guildId
        ? await deps.lookupAllowlist(interaction.guildId)
        : null;
      // Only looked up when an allowlist is actually in force — a guild
      // without one needs no exemption, and this saves a query on every
      // interaction in the common case.
      const bossChannelId =
        interaction.guildId && deps.lookupBossChannelId && allowlist && allowlist.length > 0
          ? await deps.lookupBossChannelId(interaction.guildId)
          : null;
      const decision = decidePlayChannel(channelInfo, allowlist, [bossChannelId]);
      if (!decision.allow) {
        await (interaction as { reply: (o: unknown) => Promise<unknown> }).reply({
          content: blockedMessage(decision.reason, allowlist),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const prov = await deps.provision(interaction.guildId!, interaction.user.id);

      // No session-owner check: gameplay screens are ephemeral, so only the
      // player who triggered one can see (or click) its controls. Discord
      // enforces that for us — there is no shared board to guard.

      if (isCommand) {
        const key = commandKey(interaction);
        const handler = deps.commandHandlers[key];
        if (!handler) {
          deps.logger.warn({ key }, 'no handler for command');
          await interaction.reply({
            content: "That command isn't available yet.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await handler(interaction as never, prov);
      } else if (parsed) {
        const key = `${parsed.scope}:${parsed.action}`;
        const handler = deps.componentHandlers[key];
        if (!handler) {
          deps.logger.warn({ key }, 'no handler for component');
          await (interaction as { reply: (o: unknown) => Promise<unknown> }).reply({
            content: 'That button no longer works — re-run /waifumon.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await handler(interaction as never, prov, parsed.args);
      }
    } catch (err) {
      if (interaction.isRepliable()) {
        await replyWithError(deps.logger, interaction, err);
      } else {
        deps.logger.error({ err }, 'unhandled interaction error (not repliable)');
      }
    }
  };
}
