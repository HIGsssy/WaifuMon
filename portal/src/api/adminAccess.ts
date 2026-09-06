/**
 * Portal Admin — Role Access API client.
 *
 * Mirrors `/api/v1/admin/access/*`. Every endpoint here is owner-only on the
 * server; nothing in this file is a security boundary, and the screen it feeds
 * is a convenience over checks the API performs independently.
 *
 * Note what is *not* sent: no guild id. The server takes the guild from the
 * authenticated session, so this client cannot address another server's grants
 * even if it wanted to.
 */
import { deleteData, getData, patchData, postData } from './client';

/** One Discord role, as the picker renders it. */
export interface AdminAccessRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
}

export interface AdminAccessRolesResponse {
  roles: AdminAccessRole[];
  /** False when the bot could not reach Discord — the UI falls back to ids. */
  available: boolean;
}

export interface AdminAccessGrant {
  roleId: string;
  permissions: string[];
  /** `encounter_editor`, `encounter_publisher`, or `custom`. */
  preset: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AdminAccessGrantsResponse {
  grants: AdminAccessGrant[];
  /** Preset name → permission list, served by the API so the two cannot drift. */
  presets: Record<string, string[]>;
  /** Every permission an owner may delegate. Never includes role management. */
  grantablePermissions: string[];
}

export function getAdminAccessRoles(signal?: AbortSignal): Promise<AdminAccessRolesResponse> {
  return getData<AdminAccessRolesResponse>(
    '/v1/admin/access/roles',
    signal ? { signal } : {},
  );
}

export function getAdminAccessGrants(signal?: AbortSignal): Promise<AdminAccessGrantsResponse> {
  return getData<AdminAccessGrantsResponse>(
    '/v1/admin/access/grants',
    signal ? { signal } : {},
  );
}

export function createAdminAccessGrant(input: {
  roleId: string;
  permissions: string[];
}): Promise<AdminAccessGrant> {
  return postData<AdminAccessGrant>('/v1/admin/access/grants', input);
}

export function updateAdminAccessGrant(
  roleId: string,
  permissions: string[],
): Promise<AdminAccessGrant> {
  return patchData<AdminAccessGrant>(`/v1/admin/access/grants/${roleId}`, { permissions });
}

export function deleteAdminAccessGrant(roleId: string): Promise<{ removed: boolean }> {
  return deleteData<{ removed: boolean }>(`/v1/admin/access/grants/${roleId}`);
}
