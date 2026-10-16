/**
 * Region Pool fixtures in the API's exact response shapes, and a renderer that
 * mounts the real Region Pools routes with a chosen permission set.
 */
import { Suspense, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import type {
  DistributionResult,
  RegionPoolAnalysis,
  RegionPoolEntry,
  RegionPoolEntryView,
  RegionPoolListItem,
  RegionPoolReview,
  RegionPoolShipped,
  RegionPoolSpecies,
  RegionPoolView,
  RegionRef,
} from '@/api/adminRegionPools';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { RegionPoolEditorPage } from '../RegionPoolEditorPage';
import { RegionPoolsListPage } from '../RegionPoolsListPage';

export const ALL = ['regions.read', 'regions.write', 'regions.publish'];

export const TWIN_PEEKS: RegionRef = {
  id: 'twin-peeks',
  name: 'Twin Peeks',
  released: true,
  isDefault: false,
};
export const VALLEY: RegionRef = {
  id: 'waifu-valley',
  name: 'Waifu Valley',
  released: true,
  isDefault: true,
};
export const BELT: RegionRef = {
  id: 'assteroid-belt',
  name: 'Assteroid Belt',
  released: false,
  isDefault: false,
};

function sp(
  slug: string,
  name: string,
  rarity: string,
  extra: Partial<RegionPoolSpecies> = {},
): RegionPoolSpecies {
  return {
    slug,
    name,
    rarity,
    enabled: true,
    inContent: true,
    huntable: rarity !== 'EX',
    regionExclusive: false,
    dungeonExclusive: false,
    race: 'human',
    affinity: 'dominant',
    imagePath: `waifumon/${slug}/standard.png`,
    publishedIn: [],
    ...extra,
  };
}

export const CATALOGUE: RegionPoolSpecies[] = [
  sp('cafe_maid', 'Cafe Maid', 'N', { publishedIn: ['twin-peeks', 'waifu-valley'] }),
  sp('alley_cat', 'Alley Catgirl', 'N', { race: 'demi-human', publishedIn: ['twin-peeks'] }),
  sp('shrine_girl', 'Shrine Assistant', 'R', {
    affinity: 'caregiver',
    publishedIn: ['twin-peeks'],
  }),
  sp('sr_idol', 'Stage Idol', 'SR', { publishedIn: ['twin-peeks'] }),
  sp('sr_nurse', 'Night Nurse', 'SR', { affinity: 'caregiver', publishedIn: ['twin-peeks'] }),
  sp('ssr_knight', 'Rose Knight', 'SSR', { race: 'valkyrie', publishedIn: ['twin-peeks'] }),
  sp('ur_witch', 'Moon Witch', 'UR', { race: 'spirit', publishedIn: ['twin-peeks'] }),
  sp('lr_queen', 'Peak Queen', 'LR', { regionExclusive: true, publishedIn: ['twin-peeks'] }),
  sp('ex_goddess', 'Ex Goddess', 'EX', { race: 'angel', publishedIn: ['twin-peeks'] }),
  sp('belt_empress', 'Belt Empress', 'LR', {
    regionExclusive: true,
    race: 'android',
    publishedIn: ['assteroid-belt'],
  }),
  sp('delve_wraith', 'Delve Wraith', 'SR', { dungeonExclusive: true, race: 'demon' }),
  sp('sleepy_r', 'Sleepy Clerk', 'R', { enabled: false }),
  sp('new_r', 'Fresh Recruit', 'R'),
];

const BY_SLUG = new Map(CATALOGUE.map((s) => [s.slug, s]));

export function viewOf(entry: RegionPoolEntry): RegionPoolEntryView {
  const s = BY_SLUG.get(entry.species);
  return {
    ...entry,
    name: s?.name ?? null,
    rarity: s?.rarity ?? null,
    enabled: s?.enabled ?? false,
    inContent: s?.inContent ?? false,
    regionExclusive: s?.regionExclusive ?? false,
    dungeonExclusive: s?.dungeonExclusive ?? false,
    race: s?.race ?? null,
    affinity: s?.affinity ?? null,
    imagePath: s?.imagePath ?? null,
  };
}

export const PUBLISHED_ENTRIES: RegionPoolEntry[] = [
  { species: 'cafe_maid', weight: 3 },
  { species: 'alley_cat', weight: 1 },
  { species: 'shrine_girl', weight: 1 },
  { species: 'sr_idol', weight: 3 },
  { species: 'sr_nurse', weight: 1 },
  { species: 'ssr_knight', weight: 1 },
  { species: 'ur_witch', weight: 1 },
  { species: 'lr_queen', weight: 1 },
  { species: 'ex_goddess', weight: 1 },
];

export function poolView(
  draft: RegionPoolEntry[] = PUBLISHED_ENTRIES,
  overrides: { draftRevision?: number; publishedNumber?: number; region?: RegionRef } = {},
): RegionPoolView {
  const unpublished =
    draft.length !== PUBLISHED_ENTRIES.length ||
    draft.some(
      (e, i) =>
        PUBLISHED_ENTRIES[i]?.species !== e.species || PUBLISHED_ENTRIES[i]?.weight !== e.weight,
    );
  return {
    region: overrides.region ?? TWIN_PEEKS,
    draft: {
      revision: overrides.draftRevision ?? 4,
      hash: 'sha256:draft',
      entries: draft.map(viewOf),
      updatedAt: '2026-10-01T10:00:00.000Z',
      updatedBy: '111',
      unpublishedChanges: unpublished,
    },
    published: {
      number: overrides.publishedNumber ?? 2,
      source: 'editor',
      rolledBackFrom: null,
      publishedAt: '2026-09-30T09:00:00.000Z',
      publishedBy: '222',
      contentHash: 'sha256:pub',
      entryCount: PUBLISHED_ENTRIES.length,
      entries: PUBLISHED_ENTRIES.map(viewOf),
    },
    issues: [
      {
        id: 'species_not_huntable:ex_goddess',
        code: 'species_not_huntable',
        severity: 'warning',
        message: 'Ex Goddess is EX, a rarity the hunt never rolls, so she can never be met here.',
        acknowledgementRequired: false,
        species: 'ex_goddess',
        index: 8,
      },
    ],
  };
}

export function listItem(
  region: RegionRef,
  extra: Partial<RegionPoolListItem> = {},
): RegionPoolListItem {
  return {
    region,
    hasPool: true,
    draftRevision: 4,
    unpublishedChanges: false,
    published: {
      number: 2,
      source: 'editor',
      rolledBackFrom: null,
      publishedAt: '2026-09-30T09:00:00.000Z',
      publishedBy: '222',
      contentHash: 'sha256:pub',
      entryCount: 9,
    },
    rarityCounts: { N: 2, R: 1, SR: 2, SSR: 1, UR: 1, LR: 1, EX: 1 },
    driftStatus: 'clean',
    ...extra,
  };
}

export const LIST: RegionPoolListItem[] = [
  listItem(TWIN_PEEKS, { unpublishedChanges: true }),
  listItem(VALLEY, { draftRevision: 1 }),
  listItem(BELT, {
    driftStatus: 'drift',
    rarityCounts: { N: 3, R: 1, SR: 1, SSR: 1, UR: 1, LR: 0 },
  }),
];

/** An analysis result for the published Twin Peeks pool, as the server shapes it. */
export function distribution(extra: Partial<DistributionResult> = {}): DistributionResult {
  return {
    mode: 'hunt',
    level: 1,
    encounterShare: 0.74,
    rarities: [
      {
        rarity: 'N',
        baseWeight: 600,
        effectiveWeight: 600,
        rollProbability: 0.6,
        probability: 0.6,
        tier: 'region',
        candidates: 2,
        unsafe: false,
      },
      {
        rarity: 'R',
        baseWeight: 250,
        effectiveWeight: 250,
        rollProbability: 0.25,
        probability: 0.25,
        tier: 'region',
        candidates: 1,
        unsafe: false,
      },
      {
        rarity: 'SR',
        baseWeight: 100,
        effectiveWeight: 100,
        rollProbability: 0.1,
        probability: 0.1,
        tier: 'region',
        candidates: 2,
        unsafe: false,
      },
      {
        rarity: 'SSR',
        baseWeight: 35,
        effectiveWeight: 35,
        rollProbability: 0.035,
        probability: 0.035,
        tier: 'region',
        candidates: 1,
        unsafe: false,
      },
      {
        rarity: 'UR',
        baseWeight: 14,
        effectiveWeight: 14,
        rollProbability: 0.014,
        probability: 0.014,
        tier: 'region',
        candidates: 1,
        unsafe: false,
      },
      {
        rarity: 'LR',
        baseWeight: 1,
        effectiveWeight: 1,
        rollProbability: 0.001,
        probability: 0.001,
        tier: 'region',
        candidates: 1,
        unsafe: false,
      },
    ],
    species: [
      {
        slug: 'cafe_maid',
        name: 'Cafe Maid',
        rarity: 'N',
        tier: 'region',
        inPool: true,
        weight: 3,
        effectiveWeight: 3,
        shareOfRarity: 0.75,
        perEncounter: 0.45,
        perHunt: 0.333,
      },
      {
        slug: 'alley_cat',
        name: 'Alley Catgirl',
        rarity: 'N',
        tier: 'region',
        inPool: true,
        weight: 1,
        effectiveWeight: 1,
        shareOfRarity: 0.25,
        perEncounter: 0.15,
        perHunt: 0.111,
      },
      {
        slug: 'shrine_girl',
        name: 'Shrine Assistant',
        rarity: 'R',
        tier: 'region',
        inPool: true,
        weight: 1,
        effectiveWeight: 1,
        shareOfRarity: 1,
        perEncounter: 0.25,
        perHunt: 0.185,
      },
      {
        slug: 'sr_idol',
        name: 'Stage Idol',
        rarity: 'SR',
        tier: 'region',
        inPool: true,
        weight: 3,
        effectiveWeight: 3,
        shareOfRarity: 0.75,
        perEncounter: 0.075,
        perHunt: 0.0555,
      },
      {
        slug: 'sr_nurse',
        name: 'Night Nurse',
        rarity: 'SR',
        tier: 'region',
        inPool: true,
        weight: 1,
        effectiveWeight: 1,
        shareOfRarity: 0.25,
        perEncounter: 0.025,
        perHunt: 0.0185,
      },
      {
        slug: 'ssr_knight',
        name: 'Rose Knight',
        rarity: 'SSR',
        tier: 'region',
        inPool: true,
        weight: 1,
        effectiveWeight: 1,
        shareOfRarity: 1,
        perEncounter: 0.035,
        perHunt: 0.0259,
      },
      {
        slug: 'ur_witch',
        name: 'Moon Witch',
        rarity: 'UR',
        tier: 'region',
        inPool: true,
        weight: 1,
        effectiveWeight: 1,
        shareOfRarity: 1,
        perEncounter: 0.014,
        perHunt: 0.01036,
      },
      {
        slug: 'lr_queen',
        name: 'Peak Queen',
        rarity: 'LR',
        tier: 'region',
        inPool: true,
        weight: 1,
        effectiveWeight: 1,
        shareOfRarity: 1,
        perEncounter: 0.001,
        perHunt: 0.00074,
      },
    ],
    excluded: [{ slug: 'ex_goddess', reason: 'rarity_not_hunted' }],
    exhausted: null,
    errorProbability: 0,
    issues: [],
    ...extra,
  };
}

export function analysis(extra: Partial<RegionPoolAnalysis> = {}): RegionPoolAnalysis {
  return {
    source: 'published',
    assumptions: [
      'Player level 1.',
      'No Buddy equipped.',
      'Owned species assumed: none.',
      'Fallback pool: Waifu Valley as currently projected; global tier from current species.',
    ],
    result: distribution(),
    comparison: null,
    ...extra,
  };
}

export function review(extra: Partial<RegionPoolReview> = {}): RegionPoolReview {
  return {
    purpose: 'publish',
    draftRevision: 4,
    issues: [
      {
        id: 'species_not_huntable:ex_goddess',
        code: 'species_not_huntable',
        severity: 'warning',
        message: 'Ex Goddess is EX, a rarity the hunt never rolls, so she can never be met here.',
        acknowledgementRequired: true,
        species: 'ex_goddess',
      },
    ],
    requiredAcknowledgements: ['species_not_huntable:ex_goddess'],
    reviewHash: 'sha256:review-one',
    canPublish: true,
    diffFromPublished: {
      added: [],
      removed: [],
      reweighted: [{ species: 'sr_idol', from: 3, to: 5 }],
    },
    ...extra,
  };
}

export function shipped(extra: Partial<RegionPoolShipped> = {}): RegionPoolShipped {
  return {
    available: true,
    hash: 'sha256:shipped',
    entries: [
      { species: 'cafe_maid', weight: 2 },
      { species: 'shrine_girl', weight: 1 },
      { species: 'new_r', weight: 4 },
    ],
    skipped: ['ghost_slug'],
    diffFromDraft: {
      added: [{ species: 'new_r', weight: 4 }],
      removed: [{ species: 'alley_cat', weight: 1 }],
      reweighted: [{ species: 'cafe_maid', from: 3, to: 2 }],
    },
    diffFromPublished: {
      added: [{ species: 'new_r', weight: 4 }],
      removed: [{ species: 'alley_cat', weight: 1 }],
      reweighted: [{ species: 'cafe_maid', from: 3, to: 2 }],
    },
    mergeCandidates: [{ species: 'new_r', weight: 4 }],
    weightConflicts: [{ species: 'cafe_maid', draft: 3, shipped: 2 }],
    ...extra,
  };
}

export function renderRegionPools(path: string, permissions: string[] = ALL) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Admin', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>
          <Suspense fallback={<p>Loading…</p>}>{children}</Suspense>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/admin/region-pools" element={<RegionPoolsListPage />} />
      <Route path="/admin/region-pools/:regionId" element={<RegionPoolEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
}
