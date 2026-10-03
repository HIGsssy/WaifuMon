/**
 * Dungeon button handlers (`dg:*`).
 *
 * Thin: every handler acts on `prov.playerId`, asks `DungeonPlayService`
 * (which checks the Equipment unlock, locks the run and re-reads all state)
 * and hands the read model to `dungeonPresenter`. Nothing about a run is
 * decided here.
 *
 * Idempotency: buttons carry the run id and node id, which *are* the
 * transition. A double-click or a Discord retry names the same transition and
 * the service replays it; a stale button (the other side of a fork, a run that
 * has ended) is refused and the run is repainted as it now stands.
 */
import path from 'node:path';
import { AttachmentBuilder, type ButtonInteraction } from 'discord.js';
import { ownedArtworkImage } from '../assets/attachRenderedCard';
import type { TrialArt, TrialArtwork } from '../combatTrialPresenter';
import {
  RUN_ACTIVE_NOTICE,
  RUN_NOT_FOUND,
  ZONE_UNAVAILABLE,
  actionNotice,
  buildAbandonConfirm,
  buildDungeonHome,
  buildExtractConfirm,
  buildRunScreen,
  buildZoneDetail,
  lockedDungeonsView,
  type DungeonScreenOptions,
} from '../dungeonPresenter';
import { respondEphemeral, type SessionPayload } from '../ephemeralSession';
import type { AppContext, Provisioned } from '../types';
import { locateCombatArtwork } from '../../modules/combat/combatArtwork';
import type { DungeonPlayService, DungeonRunView } from '../../modules/dungeons/dungeonPlayService';
import {
  AppError,
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  DungeonDailyLimitError,
  DungeonGenerationError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonZoneInvalidError,
  DungeonZoneUnavailableError,
  FeatureLockedError,
} from '../../shared/errors';

const NO_LONGER_WORKS = 'That button no longer works.';
const MALFORMED = 'That button is malformed — re-open Delve from /waifumon.';
const RUN_ID_PATTERN = /^[1-9]\d{0,15}$/;
const NODE_ID_PATTERN = /^n\d{1,3}$/;
const ZONE_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * The large picture, first match wins: the node's event artwork, the enemy's
 * artwork, the zone's artwork, the zone's background. Missing or unsafe files
 * are skipped, so a screen renders text-only rather than failing.
 */
export function dungeonSceneArtwork(
  ctx: AppContext,
  candidates: readonly (string | null | undefined)[],
): TrialArtwork | null {
  for (const relative of candidates) {
    const found = locateCombatArtwork(ctx.config.assetsDir, relative);
    if (found.status !== 'available') continue;
    // Named after the file that was found, so the attachment says which one it is.
    const base = path.basename(found.absolutePath, path.extname(found.absolutePath)).replace(/[^A-Za-z0-9]+/g, '-');
    const name = `dungeon-${base}.${found.extension}`;
    return { file: new AttachmentBuilder(found.absolutePath, { name }), url: `attachment://${name}` };
  }
  return null;
}

/**
 * The run's *snapshotted* Buddy, by the copy the run started with — not
 * whoever is active now. Null once she is released, or on any failure.
 */
async function fighterArtwork(ctx: AppContext, playerId: number, waifuId: number): Promise<TrialArtwork | null> {
  if (!ctx.services.collection) return null;
  try {
    return ownedArtworkImage(ctx, await ctx.services.collection.getOwned(playerId, waifuId));
  } catch (err) {
    ctx.logger.warn({ err, playerId, waifuId }, 'dungeons: fighter artwork unavailable');
    return null;
  }
}

/** The live active Buddy's artwork, for the pre-run zone screen. Never throws. */
async function buddyArtwork(ctx: AppContext, playerId: number, waifuId: number | null): Promise<TrialArtwork | null> {
  if (waifuId == null || !ctx.services.collection) return null;
  try {
    const entry = await ctx.services.collection.getBuddy(playerId);
    return entry?.waifu.id === waifuId ? ownedArtworkImage(ctx, entry) : null;
  } catch (err) {
    ctx.logger.warn({ err, playerId }, 'dungeons: buddy artwork unavailable');
    return null;
  }
}

