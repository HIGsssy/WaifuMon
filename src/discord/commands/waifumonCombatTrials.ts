/**
 * Combat Trials button handlers (`ct:*`).
 *
 * Thin: every handler acts on `prov.playerId`, asks `CombatTrialService` (which
 * checks the Equipment unlock on every call and re-reads all state), and hands
 * the read model to `combatTrialPresenter`. No combat is orchestrated here.
 *
 * Idempotency: the Fight button carries a nonce minted when its screen was
 * drawn. The nonce is the service's request key, so a double-click or a
 * Discord retry of the same button resolves to the one attempt it created —
 * repainted, never fought or paid twice. Every freshly drawn Fight button
 * (detail, Fight Again) gets a new nonce.
 */
import { randomBytes } from 'node:crypto';
import { AttachmentBuilder, type ButtonInteraction } from 'discord.js';
import { ownedArtworkImage } from '../assets/attachRenderedCard';
import {
  buildFightResult,
  buildTrialDetail,
  buildTrialList,
  lockedTrialsView,
  TRIAL_UNAVAILABLE,
  type TrialArtwork,
} from '../combatTrialPresenter';
import { respondEphemeral } from '../ephemeralSession';
import type { AppContext, Provisioned } from '../types';
import { locateCombatArtwork } from '../../modules/combat/combatArtwork';
import type { CombatTrialService } from '../../modules/combatTrials/combatTrialService';
import type { CombatEnemyDefinition } from '../../modules/combat/enemyDefinitions';
import type { CombatTrialDefinition } from '../../modules/combat/trialDefinitions';
import {
  AppError,
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  CombatTrialRequestConflictError,
  CombatTrialUnavailableError,
  FeatureLockedError,
} from '../../shared/errors';

const NO_LONGER_WORKS = 'That button no longer works.';
const MALFORMED = 'That button is malformed — re-open Combat Trials from /waifumon.';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

/** A fresh Fight-button nonce. Exported so tests can recognise the shape. */
export function mintFightNonce(): string {
  return randomBytes(9).toString('base64url');
}

/** The service request key for a Fight nonce. */
export function fightRequestKey(nonce: string): string {
  return `discord:${nonce}`;
}

/**
 * The Trial's large picture: its own artwork, else the enemy's, else its
 * background. Missing or unsafe files are skipped (logged once at content
 * load), so the screen renders text-only rather than failing.
 */
export function trialSceneArtwork(
  ctx: AppContext,
  trial: CombatTrialDefinition | null,
  enemy: Pick<CombatEnemyDefinition, 'key' | 'artworkPath'> | null,
): TrialArtwork | null {
  const candidates = [trial?.artworkPath, enemy?.artworkPath, trial?.backgroundArtworkPath];
  for (const relative of candidates) {
    const found = locateCombatArtwork(ctx.config.assetsDir, relative);
    if (found.status !== 'available') continue;
    const name = `combat-trial-${(trial?.key ?? enemy?.key ?? 'scene').replace(/_/g, '-')}.${found.extension}`;
    return { file: new AttachmentBuilder(found.absolutePath, { name }), url: `attachment://${name}` };
  }
  return null;
}

/** The active Buddy's own artwork, only if it is still the copy `waifuId` names. Never throws. */
async function buddyArtwork(ctx: AppContext, playerId: number, waifuId: number | null): Promise<TrialArtwork | null> {
  if (waifuId == null || !ctx.services.collection) return null;
  try {
    const entry = await ctx.services.collection.getBuddy(playerId);
    if (entry?.waifu.id !== waifuId) return null;
    return ownedArtworkImage(ctx, entry);
  } catch (err) {
    ctx.logger.warn({ err, playerId }, 'combat trials: buddy artwork unavailable');
    return null;
  }
}

function itemNameResolver(ctx: AppContext): (slug: string) => string {
  return (slug) => ctx.content.items.find((i) => i.slug === slug)?.name ?? slug;
}

async function listScreen(service: CombatTrialService, playerId: number, page: number, status?: string) {
  return buildTrialList(await service.list(playerId), page, status);
}

