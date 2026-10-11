import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { fixture, install, issue, renderAt } from './dungeonFixtures';

// jsdom cannot lay out the canvas; the browser-level layout is covered by
// playwright/dungeonWorkspace.spec.ts.
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    ReactFlow: ({
      nodes,
      onNodeClick,
    }: {
      nodes: Array<{ id: string; selected?: boolean }>;
      onNodeClick: (e: null, n: { id: string }) => void;
    }) => (
      <div data-testid="flow">
        {nodes.map((n) => (
          <button key={n.id} aria-pressed={n.selected} onClick={() => onNodeClick(null, n)}>
            Canvas room {n.id}
          </button>
        ))}
      </div>
    ),
  };
});
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  stubObjectUrls();
});
const inspector = () => within(screen.getByRole('complementary', { name: 'Map inspector' }));
const outline = () => within(screen.getByRole('navigation', { name: 'Dungeon outline' }));

describe('dungeon editor workspace', () => {
  it('shows the header actions, outline, canvas and dungeon settings together', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { level: 1, name: 'Tunnels' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeEnabled();
    expect(screen.getByText('Draft 4')).toBeInTheDocument();
    expect(screen.getByText('Published 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Dungeon map canvas')).toBeInTheDocument();
    expect(outline().getByRole('button', { name: 'Select room Entrance' })).toHaveTextContent(
      'EntranceStart',
    );
    expect(inspector().getByLabelText('Dungeon name')).toHaveValue('Tunnels');
    expect(inspector().getByLabelText('Artwork path')).toBeInTheDocument();
  });
  it('swaps the inspector between dungeon settings and the selected room beside the canvas', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Canvas room entrance' }));
    expect(inspector().getByLabelText('Room name')).toHaveValue('Entrance');
    expect(inspector().queryByLabelText('Dungeon name')).not.toBeInTheDocument();
    expect(outline().getByRole('button', { name: 'Select room Entrance' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Dungeon map canvas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    await user.click(inspector().getByRole('button', { name: 'Show dungeon settings' }));
    expect(inspector().getByLabelText('Dungeon name')).toBeInTheDocument();
  });
  it('names paths by their rooms and selects them from the outline', async () => {
    const draft = fixture().draft;
    world.stored = {
      ...fixture(),
      draft: {
        ...draft,
        rooms: [...draft.rooms, { id: 'r_vault', name: 'Vault', kind: 'exit', actions: [] }],
        connections: [
          { id: 'c_0f3a', from: 'entrance', to: 'r_vault' },
          { id: 'c_77be', from: 'entrance', to: 'r_vault', label: 'Side door' },
        ],
      },
    };
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select path Entrance → Vault' }));
    expect(inspector().getByLabelText('Open path')).toBeChecked();
    await user.click(
      screen.getByRole('button', { name: 'Select path Entrance → Vault (Side door)' }),
    );
    expect(inspector().getByLabelText('Path button text')).toHaveValue('Side door');
    for (const pane of [
      screen.getByRole('navigation', { name: 'Dungeon outline' }),
      screen.getByRole('complementary', { name: 'Map inspector' }),
    ])
      expect(pane).not.toHaveTextContent(/c_0f3a|c_77be|r_vault/);
  });
  it('counts what is left to do in the header and reveals the checklist', async () => {
    world.stored = { ...fixture(), issues: [issue, { ...issue, severity: 'warning', path: '' }] };
    const user = userEvent.setup();
    renderAt();
    const todo = await screen.findByRole('button', { name: 'Checklist: 1 to fix. Show it' });
    const section = outline().getByRole('button', { name: /^To do/ });
    await user.click(section);
    expect(section).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Hide outline' }));
    await user.click(todo);
    expect(section).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: 'Show outline' })).not.toBeInTheDocument();
    expect(outline().getByText('Fix before publishing')).toBeInTheDocument();
    expect(outline().getByText('Worth a look')).toBeInTheDocument();
    await user.click(
      outline().getByRole('button', {
        name: 'Show me: Entrance: wave 1 uses an enemy that no longer exists.',
      }),
    );
    expect(inspector().getByLabelText('Room name')).toHaveValue('Entrance');
  });
  it('keeps what the dungeon remembers in dungeon-level Advanced settings, not in rooms', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByLabelText('Dungeon name');
    expect(screen.queryByText('Things this dungeon remembers')).not.toBeInTheDocument();
    await user.click(inspector().getByRole('button', { name: 'Advanced' }));
    await user.click(inspector().getByRole('button', { name: 'Add something to remember' }));
    await user.clear(inspector().getByLabelText('Remembered thing 1'));
    await user.type(inspector().getByLabelText('Remembered thing 1'), 'Lever pulled');
    await user.click(screen.getByRole('button', { name: 'Select room Entrance' }));
    expect(inspector().queryByText(/remembers|flag/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    expect(world.stored.draft.flags).toEqual([
      expect.objectContaining({ scope: 'run', description: 'Lever pulled' }),
    ]);
  });
  it('collapses and restores the outline without losing the selection', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await user.click(screen.getByRole('button', { name: 'Hide outline' }));
    expect(screen.queryByRole('button', { name: 'Select room Entrance' })).not.toBeInTheDocument();
    expect(inspector().getByLabelText('Room name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show outline' }));
    expect(screen.getByRole('button', { name: 'Select room Entrance' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  it('keeps every secondary function reachable and preserves edits and selection across views', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await user.clear(inspector().getByLabelText('Room name'));
    await user.type(inspector().getByLabelText('Room name'), 'Gatehouse');
    await user.click(screen.getByRole('button', { name: 'History & export' }));
    const manage = within(screen.getByRole('region', { name: 'History and export' }));
    expect(manage.getByRole('button', { name: 'Export saved draft' })).toBeDisabled();
    expect(manage.getByRole('button', { name: 'Export current published package' })).toBeEnabled();
    expect(manage.getByRole('button', { name: 'View revision 1' })).toBeInTheDocument();
    expect(manage.getByRole('button', { name: 'Roll back to revision 1' })).toBeDisabled();
    expect(manage.getByText('Import history')).toBeInTheDocument();
    expect(manage.getByText('Content history')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select room Gatehouse' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    expect(screen.getByText('Unsaved dungeon changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Map' }));
    expect(inspector().getByLabelText('Room name')).toHaveValue('Gatehouse');
    expect(screen.queryByRole('region', { name: 'History and export' })).not.toBeInTheDocument();
  });
  it('keeps a stale-revision conflict visible above the workspace with edits intact', async () => {
    vi.mocked(api.saveDungeonDraft).mockRejectedValue(
      new PortalApiError({ status: 409, code: 'DUNGEON_DRAFT_STALE', message: 'Draft stale' }),
    );
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await user.type(inspector().getByLabelText('Room description'), 'Cold air');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/A newer draft exists/)).toBeInTheDocument();
    expect(inspector().getByLabelText('Room description')).toHaveValue('Cold air');
    expect(inspector().getByLabelText('Room description')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Reload latest draft (discard local edits)' }),
    ).toBeEnabled();
  });
  it('offers the read-only workspace without save or room creation', async () => {
    renderAt(undefined, ['dungeons.read']);
    expect(await screen.findByLabelText('Dungeon name')).toBeDisabled();
    expect(inspector().getByLabelText('Dungeon name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add room' })).not.toBeInTheDocument();
    expect(screen.getByText(/require dungeons.publish permission/)).toBeInTheDocument();
  });
});
