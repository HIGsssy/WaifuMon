/**
 * Locations & Travel screens.
 *
 * Reached from the **Locations** button on the main Waifumon menu — there is
 * deliberately no `/travel` or `/location` slash command. Every screen here is
 * ephemeral and painted through `respondEphemeral`, so a button click replaces
 * the previous screen in place rather than stacking a new message, exactly as
 * Shop, Collection and the Charm Exchange do.
 *
 * Five screens, one per state the feature can be in:
 *
 *   `loc:home`    — where you are, and every released destination.
 *   `loc:detail`  — one destination, its requirements, and its one action.
 *   `loc:confirm` — the mandatory confirmation before any purchase.
 *   `loc:buy`     — the purchase itself, landing back on the detail screen.
 *   `loc:travel`  — the move, landing back on the home screen.
 *   `loc:shop`    — a region's own shelf, reusing the shop's rendering.
 *
 * The destination *states* (current / unlocked / purchasable / ineligible)
 * are computed once by `travelService`, not re-derived here. Anything this
 * file decided for itself would be a second opinion the purchase path could
 * disagree with — which is precisely how a screen ends up offering a Buy
 * button that then refuses.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
} from 'discord.js';
import { AppError } from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondEphemeral } from '../ephemeralSession';
import { withBackRow } from '../ui';
import { formatPrice, buttonRows, type ScreenView } from './waifumon';
import { resolveRegionBanner } from '../regionBanner';
import type { DestinationView, TravelStatus } from '../../modules/travel/travelService';
import { maybeTriggerTravelEncounter } from './waifumonWorldEncounter';
import { players as playersTable } from '../../db/schema';
import { eq } from 'drizzle-orm';

const LOCATIONS_COLOR = 0x7fb2e5;

/** The map pin that marks where the player is standing. */
const HERE = '📍';

function destinationEmoji(destination: DestinationView): string {
  return destination.emoji ?? '•';
}

/**
 * One line per destination on the home screen.
 *
 * The four states each get a visually distinct prefix rather than a shared
 * bullet, because the list is the only place a player compares destinations
 * against each other and "which of these can I actually do something with"
 * has to be readable at a glance.
 */
function destinationLine(destination: DestinationView): string {
  const icon = destinationEmoji(destination);
  const name = `**${destination.name}**`;
  switch (destination.state) {
    case 'current':
      return `${HERE} ${name} — *you are here*`;
    case 'unlocked':
      return `${icon} ${name} — unlocked`;
    case 'purchasable':
      return `${icon} ${name} — 🔒 ${formatPrice(destination.price, destination.currency)}`;
    case 'ineligible':
      return `${icon} ${name} — 🔒 ${destination.requirements.join(' · ')}`;
  }
}

function buildHomeView(
  ctx: AppContext,
  status: TravelStatus,
  statusLine?: string,
): ScreenView {
  if (!status.enabled) {
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle('🗺️ Locations')
          .setColor(LOCATIONS_COLOR)
          .setDescription('The caravans are not running right now~'),
      ],
      components: withBackRow(),
    };
  }

  const header =
    `${HERE} You are in **${status.currentRegionName}**\n` +
    `💰 **${status.waifubux}** WaifuBux · 🎖️ Trainer Level **${status.level}**`;
  // Surfaced on the list rather than only on the failed click: a player who
  // has an encounter open should see *why* travel is greyed out before they
  // reach for it.
  const blocked = status.activeEncounterId
    ? "\n\n⚠️ Someone's still waiting on you — finish or release your encounter before travelling."
    : '';
  const note = statusLine ? `\n\n${statusLine}` : '';
  const lines = status.destinations.map(destinationLine).join('\n');

  const current = status.destinations.find((d) => d.state === 'current');
  const banner = resolveRegionBanner(
    ctx,
    current?.regionId ?? status.currentRegion,
    current?.bannerImagePath ?? null,
  );

  const embed = new EmbedBuilder()
    .setTitle('🗺️ Locations')
    .setColor(LOCATIONS_COLOR)
    .setDescription(`${header}${blocked}${note}\n\n${lines}`);
  if (banner) embed.setImage(banner.url);

  // One button per destination, opening its detail screen. The detail screen
  // owns the actions, so the list never has to fit a Buy and a Travel button
  // per row — and a destination with no available action is still openable,
  // which is where its requirements are explained.
  const buttons = status.destinations.map((destination) =>
    new ButtonBuilder()
      .setCustomId(buildCustomId('loc', 'detail', destination.regionId))
      .setLabel(destination.name)
      .setEmoji(destinationEmoji(destination))
      .setStyle(
        destination.state === 'current'
          ? ButtonStyle.Primary
          : destination.state === 'unlocked'
            ? ButtonStyle.Success
            : ButtonStyle.Secondary,
      ),
  );

  return {
    embeds: [embed],
    components: withBackRow(buttonRows(buttons)),
    files: banner ? [banner.file] : [],
  };
}

