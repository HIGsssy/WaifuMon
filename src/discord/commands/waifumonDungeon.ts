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
 * it now stands. Abandon confirmations also carry the quoted step; older
 * step-less buttons reopen a current confirmation without settling.
 *
 * Encounters (`ci`, `cap`, `res`, `cl`, `cu`) follow the same rule. What a
 * capture or rescue *did* — the card, the XP, the rare-capture announcement,
 * the Activity Feed, appearance toasts — comes only from the receipts of the
 * press that committed it, and is sent only after the service's transaction
 * has returned. A stale press, a repaint or a resumed run has no receipts, so
 * nothing one-time is ever sent twice; a rolled-back step throws and sends
 * nothing at all.
 *
 * Puzzles (`pz`, `pza`): Enter Answer opens a modal and changes nothing. The
 * modal's id carries the run and the step the puzzle was drawn for, exactly
 * like a button, and its submission is one `answer` step under the same guard
 * — so a duplicate or late submission is `stale`, another player's is not
 * found, and an ended run refuses it. The typed answer goes to the service and
 * nowhere else: it is not logged here.
 */
import type { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
import { ownedArtworkImage, ownedCardImage } from '../assets/attachRenderedCard';
import { postAppearanceUnlockToasts } from '../appearanceToast';
import { dungeonRunSceneArtwork, dungeonZoneArtwork, speciesArtwork } from '../dungeonArtwork';
import { emitEvents } from '../gameEventEmitter';
import { dungeonEncounterDescriptors } from '../gameEventBuilders';
import { conversionResultPayload, duplicatePromptComponents } from './waifumonCollection';
import { sendRareAnnouncement } from './waifumonHunt';
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
  buildPuzzleModal,
  buildRunScreen,
  dgId,
  dungeonCaptureNavigation,
  lockedDungeonsView,
  PUZZLE_ANSWER_FIELD,
  type DungeonScreenOptions,
} from '../dungeonPresenter';
import { respondEphemeral, type SessionPayload } from '../ephemeralSession';
import type { AppContext, Provisioned } from '../types';
import type { DungeonEncounterReceipt, DungeonRunService, DungeonRunView } from '../../modules/dungeons/dungeonRunService';
import type { DungeonInput } from '../../modules/dungeons/engine/types';
import {
  AppError,
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  DungeonCaptureItemUnavailableError,
  DungeonCaptureQuoteChangedError,
  DungeonDailyLimitError,
  DungeonEncounterSpeciesUnavailableError,
  DungeonEventItemUnavailableError,
  DungeonInvalidError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonStepContendedError,
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
const ITEM_SLUG_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const ITEM_SLUG_MAX_LENGTH = 64;

type DungeonInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

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

function options(ctx: AppContext, art: TrialArt, status?: string | null, pinnedItems: Readonly<Record<string, string>> = {}): DungeonScreenOptions {
  return {
    itemName: (slug) => ctx.content.items.find((i) => i.slug === slug)?.name ?? pinnedItems[slug] ?? 'Unknown item',
    art,
    status: status ?? null,
  };
}

/** The copy a capture or rescue just created, as her card (else the look she wears). Null on any failure. */
async function acquiredArtwork(ctx: AppContext, playerId: number, waifuId: number): Promise<TrialArtwork | null> {
  if (!ctx.services.collection) return null;
  try {
    return await ownedCardImage(ctx, await ctx.services.collection.getOwned(playerId, waifuId));
  } catch (err) {
    ctx.logger.warn({ err, playerId, waifuId }, 'dungeons: acquired WaifuMon artwork unavailable');
    return null;
  }
}

/**
 * The picture for the step a WaifuMon was caught or rescued on: her new
 * card when this press made her, her standard artwork on a later repaint.
 * Null when the step gained no one, or the run is already offering another
 * WaifuMon (who is then the picture's subject) — and, on a repaint, when a
 * fight is waiting, whose enemy is.
 */
async function acquiredScene(
  ctx: AppContext,
  playerId: number,
  view: DungeonRunView,
  receipts: readonly DungeonEncounterReceipt[],
): Promise<TrialArtwork | null> {
  if (view.encounterActor) return null;
  const made = receipts.find((r) => r.acquired && (r.type === 'rescue_grant' || r.success));
  if (made?.acquired) return acquiredArtwork(ctx, playerId, made.acquired.waifuId);
  const told = view.latestEncounters?.find((e) => e.outcome === 'captured' || e.outcome === 'rescued');
  return told && !view.enemy ? speciesArtwork(ctx, told.species) : null;
}

async function runArt(ctx: AppContext, playerId: number, view: DungeonRunView, receipts: readonly DungeonEncounterReceipt[] = []): Promise<TrialArt> {
  // The scene and its precedence are `dungeonArtwork.ts`; the Buddy is the thumbnail.
  return {
    scene: (await acquiredScene(ctx, playerId, view, receipts)) ?? await dungeonRunSceneArtwork(ctx, view),
    buddy: await fighterArtwork(ctx, playerId, view.fighter.waifuId),
  };
}

async function runScreen(
  ctx: AppContext,
  playerId: number,
  view: DungeonRunView,
  status?: string | null,
  extra: { receipts?: readonly DungeonEncounterReceipt[]; extraRows?: ActionRowBuilder<ButtonBuilder>[] } = {},
) {
  const opts = options(ctx, await runArt(ctx, playerId, view, extra.receipts), status, { ...view.rewardItemNames, ...view.eventItemNames });
  return buildRunScreen(view, {
    ...opts,
    ...(extra.receipts?.length ? { encounterReceipts: extra.receipts } : {}),
    ...(extra.extraRows?.length ? { extraRows: extra.extraRows } : {}),
  });
}

async function homeScreen(ctx: AppContext, service: DungeonRunService, playerId: number, status?: string | null) {
  const view = await service.home(playerId);
  // With a run: the run's own scene. Without: the first listed dungeon that has
  // artwork deployed — its artwork, else its background, else text only.
  const art = view.activeRun
    ? await runArt(ctx, playerId, view.activeRun)
    : { scene: await dungeonZoneArtwork(ctx, view.dungeons) };
  return buildDungeonHome(view, options(ctx, art, status, view.activeRun?.rewardItemNames));
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
  interaction: DungeonInteraction,
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

/**
 * `dg|ev|<runId>|<step>|<choiceId>` — answer the offered event. An item the
 * choice spends that has gone since the screen was drawn aborts the whole
 * step; the event is repainted, still open, with that choice now unavailable.
 */
export async function handleDungeonChoose(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 1);
  const choiceId = parsed?.rest[0];
  if (!parsed || !choiceId || choiceId.length > CONNECTION_ID_MAX_LENGTH || !CONNECTION_ID_PATTERN.test(choiceId)) {
    return respondEphemeral(i, MALFORMED);
  }
  return run(ctx, i, prov, async (s) => {
    try {
      return await step(ctx, s, prov.playerId, parsed.runId, { type: 'choose', choiceId, expectedStep: parsed.step });
    } catch (err) {
      if (!(err instanceof DungeonEventItemUnavailableError)) throw err;
      return runScreen(ctx, prov.playerId, await s.run(prov.playerId, parsed.runId), err.userMessage);
    }
  });
}

// ── puzzles ─────────────────────────────────────────────────────────────────

/**
 * `dg|pz|<runId>|<step>` — open the answer form. Reads and changes nothing:
 * the submission is where the run, the player and the step are checked.
 */
export async function handleDungeonPuzzleOpen(_ctx: AppContext, i: ButtonInteraction, _prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  await i.showModal(buildPuzzleModal(parsed.runId, parsed.step));
}

/**
 * `dg|pza|<runId>|<step>` — the submitted answer, as one `answer` step. The
 * run screen the form was opened from is repainted in place with the result.
 */
export async function handleDungeonPuzzleSubmit(ctx: AppContext, i: ModalSubmitInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  const answer = i.fields.getTextInputValue(PUZZLE_ANSWER_FIELD);
  // Acknowledge on the message the form came from, so the result replaces that screen.
  if (i.isFromMessage()) await i.deferUpdate();
  return run(ctx, i, prov, (s) => step(ctx, s, prov.playerId, parsed.runId, { type: 'answer', answer, expectedStep: parsed.step }));
}

// ── encounters ──────────────────────────────────────────────────────────────

/**
 * Refusals that roll an encounter step back whole: a charm gone or no longer
 * eligible, a species that stopped being obtainable, odds that moved under
 * the step, or a deadlock that outlasted the retries. Nothing was spent; the
 * run is repainted as it stands with the service's own words.
 */
function isEncounterRollback(err: unknown): err is DungeonCaptureItemUnavailableError | DungeonEncounterSpeciesUnavailableError | DungeonCaptureQuoteChangedError | DungeonStepContendedError {
  return err instanceof DungeonCaptureItemUnavailableError || err instanceof DungeonEncounterSpeciesUnavailableError ||
    err instanceof DungeonCaptureQuoteChangedError || err instanceof DungeonStepContendedError;
}

/** The Keep / Convert prompt for a duplicate this press created, as a hunt offers it. Never throws. */
async function duplicateRows(ctx: AppContext, playerId: number, view: DungeonRunView, receipts: readonly DungeonEncounterReceipt[]): Promise<ActionRowBuilder<ButtonBuilder>[]> {
  if (view.status !== 'active') return [];
  const dup = receipts.find((r) => r.acquired?.isDuplicate && !(r.type === 'rescue_grant' && r.replayed));
  if (!dup?.acquired || !ctx.services.collection) return [];
  try {
    const preview = await ctx.services.collection.previewConversionEssence(playerId, dup.acquired.rarity, 'convert');
    return [duplicatePromptComponents(dup.acquired.waifuId, preview, {
      keep: dgId.keepDuplicate(view.id, view.step, dup.acquired.waifuId),
      convert: dgId.convertDuplicate(view.id, view.step, dup.acquired.waifuId),
    })];
  } catch (err) {
    ctx.logger.warn({ err, playerId, waifuId: dup.acquired.waifuId }, 'dungeons: duplicate prompt unavailable');
    return [];
  }
}

/**
 * After commit, once per committed receipt: the session board, the SR+
 * rare-capture announcement (captures only, by the hunt's own rules), the
 * Activity Feed and appearance toasts. A replayed rescue wrote nothing and
 * sends nothing. Never throws — the player already has their result.
 */
async function afterEncounter(ctx: AppContext, interaction: DungeonInteraction, prov: Provisioned, receipts: readonly DungeonEncounterReceipt[]): Promise<void> {
  for (const receipt of receipts) {
    if (receipt.type === 'rescue_grant' && receipt.replayed) continue;
    try {
      const channelId = interaction.channelId;
      if (channelId && ctx.services.session) {
        const session = await ctx.services.session.ensureSession(prov.guildDbId, prov.playerId, channelId);
        if (receipt.type === 'capture_attempt' && receipt.success && receipt.acquired) {
          await ctx.services.session.recordEvent(session.id, { type: 'capture', speciesName: receipt.acquired.name, rarity: receipt.acquired.rarity });
        } else if (receipt.type === 'capture_attempt' && receipt.outcome === 'escape') {
          const escaped = ctx.content.species.find((sp) => sp.slug === receipt.species);
          if (escaped) await ctx.services.session.recordEvent(session.id, { type: 'escape', speciesName: escaped.name });
        }
        for (const lu of receipt.levelUps) await ctx.services.session.recordEvent(session.id, { type: 'levelup', toLevel: lu.toLevel });
      }
      if (receipt.type === 'capture_attempt' && receipt.success && receipt.acquired && interaction.isButton()) {
        const entry = await ctx.services.collection.getOwned(prov.playerId, receipt.acquired.waifuId);
        await sendRareAnnouncement(ctx, interaction, entry.species, `<@${interaction.user.id}>`, receipt.acquired.isDuplicate, entry.waifu);
      }
      await emitEvents(ctx, interaction, prov, await dungeonEncounterDescriptors(ctx, prov, receipt));
      if (receipt.acquired && receipt.newAppearances?.length) {
        await postAppearanceUnlockToasts(ctx, interaction, receipt.newAppearances, receipt.acquired.name, prov.playerId);
      }
    } catch (err) {
      ctx.logger.warn({ err, tag: 'dungeons/encounter-post-commit', playerId: prov.playerId }, 'dungeon encounter notification failed');
    }
  }
}

/**
 * One encounter input under the step guard. The screen is painted from the
 * committed result; notifications follow it, and only for what committed.
 */
async function encounterStep(
  ctx: AppContext,
  interaction: DungeonInteraction,
  prov: Provisioned,
  target: { runId: number; step: number },
  input: Extract<DungeonInput, { type: 'select_item' | 'capture' | 'rescue' | 'leave_encounter' | 'dismiss_encounter' }>,
): Promise<void> {
  let committed: DungeonEncounterReceipt[] = [];
  try {
    await run(ctx, interaction, prov, async (s) => {
      try {
        const result = await s.act(prov.playerId, target.runId, { ...input, expectedStep: target.step });
        committed = result.status === 'applied' ? (result.encounterReceipts ?? []) : [];
        return await runScreen(ctx, prov.playerId, result.run, actionNotice(result), { receipts: committed, extraRows: await duplicateRows(ctx, prov.playerId, result.run, committed) });
      } catch (err) {
        if (!isEncounterRollback(err)) throw err;
        return runScreen(ctx, prov.playerId, await s.run(prov.playerId, target.runId), err.userMessage);
      }
    });
  } finally {
    // Committed whatever happened to the paint: what it did is still announced.
    if (committed.length > 0) await afterEncounter(ctx, interaction, prov, committed);
  }
}

/** `dg|ci|<runId>|<step>` (select menu) — choose the charm the next Capture uses. Spends nothing. */
export async function handleDungeonCharm(ctx: AppContext, i: StringSelectMenuInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  const item = i.values?.[0];
  if (!parsed || !item || i.values.length !== 1 || item.length > ITEM_SLUG_MAX_LENGTH || !ITEM_SLUG_PATTERN.test(item)) {
    return respondEphemeral(i, MALFORMED);
  }
  return encounterStep(ctx, i, prov, parsed, { type: 'select_item', item });
}

/** `dg|cap|<runId>|<step>` — one capture attempt with the charm stored on the run. */
export async function handleDungeonCapture(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return encounterStep(ctx, i, prov, parsed, { type: 'capture' });
}

/** Dungeon-only post-acquisition decisions. IDs bind run + result step + newly granted copy. */
async function duplicateDecision(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[], decision: 'keep' | 'convert') {
  const parsed = parseRunStep(args, 1);
  const waifuId = parseRunId(parsed?.rest[0]);
  if (!parsed || waifuId == null || !Number.isSafeInteger(waifuId) || !Number.isSafeInteger(parsed.runId)) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    try {
      const context = { runId: parsed.runId, step: parsed.step };
      if (decision === 'keep') {
        await ctx.services.collection.keepDungeonCaptureDuplicate(prov.playerId, waifuId, context);
        const view = await s.run(prov.playerId, parsed.runId);
        return { content: '💜 Kept in your collection~', components: dungeonCaptureNavigation(view) };
      }
      const result = await ctx.services.collection.convertDuplicateToEssence(prov.playerId, waifuId, { dungeonCapture: context });
      const view = await s.run(prov.playerId, parsed.runId);
      return conversionResultPayload(ctx, result, result.species.name, dungeonCaptureNavigation(view));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // Only resume the ID this button named. Never substitute a later active run.
      try {
        const view = await s.run(prov.playerId, parsed.runId);
        return { content: err.userMessage, components: dungeonCaptureNavigation(view) };
      } catch (missing) {
        if (!(missing instanceof DungeonRunNotFoundError)) throw missing;
        return { content: RUN_NOT_FOUND, components: [] };
      }
    }
  });
}

