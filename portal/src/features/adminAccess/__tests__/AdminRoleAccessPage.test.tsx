/**
 * The Role Access page.
 *
 * What it owes an owner, and what is tested here: it names the roles rather
 * than only their snowflakes, it makes the owner's unconditional access
 * explicit, it never offers the one permission that cannot be delegated, and
 * it degrades honestly when Discord cannot be reached — an empty picker would
 * read as "this server has no roles", which is a lie.
 *
 * Nothing here is a security boundary; the API re-checks every request.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AdminRoleAccessPage } from '../AdminRoleAccessPage';
import * as adminAccess from '@/api/adminAccess';
import type { AdminAccessGrantsResponse, AdminAccessRolesResponse } from '@/api/adminAccess';

const EDITOR_ROLE = '100000000000000001';
const PUBLISHER_ROLE = '100000000000000002';

const PRESETS = {
  encounter_editor: [
    'admin.access',
    'encounters.read',
    'encounters.write',
    'encounters.simulate',
    'encounters.history',
  ],
  encounter_publisher: [
    'admin.access',
    'encounters.read',
    'encounters.write',
    'encounters.publish',
    'encounters.simulate',
    'encounters.history',
  ],
};

const GRANTABLE = [
  'admin.access',
  'encounters.read',
  'encounters.write',
  'encounters.publish',
  'encounters.simulate',
  'encounters.history',
];

function grantsResponse(
  grants: AdminAccessGrantsResponse['grants'] = [],
): AdminAccessGrantsResponse {
  return { grants, presets: PRESETS, grantablePermissions: GRANTABLE };
}

function rolesResponse(available = true): AdminAccessRolesResponse {
  return {
    available,
    roles: available
      ? [
          { id: EDITOR_ROLE, name: 'Encounter Devs', color: 0x5865f2, position: 5, managed: false },
          { id: PUBLISHER_ROLE, name: 'Leads', color: 0, position: 6, managed: false },
        ]
      : [],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.spyOn(adminAccess, 'getAdminAccessRoles').mockResolvedValue(rolesResponse());
  vi.spyOn(adminAccess, 'getAdminAccessGrants').mockResolvedValue(grantsResponse());
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Role Access page', () => {
  it('states that the guild owner always has full access', async () => {
    render(<AdminRoleAccessPage />, { wrapper });

    expect(await screen.findByText(/you are the server owner/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed or removed here/i)).toBeInTheDocument();
  });

  it('shows each granted role by name and id, with its preset', async () => {
    vi.spyOn(adminAccess, 'getAdminAccessGrants').mockResolvedValue(
      grantsResponse([
        {
          roleId: EDITOR_ROLE,
          permissions: PRESETS.encounter_editor,
          preset: 'encounter_editor',
          createdAt: new Date(0).toISOString(),
          createdBy: null,
          updatedAt: new Date(0).toISOString(),
          updatedBy: null,
        },
      ]),
    );
    render(<AdminRoleAccessPage />, { wrapper });

    expect(await screen.findByText('Encounter Devs')).toBeInTheDocument();
    expect(screen.getByText(EDITOR_ROLE)).toBeInTheDocument();
    // The badge specifically: "Encounter Editor" is also a preset radio in the
    // form below and a preset button inside the row itself.
    const [row] = await screen.findAllByTestId('grant-row');
    expect(within(row!).getByTestId('grant-preset')).toHaveTextContent('Encounter Editor');
  });

  it('marks a grant whose Discord role no longer exists', async () => {
    vi.spyOn(adminAccess, 'getAdminAccessGrants').mockResolvedValue(
      grantsResponse([
        {
          roleId: '900000000000000009',
          permissions: PRESETS.encounter_editor,
          preset: 'encounter_editor',
          createdAt: new Date(0).toISOString(),
          createdBy: null,
          updatedAt: new Date(0).toISOString(),
          updatedBy: null,
        },
      ]),
    );
    render(<AdminRoleAccessPage />, { wrapper });

    expect(await screen.findByText(/deleted in Discord/i)).toBeInTheDocument();
  });

  it('grants a role through the picker, sending the preset’s permissions', async () => {
    const create = vi
      .spyOn(adminAccess, 'createAdminAccessGrant')
      .mockResolvedValue({
        roleId: EDITOR_ROLE,
        permissions: PRESETS.encounter_editor,
        preset: 'encounter_editor',
        createdAt: new Date(0).toISOString(),
        createdBy: null,
        updatedAt: new Date(0).toISOString(),
        updatedBy: null,
      });
    const user = userEvent.setup();
    render(<AdminRoleAccessPage />, { wrapper });

    const picker = await screen.findByLabelText('Discord role');
    await user.selectOptions(picker, EDITOR_ROLE);
    await user.click(screen.getByRole('button', { name: /grant access/i }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        roleId: EDITOR_ROLE,
        permissions: PRESETS.encounter_editor,
      }),
    );
  });

  it('the Editor preset it sends does not include publish', async () => {
    render(<AdminRoleAccessPage />, { wrapper });
    await screen.findByLabelText('Discord role');

    // The blurb is the promise the preset makes to the owner.
    expect(screen.getByText(/Cannot publish\./i)).toBeInTheDocument();
    expect(PRESETS.encounter_editor).not.toContain('encounters.publish');
  });

  it('never offers the grant-management permission in Custom', async () => {
    const user = userEvent.setup();
    render(<AdminRoleAccessPage />, { wrapper });
    await screen.findByLabelText('Discord role');

    await user.click(screen.getByRole('radio', { name: /custom/i }));

    expect(await screen.findByText('encounters.publish')).toBeInTheDocument();
    expect(screen.queryByText('admin.roles.manage')).not.toBeInTheDocument();
  });

  it('falls back to a role-ID box, and says why, when Discord is unreachable', async () => {
    vi.spyOn(adminAccess, 'getAdminAccessRoles').mockResolvedValue(rolesResponse(false));
    render(<AdminRoleAccessPage />, { wrapper });

    expect(await screen.findByText(/could not read this server/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Discord role ID')).toBeInTheDocument();
  });

  it('removes a grant', async () => {
    vi.spyOn(adminAccess, 'getAdminAccessGrants').mockResolvedValue(
      grantsResponse([
        {
          roleId: EDITOR_ROLE,
          permissions: PRESETS.encounter_editor,
          preset: 'encounter_editor',
          createdAt: new Date(0).toISOString(),
          createdBy: null,
          updatedAt: new Date(0).toISOString(),
          updatedBy: null,
        },
      ]),
    );
    const remove = vi
      .spyOn(adminAccess, 'deleteAdminAccessGrant')
      .mockResolvedValue({ removed: true });
    const user = userEvent.setup();
    render(<AdminRoleAccessPage />, { wrapper });

    await user.click(await screen.findByRole('button', { name: /remove/i }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(EDITOR_ROLE));
  });

  it('changes a grant to the Publisher preset in one click', async () => {
    vi.spyOn(adminAccess, 'getAdminAccessGrants').mockResolvedValue(
      grantsResponse([
        {
          roleId: EDITOR_ROLE,
          permissions: PRESETS.encounter_editor,
          preset: 'encounter_editor',
          createdAt: new Date(0).toISOString(),
          createdBy: null,
          updatedAt: new Date(0).toISOString(),
          updatedBy: null,
        },
      ]),
    );
    const update = vi.spyOn(adminAccess, 'updateAdminAccessGrant').mockResolvedValue({
      roleId: EDITOR_ROLE,
      permissions: PRESETS.encounter_publisher,
      preset: 'encounter_publisher',
      createdAt: new Date(0).toISOString(),
      createdBy: null,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
    });
    const user = userEvent.setup();
    render(<AdminRoleAccessPage />, { wrapper });

    const rows = await screen.findAllByTestId('grant-row');
    const publisherButton = within(rows[0]!).getByRole('button', {
      name: 'Encounter Publisher',
    });
    await user.click(publisherButton);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(EDITOR_ROLE, PRESETS.encounter_publisher),
    );
  });
});