/**
 * One destination, and the single action its state permits.
 *
 * The state→action mapping is the settled UI contract:
 *   current      → travel button present but **disabled**, and marked "here";
 *   unlocked     → Travel;
 *   purchasable  → price and a Buy that routes through confirmation;
 *   ineligible   → requirements listed, no action offered at all.
 */
function buildDetailView(
  ctx: AppContext,
  destination: DestinationView,
  status: TravelStatus,
  statusLine?: string,
): ScreenView {
  const parts: string[] = [];
  if (destination.state === 'current') parts.push(`${HERE} *You are here.*`);
  if (destination.description) parts.push(destination.description);
  for (const line of destination.flavor) parts.push(`*${line}*`);

  if (destination.state === 'purchasable') {
    const what = destination.purchaseGrantsPass
      ? `**${destination.passName}** — and it opens the road to **${destination.name}**`
      : `the road to **${destination.name}**`;
    parts.push(
      `\n🎫 Buy ${what} for **${formatPrice(destination.price, destination.currency)}**.\n` +
        `You have **${status.waifubux}** WaifuBux.`,
    );
  }
  if (destination.state === 'ineligible') {
    parts.push(`\n🔒 **Requires:**\n${destination.requirements.map((r) => `• ${r}`).join('\n')}`);
  }
  if (statusLine) parts.push(`\n${statusLine}`);

  const banner = resolveRegionBanner(ctx, destination.regionId, destination.bannerImagePath);

  const embed = new EmbedBuilder()
    .setTitle(`${destinationEmoji(destination)} ${destination.name}`)
    .setColor(LOCATIONS_COLOR)
    .setDescription(parts.join('\n'));
  if (banner) embed.setImage(banner.url);

  const actions: ButtonBuilder[] = [];
  if (destination.state === 'unlocked' || destination.state === 'current') {
    actions.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('loc', 'travel', destination.regionId))
        .setLabel(destination.state === 'current' ? 'You are here' : `Travel to ${destination.name}`)
        .setEmoji('🚶')
        .setStyle(ButtonStyle.Success)
        // Two independent reasons to refuse, both shown as a dead button
        // rather than a hidden one, so the screen explains itself.
        .setDisabled(destination.state === 'current' || status.activeEncounterId !== null),
    );
  }
  if (destination.state === 'purchasable') {
    actions.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('loc', 'confirm', destination.regionId))
        .setLabel(`Buy — ${formatPrice(destination.price, destination.currency)}`)
        .setEmoji('🎫')
        .setStyle(ButtonStyle.Primary),
    );
  }
  // A region's own shelf, only when it has one. Reached from the destination
  // rather than from the Shop, because a regional shop is a property of the
  // place, not a second tab on the global store.
  if (destination.shopItemCount > 0 && destination.state !== 'ineligible') {
    actions.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('loc', 'shop', destination.regionId))
        .setLabel(`${destination.name} Shop`)
        .setEmoji('🛍️')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  actions.push(
    new ButtonBuilder()
      .setCustomId(buildCustomId('loc', 'home'))
      .setLabel('⟵ Locations')
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: buttonRows(actions),
    files: banner ? [banner.file] : [],
  };
}

/**
 * The mandatory confirmation step.
 *
 * Every purchase passes through here — no Buy button anywhere spends currency
 * on its first click. It also re-reads the destination, so a screen left open
 * while the player spent their WaifuBux elsewhere confirms against live state
 * rather than against what the list said five minutes ago.
 */
function buildConfirmView(destination: DestinationView, status: TravelStatus): ScreenView {
  const what = destination.purchaseGrantsPass
    ? `the **${destination.passName}**, which opens the road to **${destination.name}**`
    : `the road to **${destination.name}**`;
  const embed = new EmbedBuilder()
    .setTitle('🎫 Confirm purchase')
    .setColor(LOCATIONS_COLOR)
    .setDescription(
      `Buy ${what} for **${formatPrice(destination.price, destination.currency)}**?\n\n` +
        `Balance after: **${status.waifubux - destination.price}** WaifuBux.`,
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('loc', 'buy', destination.regionId))
          .setLabel('Confirm')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildCustomId('loc', 'detail', destination.regionId))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/** Re-reads status + one destination, or reports the button as stale. */
