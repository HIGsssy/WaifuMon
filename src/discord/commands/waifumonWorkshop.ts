/**
 * Patch's Workshop button and select handlers (`pw:*`).
 *
 * Thin, like the Equipment and Combat Trials handlers: every handler acts on
 * `prov.playerId`, asks `EquipmentWorkshopService` (which checks the Equipment
 * unlock on every call and decides every rule), and hands the read model to
 * `workshopPresenter`. Component state is advisory — ids name instances,
 * recipes and pages, never players, and the service re-validates all of it.
 *
 * Idempotency: each rendered Confirm button carries a nonce, which becomes
 * the service's request key (`discord:<nonce>`). A double-click or a Discord
 * retry replays the operation that button already made — nothing is
 * destroyed, charged or rolled twice. Every freshly drawn review mints a new
 * nonce.
 *
 * Stale state is a repaint with a one-line reason: a copy favourited, locked,
 * equipped or dismantled since the list was drawn refuses the whole batch and
 * shows the list as it is now.
 */
import { randomBytes } from 'node:crypto';
import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import { resolveArtworkAttachment } from '../assets/resolveArtworkAttachment';
import { respondEphemeral } from '../ephemeralSession';
import { lockedFeatureView } from '../equipmentPresenter';
import {
  NONCE_PATTERN,
  buildDismantleList,
  buildDismantleResult,
  buildDismantleReview,
  buildFabricationResult,
  buildFabricationReview,
  buildRecipeList,
  buildSlotChoice,
  buildWorkshopHome,
  decodeIds,
  parseSlotChoice,
  type WorkshopArt,
} from '../workshopPresenter';
import type { AppContext, Provisioned } from '../types';
import type { NpcContent } from '../../modules/content/onboardingSchemas';
import { DISMANTLE_PAGE_SIZE, type EquipmentWorkshopService } from '../../modules/equipment/equipmentWorkshopService';
import { workshopArtworkCandidates } from '../../modules/equipment/workshopConfig';
import {
  AppError,
  EquipmentDismantleRefusedError,
  EquipmentDismantleSelectionError,
  FeatureLockedError,
  InsufficientComponentsError,
  InsufficientFundsError,
  WorkshopNoEligibleEquipmentError,
  WorkshopPreviewStaleError,
  WorkshopRecipeUnavailableError,
  WorkshopRequestConflictError,
} from '../../shared/errors';

type Interaction = ButtonInteraction | StringSelectMenuInteraction;

const NO_LONGER_WORKS = 'That button no longer works.';
const MALFORMED = 'That button is malformed — re-open Equipment from /waifumon.';
const RECIPE_GONE = "Patch isn't taking that order right now.";

/** A fresh Confirm-button nonce. */
export function mintWorkshopNonce(): string {
  return randomBytes(6).toString('base64url');
}

/** The service request key for a Confirm nonce. */
export function workshopRequestKey(nonce: string): string {
  return `discord:${nonce}`;
}

function patch(ctx: AppContext): NpcContent | null {
  return ctx.content.npcs?.find((n) => n.key === 'patch') ?? null;
}

/**
 * The Workshop's one picture: its configured artwork, else Patch's portrait,
 * else none (`workshopArtworkCandidates`). A missing or unsafe file is logged
 * by the resolver and skipped — artwork never costs a player the screen.
 */
export function workshopArt(ctx: AppContext): WorkshopArt | null {
  const candidates = workshopArtworkCandidates(ctx.content.equipmentWorkshop ?? null, patch(ctx));
  for (const c of candidates) {
    const resolved = resolveArtworkAttachment(ctx, {
      relativePath: c.relativePath,
      stem: c.source === 'workshop' ? 'patch_workshop' : 'npc_patch',
      logTag: c.source === 'workshop' ? 'equipment-workshop' : 'npc-portrait',
      logFields: { source: c.source },
    });
    if (resolved) return resolved;
  }
  return null;
}

function parsePage(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d{1,4}$/.test(raw)) return null;
  return Number(raw);
}