function options(ctx: AppContext, art: TrialArt, status?: string | null): DungeonScreenOptions {
  return {
    itemName: (slug) => ctx.content.items.find((i) => i.slug === slug)?.name ?? slug,
    art,
    status: status ?? null,
  };
}

async function runArt(ctx: AppContext, playerId: number, view: DungeonRunView): Promise<TrialArt> {
  return {
    scene: dungeonSceneArtwork(ctx, [
      view.node.event?.artworkPath,
      view.node.enemy?.artworkPath,
      view.zone.artworkPath,
      view.zone.backgroundArtworkPath,
    ]),
    buddy: await fighterArtwork(ctx, playerId, view.fighter.waifuId),
  };
}

async function runScreen(ctx: AppContext, playerId: number, view: DungeonRunView, status?: string | null) {
  return buildRunScreen(view, options(ctx, await runArt(ctx, playerId, view), status));
}

async function homeScreen(ctx: AppContext, service: DungeonPlayService, playerId: number, status?: string | null) {
  const view = await service.home(playerId);
  // With a run: the run's own scene. Without: the first listed zone that has
  // artwork deployed — its zone art, else its background, else text only.
  const art = view.activeRun
    ? await runArt(ctx, playerId, view.activeRun)
    : { scene: dungeonSceneArtwork(ctx, view.zones.flatMap((z) => [z.artworkPath, z.backgroundArtworkPath])) };
  return buildDungeonHome(view, options(ctx, art, status));
}

async function zoneScreen(
  ctx: AppContext,
  service: DungeonPlayService,
  playerId: number,
  zoneKey: string,
  status?: string | null,
) {
  const view = await service.zone(playerId, zoneKey);
  const art = {
    scene: dungeonSceneArtwork(ctx, [view.zone.artworkPath, view.zone.backgroundArtworkPath]),
    buddy: await buddyArtwork(ctx, playerId, view.stats.buddy?.waifuId ?? null),
  };
  return buildZoneDetail(view, options(ctx, art, status));
}

/**
 * Run one action with the shared error handling. Everything a handler does
 * happens inside the service's own transaction, so every failure path is a
 * repaint of where the player actually is.
 */
async function run(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  action: (service: DungeonPlayService) => Promise<SessionPayload | string>,
  recover: { zoneKey?: string } = {},
): Promise<void> {
  const service = ctx.services.dungeonPlay;
  if (!service) {
    await respondEphemeral(interaction, NO_LONGER_WORKS);
    return;
  }
  try {
    await respondEphemeral(interaction, await action(service));
  } catch (err) {
    try {
      if (err instanceof FeatureLockedError) {
        await respondEphemeral(interaction, lockedDungeonsView());
        return;
      }
      if (err instanceof DungeonRunActiveError) {
        const active = await service.activeRun(prov.playerId);
        await respondEphemeral(
          interaction,
          active
            ? await runScreen(ctx, prov.playerId, active, RUN_ACTIVE_NOTICE)
            : await homeScreen(ctx, service, prov.playerId, RUN_ACTIVE_NOTICE),
        );
        return;
      }
      if (err instanceof DungeonDailyLimitError) {
        // The home says how many are left and when they come back.
        await respondEphemeral(interaction, await homeScreen(ctx, service, prov.playerId, err.userMessage));
        return;
      }
      if (
        err instanceof DungeonZoneUnavailableError ||
        err instanceof DungeonZoneInvalidError ||
        err instanceof DungeonGenerationError
      ) {
        if (!(err instanceof DungeonZoneUnavailableError)) {
          ctx.logger.error({ err, tag: 'dungeons/start-failed', playerId: prov.playerId }, 'dungeon run could not be generated');
        }
        // Not startable from here: say where "here" is, over the zones that are.
        const notice =
          err instanceof DungeonZoneUnavailableError && err.reason === 'region' ? err.userMessage : ZONE_UNAVAILABLE;
        await respondEphemeral(interaction, await homeScreen(ctx, service, prov.playerId, notice));
        return;
      }
      if (err instanceof DungeonRunNotFoundError) {
        await respondEphemeral(interaction, await homeScreen(ctx, service, prov.playerId, RUN_NOT_FOUND));
        return;
      }
      if ((err instanceof CombatBuddyRequiredError || err instanceof CombatLoadoutIncompleteError) && recover.zoneKey) {
        await respondEphemeral(interaction, await zoneScreen(ctx, service, prov.playerId, recover.zoneKey, err.userMessage));
        return;
      }
    } catch (inner) {
      // The recovery screen itself failed: handle that error plainly.
      err = inner;
      if (err instanceof FeatureLockedError) {
        await respondEphemeral(interaction, lockedDungeonsView());
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

function parseRun(args: string[], withNode: boolean): { runId: number; nodeId: string } | null {
  const [rawRun, rawNode] = args;
  if (!rawRun || !RUN_ID_PATTERN.test(rawRun)) return null;
  if (withNode && (!rawNode || !NODE_ID_PATTERN.test(rawNode))) return null;
  return { runId: Number(rawRun), nodeId: rawNode ?? '' };
}

/** `dg|home` — zones, or the active run; also the main menu's ⛏️ Delve. */
export async function handleDungeonHome(ctx: AppContext, i: ButtonInteraction, prov: Provisioned) {
  return run(ctx, i, prov, (s) => homeScreen(ctx, s, prov.playerId));
}

/** `dg|zone|<zoneKey>` — the zone screen. Never starts a run. */
export async function handleDungeonZone(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const zoneKey = args[0];
  if (!zoneKey || !ZONE_KEY_PATTERN.test(zoneKey)) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) => zoneScreen(ctx, s, prov.playerId, zoneKey));
}

/** `dg|start|<zoneKey>` — spend a daily run, generate a run and snapshot the fighter. */
export async function handleDungeonStart(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const zoneKey = args[0];
  if (!zoneKey || !ZONE_KEY_PATTERN.test(zoneKey)) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => runScreen(ctx, prov.playerId, await s.start(prov.playerId, zoneKey)), { zoneKey });
}

/** `dg|run|<runId>` — the run as it stands (Resume, and "back" from a confirmation). */
export async function handleDungeonRun(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args, false);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => runScreen(ctx, prov.playerId, await s.run(prov.playerId, parsed.runId)));
}

