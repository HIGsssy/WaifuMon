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
import { z } from 'zod';
import type { Rarity } from '../../../db/schema';
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, errorSchema, notFoundResponse, playerIdParams } from '../../schemas/common';
import {
  dismantleBody,
  dismantlePreviewBody,
  dismantlePreviewSchema,
  dismantleResultSchema,
  fabricateBody,
  fabricationResultSchema,
  workshopOverviewSchema,
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
  type CombatBonusFamilyId,
} from '../../schemas/equipment';
import type { EquipmentInstanceView } from '../../../modules/equipment/equipmentQueries';
import type { EquipmentSort } from '../../../modules/equipment/equipmentService';
import type { CombatModifiers } from '../../../modules/combat/combatTypes';
import {
  COMBAT_BONUS_LABELS,
  COMBAT_BONUS_MODIFIER,
  COMBAT_BONUS_STATS,
  combatModifierRows,
  formatCombatBonus,
  type CombatBonus,
  type CombatBonusStat,
} from '../../../modules/equipment/combatBonuses';
import { BASIS_POINTS, SLOT_STAT } from '../../../modules/equipment/equipmentMath';
import { rollQualityPercent } from '../../../modules/equipment/equipmentRoll';
import { EQUIPMENT_SOURCE_LABELS, type EquipmentSourceType } from '../../../modules/equipment/vocabulary';
import type { SlotChangeOutcome } from '../../../modules/equipment/equipmentManagementService';
import {
  dismantleBlocker,
  type DismantleLine,
  type FabricationOutcome,
} from '../../../modules/equipment/equipmentWorkshopService';
import {
  salvageYieldOf,
  workshopArtworkCandidates,
  type WorkshopArtworkSource,
  type WorkshopConfig,
} from '../../../modules/equipment/workshopConfig';
import { locateArtworkFile } from '../../../modules/assets/artworkFile';
import type { ArtworkFile } from '../../../modules/assets/speciesArtworkFile';
import { sendArtwork } from '../../artworkResponse';
import { EquipmentDismantleRefusedError, FeatureLockedError } from '../../../shared/errors';
import { ApiErrorWithDetails, ApiNotFoundError } from '../../errors';

const lockedResponse = {
  422: errorSchema.describe('`FEATURE_LOCKED` — Equipment is not unlocked for this player.'),
} as const;

const toMultiplier = (bp: number) => bp / BASIS_POINTS;

const BONUS_FAMILY_ID: Readonly<Record<CombatBonusStat, CombatBonusFamilyId>> = {
  crit_chance_bp: 'crit_chance',
  crit_damage_bonus_bp: 'crit_damage',
  double_attack_chance_bp: 'double_attack',
  armor_penetration_bp: 'armor_penetration',
  lifesteal_bp: 'lifesteal',
};
const MODIFIER_FAMILY_ID = Object.fromEntries(
  COMBAT_BONUS_STATS.map((stat) => [COMBAT_BONUS_MODIFIER[stat], BONUS_FAMILY_ID[stat]]),
) as Readonly<Record<keyof CombatModifiers, CombatBonusFamilyId>>;

/** A loadout's cumulative totals as the Portal shows them. Zero rows are already omitted. */
export function toCombatModifierResources(modifiers: CombatModifiers) {
  return combatModifierRows(modifiers).map((row) => ({ key: MODIFIER_FAMILY_ID[row.key], label: row.label, value: row.value }));
}

/** A copy's rolled bonuses as the Portal shows them: percentages and ready text, never basis points. */
export function toCombatBonusResources(bonuses: readonly CombatBonus[]) {
  return bonuses.map((bonus) => ({
    stat: BONUS_FAMILY_ID[bonus.stat],
    label: COMBAT_BONUS_LABELS[bonus.stat],
    percent: bonus.valueBp / 100,
    text: formatCombatBonus(bonus),
  }));
}

/**
 * The one projection of an owned copy the Portal sees. `workshop` is the live
 * Workshop configuration: dismantle eligibility is decided here, by the same
 * rule the dismantle route enforces, so the Portal never re-derives it.
 */
export function toEquipmentItemResource(view: EquipmentInstanceView, workshop: WorkshopConfig | null) {
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
    combatBonuses: toCombatBonusResources(view.combatBonuses),
    equipped: view.equipped,
    favorite: view.isFavorite,
    locked: view.isLocked,
    acquiredAt: view.acquiredAt,
    source: EQUIPMENT_SOURCE_LABELS[view.sourceType as EquipmentSourceType] ?? 'Unknown',
    salvage: {
      components: salvageYieldOf(workshop, def.rarity),
      blockedBy: dismantleBlocker(view, workshop),
    },
  };
}

function toSlotChange(outcome: SlotChangeOutcome, workshop: WorkshopConfig | null) {
  return {
    slot: outcome.slot,
    changed: outcome.changed,
    item: outcome.item ? toEquipmentItemResource(outcome.item, workshop) : null,
    before: outcome.before,
    after: outcome.after,
  };
}