async function homeScreen(ctx: AppContext, s: EquipmentWorkshopService, playerId: number, status?: string) {
  return buildWorkshopHome(await s.overview(playerId), patch(ctx), status, workshopArt(ctx));
}

async function listScreen(ctx: AppContext, s: EquipmentWorkshopService, playerId: number, page: number, status?: string) {
  return buildDismantleList(await s.dismantleCandidates(playerId, page, DISMANTLE_PAGE_SIZE), patch(ctx), status);
}

async function recipesScreen(ctx: AppContext, s: EquipmentWorkshopService, playerId: number, status?: string) {
  return buildRecipeList(await s.overview(playerId), patch(ctx), status);
}

/**
 * Run one action with the shared error handling. `recover` repaints the
 * screen a refusal belongs on, with the refusal as its status line.
 */
async function run(
  ctx: AppContext,
  interaction: Interaction,
  prov: Provisioned,
  action: (s: EquipmentWorkshopService) => Promise<Parameters<typeof respondEphemeral>[1]>,
  recover?: (s: EquipmentWorkshopService, err: AppError) => Promise<Parameters<typeof respondEphemeral>[1]> | null,
): Promise<void> {
  const service = ctx.services.equipmentWorkshop;
  if (!service) {
    await respondEphemeral(interaction, NO_LONGER_WORKS);
    return;
  }
  try {
    await respondEphemeral(interaction, await action(service));
  } catch (err) {
    try {
      if (err instanceof FeatureLockedError) {
        await respondEphemeral(interaction, lockedFeatureView());
        return;
      }
      const screen = err instanceof AppError && recover ? recover(service, err) : null;
      if (screen) {
        await respondEphemeral(interaction, await screen);
        return;
      }
    } catch (inner) {
      // The recovery screen itself failed (e.g. the unlock was revoked
      // meanwhile): handle *that* error plainly.
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

/** Dismantle refusals repaint the list as it is now. */
function dismantleRecovery(ctx: AppContext, prov: Provisioned, page: number) {
  return (s: EquipmentWorkshopService, err: AppError) =>
    err instanceof EquipmentDismantleRefusedError ||
    err instanceof EquipmentDismantleSelectionError ||
    err instanceof WorkshopPreviewStaleError
      ? listScreen(ctx, s, prov.playerId, page, err.userMessage)
      : err instanceof WorkshopRequestConflictError
        ? homeScreen(ctx, s, prov.playerId, err.userMessage)
        : null;
}

/** Fabrication refusals repaint the recipe's slot screen (or the recipe list, if the recipe is gone). */
function fabricationRecovery(ctx: AppContext, prov: Provisioned, recipeKey: string) {
  return (s: EquipmentWorkshopService, err: AppError) => {
    if (err instanceof WorkshopRecipeUnavailableError) return recipesScreen(ctx, s, prov.playerId, RECIPE_GONE);
    if (
      err instanceof InsufficientComponentsError ||
      err instanceof InsufficientFundsError ||
      err instanceof WorkshopNoEligibleEquipmentError ||
      err instanceof WorkshopRequestConflictError
    ) {
      return (async () => {
        const view = await s.overview(prov.playerId);
        const recipe = view.recipes.find((r) => r.key === recipeKey);
        return recipe
          ? buildSlotChoice(recipe, view.balances, patch(ctx), err.userMessage)
          : buildRecipeList(view, patch(ctx), RECIPE_GONE);
      })();
    }
    return null;
  };
}

/** `pw|home` — the Workshop; also the Equipment home's 🔧 Visit Patch. */
export function handleWorkshopHome(ctx: AppContext, i: ButtonInteraction, prov: Provisioned) {
  return run(ctx, i, prov, (s) => homeScreen(ctx, s, prov.playerId));
}

/** `pw|dis|<page>` and `pw|disp|<page>|…` — the dismantle list. */
export async function handleDismantleList(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const page = parsePage(args[0]);
  if (page === null) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) => listScreen(ctx, s, prov.playerId, page));
}

/** `pw|dsel|<page>` — the multi-select; the chosen values are instance ids. Shows the review. */
export async function handleDismantleSelect(
  ctx: AppContext,
  i: StringSelectMenuInteraction,
  prov: Provisioned,
  args: string[],
) {
  const page = parsePage(args[0]);
  const values = i.values ?? [];
  const ids = values.map((v) => (/^\d{1,15}$/.test(v) ? Number(v) : NaN));
  if (page === null || ids.length === 0 || ids.length > DISMANTLE_PAGE_SIZE || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return respondEphemeral(i, MALFORMED);
  }
  return run(
    ctx,
    i,
    prov,
    async (s) =>
      buildDismantleReview(
        await s.previewDismantle(prov.playerId, ids),
        ids,
        page,
        mintWorkshopNonce(),
        patch(ctx),
        workshopArt(ctx),
      ),
    dismantleRecovery(ctx, prov, page),
  );
}

/** `pw|dcf|<nonce>|<total>|<ids>` — dismantle exactly the reviewed copies (or replay). */
export async function handleDismantleConfirm(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const [nonce, rawTotal, rawIds] = args;
  const ids = decodeIds(rawIds);
  if (!nonce || !NONCE_PATTERN.test(nonce) || !rawTotal || !/^\d{1,7}$/.test(rawTotal) || !ids) {
    return respondEphemeral(i, MALFORMED);
  }
  return run(
    ctx,
    i,
    prov,
    async (s) =>
      buildDismantleResult(
        await s.dismantle(prov.playerId, {
          equipmentIds: ids,
          requestKey: workshopRequestKey(nonce),
          expectedComponents: Number(rawTotal),
        }),
        patch(ctx),
        workshopArt(ctx),
      ),
    dismantleRecovery(ctx, prov, 0),
  );
}

/** `pw|fab` — the recipe list. */
export function handleFabricateList(ctx: AppContext, i: ButtonInteraction, prov: Provisioned) {
  return run(ctx, i, prov, (s) => recipesScreen(ctx, s, prov.playerId));
}

/** `pw|fr|<recipe>` — choose a slot. */
export async function handleFabricateRecipe(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const recipeKey = args[0];
  if (!recipeKey) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const view = await s.overview(prov.playerId);
    const recipe = view.recipes.find((r) => r.key === recipeKey);
    return recipe ? buildSlotChoice(recipe, view.balances, patch(ctx)) : buildRecipeList(view, patch(ctx), RECIPE_GONE);
  });
}

