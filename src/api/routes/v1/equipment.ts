/**
 * A player's own Equipment — the Portal's management surface.
 *
 * Every route is a thin projection over `equipmentManagementService`, the same
 * service the Discord screens use: the unlock check, ownership, slot rules,
 * the stale-slot guard and every ATK / DEF / HP number (via
 * `combatStatsService`) live there. Nothing here calculates a stat, decides a
 * rule, or writes a table.
 *
 * Self-only through the player-scope hook: a Portal session can only name its
 * own player, and an instance id belonging to anyone else answers exactly as a
 * missing one does (`404 EQUIPMENT_NOT_OWNED`).
 *
 * A locked player reads `{ unlocked: false }` from the overview and
 * `422 FEATURE_LOCKED` from everything else — no counts, no gear.
 */
import type { Rarity } from '../../../db/schema';
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, errorSchema, notFoundResponse, playerIdParams } from '../../schemas/common';
import {
  equipmentBrowseQuery,
  equipmentDetailSchema,
  equipmentFlagParams,
  equipmentItemParams,
  equipmentItemSchema,
  equipmentOverviewSchema,
  equipmentPageSchema,
  equipmentSlotParams,
  flagBody,
  slotChangeBody,
  slotChangeSchema,
} from '../../schemas/equipment';
import type { EquipmentInstanceView } from '../../../modules/equipment/equipmentQueries';
import type { EquipmentSort } from '../../../modules/equipment/equipmentService';
import { BASIS_POINTS, SLOT_STAT } from '../../../modules/equipment/equipmentMath';
import { rollQualityPercent } from '../../../modules/equipment/equipmentRoll';
import { EQUIPMENT_SOURCE_LABELS, type EquipmentSourceType } from '../../../modules/equipment/vocabulary';
import type { SlotChangeOutcome } from '../../../modules/equipment/equipmentManagementService';

const lockedResponse = {
  422: errorSchema.describe('`FEATURE_LOCKED` — Equipment is not unlocked for this player.'),
} as const;

const toMultiplier = (bp: number) => bp / BASIS_POINTS;

/** The one projection of an owned copy the Portal sees. */
export function toEquipmentItemResource(view: EquipmentInstanceView) {
  const def = view.definition;
  return {
    id: view.id,
    name: view.displayName,
    baseName: def.name,
    description: def.description,
    slot: view.slot,
    rarity: def.rarity as Rarity,
    multiplier: toMultiplier(view.rolledMultiplierBp),
    range: { min: toMultiplier(def.multiplierMinBp), max: toMultiplier(def.multiplierMaxBp) },
    rollQuality: rollQualityPercent(def, view.rolledMultiplierBp),
    equipped: view.equipped,
    favorite: view.isFavorite,
    locked: view.isLocked,
    acquiredAt: view.acquiredAt,
    source: EQUIPMENT_SOURCE_LABELS[view.sourceType as EquipmentSourceType] ?? 'Unknown',
  };
}

function toSlotChange(outcome: SlotChangeOutcome) {
  return {
    slot: outcome.slot,
    changed: outcome.changed,
    item: outcome.item ? toEquipmentItemResource(outcome.item) : null,
    before: outcome.before,
    after: outcome.after,
  };
}

const SORT_TO_SERVICE: Readonly<Record<string, EquipmentSort>> = {
  newest: 'acquired',
  oldest: 'oldest',
  slot: 'slot',
  rarity: 'rarity',
  name: 'name',
  multiplier: 'multiplier',
  quality: 'quality',
};

