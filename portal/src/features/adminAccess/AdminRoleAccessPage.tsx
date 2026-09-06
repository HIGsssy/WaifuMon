/**
 * Role Access — who, besides you, may use the Portal Admin area.
 *
 * Visible only to the Discord guild owner. That is enforced by the API (every
 * endpoint here requires `admin.roles.manage`, which only an owner is ever
 * issued); the route guard and this screen are the affordance, not the
 * boundary.
 *
 * Three things this screen owes an owner:
 *
 *   - **A role picker, not a snowflake box.** Role ids are unreadable and
 *     mistyping one creates a grant that silently matches nobody. The picker
 *     is populated from the guild's live role list, and the id is shown beside
 *     each name so a grant can still be verified by eye.
 *   - **Presets that answer the real question.** The distinction an owner
 *     cares about is "can this person publish?", so Editor and Publisher are
 *     the headline choices; Custom covers the rest.
 *   - **A clear statement that the owner is unconditional.** Someone reading a
 *     list of grants needs to know their own access is not one of the rows and
 *     cannot be revoked by anything on this page.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createAdminAccessGrant,
  deleteAdminAccessGrant,
  getAdminAccessGrants,
  getAdminAccessRoles,
  updateAdminAccessGrant,
  type AdminAccessGrant,
  type AdminAccessRole,
} from '@/api/adminAccess';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';

const GRANTS_KEY = ['admin', 'access', 'grants'] as const;
const ROLES_KEY = ['admin', 'access', 'roles'] as const;

/** Preset labels. The permission lists themselves come from the API. */
const PRESET_LABELS: Record<string, string> = {
  encounter_editor: 'Encounter Editor',
  encounter_publisher: 'Encounter Publisher',
  custom: 'Custom',
};

const PRESET_BLURB: Record<string, string> = {
  encounter_editor: 'Can author, edit and simulate encounters. Cannot publish.',
  encounter_publisher: 'Everything an Editor can do, plus publishing.',
  custom: 'Pick individual permissions.',
};

function roleLabel(roleId: string, roles: readonly AdminAccessRole[]): string {
  return roles.find((r) => r.id === roleId)?.name ?? 'Unknown role';
}

/** Discord's integer colour as CSS; 0 means "no colour set". */
function roleColor(color: number): string | undefined {
  return color === 0 ? undefined : `#${color.toString(16).padStart(6, '0')}`;
}