async function loadDetail(
  ctx: AppContext,
  prov: Provisioned,
  regionId: string,
): Promise<{ status: TravelStatus; destination: DestinationView } | null> {
  const status = await ctx.services.travel.getStatus(prov.playerId);
  const destination = status.destinations.find((d) => d.regionId === regionId);
  return destination ? { status, destination } : null;
}

const STALE = 'That destination is no longer on the map — re-open Locations.';

/**
 * Shown when a Continue Journey button can no longer be honoured — the id is
 * malformed, belongs to someone else, or names a hunt encounter. Deliberately
 * says nothing about which of those it was.
 */
const JOURNEY_STALE =
  'That journey has already moved on. Open **Locations** to see where you are.';

export async function handleLocationsHome(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  statusLine?: string,
): Promise<void> {
  const status = await ctx.services.travel.getStatus(prov.playerId);
  await respondEphemeral(interaction, buildHomeView(ctx, status, statusLine));
}

/**
 * Continue Journey — resume the arrival screen after a travel encounter.
 *
 * This is **navigation, not travel**. `travelService.travel()` already ran and
 * committed before the encounter rolled (see `handleLocationTravel`), so the
 * player is standing in the destination the entire time the encounter is on
 * screen. There is nothing left to charge, gate, move, or reward — this
 * repaints the Locations home screen the trip would have landed on had the
 * encounter not interrupted it.
 *
 * Three consequences worth stating, because they are what make the button
 * safe rather than merely convenient:
 *
 *   - **Idempotent by construction.** The only writes on this path are none.
 *     `travel.getStatus` is a read, `buildHomeView` is pure rendering, so a
 *     double-click repaints the same screen and a click an hour later shows
 *     wherever the player actually is now.
 *   - **Server-authoritative.** The custom id carries an active-encounter id
 *     and nothing else. The region comes from `travel.getStatus`, which reads
 *     the player row; `getJourneyContext` is an authorization check (is this
 *     your encounter, and did it come from travel?), not a source of
 *     destination.
 *   - **No re-roll.** Nothing here calls `maybeTriggerTravelEncounter`, so
 *     continuing a journey cannot spawn a second encounter.
 */
export async function handleContinueJourney(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const service = ctx.services.worldEncounter;
  const activeId = Number(args[0] ?? '');
  if (!service || !Number.isFinite(activeId)) {
    await respondEphemeral(interaction, JOURNEY_STALE);
    return;
  }
  // Ownership + origin check. A forged id, someone else's encounter, or a
  // hunt encounter all come back null and get the same neutral answer.
  const journey = await service.getJourneyContext(activeId, prov.playerId);
  if (!journey) {
    await respondEphemeral(interaction, JOURNEY_STALE);
    return;
  }
  const status = await ctx.services.travel.getStatus(prov.playerId);
  await respondEphemeral(
    interaction,
    buildHomeView(
      ctx,
      status,
      `🚶 You shoulder your pack and carry on into **${status.currentRegionName}**.`,
    ),
  );
}

export async function handleLocationDetail(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  regionId: string,
): Promise<void> {
  const loaded = await loadDetail(ctx, prov, regionId);
  if (!loaded) {
    await respondEphemeral(interaction, STALE);
    return;
  }
  await respondEphemeral(interaction, buildDetailView(ctx, loaded.destination, loaded.status));
}

export async function handleLocationConfirm(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  regionId: string,
): Promise<void> {
  const loaded = await loadDetail(ctx, prov, regionId);
  if (!loaded) {
    await respondEphemeral(interaction, STALE);
    return;
  }
  // A stale confirm button for a destination that is no longer purchasable
  // (already bought in another window, or a level lost to an admin edit) falls
  // back to the detail screen, which will explain the current state.
  if (loaded.destination.state !== 'purchasable') {
    await respondEphemeral(interaction, buildDetailView(ctx, loaded.destination, loaded.status));
    return;
  }
  await respondEphemeral(interaction, buildConfirmView(loaded.destination, loaded.status));
}

