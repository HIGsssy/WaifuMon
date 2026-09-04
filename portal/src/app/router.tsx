/**
 * Route configuration (plan §7).
 *
 * Three things are load-bearing here:
 *
 *  - **Every feature is a lazy chunk.** `React.lazy` per route means the
 *    Dashboard bundle is not carrying the Guide's prose or the Collection's
 *    filter machinery (§15 route-level code splitting).
 *  - **Player-scoped routes sit under `<RequireSession>`.** They read
 *    `session.playerId`, never a URL param (§7 rules).
 *  - **`/__dev/diagnostics` is registered only when `import.meta.env.DEV`.**
 *    The check wraps both the route entry *and* the dynamic import, so Vite
 *    eliminates the whole `features/diagnostics/` subtree from a production
 *    build rather than merely hiding the link (§23 guarantees, §24.16).
 */
import { lazy, type ReactElement } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { CalendarDays, Trophy, Users } from 'lucide-react';

import { AppShell } from './AppShell';
import { RequireSession } from '@/auth/RequireSession';
import { RequirePortalPermission } from '@/auth/RequirePortalPermission';
import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';
import { NotFoundPage } from '@/features/notFound/NotFoundPage';
import { SelectPlayerPage } from '@/features/selectPlayer/SelectPlayerPage';

// ── Lazy feature routes ──────────────────────────────────────────────────────
// Phase 0 points these at placeholders; each phase replaces one with the real
// page and nothing else in this file changes.

const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const CollectionPage = lazy(() =>
  import('@/features/collection/CollectionPage').then((m) => ({ default: m.CollectionPage })),
);
const WaifumonDetailPage = lazy(() =>
  import('@/features/collection/WaifumonDetailPage').then((m) => ({
    default: m.WaifumonDetailPage,
  })),
);
const BuddyPage = lazy(() =>
  import('@/features/buddy/BuddyPage').then((m) => ({ default: m.BuddyPage })),
);
const InventoryPage = lazy(() =>
  import('@/features/inventory/InventoryPage').then((m) => ({ default: m.InventoryPage })),
);
const ShopPage = lazy(() =>
  import('@/features/shop/ShopPage').then((m) => ({ default: m.ShopPage })),
);
const EncyclopediaPage = lazy(() =>
  import('@/features/encyclopedia/EncyclopediaPage').then((m) => ({
    default: m.EncyclopediaPage,
  })),
);
const SpeciesDetailPage = lazy(() =>
  import('@/features/encyclopedia/SpeciesDetailPage').then((m) => ({
    default: m.SpeciesDetailPage,
  })),
);
const ProfilePage = lazy(() =>
  import('@/features/profile/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
const GuidePage = lazy(() =>
  import('@/features/guide/GuidePage').then((m) => ({ default: m.GuidePage })),
);
const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

// Admin — encounter management. Lazy so an unprivileged bundle does not
// carry the editor tree; the route also renders `<RequirePortalPermission>`
// so a direct hit shows the not-found page.
const AdminEncountersListPage = lazy(() =>
  import('@/features/adminEncounters/AdminEncountersListPage').then((m) => ({
    default: m.AdminEncountersListPage,
  })),
);
const AdminEncounterEditorPage = lazy(() =>
  import('@/features/adminEncounters/AdminEncounterEditorPage').then((m) => ({
    default: m.AdminEncounterEditorPage,
  })),
);
const AdminEncounterPreviewPage = lazy(() =>
  import('@/features/adminEncounters/AdminEncounterPreviewPage').then((m) => ({
    default: m.AdminEncounterPreviewPage,
  })),
);

/**
 * Dev-only routes. The array is empty in production *and* the import inside it
 * is never evaluated, which is what lets Vite drop the module graph behind it.
 */
function devRoutes(): RouteObject[] {
  if (!import.meta.env.DEV) return [];

  const DiagnosticsPage = lazy(() =>
    import('@/features/diagnostics/DiagnosticsPage').then((m) => ({
      default: m.DiagnosticsPage,
    })),
  );

  return [{ path: '__dev/diagnostics', element: <DiagnosticsPage /> }];
}

const comingSoon = (
  title: string,
  description: string,
  icon: Parameters<typeof ComingSoonPage>[0]['icon'],
  detail: string,
): ReactElement => (
  <ComingSoonPage title={title} description={description} icon={icon} detail={detail} />
);

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      // Dev-auth fallback. Outside the guard by necessity — it is what the
      // guard redirects to.
      { path: 'select-player', element: <SelectPlayerPage /> },
      {
        element: <RequireSession />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'collection', element: <CollectionPage /> },
          { path: 'collection/:waifuId', element: <WaifumonDetailPage /> },
          { path: 'buddy', element: <BuddyPage /> },
          { path: 'inventory', element: <InventoryPage /> },
          { path: 'shop', element: <ShopPage /> },
          { path: 'encyclopedia', element: <EncyclopediaPage /> },
          { path: 'encyclopedia/:slug', element: <SpeciesDetailPage /> },
          { path: 'profile', element: <ProfilePage /> },
          { path: 'guide', element: <GuidePage /> },
          { path: 'settings', element: <SettingsPage /> },

          // Reserved slots — see §25.12.
          {
            path: 'achievements',
            element: comingSoon(
              'Achievements',
              'Milestones and badges earned across your journey.',
              Trophy,
              'Achievements are not modelled in the game services yet, so there is nothing for the Portal to read.',
            ),
          },
          {
            path: 'events',
            element: comingSoon(
              'Events',
              'Limited-time hunts, seasonal species and campaigns.',
              CalendarDays,
              'Event content exists in the data model but has no player-facing surface yet.',
            ),
          },
          {
            path: 'friends',
            element: comingSoon(
              'Friends',
              'Other trainers, their collections, and trading.',
              Users,
              'Social features need cross-player queries the Platform API deliberately does not expose today.',
            ),
          },

          // Admin — Encounter Manager. Nested `<RequirePortalPermission>` is a
          // UX affordance; the API independently re-checks every request.
          {
            path: 'admin/encounters',
            element: (
              <RequirePortalPermission permission="admin.access">
                <AdminEncountersListPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/encounters/new',
            element: (
              <RequirePortalPermission permission="encounters.write">
                <AdminEncounterEditorPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/encounters/:id',
            element: (
              <RequirePortalPermission permission="encounters.read">
                <AdminEncounterEditorPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/encounters/:id/preview',
            element: (
              <RequirePortalPermission permission="encounters.read">
                <AdminEncounterPreviewPage />
              </RequirePortalPermission>
            ),
          },

          ...devRoutes(),
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