/** `pw|fs|<recipe>|<slot>` — review the cost. Never charges. */
export async function handleFabricateReview(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const recipeKey = args[0];
  const slot = parseSlotChoice(args[1]);
  if (!recipeKey || !slot) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const view = await s.overview(prov.playerId);
    const recipe = view.recipes.find((r) => r.key === recipeKey);
    if (!recipe) return buildRecipeList(view, patch(ctx), RECIPE_GONE);
    return buildFabricationReview(recipe, slot, view.balances, mintWorkshopNonce(), patch(ctx), null, workshopArt(ctx));
  });
}

/** `pw|fc|<recipe>|<slot>|<nonce>` — fabricate (or replay) and reveal. */
export async function handleFabricateConfirm(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const [recipeKey, rawSlot, nonce] = args;
  const slot = parseSlotChoice(rawSlot);
  if (!recipeKey || !slot || !nonce || !NONCE_PATTERN.test(nonce)) return respondEphemeral(i, MALFORMED);
  return run(
    ctx,
    i,
    prov,
    async (s) => {
      const outcome = await s.fabricate(prov.playerId, {
        recipeKey,
        slot,
        requestKey: workshopRequestKey(nonce),
      });
      const view = await s.overview(prov.playerId);
      const again = view.recipes.find((r) => r.key === recipeKey)?.slots.find((c) => c.choice === slot)?.available ?? false;
      return buildFabricationResult(outcome, patch(ctx), again, workshopArt(ctx));
    },
    fabricationRecovery(ctx, prov, recipeKey),
  );
}

/** `pw|noop|…` — disabled labels; only reachable by a forged click. */
export function handleWorkshopNoop(ctx: AppContext, i: ButtonInteraction, prov: Provisioned) {
  return handleWorkshopHome(ctx, i, prov);
}
