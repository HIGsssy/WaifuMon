/**
 * Portal permission guard.
 *
 * Every admin-only route calls {@link requirePortalPermission} to assert the
 * requesting session carries a specific capability. The lookup runs through
 * {@link PortalAuthorizationService}, which is the one place authorization
 * rules live — so a route never asks "is this the guild owner?" or "does
 * this user have some role?" directly. Adding a new source of admin (e.g.
 * Discord role mapping) is a change to that service only.
 *
 * Two distinct rejection cases, on purpose:
 *
 *   - **Bearer-authenticated requests** carry no user identity, so permission
 *     checks are meaningless: the loopback bearer is trusted for everything.
 *     A bearer request is allowed to pass every check.
 *   - **Portal sessions without the permission** are rejected as 403
 *     `PORTAL_PERMISSION_DENIED` — a distinct code from 401
 *     `UNAUTHORIZED` so the frontend can render "you don't have permission"
 *     separately from "please sign in".
 *   - **No session at all** on a private route is already caught by
 *     `registerAuth` at `onRequest`, so we do not re-check that here.
 */
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors';
import type {
  PortalAuthorizationService,
  PortalPermission,
} from '../../modules/portalAuth/portalAuthService';

export class PortalPermissionError extends AppError {
  constructor(permission: PortalPermission) {
    super(
      'PORTAL_PERMISSION_DENIED',
      `Portal session lacks required permission: ${permission}`,
      'You do not have permission to do that.',
    );
  }
}

/**
 * Enforce that the request holds `permission`. Throws with a 403-mapped
 * {@link PortalPermissionError} otherwise. No-op for bearer-auth requests,
 * which have already proven privileged access via the loopback token.
 */
export async function requirePortalPermission(
  req: FastifyRequest,
  authorization: PortalAuthorizationService,
  permission: PortalPermission,
): Promise<void> {
  if (req.apiAuth === 'bearer') return;
  const session = req.portalSession ?? null;
  if (!session) throw new PortalPermissionError(permission);
  const has = await authorization.has(session, permission);
  if (!has) throw new PortalPermissionError(permission);
}
