/**
 * Equipment management button and select handlers (`eq:*`).
 *
 * Component state is advisory. Every handler:
 *  - acts on `prov.playerId` — ids name instances and pages, never players;
 *  - goes through `EquipmentManagementService`, which checks the Equipment
 *    unlock on every call (a locked player's forged or stale button reaches
 *    nothing) and re-reads all state;
 *  - turns stale state into a one-line explanation plus the freshest screen:
 *    a removed / foreign / missing item reads as "no longer available" (the
 *    three are indistinguishable, as in Phase 1), and a slot changed elsewhere
 *    (`LoadoutConflictError`) repaints that slot as it now is.
 */
import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import { ownedArtworkImage } from '../assets/attachRenderedCard';
import { respondEphemeral } from '../ephemeralSession';
import {
  HOME_CONTEXT,
  STALE_ITEM,
  buildEquipmentHome,
  buildGearBag,
  buildItemDetail,
  buildSlotScreen,
  conflictStatus,
  equipStatus,
  lockedFeatureView,
  parseContext,
  parseInstanceId,
  parsePage,
  unequipStatus,
  type BuddyArtwork,
  type EquipmentContext,
} from '../equipmentPresenter';
import type { AppContext, Provisioned } from '../types';
import type { EquipmentManagementService } from '../../modules/equipment/equipmentManagementService';
import type { CombatStats } from '../../modules/equipment/equipmentMath';
import { isGearBagFilter } from '../../modules/equipment/gearBag';
import { isEquipmentSlot } from '../../modules/equipment/vocabulary';
import {
  AppError,
  EquipmentNotOwnedError,
  EquipmentSlotMismatchError,
  FeatureLockedError,
  LoadoutConflictError,
} from '../../shared/errors';

type Interaction = ButtonInteraction | StringSelectMenuInteraction;

const NO_LONGER_WORKS = 'That button no longer works.';

/**
 * The picture of the Buddy the stats were calculated for. Matched on the copy
 * id, so a Buddy swapped between the two reads costs the picture rather than
 * showing one Waifumon beside another's numbers. Never throws.
 */
export async function equipmentHomeArtwork(app: AppContext, playerId: number, stats: CombatStats): Promise<BuddyArtwork | null> {
  if (!stats.buddy || !app.services.collection) return null;
  try {
    const entry = await app.services.collection.getBuddy(playerId);
    if (entry?.waifu.id !== stats.buddy.waifuId) return null;
    return ownedArtworkImage(app, entry);
  } catch (err) {
    app.logger.warn({ err, playerId }, 'equipment home: buddy artwork unavailable');
    return null;
  }
}

async function homeScreen(app: AppContext, service: EquipmentManagementService, playerId: number, status?: string) {
  const { stats } = await service.home(playerId);
  return buildEquipmentHome(stats, status, await equipmentHomeArtwork(app, playerId, stats));
}

async function renderContext(
  app: AppContext,
  service: EquipmentManagementService,
  playerId: number,
  ctx: EquipmentContext,
  status?: string,
) {
  switch (ctx.kind) {
    case 'home':
      return homeScreen(app, service, playerId, status);
    case 'slot':
      return buildSlotScreen(await service.slot(playerId, ctx.slot, ctx.page), status);
    case 'bag':
      return buildGearBag(await service.bag(playerId, ctx.filter, ctx.page), status);
  }
}

/**
 * Run one action with the shared error handling. `fallback` is the screen to
 * repaint when the item the action named is gone.
 */