export async function handleDungeonDuplicateKeep(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  return duplicateDecision(ctx, i, prov, args, 'keep');
}

export async function handleDungeonDuplicateConvert(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  return duplicateDecision(ctx, i, prov, args, 'convert');
}

/** `dg|res|<runId>|<step>` — a direct rescue: no charm, no roll. */
export async function handleDungeonRescue(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return encounterStep(ctx, i, prov, parsed, { type: 'rescue' });
}

/** `dg|cl|<runId>|<step>` — leave her. Resolves the encounter as `left`. */
export async function handleDungeonLeaveEncounter(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return encounterStep(ctx, i, prov, parsed, { type: 'leave_encounter' });
}

/**
 * `dg|cu|<runId>|<step>` — move on from a WaifuMon (wild, capture-mode or
 * direct rescue) who can no longer be had. `dismiss_encounter` has no
 * effects: no charm, Microdose charge, roll, copy, XP or notification. It
 * resolves the encounter `unavailable`, with its authored text and routing,
 * while the live facts still say so; should she have become obtainable again
 * by the press it is refused (`encounter_available`), nothing changes and the
 * encounter is repainted open.
 */
export async function handleDungeonEncounterGone(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return encounterStep(ctx, i, prov, parsed, { type: 'dismiss_encounter' });
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

/** `dg|ab|<runId>|<step>` — abandon only the state the player confirmed. */
export async function handleDungeonAbandon(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  // Historical buttons cannot safely quote today's losses. Ask again.
  if (args.length === 1) return handleDungeonAbandonConfirm(ctx, i, prov, args);
  const parsed = parseRunStep(args, 0);
  if (!parsed) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, async (s) => {
    const result = await s.act(prov.playerId, parsed.runId, { type: 'abandon', expectedStep: parsed.step });
    const notice = result.status === 'refused' && result.run.status !== 'active'
      ? actionNotice({ status: 'refused', refusal: 'run_over' }) : actionNotice(result);
    return runScreen(ctx, prov.playerId, result.run, notice);
  });
}
