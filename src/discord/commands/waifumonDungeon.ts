/**
 * Dungeon button handlers (`dg:*`).
 *
 * Thin: every handler acts on `prov.playerId`, asks `DungeonRunService`
 * (which checks the Equipment unlock, locks the run and re-reads all state)
 * and hands the read model to `dungeonPresenter`. Nothing about a run is
 * decided here.
 *
 * Idempotency: a button that moves a run carries the run id and the step it
 * was drawn for, passed on as `expectedStep`. A double-click, a Discord retry
 * or a button from an earlier screen names a step the run has left; the
 * service refuses it as `stale`, changes nothing, and the run is repainted as
 * it now stands. Abandoning carries no step — it is always allowed, and a
 * second click finds the run already over.
 */
import type { ButtonInteraction } from 'discord.js';
import { ownedArtworkImage } from '../assets/attachRenderedCard';
import { dungeonRunSceneArtwork, dungeonZoneArtwork } from '../dungeonArtwork';
import type { TrialArt, TrialArtwork } from '../combatTrialPresenter';
import {
  RUN_ACTIVE_NOTICE,
  RUN_NOT_FOUND,
  ZONE_UNAVAILABLE,
  actionNotice,
  buildAbandonConfirm,
  buildDungeonDetail,
  buildDungeonHome,
  buildExtractConfirm,
  buildRunScreen,
  lockedDungeonsView,
  type DungeonScreenOptions,
} from '../dungeonPresenter';
import { respondEphemeral, type SessionPayload } from '../ephemeralSession';
import type { AppContext, Provisioned } from '../types';
import type { DungeonRunService, DungeonRunView } from '../../modules/dungeons/dungeonRunService';
import type { DungeonInput } from '../../modules/dungeons/engine/types';
import {
  AppError,
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  DungeonDailyLimitError,
  DungeonInvalidError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonUnavailableError,
  FeatureLockedError,
} from '../../shared/errors';

const NO_LONGER_WORKS = 'That button no longer works.';
const MALFORMED = 'That button is malformed — re-open Delve from /waifumon.';
const RUN_ID_PATTERN = /^[1-9]\d{0,15}$/;
const STEP_PATTERN = /^\d{1,7}$/;
const CONNECTION_ID_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const CONNECTION_ID_MAX_LENGTH = 40;
const DUNGEON_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

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

/** The live active Buddy's artwork, for the pre-run dungeon screen. Never throws. */
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
  // The scene and its precedence are `dungeonArtwork.ts`; the Buddy is the thumbnail.
  return {
    scene: await dungeonRunSceneArtwork(ctx, view),
    buddy: await fighterArtwork(ctx, playerId, view.fighter.waifuId),
  };
}

async function runScreen(ctx: AppContext, playerId: number, view: DungeonRunView, status?: string | null) {
  return buildRunScreen(view, options(ctx, await runArt(ctx, playerId, view), status));
}

async function homeScreen(ctx: AppContext, service: DungeonRunService, playerId: number, status?: string | null) {
  const view = await service.home(playerId);
  // With a run: the run's own scene. Without: the first listed dungeon that has
  // artwork deployed — its artwork, else its background, else text only.
  const art = view.activeRun
    ? await runArt(ctx, playerId, view.activeRun)
    : { scene: await dungeonZoneArtwork(ctx, view.dungeons) };
  return buildDungeonHome(view, options(ctx, art, status));
}

