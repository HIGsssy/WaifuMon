/**
 * Expeditions — read-only. Deploying, collecting and recalling stay in Discord.
 *
 * One GET, and deliberately no other verb: there is no Portal route to start,
 * assign, claim, cancel, reroll or resolve a mission.
 *
 * Nothing this handler calls writes. In particular it uses
 * `expeditions.getOverview`, **not** `getActive` or `getBoard`: those two
 * resolve due missions on read (Discord's trigger), and a Portal page view
 * must not be one. A mission past its finish line is reported as `isDue` and
 * `readyToClaim`, and its outcome stays hidden until the player collects it in
 * Discord. The boards come from the same `boardFor` path Discord's `getBoard`
 * uses, so they are the offers Discord shows.
 *
 * Regions are the travel service's own answer — current plus unlocked, in its
 * catalog order — so a region that gains Expedition content appears here with
 * no Portal change, and one with none yet shows an empty board.
 */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { expeditionOverviewSchema } from '../../schemas/expeditions';
import { toOwnedWaifuResource, toSpeciesResource } from '../../resources';
import type { ExpeditionBoardEntry, ExpeditionView } from '../../../modules/expeditions/types';
import type { OwnedEntry } from '../../../modules/collection/collectionService';
import { AppError } from '../../../shared/errors';

/** A board entry, reduced to the fields a player plans with. Named, never spread. */
function toOffer({ definition }: ExpeditionBoardEntry) {
  return {
    name: definition.name,
    emoji: definition.emoji,
    description: definition.description,
    type: definition.type,
    durationMinutes: definition.durationMinutes,
    recommendedLevel: definition.recommendedLevel,
    preferredAffinities: definition.preferredAffinities,
    preferredRaces: definition.preferredRaces,
    rewardPreview: definition.rewardPreview,
  };
}

export const expeditionRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/expeditions',
      {
        schema: {
          tags: ['Expeditions'],
          summary: 'Get open Expeditions and regional boards',
          description:
            'Read-only and non-resolving: a mission past `completesAt` is reported as `isDue` / ' +
            '`readyToClaim` and is resolved and claimed through Discord. Outcomes, rewards and ' +
            'success chances are never included. Boards are the same per-player offers Discord ' +
            'shows, for the current region and every unlocked one.',
          params: playerIdParams,
          response: {
            200: dataSchema(expeditionOverviewSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const playerId = requirePlayer(req).id;
        const { travel, expeditions, collection, appearance } = ctx.services;

        // `getStatus` is a pure read (it never ticks or exits Care Mode).
        const status = await travel.getStatus(playerId);
        const reachable = status.destinations.filter(
          (d) => d.state === 'current' || d.state === 'unlocked',
        );
        // Current first, then the catalog's own order. With travel switched off
        // the catalog lists nothing, and the player's one region is still real.
        const regions = [
          ...reachable.filter((d) => d.state === 'current'),
          ...reachable.filter((d) => d.state !== 'current'),
        ].map((d) => ({ regionId: d.regionId, name: d.name, emoji: d.emoji }));
        if (!regions.some((r) => r.regionId === status.currentRegion)) {
          regions.unshift({
            regionId: status.currentRegion,
            name: status.currentRegionName,
            emoji: null,
          });
        }

        const overview = await expeditions.getOverview(
          playerId,
          regions.map((r) => r.regionId),
        );

        // The deployed copies, through the same owner-scoped read and the same
        // resource builders as every other owned-copy embed — so artwork obeys
        // the selected-appearance and unlock rules without a second resolver.
        const copies = await Promise.all(
          overview.open.map(async (view): Promise<OwnedEntry | null> => {
            try {
              return await collection.getOwned(playerId, view.waifuId);
            } catch (err) {
              // A copy that cannot be read must not hide the mission.
              if (err instanceof AppError) return null;
              throw err;
            }
          }),
        );

        const toActive = (view: ExpeditionView, copy: OwnedEntry | null) => ({
          region: view.region,
          regionName: travel.catalog().label(view.region),
          name: view.name,
          emoji: view.emoji,
          description: view.description,
          type: view.type,
          durationMinutes: view.durationMinutes,
          recommendedLevel: view.recommendedLevel,
          rewardPreview: view.rewardPreview,
          match: view.match,
          status: view.status as 'active' | 'resolved',
          isDue: view.isDue,
          readyToClaim: view.status === 'resolved' || view.isDue,
          startedAt: view.startedAt,
          completesAt: view.completesAt,
          secondsRemaining: view.secondsRemaining,
          waifuName: view.waifuName,
          waifu: copy
            ? {
                waifu: toOwnedWaifuResource(copy.waifu, copy.species, appearance),
                species: toSpeciesResource(copy.species, appearance.catalogFor(copy.species)),
              }
            : null,
        });

        return ok(req, {
          enabled: overview.enabled,
          currentRegion: status.currentRegion,
          rotatesAt: overview.rotatesAt,
          active: overview.open.map((view, i) => toActive(view, copies[i] ?? null)),
          regions: regions.map((region, i) => {
            const board = overview.boards[i]!;
            return {
              regionId: region.regionId,
              name: region.name,
              emoji: region.emoji,
              isCurrent: region.regionId === status.currentRegion,
              occupied: board.regionMission != null,
              offers: board.entries.map(toOffer),
            };
          }),
        });
      },
    );
  };
