import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';
import * as api from '@/api/adminDungeons';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { DungeonZoneEditorPage } from '../DungeonZoneEditorPage';
import { DungeonCreatePage } from '../DungeonCreatePage';
import { DungeonsListPage } from '../DungeonsListPage';
import { starterDungeon } from '../dungeonModel';
export const PERMISSIONS = ['dungeons.read', 'dungeons.write', 'dungeons.publish', 'artwork.read'];
export const issue: api.DungeonIssue = {
  code: 'enemy_missing',
  severity: 'error',
  path: 'rooms[0].actions[0].waves[0].enemy',
  message: 'Enemy ghost is missing',
};
export function fixture(): api.DungeonDetail {
  return {
    key: 'tunnels',
    name: 'Tunnels',
    enabled: true,
    position: 0,
    roomCount: 1,
    draftRevision: 4,
    draftHash: 'hash',
    published: {
      revisionId: 2,
      number: 2,
      contentHash: 'hash2',
      publishedAt: '2026-10-10T12:00:00Z',
      publishedBy: 'author',
    },
    draftDiffers: true,
    open: true,
    updatedAt: '2026-10-10T12:00:00Z',
    updatedBy: 'author',
    draft: starterDungeon('tunnels', 'Tunnels', ['waifu-valley']),
    layout: { rooms: { entrance: { x: 4, y: 8 } }, notes: [] },
    issues: [],
  };
}
export const revision: api.DungeonRevision = {
  revisionId: 1,
  number: 1,
  contentHash: 'h1',
  publishedAt: '2026-10-09T12:00:00Z',
  publishedBy: 'author',
  source: 'editor',
  draftRevision: 1,
  current: false,
  activeRuns: 1,
};
export function install() {
  vi.spyOn(api, 'getDungeonImportHistory').mockResolvedValue({ imports: [] });
  let stored = fixture();
  vi.spyOn(api, 'getDungeon').mockImplementation(async () => structuredClone(stored));
  vi.spyOn(api, 'listDungeons').mockImplementation(async () => ({
    dungeons: [structuredClone(stored)],
  }));
  vi.spyOn(api, 'getDungeonReference').mockResolvedValue({
    actionTypes: ['reward'],
    reservedActionTypes: {},
    enemies: [],
    rewardTables: [],
    currencies: [],
    regions: [{ id: 'waifu-valley', name: 'Waifu Valley', enabled: true }],
  });
  vi.spyOn(api, 'getDungeonSettings').mockResolvedValue({
    dailyRunLimit: 3,
    dailyRunLimitMin: 0,
    dailyRunLimitMax: 50,
    updatedAt: null,
    updatedBy: null,
  });
  vi.spyOn(api, 'updateDungeonSettings').mockImplementation(async ({ dailyRunLimit }) => ({
    dailyRunLimit,
    dailyRunLimitMin: 0,
    dailyRunLimitMax: 50,
    updatedAt: null,
    updatedBy: null,
  }));
  vi.spyOn(api, 'listProgressionCurrencies').mockResolvedValue({
    currencies: [
      {
        key: 'ascension_currency',
        singularName: 'Token',
        pluralName: 'Tokens',
        description: 'Ascension',
        icon: null,
        enabled: true,
        revision: 2,
        updatedAt: '2026-10-10T12:00:00Z',
        updatedBy: null,
      },
    ],
  });
  vi.spyOn(api, 'updateProgressionCurrency').mockImplementation(async (key, metadata) => ({
    key,
    ...metadata,
    revision: 3,
    updatedAt: '2026-10-10T12:00:00Z',
    updatedBy: null,
  }));
  vi.spyOn(api, 'saveDungeonDraft').mockImplementation(async (_key, input) => {
    stored = {
      ...stored,
      draft: input.definition!,
      layout: input.layout ?? stored.layout,
      name: input.definition!.name,
      draftRevision: stored.draftRevision + 1,
    };
    return structuredClone(stored);
  });
  vi.spyOn(api, 'validateDungeon').mockImplementation(async (definition) => ({
    definition,
    contentHash: 'hash',
    issues: [],
    publishable: true,
  }));
  vi.spyOn(api, 'listDungeonRevisions').mockResolvedValue({ revisions: [revision] });
  vi.spyOn(api, 'getDungeonRevision').mockImplementation(async () => ({
    ...revision,
    content: stored.draft,
    layout: stored.layout,
  }));
  vi.spyOn(api, 'getDungeonHistory').mockResolvedValue({
    events: [
      {
        id: 1,
        dungeonKey: 'tunnels',
        action: 'draft_saved',
        actor: 'author',
        details: { draftRevision: 4 },
        createdAt: '2026-10-10T12:00:00Z',
      },
    ],
  });
  vi.spyOn(api, 'publishDungeon').mockImplementation(async () => {
    stored = { ...stored, published: { ...revision, number: 3 }, draftDiffers: false };
    return {
      dungeon: structuredClone(stored),
      revision: { ...revision, number: 3, current: true },
      unchanged: false,
    };
  });
  vi.spyOn(api, 'rollbackDungeon').mockImplementation(async (_key, number) => {
    stored = { ...stored, published: { ...revision, number } };
    return {
      dungeon: structuredClone(stored),
      revision: { ...revision, number, current: true },
      unchanged: false,
    };
  });
  vi.spyOn(api, 'exportDungeonPackage').mockImplementation(async () => ({
    format: 'waifumon-dungeon-package',
    schemaVersion: 1,
    dungeon: stored.draft,
  }));
  vi.spyOn(api, 'createDungeon').mockImplementation(async (draft) => {
    stored = { ...stored, key: draft.key, name: draft.name, draft, published: null };
    return structuredClone(stored);
  });
  vi.spyOn(api, 'setDungeonEnabled').mockImplementation(async (_key, enabled) => ({
    ...stored,
    enabled,
  }));
  vi.spyOn(api, 'dungeonArtworkBlob').mockResolvedValue(new Blob(['art']));
  return {
    get stored() {
      return stored;
    },
    set stored(next: api.DungeonDetail) {
      stored = next;
    },
  };
}
export function renderAt(path = '/admin/dungeons/definitions/tunnels', permissions = PERMISSIONS) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/admin/dungeons" element={<DungeonsListPage />} />
      <Route path="/admin/dungeons/new" element={<DungeonCreatePage />} />
      <Route path="/admin/dungeons/definitions/:key" element={<DungeonZoneEditorPage />} />
      <Route path="/admin/dungeons/zones/:key" element={<DungeonZoneEditorPage />} />
    </Routes>,
    { wrapper },
  );
}
