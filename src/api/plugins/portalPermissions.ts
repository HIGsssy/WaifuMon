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
 * ## The bearer-token trust boundary
 *
 * `PLATFORM_API_TOKEN` is a single static shared secret. Until Phase 2 the
 * Platform API was, in substance, a **read** API — one cosmetic mutation
 * aside — so a bearer holder could read every player's data and change
 * essentially nothing. The World Encounter admin namespace changes that: it
 * can create, edit, publish and delete game content.
 *
 * Letting bearer skip permission checks would therefore have silently
 * promoted an existing read credential into a content-authoring super-admin,
 * and that credential is not narrow: it is one process-wide value, it is
 * pasted into operator shells, and in development it is compiled into the
 * Portal bundle as `VITE_PLATFORM_API_TOKEN` (production builds are refused
 * by `portal/scripts/verify-build-env.mjs`, which is the only reason a
 * browser cannot read it in production).
 *
 * So the bypass is **opt-in and off by default**. `allowBearer` comes from
 * `PLATFORM_API_ADMIN_BEARER`, which an operator sets only when they intend
 * the API token to be an administrative credential — typically a loopback-only
 * deployment driving content from scripts. Left unset, a bearer request
 * reaches admin routes and is refused exactly like any other session with no
 * permissions, and the Portal cookie session is the sole route to admin.
 *
 * Three distinct rejection cases, on purpose:
 *
 *   - **Bearer with the bypass enabled** passes every check.
 *   - **Bearer without it**, and **portal sessions lacking the permission**,
 *     are rejected as 403 `PORTAL_PERMISSION_DENIED` — a distinct code from
 *     401 `UNAUTHORIZED` so the frontend can render "you do not have
 *     permission" separately from "please sign in".
 *   - **No session at all** on a private route is already caught by
 *     `registerAuth` at `onRequest`, so it is not re-checked here.
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
 * Enforce that the request holds `permission`, throwing a 403-mapped
 * {@link PortalPermissionError} otherwise.
 *
 * `allowBearer` defaults to **false**: the caller must pass it explicitly to
 * treat the shared Platform API token as an administrative credential. See
 * the module comment for why that default is the safe one.
 */
export async function requirePortalPermission(
  req: FastifyRequest,
  authorization: PortalAuthorizationService,
  permission: PortalPermission,
  opts: { allowBearer?: boolean | undefined } = {},
): Promise<void> {
  if (req.apiAuth === 'bearer') {
    if (opts.allowBearer === true) return;
    throw new PortalPermissionError(permission);
  }
  const session = req.portalSession ?? null;
  if (!session) throw new PortalPermissionError(permission);
  const has = await authorization.has(session, permission);
  if (!has) throw new PortalPermissionError(permission);
}