export async function handleLocationBuy(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  regionId: string,
): Promise<void> {
  let statusLine: string;
  try {
    const outcome = await ctx.services.travel.purchaseDestination(prov.playerId, regionId);
    statusLine = outcome.grantedPass
      ? `✅ Bought the **${outcome.passName}** for **${formatPrice(outcome.amount, outcome.currency)}** — ` +
        `the road to **${outcome.regionName}** is open. Balance: **${outcome.balanceAfter}**.`
      : `✅ Unlocked **${outcome.regionName}** for **${formatPrice(outcome.amount, outcome.currency)}**. ` +
        `Balance: **${outcome.balanceAfter}**.`;
  } catch (err) {
    // Every refusal this path can produce is an AppError with player-safe
    // copy — insufficient funds, already owned, level gate, the lost half of a
    // double-click. They all land back on the detail screen with the reason on
    // it rather than as a separate followUp that would stack a message.
    if (!(err instanceof AppError)) throw err;
    statusLine = `⚠️ ${err.userMessage}`;
  }
  const loaded = await loadDetail(ctx, prov, regionId);
  if (!loaded) {
    await handleLocationsHome(ctx, interaction, prov, statusLine);
    return;
  }
  await respondEphemeral(
    interaction,
    buildDetailView(ctx, loaded.destination, loaded.status, statusLine),
  );
}

export async function handleLocationTravel(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  regionId: string,
): Promise<void> {
  let statusLine: string;
  let travelSucceeded = false;
  let originRegionId: string | null = null;
  let destinationRegionId: string | null = null;
  try {
    const outcome = await ctx.services.travel.travel(prov.playerId, regionId);
    statusLine = `🚶 You set out from **${outcome.fromRegion}** and arrive in **${outcome.toRegionName}**.`;
    travelSucceeded = true;
    originRegionId = outcome.fromRegion;
    destinationRegionId = outcome.toRegion;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    statusLine = `⚠️ ${err.userMessage}`;
  }
  // Destination is now committed. Fire the travel-encounter roll — the
  // player's map has already moved. When one fires it takes over the
  // ephemeral; otherwise fall through to the standard Locations home screen.
  if (travelSucceeded && originRegionId && destinationRegionId) {
    const [level] = await ctx.db
      .select({ level: playersTable.level })
      .from(playersTable)
      .where(eq(playersTable.id, prov.playerId))
      .limit(1);
    const playerLevel = level?.level ?? 1;
    const fired = await maybeTriggerTravelEncounter(ctx, interaction, prov, {
      playerLevel,
      originRegionId,
      destinationRegionId,
    });
    if (fired) return;
  }
  // Travel lands on the *home* screen rather than the detail screen: the
  // player's whole map has changed meaning (a new "you are here"), and the
  // list is where that reads.
  await handleLocationsHome(ctx, interaction, prov, statusLine);
}

export async function handleLocationShop(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  regionId: string,
): Promise<void> {
  const loaded = await loadDetail(ctx, prov, regionId);
  if (!loaded) {
    await respondEphemeral(interaction, STALE);
    return;
  }
  const [catalog, balances] = await Promise.all([
    ctx.services.shop.getRegionalCatalog(regionId),
    ctx.services.currency.getBalances(prov.playerId),
  ]);

  const header = `💰 **${balances.waifubux}** WaifuBux · ✨ **${balances.essence}** Essence`;
  const lines =
    catalog.length > 0
      ? catalog
          .map(
            ({ item, currency }) =>
              `${item.emoji ?? '•'} **${item.name}** — **${formatPrice(item.buyPrice ?? 0, currency)}**`,
          )
          .join('\n')
      : '*The stalls are empty today.*';

  const embed = new EmbedBuilder()
    .setTitle(`🛍️ ${loaded.destination.name} Shop`)
    .setColor(LOCATIONS_COLOR)
    .setDescription(`${header}\n\n${lines}`);

  // Buying reuses the global `shop:buy` handler unchanged: a regional item is
  // an ordinary item with an ordinary price, and `shopService.purchase` is
  // already region-agnostic. Nothing about regional stock changes what a
  // purchase *is*.
  const buyButtons = catalog.map(({ item, currency }) =>
    new ButtonBuilder()
      .setCustomId(buildCustomId('shop', 'buy', item.slug))
      .setLabel(`Buy ${item.name} — ${formatPrice(item.buyPrice ?? 0, currency)}`)
      .setStyle(ButtonStyle.Success),
  );
  const back = new ButtonBuilder()
    .setCustomId(buildCustomId('loc', 'detail', regionId))
    .setLabel(`⟵ ${loaded.destination.name}`)
    .setStyle(ButtonStyle.Secondary);

  await respondEphemeral(interaction, {
    embeds: [embed],
    components: buttonRows([...buyButtons, back]),
  });
}