async function detailScreen(
  ctx: AppContext,
  service: CombatTrialService,
  playerId: number,
  trialKey: string,
  status?: string,
) {
  const view = await service.detail(playerId, trialKey);
  const art = {
    scene: trialSceneArtwork(ctx, view.trial, view.enemy),
    buddy: await buddyArtwork(ctx, playerId, view.stats.buddy?.waifuId ?? null),
  };
  return buildTrialDetail(view, mintFightNonce(), art, status);
}

/**
 * Run one action with the shared error handling. Nothing a handler does here
 * spends anything outside the service's own transaction, so every failure
 * path is a repaint.
 */
async function run(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  action: (service: CombatTrialService) => Promise<Parameters<typeof respondEphemeral>[1]>,
  recover: { trialKey?: string } = {},
): Promise<void> {
  const service = ctx.services.combatTrials;
  if (!service) {
    await respondEphemeral(interaction, NO_LONGER_WORKS);
    return;
  }
  try {
    await respondEphemeral(interaction, await action(service));
  } catch (err) {
    try {
      if (err instanceof FeatureLockedError) {
        await respondEphemeral(interaction, lockedTrialsView());
        return;
      }
      if (err instanceof CombatTrialUnavailableError || err instanceof CombatTrialRequestConflictError) {
        const status = err instanceof CombatTrialUnavailableError ? TRIAL_UNAVAILABLE : err.userMessage;
        await respondEphemeral(interaction, await listScreen(service, prov.playerId, 0, status));
        return;
      }
      if ((err instanceof CombatBuddyRequiredError || err instanceof CombatLoadoutIncompleteError) && recover.trialKey) {
        await respondEphemeral(
          interaction,
          await detailScreen(ctx, service, prov.playerId, recover.trialKey, err.userMessage),
        );
        return;
      }
    } catch (inner) {
      // The recovery screen itself failed (the unlock was revoked, the Trial
      // vanished): handle *that* error plainly.
      err = inner;
      if (err instanceof FeatureLockedError) {
        await respondEphemeral(interaction, lockedTrialsView());
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

function parsePage(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d{1,4}$/.test(raw)) return null;
  return Number(raw);
}

/** `ct|home|<page>` — the Trial list; also the main menu's ⚔️ Combat Trials. */
export async function handleCombatTrialsHome(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const page = parsePage(args[0]);
  if (page === null) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) => listScreen(s, prov.playerId, page));
}

/** `ct|view|<trialKey>` — the pre-fight screen. Never starts a fight. */
export async function handleCombatTrialView(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const trialKey = args[0];
  if (!trialKey) return respondEphemeral(i, MALFORMED);
  return run(ctx, i, prov, (s) => detailScreen(ctx, s, prov.playerId, trialKey));
}

/** `ct|fight|<trialKey>|<nonce>` — resolve (or replay) one fight. */
export async function handleCombatTrialFight(ctx: AppContext, i: ButtonInteraction, prov: Provisioned, args: string[]) {
  const [trialKey, nonce] = args;
  if (!trialKey || !nonce || !NONCE_PATTERN.test(nonce)) return respondEphemeral(i, MALFORMED);
  return run(
    ctx,
    i,
    prov,
    async (s) => {
      const outcome = await s.fight(prov.playerId, trialKey, fightRequestKey(nonce));
      // The catalogue is where enemies live; shipped content is the fallback
      // for a deployment (or a test) running without one.
      const enemy =
        (await ctx.services.enemies?.definition(outcome.attempt.enemyKey)) ??
        ctx.content.combatEnemies?.find((e) => e.key === outcome.attempt.enemyKey) ??
        null;
      return buildFightResult(outcome, {
        againNonce: outcome.trial ? mintFightNonce() : null,
        itemName: itemNameResolver(ctx),
        art: {
          scene: trialSceneArtwork(ctx, outcome.trial, enemy),
          buddy: await buddyArtwork(ctx, prov.playerId, outcome.attempt.buddyWaifuId),
        },
      });
    },
    { trialKey },
  );
}

/** `ct|noop|…` — the disabled page indicator; only reachable by a forged click. */
export function handleCombatTrialsNoop(ctx: AppContext, i: ButtonInteraction, prov: Provisioned) {
  return handleCombatTrialsHome(ctx, i, prov, []);
}
