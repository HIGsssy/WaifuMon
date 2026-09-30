/**
 * Portal admin — Staging Test Controls.
 *
 * Direct account adjustments for testers on a staging deployment: Trainer
 * Level, WaifuBux, Energy, the Transporter Beacon, standard travel access, a
 * one-click "Prepare Player for Current Content" boost, and a reset of the
 * Assteroid Belt unlock. All of the work is in
 * `modules/testControls/stagingTestControlsService.ts`; this file is the HTTP
 * adapter and the access rules.
 *
 * ## Locks, outermost first
 *
 * 1. **Registration.** These routes exist only when the host built a
 *    `StagingTestControlsService`, which it does only when
 *    `ENABLE_TEST_ADMIN_CONTROLS=true` *and* `DEPLOYMENT_ENV` is not
 *    production. Everywhere else every path below 404s.
 * 2. **Permission.** `players.testcontrols` — held by the guild owner and by
 *    any role an owner grants it to, and withheld from everyone by the
 *    authorization service on a deployment that does not allow the controls.
 * 3. **The service** re-checks the flag and the environment on every call.
 *
 * ## No bearer access
 *
 * Unlike most admin routes, the shared Platform API token cannot reach these,
 * even with `PLATFORM_API_ADMIN_BEARER=true`. Every mutation is audited with
 * the Discord id of the admin who made it, and a bearer request has no one to
 * name.
 *
 * ## Target scope
 *
 * The target is `:targetPlayerId` — deliberately not `:playerId`, which the
 * shared player-scope hook reserves for "the session's own player". A target
 * must belong to the guild the session has selected; any other id (unknown,
 * or in another guild) answers the same 404, so ids cannot be walked to map
 * out other servers.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../../../context';
import { ApiPlayerNotFoundError } from '../../../errors';
import { noIdentity } from '../../../identity';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { resolveGuildScope } from '../../../plugins/guildScope';
import { commonErrorResponses, errorSchema, idParam, notFoundResponse } from '../../../schemas/common';
import { PortalPermissionError, requirePortalPermission } from '../../../plugins/portalPermissions';
import { PLAYERS_TEST_CONTROLS } from '../../../../modules/portalAuth/portalAuthService';
import {
  TEST_CONTROL_ACTIONS,
  TEST_MAX_WAIFUBUX_PER_ACTION,
  type StagingTestControlsService,
  type TestControlsActor,
} from '../../../../modules/testControls/stagingTestControlsService';
import type { PlayerRow } from '../../../../db/schema';

const PERMISSION = PLAYERS_TEST_CONTROLS;

const targetParams = z.object({ targetPlayerId: idParam });

const stateSchema = z.object({
  playerId: z.number().int(),
  discordUserId: z.string(),
  displayName: z.string(),
  level: z.number().int(),
  xp: z.number().int(),
  maxLevel: z.number().int(),
  waifubux: z.number().int(),
  energy: z.number().int(),
  maxEnergy: z.number().int(),
  currentRegion: z.string(),
  currentRegionName: z.string(),
  beacon: z
    .object({
      slug: z.string(),
      name: z.string(),
      owned: z.boolean(),
      /** Null: the gate has no level requirement — the key alone opens it. */
      requiredLevel: z.number().int().nullable(),
    })
    .nullable(),
  beltComponents: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      owned: z.number().int(),
      required: z.number().int(),
    }),
  ),
  legacyBeltRoute: z.boolean(),
  beltEncounterCooldowns: z.number().int(),
  passes: z.array(z.object({ id: z.string(), name: z.string(), owned: z.boolean() })),
  routes: z.array(
    z.object({
      regionId: z.string(),
      name: z.string(),
      unlocked: z.boolean(),
      requiredLevel: z.number().int().nullable(),
    }),
  ),
});

const resultSchema = z.object({
  action: z.enum(TEST_CONTROL_ACTIONS),
  changed: z.boolean(),
  message: z.string(),
  changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
  state: stateSchema,
});

const infoSchema = z.object({
  enabled: z.literal(true),
  deploymentEnv: z.enum(['staging', 'development', 'production']),
  stagingBoost: z.object({ level: z.number().int(), waifubux: z.number().int() }),
  maxWaifubuxPerAction: z.number().int(),
});

// Upper bounds here are only a sanity cap on the wire; the real limits (level
// cap, the player's own max Energy) are content-driven and enforced by the
// service against the live values.
const levelBody = z.object({ level: z.number().int().min(1).max(1000) });
const amountBody = z.object({
  amount: z.number().int().min(1).max(TEST_MAX_WAIFUBUX_PER_ACTION),
});
const energyBody = z.object({ energy: z.number().int().min(0).max(1000) });