export const equipmentRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const mgmt = ctx.services.equipmentManagement;
    // Not wired (a test context without Equipment): the paths do not exist.
    if (!mgmt) return;

    app.get(
      '/players/:playerId/equipment',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Equipment overview',
          description:
            'The active Buddy, ATK / DEF / HP from the combat-stat service, and the three active ' +
            'loadout slots. `{ unlocked: false }` — and nothing else — until Equipment is unlocked.',
          params: playerIdParams,
          response: {
            200: dataSchema(equipmentOverviewSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const overview = await mgmt.overview(requirePlayer(req).id);
        if (!overview.unlocked) return ok(req, { unlocked: false as const });
        const { stats, loadout } = overview;
        return ok(req, {
          unlocked: true as const,
          buddy: stats.buddy
            ? {
                waifuId: stats.buddy.waifuId,
                name: stats.buddy.name,
                level: stats.buddy.level,
                currentSp: stats.buddy.currentSp,
              }
            : null,
          stats: { ...stats.stats },
          unavailableReason: stats.unavailableReason,
          slots: {
            attack: loadout.slots.attack ? toEquipmentItemResource(loadout.slots.attack) : null,
            defense: loadout.slots.defense ? toEquipmentItemResource(loadout.slots.defense) : null,
            health: loadout.slots.health ? toEquipmentItemResource(loadout.slots.health) : null,
          },
        });
      },
    );

    app.get(
      '/players/:playerId/equipment/items',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Browse the Gear Bag',
          description:
            'One page of owned copies — one entry per copy, never grouped. Keyset-paginated: pass ' +
            '`nextCursor` back as `cursor` with the same filters and sort. `search` matches the ' +
            'display name (base name or affix suffix), never an internal key.',
          params: playerIdParams,
          querystring: equipmentBrowseQuery,
          response: {
            200: dataSchema(equipmentPageSchema),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const q = req.query;
        const page = await mgmt.browse(requirePlayer(req).id, {
          ...(q.slot !== undefined ? { slot: q.slot } : {}),
          ...(q.rarity !== undefined ? { rarity: q.rarity } : {}),
          ...(q.equipped !== undefined ? { equipped: q.equipped } : {}),
          ...(q.favorite !== undefined ? { favorite: q.favorite } : {}),
          ...(q.locked !== undefined ? { locked: q.locked } : {}),
          ...(q.search ? { search: q.search } : {}),
          sort: SORT_TO_SERVICE[q.sort]!,
          cursor: q.cursor ?? null,
          limit: q.limit,
        });
        return ok(req, { items: page.items.map(toEquipmentItemResource), nextCursor: page.nextCursor });
      },
    );

    app.get(
      '/players/:playerId/equipment/items/:equipmentId',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Inspect one owned copy',
          description:
            'The copy, plus a comparison against what its slot holds now — both numbers from the ' +
            'combat-stat service’s `previewSlot`. Values are null without an active Buddy.',
          params: equipmentItemParams,
          response: {
            200: dataSchema(equipmentDetailSchema),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const view = await mgmt.item(requirePlayer(req).id, req.params.equipmentId);
        return ok(req, {
          item: toEquipmentItemResource(view.instance),
          identicalCopies: view.copies.length,
          comparison: {
            stat: SLOT_STAT[view.instance.slot],
            current: view.current,
            withItem: view.preview.value,
            delta: view.preview.delta,
            equippedItem: view.slotEquipped ? toEquipmentItemResource(view.slotEquipped) : null,
            hasBuddy: view.stats.buddy != null,
          },
        });
      },
    );

    app.post(
      '/players/:playerId/equipment/items/:equipmentId/equip',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Equip a copy in its slot',
          description:
            '`expectedCurrentId` is what the client showed in the slot (null for empty). If the ' +
            'slot changed since, nothing is written and the answer is `409 LOADOUT_CONFLICT`.',
          params: equipmentItemParams,
          body: slotChangeBody,
          response: {
            200: dataSchema(slotChangeSchema),
            409: errorSchema.describe('`LOADOUT_CONFLICT` — the slot changed since it was read.'),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const outcome = await mgmt.equip(requirePlayer(req).id, req.params.equipmentId, req.body.expectedCurrentId);
        return ok(req, toSlotChange(outcome));
      },
    );

    app.post(
      '/players/:playerId/equipment/loadout/:slot/unequip',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Empty a slot',
          description:
            'Same stale-view guard as equip. The slot’s stat becomes null — there is no fallback ' +
            'multiplier.',
          params: equipmentSlotParams,
          body: slotChangeBody,
          response: {
            200: dataSchema(slotChangeSchema),
            409: errorSchema.describe('`LOADOUT_CONFLICT` — the slot changed since it was read.'),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const outcome = await mgmt.unequip(requirePlayer(req).id, req.params.slot, req.body.expectedCurrentId);
        return ok(req, toSlotChange(outcome));
      },
    );

    app.put(
      '/players/:playerId/equipment/items/:equipmentId/flags/:flag',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Set a copy’s favourite or lock flag',
          description:
            'Sets (does not toggle), so a doubled request lands on the same value. Favourite and ' +
            'lock are independent. A lock protects a copy from admin removal; it does not stop ' +
            'equipping or unequipping.',
          params: equipmentFlagParams,
          body: flagBody,
          response: {
            200: dataSchema(equipmentItemSchema),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const view = await mgmt.setFlag(requirePlayer(req).id, req.params.equipmentId, req.params.flag, req.body.value);
        return ok(req, toEquipmentItemResource(view));
      },
    );
  };