function toDismantleLine(line: DismantleLine) {
  return {
    id: line.equipmentId,
    name: line.displayName,
    rarity: line.rarity as Rarity,
    slot: line.slot,
    multiplier: toMultiplier(line.rolledMultiplierBp),
    combatBonuses: toCombatBonusResources(line.combatBonuses),
    components: line.components,
  };
}

function toFabricationResult(outcome: FabricationOutcome) {
  return {
    replayed: outcome.replayed,
    recipe: { ...outcome.recipe, rarity: outcome.recipe.rarity as Rarity },
    slotChoice: outcome.slotChoice,
    cost: outcome.cost,
    item: {
      id: outcome.item.equipmentId,
      name: outcome.item.displayName,
      baseName: outcome.item.name,
      slot: outcome.item.slot,
      rarity: outcome.item.rarity as Rarity,
      multiplier: toMultiplier(outcome.item.rolledMultiplierBp),
      affix: outcome.item.affixSuffix,
      combatBonuses: toCombatBonusResources(outcome.item.combatBonuses),
    },
    balances: outcome.balances,
  };
}

/**
 * A refused dismantle names every offending copy in `details.problems`, so the
 * Portal can point at them. Only ids the caller sent and a reason — nothing
 * about anyone else's gear.
 */
async function withDismantleProblems<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof EquipmentDismantleRefusedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        problems: err.problems.map((p) => ({ id: p.equipmentId, reason: p.reason })),
      });
    }
    throw err;
  }
}

/** Caller-dependent (self-only, unlock-gated) bytes: never a shared cache. */
const WORKSHOP_ARTWORK_CACHE = 'private, max-age=300, must-revalidate';

interface WarnLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The Workshop image that is actually on disk: the configured Workshop
 * artwork, else Patch's portrait (`workshopArtworkCandidates`), checked with
 * the shared shape / containment / existence rules. A missing or unsafe file
 * is logged and skipped, so the Workshop always renders — text-only at worst.
 */
