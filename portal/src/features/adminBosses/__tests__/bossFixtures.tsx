/**
 * Shared by the Boss Management tests: fixtures in the shapes the API returns,
 * a small in-memory stand-in for the boss routes, and the render helper.
 */
import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import * as api from '@/api/adminBosses';
import type {
  BossAvailability,
  BossDefinition,
  BossDetail,
  BossDiagnostics,
  BossEncounter,
  BossInput,
  BossReference,
  BossSchedule,
  BossSchedulePreview,
} from '@/api/adminBosses';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';

export const TORONTO = 'America/Toronto';
export const ALWAYS: BossSchedule = { timezone: TORONTO, weekly: null, dateRange: null };

export const OPEN: BossAvailability = {
  mode: 'always',
  availableNow: true,
  currentWindow: { start: null, end: null },
  nextWindow: null,
  unavailableReason: null,
};

/** Friday evenings in Toronto, closed now, next open 2026-10-30 18:00–23:00 local (EDT). */
export const FRIDAY_EVENINGS: BossSchedule = {
  timezone: TORONTO,
  weekly: [{ day: 'fri', allDay: false, windows: [{ start: '18:00', end: '23:00' }] }],
  dateRange: null,
};
export const NEXT_FRIDAY: BossAvailability = {
  mode: 'weekly',
  availableNow: false,
  currentWindow: null,
  nextWindow: { start: '2026-10-30T22:00:00.000Z', end: '2026-10-31T03:00:00.000Z' },
  unavailableReason: null,
};

export const REFERENCE: BossReference = {
  regions: [
    { id: 'waifu-valley', label: 'Waifu Valley', enabled: true },
    { id: 'twin-peeks', label: 'Twin Peeks', enabled: false },
  ],
  affinities: ['dominant', 'submissive', 'caregiver', 'primal', 'switch'],
  rewardTables: [
    { id: 'boss_standard', enabled: true },
    { id: 'boss_legacy', enabled: false },
  ],
  artwork: ['bosses/iron_matron.webp', 'bosses/neon_hydra.webp'],
  defaultTimezone: TORONTO,
  tuning: {
    enabled: true,
    scoutingMinutes: 45,
    downtimeMinutesMin: 90,
    downtimeMinutesMax: 180,
    attacksPerParticipation: 3,
  },
};

/** One boss as the detail route returns it: Active, always available, never fought, unless told otherwise. */
export function bossFixture(over: Partial<BossDetail> & { id: string; name: string }): BossDetail {
  return {
    affinity: 'dominant',
    regions: ['waifu-valley'],
    status: 'active',
    artwork: `bosses/${over.id}.webp`,
    artworkAssetId: null,
    rewardTable: 'boss_standard',
    scoutingText: 'It has been sighted.',
    repelledText: 'It was driven off.',
    unchallengedText: 'Nobody came.',
    description: '',
    schedule: ALWAYS,
    revision: 3,
    source: 'bootstrap',
    shipped: true,
    encounterCount: 0,
    lastEncounterAt: null,
    scheduleSummary: 'Always available',
    availability: OPEN,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    updatedBy: 'bootstrap',
    issues: [],
    ...over,
  };
}

/** The boss as an export document holds it. */
export function definitionOf(boss: BossDetail): BossDefinition {
  return { id: boss.id, ...inputOfDetail(boss) };
}

/** Exactly what the editor sends when a boss is saved unchanged. */
export function inputOfDetail(boss: BossDetail): BossInput {
  return {
    name: boss.name,
    affinity: boss.affinity,
    regions: boss.regions,
    status: boss.status,
    artwork: boss.artwork,
    artworkAssetId: boss.artworkAssetId,
    rewardTable: boss.rewardTable,
    scoutingText: boss.scoutingText,
    repelledText: boss.repelledText,
    unchallengedText: boss.unchallengedText,
    description: boss.description,
    schedule: boss.schedule,
  };
}

export function encounterFixture(over: Partial<BossEncounter> = {}): BossEncounter {
  return {
    id: 41,
    bossId: 'iron_matron',
    bossName: 'Iron Matron',
    region: 'waifu-valley',
    status: 'scouting',
    forced: false,
    scheduledAt: '2026-10-09T15:00:00.000Z',
    startedAt: '2026-10-09T15:01:00.000Z',
    expiresAt: '2026-10-09T15:46:00.000Z',
    resolvedAt: null,
    participantCount: 4,
    totalDamage: 0,
    resolutionReason: null,
    rewardTable: 'boss_standard',
    ...over,
  };
}

export function diagnosticsFixture(over: Partial<BossDiagnostics> = {}): BossDiagnostics {
  return {
    generatedAt: '2026-10-09T15:30:00.000Z',
    featureEnabled: true,
    bootstrap: { definitions: 3, missingShipped: [], lastRun: null },
    scheduler: {
      health: 'ok',
      explanation: 'The last scheduler pass completed on time.',
      running: true,
      intervalMs: 60_000,
      passes: 12,
      lastPassStartedAt: '2026-10-09T15:29:30.000Z',
      lastPassCompletedAt: '2026-10-09T15:29:31.000Z',
      lastPassDurationMs: 800,
      lastPassGuilds: 2,
      lastPassUsableGuilds: 2,
      lastError: null,
    },
    guild: {
      region: 'waifu-valley',
      channelConfigured: true,
      paused: false,
      suspendedReason: null,
      suspendedAt: null,
      nextSpawnAt: null,
      cooldownActive: false,
      bagRemaining: 2,
    },
    active: null,
    bosses: [],
    ...over,
  };
}