export function AdminRoleAccessPage() {
  const queryClient = useQueryClient();
  const grantsQuery = useQuery({
    queryKey: GRANTS_KEY,
    queryFn: ({ signal }) => getAdminAccessGrants(signal),
  });
  const rolesQuery = useQuery({
    queryKey: ROLES_KEY,
    queryFn: ({ signal }) => getAdminAccessRoles(signal),
  });

  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [preset, setPreset] = useState<string>('encounter_editor');
  const [customPermissions, setCustomPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: GRANTS_KEY });
  };
  const onError = (err: unknown) => {
    setError(err instanceof Error ? err.message : 'That did not work.');
  };

  const createMutation = useMutation({
    mutationFn: (input: { roleId: string; permissions: string[] }) =>
      createAdminAccessGrant(input),
    onSuccess: () => {
      setSelectedRoleId('');
      setError(null);
      invalidate();
    },
    onError,
  });
  const updateMutation = useMutation({
    mutationFn: (input: { roleId: string; permissions: string[] }) =>
      updateAdminAccessGrant(input.roleId, input.permissions),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError,
  });
  const deleteMutation = useMutation({
    mutationFn: (roleId: string) => deleteAdminAccessGrant(roleId),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError,
  });

  const grants = grantsQuery.data;
  const roles = useMemo(() => rolesQuery.data?.roles ?? [], [rolesQuery.data]);
  const rolesAvailable = rolesQuery.data?.available ?? false;

  // A role that already has a grant is not offered again: editing the existing
  // row is how you change it, and two rows for one role is not a state the API
  // can hold.
  const grantedRoleIds = useMemo(
    () => new Set((grants?.grants ?? []).map((g) => g.roleId)),
    [grants],
  );

  if (grantsQuery.isPending) return <Skeleton className="h-96 w-full" />;
  if (grantsQuery.isError) {
    return (
      <ErrorState
        title="Could not load role access"
        error={grantsQuery.error}
        onRetry={() => void grantsQuery.refetch()}
      />
    );
  }
  if (!grants) return null;

  const availableRoles = roles.filter((r) => !grantedRoleIds.has(r.id));
  const presetNames = [...Object.keys(grants.presets), 'custom'];
  const permissionsForSubmit =
    preset === 'custom' ? customPermissions : (grants.presets[preset] ?? []);

  const togglePermission = (permission: string) => {
    setCustomPermissions((current) =>
      current.includes(permission)
        ? current.filter((p) => p !== permission)
        : [...current, permission],
    );
  };

  return (
    <div className="flex flex-col gap-6" data-testid="admin-role-access">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Role Access</h1>
        <p className="text-sm text-muted-foreground">
          Grant Portal Admin access to Discord roles in this server. Anyone holding a granted
          role gets these permissions the next time they sign in or refresh.
        </p>
      </header>

      {/*
        Stated plainly and first. An owner scanning a list of grants must not
        wonder whether their own access is one of the rows, or whether removing
        a row could lock them out.
      */}
      <Card className="border-primary/40 bg-primary/5 p-4">
        <p className="text-sm">
          <strong>You are the server owner.</strong> You always have every Portal Admin
          permission, including this page. That is read live from Discord and cannot be
          changed or removed here.
        </p>
      </Card>

      {error ? (
        <Card className="border-destructive/50 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-lg font-medium">Granted roles</h2>
        {grants.grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No roles have been granted access yet. You are the only admin.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {grants.grants.map((grant) => (
              <GrantRow
                key={grant.roleId}
                grant={grant}
                roles={roles}
                presets={grants.presets}
                grantablePermissions={grants.grantablePermissions}
                busy={updateMutation.isPending || deleteMutation.isPending}
                onChangePermissions={(permissions) =>
                  updateMutation.mutate({ roleId: grant.roleId, permissions })
                }
                onRemove={() => deleteMutation.mutate(grant.roleId)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-lg font-medium">Grant access to a role</h2>

        {rolesQuery.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : !rolesAvailable ? (
          <p className="text-sm text-muted-foreground">
            Could not read this server&rsquo;s roles from Discord, so the picker is
            unavailable. Enter a role ID directly, or try again shortly.
          </p>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Discord role</span>
          {rolesAvailable && availableRoles.length > 0 ? (
            <select
              aria-label="Discord role"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
            >
              <option value="">Pick a role…</option>
              {availableRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name} — {role.id}
                </option>
              ))}
            </select>
          ) : (
            <Input
              aria-label="Discord role ID"
              placeholder="Role ID"
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
            />
          )}
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Permissions</legend>
          {presetNames.map((name) => (
            <label key={name} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="preset"
                value={name}
                checked={preset === name}
                onChange={() => setPreset(name)}
              />
              <span>
                <span className="font-medium">{PRESET_LABELS[name] ?? name}</span>
                <span className="block text-xs text-muted-foreground">
                  {PRESET_BLURB[name] ?? ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {preset === 'custom' ? (
          <fieldset className="flex flex-col gap-1 rounded-md border p-3">
            <legend className="px-1 text-xs font-medium">Custom permissions</legend>
            {grants.grantablePermissions.map((permission) => (
              <label key={permission} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={customPermissions.includes(permission)}
                  onChange={() => togglePermission(permission)}
                />
                <code className="text-xs">{permission}</code>
              </label>
            ))}
          </fieldset>
        ) : null}

        <div>
          <Button
            disabled={
              selectedRoleId.trim().length === 0 ||
              permissionsForSubmit.length === 0 ||
              createMutation.isPending
            }
            onClick={() =>
              createMutation.mutate({
                roleId: selectedRoleId.trim(),
                permissions: permissionsForSubmit,
              })
            }
          >
            {createMutation.isPending ? 'Granting…' : 'Grant access'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function GrantRow({
  grant,
  roles,
  presets,
  grantablePermissions,
  busy,
  onChangePermissions,
  onRemove,
}: {
  grant: AdminAccessGrant;
  roles: readonly AdminAccessRole[];
  presets: Record<string, string[]>;
  grantablePermissions: readonly string[];
  busy: boolean;
  onChangePermissions: (permissions: string[]) => void;
  onRemove: () => void;
}) {
  const [editingCustom, setEditingCustom] = useState(false);
  const [draft, setDraft] = useState<string[]>(grant.permissions);
  const role = roles.find((r) => r.id === grant.roleId);
  const color = role ? roleColor(role.color) : undefined;

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" data-testid="grant-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-medium" style={color ? { color } : undefined}>
            {roleLabel(grant.roleId, roles)}
            {/* A grant naming a role that no longer exists is inert — nobody
                holds it — but saying so beats showing a bare "Unknown role". */}
            {role ? null : (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (deleted in Discord — grants nothing)
              </span>
            )}
          </span>
          <code className="text-xs text-muted-foreground">{grant.roleId}</code>
        </div>
        <div className="flex items-center gap-2">
          <Badge data-testid="grant-preset">
            {PRESET_LABELS[grant.preset] ?? grant.preset}
          </Badge>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {grant.permissions.map((permission) => (
          <code
            key={permission}
            className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {permission}
          </code>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {Object.keys(presets).map((name) => (
          <Button
            key={name}
            variant="outline"
            size="sm"
            disabled={busy || grant.preset === name}
            onClick={() => onChangePermissions(presets[name] ?? [])}
          >
            {PRESET_LABELS[name] ?? name}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setDraft(grant.permissions);
            setEditingCustom((v) => !v);
          }}
        >
          {editingCustom ? 'Cancel' : 'Custom…'}
        </Button>
      </div>

      {editingCustom ? (
        <div className="flex flex-col gap-1 rounded-md border p-3">
          {grantablePermissions.map((permission) => (
            <label key={permission} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.includes(permission)}
                onChange={() =>
                  setDraft((current) =>
                    current.includes(permission)
                      ? current.filter((p) => p !== permission)
                      : [...current, permission],
                  )
                }
              />
              <code className="text-xs">{permission}</code>
            </label>
          ))}
          <div>
            <Button
              size="sm"
              disabled={busy || draft.length === 0}
              onClick={() => {
                onChangePermissions(draft);
                setEditingCustom(false);
              }}
            >
              Save permissions
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default AdminRoleAccessPage;