async function detailScreen(
  ctx: AppContext,
  service: DungeonRunService,
  playerId: number,
  dungeonKey: string,
  status?: string | null,
) {
  const view = await service.dungeon(playerId, dungeonKey);
  const art = {
    scene: await dungeonZoneArtwork(ctx, [view.dungeon]),
    buddy: await buddyArtwork(ctx, playerId, view.stats.buddy?.waifuId ?? null),
  };
  return buildDungeonDetail(view, options(ctx, art, status));
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
  action: (service: DungeonRunService) => Promise<SessionPayload | string>,
  recover: { dungeonKey?: string } = {},
): Promise<void> {
  const service = ctx.services.dungeonRuns;
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
      if (err instanceof DungeonUnavailableError || err instanceof DungeonInvalidError) {
        if (err instanceof DungeonInvalidError) {
          ctx.logger.error({ err, tag: 'dungeons/start-failed', playerId: prov.playerId }, 'dungeon run could not be started');
        }
        // Not startable from here: say where "here" is, over the dungeons that are.
        const notice = err instanceof DungeonUnavailableError && err.reason === 'region' ? err.userMessage : ZONE_UNAVAILABLE;
        await respondEphemeral(interaction, await homeScreen(ctx, service, prov.playerId, notice));
        return;
      }
      if (err instanceof DungeonRunNotFoundError) {
        await respondEphemeral(interaction, await homeScreen(ctx, service, prov.playerId, RUN_NOT_FOUND));
        return;
      }
      if ((err instanceof CombatBuddyRequiredError || err instanceof CombatLoadoutIncompleteError) && recover.dungeonKey) {
        await respondEphemeral(interaction, await detailScreen(ctx, service, prov.playerId, recover.dungeonKey, err.userMessage));
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

function parseRunId(raw: string | undefined): number | null {
  return raw && RUN_ID_PATTERN.test(raw) ? Number(raw) : null;
}

/** `<runId>` alone: no further argument is accepted. */
function parseRun(args: string[]): { runId: number } | null {
  const runId = parseRunId(args[0]);
  return runId == null || args.length !== 1 ? null : { runId };
}

/** `<runId>|<step>` and exactly `extra` further arguments, returned as `rest`. */
function parseRunStep(args: string[], extra: number): { runId: number; step: number; rest: string[] } | null {
  const [rawRun, rawStep, ...rest] = args;
  const runId = parseRunId(rawRun);
  if (runId == null || !rawStep || !STEP_PATTERN.test(rawStep) || rest.length !== extra) return null;
  return { runId, step: Number(rawStep), rest };
}

function parseDungeonKey(args: string[]): string | null {
  const key = args[0];
  return key && args.length === 1 && DUNGEON_KEY_PATTERN.test(key) ? key : null;
}

/** One step of a run, then the run as it now stands — with a notice when the input was refused. */
async function step(ctx: AppContext, service: DungeonRunService, playerId: number, runId: number, input: DungeonInput) {
  const result = await service.act(playerId, runId, input);
  return runScreen(ctx, playerId, result.run, actionNotice(result));
}

/** `dg|home` — dungeons, or the active run; also the main menu's ⛏️ Delve. */
export async function handleDungeonHome(ctx: AppContext, i: ButtonInteraction, prov: Provisioned) {
  return run(ctx, i, prov, (s) => homeScreen(ctx, s, prov.playerId));
}

/** `dg|zone|<dungeonKey>` — the dungeon screen. Never starts a run. */
export async function handleDungeonZone(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const dungeonKey = parseDungeonKey(args);
  if (!dungeonKey) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) => detailScreen(ctx, s, prov.playerId, dungeonKey));
}

/** `dg|start|<dungeonKey>` — spend a daily run, pin the revision and snapshot the fighter. */
export async function handleDungeonStart(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const dungeonKey = parseDungeonKey(args);
  if (!dungeonKey) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => runScreen(ctx, prov.playerId, await s.start(prov.playerId, dungeonKey)), { dungeonKey });
}

/** `dg|run|<runId>` — the run as it stands (Resume, and "back" from a confirmation). */
export async function handleDungeonRun(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => runScreen(ctx, prov.playerId, await s.run(prov.playerId, parsed.runId)));
}

/** `dg|act|<runId>|<step>|<a|d>` — carry out the pending action (fight, rest, open…) or decline it. */
export async function handleDungeonAct(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 1);
  const code = parsed?.rest[0];
  if (!parsed || (code !== 'a' && code !== 'd')) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) =>
    step(ctx, s, prov.playerId, parsed.runId, { type: code === 'a' ? 'advance' : 'decline', expectedStep: parsed.step }),
  );
}

/** `dg|mv|<runId>|<step>|<connectionId>` — take a connection out of a finished room. */
export async function handleDungeonMove(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 1);
  const connectionId = parsed?.rest[0];
  if (
    !parsed ||
    !connectionId ||
    connectionId.length > CONNECTION_ID_MAX_LENGTH ||
    !CONNECTION_ID_PATTERN.test(connectionId)
  ) {
    return respondEphemeral(i, MALFORMED);
  }
  return run(ctx, i, prov, (s) =>
    step(ctx, s, prov.playerId, parsed.runId, { type: 'move', connectionId, expectedStep: parsed.step }),
  );
}

/** `dg|exq|<runId>` — ask before extracting. Changes nothing. */
export async function handleDungeonExtractConfirm(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const view = await s.run(prov.playerId, parsed.runId);
    if (!view.core.canExtract) {
      return runScreen(ctx, prov.playerId, view, actionNotice({ status: 'refused', refusal: view.status === 'active' ? 'not_extractable' : 'run_over' }));
    }
    // The confirmation's Extract button carries the step read here.
    return buildExtractConfirm(view);
  });
}

/** `dg|ex|<runId>|<step>` — extract: bank everything and end the run. */
export async function handleDungeonExtract(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) => step(ctx, s, prov.playerId, parsed.runId, { type: 'extract', expectedStep: parsed.step }));
}

/** `dg|abq|<runId>` — ask before abandoning. Changes nothing. */
export async function handleDungeonAbandonConfirm(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const view = await s.run(prov.playerId, parsed.runId);
    if (view.status !== 'active') return runScreen(ctx, prov.playerId, view, actionNotice({ status: 'refused', refusal: 'run_over' }));
    return buildAbandonConfirm(view);
  });
}

/** `dg|ab|<runId>` — abandon: settled like a defeat. No step: abandoning is always allowed. */
export async function handleDungeonAbandon(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRun(args);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) => step(ctx, s, prov.playerId, parsed.runId, { type: 'abandon' }));
}
