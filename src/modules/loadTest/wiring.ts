/**
 * Concrete collaborators for the controller: the database-backed preparer and
 * the renderer-backed cold-card service. Kept apart from `controller.ts` so
 * the controller's state machine is testable with fakes, and from `index.ts`
 * so the host's wiring stays one call.
 */
import type { Db } from '../../db/client';
import type { PortalEligibleGuild } from '../../db/schema';
import type { CardRenderer } from '../cards';
import type { CardPresentationDeps } from '../appearance/cardPresentation';
import { evictColdCards, planColdCards } from './coldCards';
import type { ColdCardService, PreparedPlayers, RunPreparer } from './controller';
import { assertSyntheticPlayers, deleteSyntheticSessions, ensureSyntheticPlayers } from './fixture';
import { sleep } from './engine';
import { SYNTHETIC_GUILD_DISCORD_ID } from './synthetic';

/** The one method of `PortalSessionService` the preparer calls. */
export interface SessionMinter {
  createSession(input: {
    user: { id: string; username: string };
    eligibleGuilds: PortalEligibleGuild[];
    selected?: PortalEligibleGuild | undefined;
  }): Promise<{ token: string }>;
}

/** Public-profile targets per player: the next few synthetic players by index. */
const NEIGHBOURS = 5;

export function createRunPreparer(db: Db, sessions: SessionMinter): RunPreparer {
  return {
    async prepare(count): Promise<PreparedPlayers> {
      const synthetic = await ensureSyntheticPlayers(db, count);
      // Checked again here, against the database, immediately before any
      // credential exists: the sessions below can only ever name these rows.
      await assertSyntheticPlayers(db, synthetic.map((p) => p.playerId));

      const players = [];
      for (const p of synthetic) {
        const guild: PortalEligibleGuild = {
          discordGuildId: SYNTHETIC_GUILD_DISCORD_ID,
          guildDbId: p.guildDbId,
          playerId: p.playerId,
          name: 'Load Test',
          iconUrl: null,
        };
        const { token } = await sessions.createSession({
          user: { id: p.discordUserId, username: `Load Test ${p.index + 1}` },
          eligibleGuilds: [guild],
          selected: guild,
        });
        const neighbours = [];
        for (let k = 1; k <= NEIGHBOURS && synthetic.length > 1; k += 1) {
          const other = synthetic[(p.index + k) % synthetic.length]!;
          if (other.playerId !== p.playerId) neighbours.push(other.playerId);
        }
        players.push({
          playerId: p.playerId,
          sessionToken: token,
          ownedWaifuIds: p.ownedWaifuIds,
          gridWaifuIds: p.gridWaifuIds,
          speciesSlugs: p.speciesSlugs,
          neighbourPlayerIds: [...new Set(neighbours)],
        });
      }

      const [first, ...rest] = synthetic.map((p) => new Set(p.speciesSlugs));
      const common = first ? [...first].filter((slug) => rest.every((set) => set.has(slug))) : [];
      return { players, commonSpeciesSlugs: common.sort() };
    },
    async release() {
      await deleteSyntheticSessions(db);
    },
  };
}

export interface ColdCardServiceDeps {
  renderer: () => CardRenderer;
  presentation: CardPresentationDeps;
  cacheRoot: string;
  maxLevel: () => number;
  /** True while any card is rendering or queued. */
  rendererBusy: () => boolean;
  /** The background owned-card warmer, when one exists. */
  warmer?: { whenIdle(): Promise<void> } | undefined;
}

export function createColdCardService(deps: ColdCardServiceDeps): ColdCardService {
  return {
    plan: (slugs, count) =>
      planColdCards(
        { renderer: deps.renderer(), presentation: deps.presentation, maxLevel: deps.maxLevel() },
        slugs,
        count,
      ),
    evict: (planned) => evictColdCards(deps.cacheRoot, planned),
    async waitForIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const never = new AbortController().signal;
      // The warmer first (it is what feeds the renderer), then the renderer
      // itself, twice in a row idle so a queue refilling between polls is seen.
      if (deps.warmer) {
        const bound = new AbortController();
        await Promise.race([deps.warmer.whenIdle(), sleep(timeoutMs, bound.signal)]);
        bound.abort(); // releases the timer if the warmer won
      }
      let idleStreak = 0;
      while (Date.now() < deadline && idleStreak < 2) {
        idleStreak = deps.rendererBusy() ? 0 : idleStreak + 1;
        if (idleStreak < 2) await sleep(250, never);
      }
    },
  };
}
