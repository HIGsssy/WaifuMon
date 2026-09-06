/**
 * Portal admin — who, besides the guild owner, may use the admin area.
 *
 * Every route here is gated on `admin.roles.manage`, which is the one
 * permission {@link GRANTABLE_PORTAL_PERMISSIONS} deliberately excludes. Only
 * the live Discord guild owner is ever issued it, so "owner-only" is expressed
 * in the same centralized permission vocabulary as everything else rather than
 * as a bespoke `if (isOwner)` in each handler — and a role-granted admin
 * cannot reach these routes to widen their own access or anyone else's.
 *
 * ## Guild scope
 *
 * The guild is taken from the authenticated session's `selectedDiscordGuildId`
 * and never from the request. There is no `guildId` in any path, body or
 * query, so a caller cannot address another server's grants — the parameter
 * that would let them simply does not exist. The permission check itself is
 * also guild-scoped: `computePermissionsFor` resolves ownership of the
 * *selected* guild, so a user who owns guild A holds `admin.roles.manage`
 * only while A is the selected guild.
 *
 * ## Ordering
 *
 * Permission checks run at `preValidation`, matching the encounter admin
 * routes: an unauthorized caller is refused before the body is parsed against
 * the schema, so a 403 never doubles as documentation of the request shape.
 * CSRF is enforced earlier still, at the `onRequest` hook in `src/api/auth.ts`,
 * for every non-GET portal-session request — these routes inherit it and add
 * nothing of their own.
 */
import { z } from 'zod';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { AppError } from '../../../../shared/errors';
import {
  ADMIN_ROLES_MANAGE,
  GRANTABLE_PORTAL_PERMISSIONS,
  ROLE_GRANT_PRESETS,
  presetForPermissions,
  type PortalPermission,
} from '../../../../modules/portalAuth/portalAuthService';
import {
  RoleGrantNotFoundError,
  type AdminRoleGrant,
} from '../../../../modules/portalAuth/adminRoleGrantService';

const permissionSchema = z.enum(
  GRANTABLE_PORTAL_PERMISSIONS as unknown as [PortalPermission, ...PortalPermission[]],
);

const permissionsBody = z.object({
  permissions: z.array(permissionSchema).min(1).max(GRANTABLE_PORTAL_PERMISSIONS.length),
});

const roleIdSchema = z
  .string()
  .regex(/^\d{17,20}$/, 'Must be a Discord role snowflake');

const roleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.number().int(),
  position: z.number().int(),
  managed: z.boolean(),
});