/** `dg|enter|<runId>|<nodeId>` — step onto an available node. */
export async function handleDungeonEnter(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args, true);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const result = await s.enterNode(prov.playerId, parsed.runId, parsed.nodeId);
    // Re-entering the node you are already on is just the screen again.
    const notice = result.status === 'replayed' ? null : actionNotice(result);
    return runScreen(ctx, prov.playerId, result.run, notice);
  });
}

/** `dg|go|<runId>|<nodeId>` — resolve the node: fight, rest, event, reward or exit. */
export async function handleDungeonResolve(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args, true);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const result = await s.resolveNode(prov.playerId, parsed.runId, parsed.nodeId);
    return runScreen(ctx, prov.playerId, result.run, actionNotice(result));
  });
}

/** `dg|exq|<runId>|<nodeId>` — ask before extracting. Changes nothing. */
export async function handleDungeonExtractConfirm(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args, true);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const view = await s.run(prov.playerId, parsed.runId);
    if (!view.canExtract || view.node.id !== parsed.nodeId) {
      return runScreen(ctx, prov.playerId, view, actionNotice({ status: 'refused', refusal: view.status === 'active' ? 'not_extractable' : 'run_over' }));
    }
    return buildExtractConfirm(view);
  });
}

/** `dg|ex|<runId>|<nodeId>` — extract: bank everything and end the run. */
export async function handleDungeonExtract(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args, true);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const result = await s.extract(prov.playerId, parsed.runId, parsed.nodeId);
    return runScreen(ctx, prov.playerId, result.run, actionNotice(result));
  });
}

/** `dg|abq|<runId>` — ask before abandoning. Changes nothing. */
export async function handleDungeonAbandonConfirm(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args, false);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const view = await s.run(prov.playerId, parsed.runId);
    if (view.status !== 'active') return runScreen(ctx, prov.playerId, view, actionNotice({ status: 'refused', refusal: 'run_over' }));
    return buildAbandonConfirm(view);
  });
}

/** `dg|ab|<runId>` — abandon: settled like a defeat. */
export async function handleDungeonAbandon(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args, false);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const result = await s.abandon(prov.playerId, parsed.runId);
    // A run with no fighter has no screen of its own: back to the zones.
    if (!result) return homeScreen(ctx, s, prov.playerId);
    return runScreen(ctx, prov.playerId, result.run, actionNotice(result));
  });
}
