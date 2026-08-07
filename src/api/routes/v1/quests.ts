/**
 * Assigned daily quests. Assigning (`/ensure`) and claiming are Phase 3.
 *
 * `getDailyQuests` reads today's rows without creating any, so a player who
 * has not interacted yet reads as an empty list rather than being silently
 * assigned quests by a GET.
 */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { dailyQuestsSchema } from '../../schemas/quests';
import { parseQuestRewards } from '../../../modules/quests/questService';
import type { PlayerDailyQuestRow } from '../../../db/schema';
import type { Rarity } from '../../../db/schema';

/** Snapshot columns → the flat resource shape. Rewards are stored as JSON. */
function toQuest(row: PlayerDailyQuestRow) {
  return {
    id: row.id,
    playerId: row.playerId,
    questDate: row.questDate,
    questSlug: row.questSlug,
    title: row.titleSnapshot,
    description: row.descriptionSnapshot,
    type: row.type,
    rarityAtLeast: (row.rarityAtLeast as Rarity | null) ?? null,
    target: row.target,
    progress: row.progress,
    rewards: parseQuestRewards(row.rewardsJson),
    completedAt: row.completedAt,
    claimedAt: row.claimedAt,
  };
}

export const questRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/quests/daily',
      {
        schema: {
          tags: ['Quests'],
          summary: "Get today's daily quests",
          description:
            'Read-only: never assigns quests, so an empty list means none have been rolled today ' +
            'yet. Title, description and rewards are snapshots frozen at assignment time — ' +
            'compare against GET /content/quests for the live pool. `questDate` is null when no ' +
            'quests have been assigned.',
          params: playerIdParams,
          response: {
            200: dataSchema(dailyQuestsSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const playerId = requirePlayer(req).id;
        const [rows, allCompleteBonusClaimed] = await Promise.all([
          ctx.services.quests.getDailyQuests(playerId),
          ctx.services.quests.hasClaimedAllCompleteBonus(playerId),
        ]);
        const quests = rows.map(toQuest);
        return ok(req, {
          // Derived from the rows rather than recomputed: the service owns what
          // "today" means in the configured timezone, and duplicating that
          // reckoning here is exactly the drift §5 warns about.
          questDate: quests[0]?.questDate ?? null,
          quests,
          allCompleteBonusClaimed,
        });
      },
    );
  };