const grantSchema = z.object({
  roleId: z.string(),
  permissions: z.array(z.string()),
  /** Which named preset the set matches, or `custom`. Presentation only. */
  preset: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

function grantToResource(grant: AdminRoleGrant): z.infer<typeof grantSchema> {
  return {
    roleId: grant.roleId,
    permissions: [...grant.permissions],
    preset: presetForPermissions(grant.permissions),
    createdAt: grant.createdAt.toISOString(),
    createdBy: grant.createdBy,
    updatedAt: grant.updatedAt.toISOString(),
    updatedBy: grant.updatedBy,
  };
}

export const adminAccessRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const grants = ctx.services.adminRoleGrants;
    const roles = ctx.services.guildRoles;
    const authorization = ctx.portalAuthorization;

    // Feature not wired — skip registration entirely, exactly as the encounter
    // admin namespace does. The paths then 404 rather than 500.
    if (!grants) return;

    const requireOwner = async (req: import('fastify').FastifyRequest): Promise<void> => {
      if (!authorization) {
        throw new AppError(
          'PORTAL_PERMISSION_DENIED',
          'Portal authorization service is not configured',
          'Admin features are unavailable.',
        );
      }
      await requirePortalPermission(req, authorization, ADMIN_ROLES_MANAGE, {
        allowBearer: ctx.adminBearerAllowed === true,
      });
    };

    const gate = () => async (req: import('fastify').FastifyRequest) => {
      await requireOwner(req);
    };

    /**
     * The selected guild for this request.
     *
     * Read from the session, never from the caller. A bearer request has no
     * session and therefore no guild — it is refused here rather than being
     * allowed to operate on an arbitrary guild, which is the one place the
     * `allowBearer` escape hatch must not reach.
     */
    const guildIdFor = (req: import('fastify').FastifyRequest): string => {
      const guildId = req.portalSession?.selectedDiscordGuildId;
      if (!guildId) {
        throw new AppError(
          'PORTAL_GUILD_REQUIRED',
          'Role access management requires a selected guild',
          'Pick a server first.',
        );
      }
      return guildId;
    };

    const actorFor = (req: import('fastify').FastifyRequest): string | null =>
      req.portalSession?.discordUserId ?? null;

    app.get(
      '/admin/access/roles',
      {
        preValidation: gate(),
        schema: {
          tags: ['Admin — Access'],
          summary: "List the Discord roles in the session's selected guild",
          response: {
            200: dataSchema(
              z.object({
                roles: z.array(roleSummarySchema),
                /** False when Discord could not be reached — the UI says so. */
                available: z.boolean(),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const guildId = guildIdFor(req);
        const list = roles ? await roles.listGuildRoles(guildId) : null;
        if (list == null) return ok(req, { roles: [], available: false });
        // `@everyone` shares the guild's id and would grant access to every
        // member, which is never what an owner means to click. Managed roles
        // belong to integrations and cannot be assigned by hand.
        const selectable = [...list]
          .filter((role) => role.id !== guildId && !role.managed)
          .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
        return ok(req, { roles: selectable, available: true });
      },
    );

    app.get(
      '/admin/access/grants',
      {
        preValidation: gate(),
        schema: {
          tags: ['Admin — Access'],
          summary: 'List Portal Admin access granted to roles in this guild',
          response: {
            200: dataSchema(
              z.object({
                grants: z.array(grantSchema),
                presets: z.record(z.string(), z.array(z.string())),
                grantablePermissions: z.array(z.string()),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const guildId = guildIdFor(req);
        const list = await grants.list(guildId);
        return ok(req, {
          grants: list.map(grantToResource),
          presets: Object.fromEntries(
            Object.entries(ROLE_GRANT_PRESETS).map(([k, v]) => [k, [...v]]),
          ),
          grantablePermissions: [...GRANTABLE_PORTAL_PERMISSIONS],
        });
      },
    );

    app.post(
      '/admin/access/grants',
      {
        preValidation: gate(),
        schema: {
          tags: ['Admin — Access'],
          summary: 'Grant Portal Admin permissions to a Discord role',
          body: permissionsBody.extend({ roleId: roleIdSchema }),
          response: {
            200: dataSchema(grantSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const guildId = guildIdFor(req);
        const grant = await grants.upsert({
          discordGuildId: guildId,
          roleId: req.body.roleId,
          permissions: req.body.permissions,
          actorDiscordUserId: actorFor(req),
        });
        req.log.info(
          {
            tag: 'portal-admin/role-grant-upserted',
            discordGuildId: guildId,
            roleId: grant.roleId,
            permissions: grant.permissions,
          },
          'portal admin role grant created or replaced',
        );
        return ok(req, grantToResource(grant));
      },
    );

    app.patch(
      '/admin/access/grants/:roleId',
      {
        preValidation: gate(),
        schema: {
          tags: ['Admin — Access'],
          summary: "Change a role's granted permissions",
          params: z.object({ roleId: roleIdSchema }),
          body: permissionsBody,
          response: {
            200: dataSchema(grantSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const guildId = guildIdFor(req);
        const grant = await grants.update({
          discordGuildId: guildId,
          roleId: req.params.roleId,
          permissions: req.body.permissions,
          actorDiscordUserId: actorFor(req),
        });
        req.log.info(
          {
            tag: 'portal-admin/role-grant-updated',
            discordGuildId: guildId,
            roleId: grant.roleId,
            permissions: grant.permissions,
          },
          'portal admin role grant updated',
        );
        return ok(req, grantToResource(grant));
      },
    );

    app.delete(
      '/admin/access/grants/:roleId',
      {
        preValidation: gate(),
        schema: {
          tags: ['Admin — Access'],
          summary: "Revoke a role's Portal Admin access",
          params: z.object({ roleId: roleIdSchema }),
          response: {
            200: dataSchema(z.object({ removed: z.boolean() })),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const guildId = guildIdFor(req);
        const removed = await grants.remove(guildId, req.params.roleId);
        if (!removed) throw new RoleGrantNotFoundError(req.params.roleId);
        req.log.info(
          {
            tag: 'portal-admin/role-grant-removed',
            discordGuildId: guildId,
            roleId: req.params.roleId,
          },
          'portal admin role grant revoked',
        );
        return ok(req, { removed });
      },
    );
  };