export function adminTestControlsRoutes(ctx: ApiContext): FastifyPluginAsyncZod {
  return async (app) => {
    const service: StagingTestControlsService | undefined = ctx.testControls;
    if (service === undefined) return; // Disabled on this deployment — no route exists.

    const authorization = ctx.portalAuthorization;
    const resolveIdentity = ctx.resolveIdentity ?? noIdentity;

    const gate = async (req: FastifyRequest): Promise<void> => {
      // Portal sessions only — see "No bearer access" above.
      if (req.apiAuth !== 'portal' || !req.portalSession || !authorization) {
        throw new PortalPermissionError(PERMISSION);
      }
      await requirePortalPermission(req, authorization, PERMISSION);
    };

    function actorOf(req: FastifyRequest): TestControlsActor {
      const session = req.portalSession;
      if (!session) throw new PortalPermissionError(PERMISSION);
      return {
        discordUserId: session.discordUserId,
        discordGuildId: session.selectedDiscordGuildId,
      };
    }

    /** The target, if it is in the session's selected guild. 404 otherwise. */
    async function targetOf(req: FastifyRequest, playerId: number): Promise<PlayerRow> {
      const scope = await resolveGuildScope(req, ctx);
      const player = await ctx.services.players.getById(playerId);
      if (!player || player.guildId !== scope.guildDbId) throw new ApiPlayerNotFoundError(playerId);
      return player;
    }

    async function displayNameOf(player: PlayerRow): Promise<string> {
      const identity = await resolveIdentity(player.discordUserId);
      return identity?.displayName ?? `Trainer #${player.id}`;
    }

    const forbidden = {
      403: errorSchema.describe('The session may not use Staging Test Controls.'),
    };
    const mutationResponses = {
      200: dataSchema(resultSchema),
      ...commonErrorResponses,
      ...forbidden,
      ...notFoundResponse,
      422: errorSchema.describe('Insufficient WaifuBux for a removal — `INSUFFICIENT_FUNDS`.'),
    };
    const tags = ['Admin — Test Controls'];

    app.get(
      '/admin/test-controls',
      {
        preValidation: gate,
        schema: {
          tags,
          summary: 'Staging Test Controls: availability and fixed parameters',
          description:
            'Present only on a non-production deployment with `ENABLE_TEST_ADMIN_CONTROLS=true`. ' +
            'Requires `players.testcontrols`. Portal sessions only.',
          response: { 200: dataSchema(infoSchema), ...commonErrorResponses, ...forbidden },
        },
      },
      async (req) => ok(req, { enabled: true as const, ...service.describe() }),
    );

    app.get(
      '/admin/test-controls/players/:targetPlayerId',
      {
        preValidation: gate,
        schema: {
          tags,
          summary: "A test player's current level, balances, keys and travel access",
          params: targetParams,
          response: {
            200: dataSchema(stateSchema),
            ...commonErrorResponses,
            ...forbidden,
            ...notFoundResponse,
          },
        },
      },
      async (req) => {
        const player = await targetOf(req, req.params.targetPlayerId);
        const state = await service.getState(player.id);
        return ok(req, { ...state, displayName: await displayNameOf(player) });
      },
    );

    /**
     * Registers one mutation. Every one shares the gate, the target check, the
     * actor, and the response shape — the handler only chooses the operation.
     */
    function mutation<B extends z.ZodTypeAny>(
      path: string,
      summary: string,
      body: B | null,
      invoke: (actor: TestControlsActor, playerId: number, body: z.infer<B>) => ReturnType<
        StagingTestControlsService['setLevel']
      >,
    ): void {
      app.post(
        `/admin/test-controls/players/:targetPlayerId/${path}`,
        {
          preValidation: gate,
          schema: {
            tags,
            summary,
            params: targetParams,
            ...(body ? { body } : {}),
            response: mutationResponses,
          },
        },
        async (req) => {
          const params = req.params as z.infer<typeof targetParams>;
          const player = await targetOf(req, params.targetPlayerId);
          const result = await invoke(actorOf(req), player.id, req.body as z.infer<B>);
          return ok(req, {
            ...result,
            state: { ...result.state, displayName: await displayNameOf(player) },
          });
        },
      );
    }

    mutation('level', 'Set Trainer Level (XP set to the start of that level)', levelBody, (a, id, b) =>
      service.setLevel(a, id, b.level),
    );
    mutation('waifubux/add', 'Add WaifuBux', amountBody, (a, id, b) =>
      service.addWaifubux(a, id, b.amount),
    );
    mutation('waifubux/remove', 'Remove WaifuBux (never below zero)', amountBody, (a, id, b) =>
      service.removeWaifubux(a, id, b.amount),
    );
    mutation('energy', 'Set Hunt Energy (0 to the player’s maximum)', energyBody, (a, id, b) =>
      service.setEnergy(a, id, b.energy),
    );
    mutation('beacon/grant', 'Grant the Transporter Beacon (idempotent)', null, (a, id) =>
      service.grantBeacon(a, id),
    );
    mutation('beacon/revoke', 'Revoke the Transporter Beacon, returning the player home if in the Belt', null, (a, id) =>
      service.revokeBeacon(a, id),
    );
    mutation('travel/grant-standard', 'Grant every pass/route travel unlock (not the Beacon)', null, (a, id) =>
      service.grantStandardTravel(a, id),
    );
    mutation('staging-boost', 'Prepare Player for Current Content', null, (a, id) =>
      service.stagingBoost(a, id),
    );
    mutation('reset-assteroid-belt', 'Reset the Assteroid Belt unlock test state', null, (a, id) =>
      service.resetAssteroidBelt(a, id),
    );
  };
}