async function run(
  ctx: AppContext,
  interaction: Interaction,
  prov: Provisioned,
  action: (service: EquipmentManagementService) => Promise<Parameters<typeof respondEphemeral>[1]>,
  recover: { fallback?: EquipmentContext } = {},
): Promise<void> {
  const service = ctx.services.equipmentManagement;
  if (!service) {
    await respondEphemeral(interaction, NO_LONGER_WORKS);
    return;
  }
  try {
    await respondEphemeral(interaction, await action(service));
  } catch (err) {
    if (err instanceof FeatureLockedError) {
      await respondEphemeral(interaction, lockedFeatureView());
      return;
    }
    try {
      if (err instanceof EquipmentNotOwnedError || err instanceof EquipmentSlotMismatchError) {
        await respondEphemeral(
          interaction,
          await renderContext(ctx, service, prov.playerId, recover.fallback ?? HOME_CONTEXT, STALE_ITEM),
        );
        return;
      }
    } catch (inner) {
      // The recovery screen itself failed (e.g. the unlock was revoked in the
      // meantime): fall through to the generic handling of *that* error.
      err = inner;
      if (err instanceof FeatureLockedError) {
        await respondEphemeral(interaction, lockedFeatureView());
        return;
      }
    }
    if (err instanceof AppError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }
}

async function malformed(interaction: Interaction): Promise<void> {
  await respondEphemeral(interaction, 'That button is malformed — re-open Equipment from /waifumon.');
}

/** `eq|home`, and the menu's `onb|view|equipment`. */
export function handleEquipmentHome(ctx: AppContext, i: ButtonInteraction, prov: Provisioned): Promise<void> {
  return run(ctx, i, prov, (s) => homeScreen(ctx, s, prov.playerId));
}

/** `eq|slot|<slot>|<page>` and `eq|slotp|…`. */
export async function handleEquipmentSlot(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const [slot, rawPage] = args;
  const page = parsePage(rawPage);
  if (!isEquipmentSlot(slot) || page === null) return malformed(i);
  return run(ctx, i, prov, async (s) => buildSlotScreen(await s.slot(prov.playerId, slot, page)));
}

/** `eq|bag|<filter>|<page>` and `eq|bagp|…`. */
export async function handleGearBag(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const [filter, rawPage] = args;
  const page = parsePage(rawPage);
  if (!isGearBagFilter(filter) || page === null) return malformed(i);
  return run(ctx, i, prov, async (s) => buildGearBag(await s.bag(prov.playerId, filter, page)));
}

/** `eq|pick|<ctx>` — a select menu; the chosen value is an instance id. */
export async function handleEquipmentPick(
  ctx: AppContext,
  i: StringSelectMenuInteraction,
  prov: Provisioned,
  args: string[],
) {
  const back = parseContext(args[0]);
  const id = parseInstanceId(i.values?.[0]);
  if (!back) return malformed(i);
  if (id === null) {
    return run(ctx, i, prov, (s) => renderContext(ctx, s, prov.playerId, back, STALE_ITEM));
  }
  return run(ctx, i, prov, async (s) => buildItemDetail(await s.item(prov.playerId, id), back), { fallback: back });
}

/** `eq|item|<id>|<ctx>` — item detail (also "Next copy"). */
export async function handleEquipmentItem(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const id = parseInstanceId(args[0]);
  const back = parseContext(args[1]);
  if (id === null || !back) return malformed(i);
  return run(ctx, i, prov, async (s) => buildItemDetail(await s.item(prov.playerId, id), back), { fallback: back });
}

/** `eq|equip|<id>|<expectedCurrentId|->|<ctx>` — then the slot screen, fresh. */
export async function handleEquipmentEquip(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const id = parseInstanceId(args[0]);
  const expected = args[1] === '-' ? null : parseInstanceId(args[1]);
  const back = parseContext(args[2]);
  if (id === null || (args[1] !== '-' && expected === null) || !back) return malformed(i);
  return run(
    ctx,
    i,
    prov,
    async (s) => {
      try {
        const outcome = await s.equip(prov.playerId, id, expected);
        return buildSlotScreen(await s.slot(prov.playerId, outcome.slot, 0), equipStatus(outcome));
      } catch (err) {
        // The slot changed since the screen was drawn: show it as it is now.
        if (!(err instanceof LoadoutConflictError)) throw err;
        const { slot } = (await s.item(prov.playerId, id)).instance;
        return buildSlotScreen(await s.slot(prov.playerId, slot, 0), conflictStatus(slot));
      }
    },
    { fallback: back },
  );
}

/** `eq|uneq|<slot>|<expectedCurrentId>|<ctx>` — then the slot screen, fresh. */
export async function handleEquipmentUnequip(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const [slot, rawExpected, rawCtx] = args;
  const expected = parseInstanceId(rawExpected);
  const back = parseContext(rawCtx);
  if (!isEquipmentSlot(slot) || expected === null || !back) return malformed(i);
  return run(
    ctx,
    i,
    prov,
    async (s) => {
      try {
        const outcome = await s.unequip(prov.playerId, slot, expected);
        return buildSlotScreen(await s.slot(prov.playerId, slot, 0), unequipStatus(outcome));
      } catch (err) {
        if (!(err instanceof LoadoutConflictError)) throw err;
        return buildSlotScreen(await s.slot(prov.playerId, slot, 0), conflictStatus(slot));
      }
    },
    { fallback: back },
  );
}

/** `eq|flag|<id>|<f|l>|<0|1>|<ctx>` — set one flag, then the item again. */
export async function handleEquipmentFlag(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const id = parseInstanceId(args[0]);
  const flag = args[1] === 'f' ? 'favorite' : args[1] === 'l' ? 'locked' : null;
  const value = args[2] === '1' ? true : args[2] === '0' ? false : null;
  const back = parseContext(args[3]);
  if (id === null || !flag || value === null || !back) return malformed(i);
  return run(
    ctx,
    i,
    prov,
    async (s) => {
      await s.setFlag(prov.playerId, id, flag, value);
      const status =
        flag === 'favorite' ? (value ? '⭐ Added to favourites.' : 'Removed from favourites.') : value ? '🔒 Locked.' : '🔓 Unlocked.';
      return buildItemDetail(await s.item(prov.playerId, id), back, status);
    },
    { fallback: back },
  );
}

/** `eq|noop|…` — disabled labels (page indicator, "Equipped"); only reachable by a forged click. */
export async function handleEquipmentNoop(ctx: AppContext, i: ButtonInteraction, prov: Provisioned) {
  return handleEquipmentHome(ctx, i, prov);
}