/** A preview that reads the schedule back: open for "always", closed until next Friday otherwise. */
export function previewOf(schedule: BossSchedule): BossSchedulePreview {
  const limited = schedule.weekly !== null || schedule.dateRange !== null;
  return {
    issues: [],
    summary: limited ? `Custom schedule (${schedule.timezone})` : 'Always available',
    availability: limited ? NEXT_FRIDAY : OPEN,
  };
}

export const apiError = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new PortalApiError({ status, code, message, ...(details ? { details } : {}) });

export const staleError = () =>
  apiError(409, 'BOSS_DEFINITION_STALE', 'This boss was changed by someone else.', {
    expectedRevision: 3,
    currentRevision: 4,
    updatedBy: '999',
    updatedAt: '2026-10-04T12:00:00.000Z',
  });

/** A call a test did not script is a test bug, never a real request. */
const unscripted = async (): Promise<never> => {
  throw new Error('this boss API call was not scripted by the test');
};

/**
 * Stands in for the boss definition routes over an in-memory store. Every
 * function is a spy, so a test asserts exactly what the page sent.
 */
export function installBossApi(initial: BossDetail[]) {
  stubObjectUrls();
  let store: Record<string, BossDetail> = Object.fromEntries(initial.map((b) => [b.id, b]));
  const found = (id: string) => {
    const boss = store[id];
    if (!boss) throw apiError(404, 'NOT_FOUND', 'Not found.');
    return boss;
  };
  const put = (boss: BossDetail) => {
    store = { ...store, [boss.id]: boss };
    return boss;
  };
  return {
    store: () => store,
    list: vi
      .spyOn(api, 'listBosses')
      .mockImplementation(async () => ({ bosses: Object.values(store) })),
    reference: vi.spyOn(api, 'getBossReference').mockImplementation(async () => REFERENCE),
    artwork: vi.spyOn(api, 'bossArtworkBlob').mockImplementation(async () => new Blob(['art'])),
    assetArtwork: vi
      .spyOn(api, 'bossArtworkAssetBlob')
      .mockImplementation(async () => new Blob(['uploaded art'])),
    library: vi.spyOn(api, 'getBossArtworkLibrary').mockImplementation(unscripted),
    uploadArtwork: vi.spyOn(api, 'uploadBossArtwork').mockImplementation(unscripted),
    deleteArtwork: vi.spyOn(api, 'deleteBossArtwork').mockImplementation(unscripted),
    get: vi.spyOn(api, 'getBoss').mockImplementation(async (id) => found(id)),
    create: vi
      .spyOn(api, 'createBoss')
      .mockImplementation(async (id, boss) =>
        put(bossFixture({ id, ...boss, revision: 1, source: 'portal', shipped: false })),
      ),
    update: vi
      .spyOn(api, 'updateBoss')
      .mockImplementation(async (id, boss) =>
        put({ ...found(id), ...boss, revision: found(id).revision + 1, updatedBy: '777' }),
      ),
    status: vi
      .spyOn(api, 'setBossStatus')
      .mockImplementation(async (id, status) =>
        put({ ...found(id), status, revision: found(id).revision + 1 }),
      ),
    duplicate: vi.spyOn(api, 'duplicateBoss').mockImplementation(async (sourceId, input) =>
      put({
        ...found(sourceId),
        id: input.id,
        name: input.name ?? `${found(sourceId).name} (copy)`,
        status: 'draft',
        revision: 1,
        source: 'portal',
        shipped: false,
        encounterCount: 0,
      }),
    ),
    remove: vi.spyOn(api, 'deleteBoss').mockImplementation(async (id) => {
      const { [id]: _gone, ...rest } = store;
      store = rest;
      return { ok: true };
    }),
    exportAll: vi.spyOn(api, 'exportBosses').mockImplementation(async () => ({
      file: 'boss-definitions.json',
      document: {
        format: 'waifumon-boss-definitions',
        version: 1,
        bosses: Object.values(store).map(definitionOf),
      },
    })),
    events: vi.spyOn(api, 'listBossEvents').mockImplementation(async () => ({ events: [] })),
    preview: vi
      .spyOn(api, 'previewBossSchedule')
      .mockImplementation(async (schedule) => previewOf(schedule)),
    planImport: vi.spyOn(api, 'planBossImport').mockImplementation(unscripted),
    applyImport: vi.spyOn(api, 'applyBossImport').mockImplementation(unscripted),
    activity: vi
      .spyOn(api, 'getBossActivity')
      .mockImplementation(async () => ({ featureEnabled: true, active: [], recent: [] })),
    diagnostics: vi
      .spyOn(api, 'getBossDiagnostics')
      .mockImplementation(async () => diagnosticsFixture()),
    spawn: vi.spyOn(api, 'spawnBoss').mockImplementation(unscripted),
    end: vi.spyOn(api, 'endBossEncounter').mockImplementation(unscripted),
  };
}
export type BossApi = ReturnType<typeof installBossApi>;

export const ALL = ['bosses.read', 'bosses.write', 'bosses.operate', 'rewards.read'];
export const READ_ONLY = ['bosses.read'];

/** Renders `ui` (usually a `<Routes>`) at `path`, signed in with `permissions`. */
export function renderWithSession(ui: ReactElement, path: string, permissions: string[] = ALL) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  render(ui, { wrapper: Wrapper });
  return user;
}
export type User = ReturnType<typeof userEvent.setup>;