function locateWorkshopArtwork(
  assetsDir: string | undefined,
  config: WorkshopConfig | null,
  patch: { portraitPath?: string | null | undefined } | null,
  log: WarnLog,
): { source: WorkshopArtworkSource; file: ArtworkFile } | null {
  if (assetsDir === undefined) return null;
  for (const candidate of workshopArtworkCandidates(config, patch)) {
    const located = locateArtworkFile(assetsDir, candidate.relativePath);
    if (located.status === 'available') {
      const { absolutePath, extension, contentType } = located;
      return { source: candidate.source, file: { absolutePath, extension, contentType } };
    }
    log.warn(
      { tag: 'equipment-workshop/artwork-unavailable', source: candidate.source, artwork: candidate.relativePath, status: located.status },
      'Workshop artwork unavailable — falling back',
    );
  }
  return null;
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
    const workshopConfig = () => ctx.getContent().equipmentWorkshop ?? null;

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
          combatModifiers: toCombatModifierResources(stats.combatModifiers),
          unavailableReason: stats.unavailableReason,
          slots: {
            attack: loadout.slots.attack ? toEquipmentItemResource(loadout.slots.attack, workshopConfig()) : null,
            defense: loadout.slots.defense ? toEquipmentItemResource(loadout.slots.defense, workshopConfig()) : null,
            health: loadout.slots.health ? toEquipmentItemResource(loadout.slots.health, workshopConfig()) : null,
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
        const config = workshopConfig();
        return ok(req, {
          items: page.items.map((item) => toEquipmentItemResource(item, config)),
          nextCursor: page.nextCursor,
        });
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
          item: toEquipmentItemResource(view.instance, workshopConfig()),
          identicalCopies: view.copies.length,
          comparison: {
            stat: SLOT_STAT[view.instance.slot],
            current: view.current,
            withItem: view.preview.value,
            delta: view.preview.delta,
            equippedItem: view.slotEquipped ? toEquipmentItemResource(view.slotEquipped, workshopConfig()) : null,
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
        return ok(req, toSlotChange(outcome, workshopConfig()));
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
        return ok(req, toSlotChange(outcome, workshopConfig()));
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
        return ok(req, toEquipmentItemResource(view, workshopConfig()));
      },
    );

    // ── Patch's Workshop ────────────────────────────────────────────────────
    //
    // Thin projections over `equipmentWorkshopService`, the same service the
    // Discord Workshop calls: every cost, yield, eligibility rule and balance
    // check lives there. Unlock-gated like every Equipment route.

    const workshop = ctx.services.equipmentWorkshop;
    if (!workshop) return;
    const patchNpc = () => ctx.getContent().npcs?.find((n) => n.key === 'patch') ?? null;
    const workshopArtwork = (log: WarnLog) =>
      locateWorkshopArtwork(ctx.assetsDir, workshopConfig(), patchNpc(), log);

    app.get(
      '/players/:playerId/equipment/workshop',
      {
        schema: {
          tags: ['Equipment'],
          summary: "Patch's Workshop overview",
          description:
            'Salvaged Components and WaifuBux balances, salvage yields by rarity, and the enabled ' +
            'fabrication recipes with live per-slot availability from the current definitions.',
          params: playerIdParams,
          response: {
            200: dataSchema(workshopOverviewSchema),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const view = await workshop.overview(requirePlayer(req).id);
        const artwork = workshopArtwork(req.log);
        return ok(req, {
          balances: view.balances,
          artwork: artwork ? { source: artwork.source } : null,
          salvageYields: view.salvageYields.map((y) => ({ rarity: y.rarity as Rarity, components: y.components })),
          recipes: view.recipes.map((r) => ({ ...r, rarity: r.rarity as Rarity })),
        });
      },
    );

    app.get(
      '/players/:playerId/equipment/workshop/artwork',
      {
        schema: {
          tags: ['Equipment'],
          summary: "Patch's Workshop artwork",
          description:
            'The Workshop’s image bytes: its configured artwork, else Patch’s portrait. ' +
            '`404` when neither file exists — the Workshop is then text-only. Self-only and ' +
            'unlock-gated like the overview; ETag / 304 like every artwork route.',
          params: playerIdParams,
          querystring: z
            .object({
              source: z
                .enum(['workshop', 'patch'])
                .optional()
                .describe('Client cache discriminator only — the server always serves the current best image.'),
            })
            .strict(),
          response: {
            304: z.null().describe('Unchanged — the ETag matched.'),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req, reply) => {
        const playerId = requirePlayer(req).id;
        // The unlock gate before any file is touched.
        if (!(await workshop.isAvailable(playerId))) throw new FeatureLockedError('equipment');
        const artwork = workshopArtwork(req.log);
        if (!artwork || ctx.assetsDir === undefined) throw new ApiNotFoundError('No Workshop artwork is configured.');
        await sendArtwork(ctx.assetsDir, { headers: req.headers, query: {} }, reply, artwork.file, WORKSHOP_ARTWORK_CACHE);
        return reply;
      },
    );

    app.post(
      '/players/:playerId/equipment/workshop/dismantle/preview',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Review a dismantle',
          description:
            'What dismantling exactly these copies would pay. Writes nothing. Refused — with every ' +
            'offending copy in `details.problems` — exactly when the dismantle itself would be.',
          params: playerIdParams,
          body: dismantlePreviewBody,
          response: {
            200: dataSchema(dismantlePreviewSchema),
            409: errorSchema.describe('`EQUIPMENT_DISMANTLE_REFUSED` — a selected copy is protected, gone or unsalvageable.'),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const preview = await withDismantleProblems(() =>
          workshop.previewDismantle(requirePlayer(req).id, req.body.equipmentIds),
        );
        return ok(req, {
          ...preview,
          byRarity: preview.byRarity.map((l) => ({ ...l, rarity: l.rarity as Rarity })),
          items: preview.items.map(toDismantleLine),
        });
      },
    );

    app.post(
      '/players/:playerId/equipment/workshop/dismantle',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Dismantle Equipment',
          description:
            'Destroy exactly these copies for Salvaged Components — all or nothing. Equipped, ' +
            'favourite and locked copies are refused, never forced. `requestKey` makes a retry ' +
            'return the original result instead of destroying or paying again.',
          params: playerIdParams,
          body: dismantleBody,
          response: {
            200: dataSchema(dismantleResultSchema),
            409: errorSchema.describe(
              '`EQUIPMENT_DISMANTLE_REFUSED`, `WORKSHOP_PREVIEW_STALE` or `WORKSHOP_REQUEST_CONFLICT`. Nothing was dismantled.',
            ),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const outcome = await withDismantleProblems(() =>
          workshop.dismantle(requirePlayer(req).id, {
            equipmentIds: req.body.equipmentIds,
            requestKey: req.body.requestKey,
            ...(req.body.expectedComponents !== undefined ? { expectedComponents: req.body.expectedComponents } : {}),
          }),
        );
        return ok(req, {
          ...outcome,
          byRarity: outcome.byRarity.map((l) => ({ ...l, rarity: l.rarity as Rarity })),
          items: outcome.items.map(toDismantleLine),
        });
      },
    );

    app.post(
      '/players/:playerId/equipment/workshop/fabricate',
      {
        schema: {
          tags: ['Equipment'],
          summary: 'Fabricate Equipment',
          description:
            'Spend a recipe’s Salvaged Components and WaifuBux for one random piece of its rarity, in ' +
            'the chosen slot (or any). Refused before any charge when nothing is eligible or a ' +
            'balance is short. `requestKey` makes a retry return the same item, charged once.',
          params: playerIdParams,
          body: fabricateBody,
          response: {
            200: dataSchema(fabricationResultSchema),
            409: errorSchema.describe('`WORKSHOP_REQUEST_CONFLICT` — the key was used for a different request.'),
            ...lockedResponse,
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const outcome = await workshop.fabricate(requirePlayer(req).id, {
          recipeKey: req.body.recipeKey,
          slot: req.body.slot,
          requestKey: req.body.requestKey,
        });
        return ok(req, toFabricationResult(outcome));
      },
    );
  };
