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
import { CalendarDays } from 'lucide-react';

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
const ExpeditionsPage = lazy(() =>
  import('@/features/expeditions/ExpeditionsPage').then((m) => ({ default: m.ExpeditionsPage })),
);
const EquipmentPage = lazy(() =>
  import('@/features/equipment/EquipmentPage').then((m) => ({ default: m.EquipmentPage })),
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
const PlayersPage = lazy(() =>
  import('@/features/players/PlayersPage').then((m) => ({ default: m.PlayersPage })),
);
// The public profile of another trainer in the selected guild. Distinct from
// `/profile`, which is the self view and reads endpoints the API scopes to the
// session's own player — see the page's own header.
const PublicProfilePage = lazy(() =>
  import('@/features/players/PublicProfilePage').then((m) => ({ default: m.PublicProfilePage })),
);
// A guild-mate's collection and one copy from it. Both render the shared
// Collection components in `public` mode — see those files for why the mode is
// an explicit prop rather than something inferred from the data.
const PublicCollectionPage = lazy(() =>
  import('@/features/players/PublicCollectionPage').then((m) => ({
    default: m.PublicCollectionPage,
  })),
);
const PublicWaifumonDetailPage = lazy(() =>
  import('@/features/players/PublicWaifumonDetailPage').then((m) => ({
    default: m.PublicWaifumonDetailPage,
  })),
);
const GuidePage = lazy(() =>
  import('@/features/guide/GuidePage').then((m) => ({ default: m.GuidePage })),
);
const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AchievementsPage = lazy(() =>
  import('@/features/achievements/AchievementsPage').then((m) => ({
    default: m.AchievementsPage,
  })),
);
const LeaderboardsPage = lazy(() =>
  import('@/features/leaderboards/LeaderboardsPage').then((m) => ({
    default: m.LeaderboardsPage,
  })),
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
const WorldEncountersLayout = lazy(() =>
  import('@/features/adminEncounters/WorldEncountersLayout').then((m) => ({
    default: m.WorldEncountersLayout,
  })),
);
const EncounterChainsPage = lazy(() =>
  import('@/features/adminEncounters/EncounterChainsPage').then((m) => ({
    default: m.EncounterChainsPage,
  })),
);
const EncounterSettingsPage = lazy(() =>
  import('@/features/adminEncounters/EncounterSettingsPage').then((m) => ({
    default: m.EncounterSettingsPage,
  })),
);
const ImportExportPage = lazy(() =>
  import('@/features/adminEncounters/ImportExportPage').then((m) => ({
    default: m.ImportExportPage,
  })),
);
const VendorsListPage = lazy(() =>
  import('@/features/adminEncounters/VendorsListPage').then((m) => ({
    default: m.VendorsListPage,
  })),
);
const VendorEditorPage = lazy(() =>
  import('@/features/adminEncounters/VendorEditorPage').then((m) => ({
    default: m.VendorEditorPage,
  })),
);
// Reward Tables (boss and expedition payouts). Gated on `rewards.read` only.
const RewardTablesListPage = lazy(() =>
  import('@/features/adminRewardTables/RewardTablesListPage').then((m) => ({
    default: m.RewardTablesListPage,
  })),
);
const RewardTableEditorPage = lazy(() =>
  import('@/features/adminRewardTables/RewardTableEditorPage').then((m) => ({
    default: m.RewardTableEditorPage,
  })),
);
// Dungeons (drafts, revisions and publication). Gated on
// `dungeons.read` only.
const SharedPoolsPage = lazy(() => import('@/features/adminDungeonSpeciesPools/SharedPoolsPage').then(m => ({ default: m.SharedPoolsPage })));
const SceneSpritesPage = lazy(() => import('@/features/adminDungeonSceneSprites/SceneSpritesPage').then((m) => ({ default: m.SceneSpritesPage })));
const DungeonsListPage = lazy(() =>
  import('@/features/adminDungeons/DungeonsListPage').then((m) => ({
    default: m.DungeonsListPage,
  })),
);
const DungeonCreatePage = lazy(() =>
  import('@/features/adminDungeons/DungeonCreatePage').then((m) => ({
    default: m.DungeonCreatePage,
  })),
);
// Dungeon Loot Tables: the dungeon-only loot catalogue. Same permissions as dungeons.
const LootTablesListPage = lazy(() =>
  import('@/features/adminDungeonLoot/LootTablesListPage').then((m) => ({
    default: m.LootTablesListPage,
  })),
);
const LootTableEditorPage = lazy(() =>
  import('@/features/adminDungeonLoot/LootTableEditorPage').then((m) => ({
    default: m.LootTableEditorPage,
  })),
);
const DungeonZoneEditorPage = lazy(() =>
  import('@/features/adminDungeons/DungeonZoneEditorPage').then((m) => ({
    default: m.DungeonZoneEditorPage,
  })),
);
// The Equipment Catalogue (Equipment 3.0): definitions across all six
// rarities. Gated on `equipment.read`; writing needs `equipment.write`.
const EquipmentCataloguePage = lazy(() =>
  import('@/features/adminEquipment/EquipmentCataloguePage').then((m) => ({
    default: m.EquipmentCataloguePage,
  })),
);
const EquipmentCreatePage = lazy(() =>
  import('@/features/adminEquipment/EquipmentDefinitionEditorPage').then((m) => ({
    default: m.EquipmentCreatePage,
  })),
);
const EquipmentEditorPage = lazy(() =>
  import('@/features/adminEquipment/EquipmentDefinitionEditorPage').then((m) => ({
    default: m.EquipmentEditorPage,
  })),
);
const EquipmentImportPage = lazy(() =>
  import('@/features/adminEquipment/EquipmentImportPage').then((m) => ({
    default: m.EquipmentImportPage,
  })),
);
const EquipmentRarityRulesPage = lazy(() =>
  import('@/features/adminEquipment/EquipmentRarityRulesPage').then((m) => ({
    default: m.EquipmentRarityRulesPage,
  })),
);
const AffixLibrariesPage = lazy(() =>
  import('@/features/adminEquipment/AffixLibrariesPage').then((m) => ({ default: m.AffixLibrariesPage })),
);
const AffixLibraryCreatePage = lazy(() =>
  import('@/features/adminEquipment/AffixLibrariesPage').then((m) => ({ default: m.AffixLibraryCreatePage })),
);
const AffixLibraryEditorPage = lazy(() =>
  import('@/features/adminEquipment/AffixLibraryEditorPage').then((m) => ({ default: m.AffixLibraryEditorPage })),
);
const AffixLibraryImportPage = lazy(() =>
  import('@/features/adminEquipment/AffixLibraryImportPage').then((m) => ({ default: m.AffixLibraryImportPage })),
);
// The Enemy Catalogue: combat enemies as shared content. Gated on
// `enemies.read`; the editor is read-only without `enemies.write`.
const EnemiesListPage = lazy(() =>
  import('@/features/adminEnemies/EnemiesListPage').then((m) => ({
    default: m.EnemiesListPage,
  })),
);
const EnemyImportPage = lazy(() =>
  import('@/features/adminEnemies/EnemyImportPage').then((m) => ({
    default: m.EnemyImportPage,
  })),
);
const EnemyCreatePage = lazy(() =>
  import('@/features/adminEnemies/EnemyCreatePage').then((m) => ({
    default: m.EnemyCreatePage,
  })),
);
const EnemyEditorPage = lazy(() =>
  import('@/features/adminEnemies/EnemyEditorPage').then((m) => ({
    default: m.EnemyEditorPage,
  })),
);
// Region Pools: which Waifumon each region's hunt can meet. Gated on
// `regions.read`; drafts need `regions.write`, publish/rollback `regions.publish`.
const RegionPoolsListPage = lazy(() =>
  import('@/features/adminRegionPools/RegionPoolsListPage').then((m) => ({
    default: m.RegionPoolsListPage,
  })),
);
const RegionPoolEditorPage = lazy(() =>
  import('@/features/adminRegionPools/RegionPoolEditorPage').then((m) => ({
    default: m.RegionPoolEditorPage,
  })),
);
// Boss Management: boss definitions, availability schedules and live boss
// activity. Gated on `bosses.read`; definition edits need `bosses.write`; Spawn Now and End Encounter need `bosses.operate`.
const BossesListPage = lazy(() =>
  import('@/features/adminBosses/BossesListPage').then((m) => ({
    default: m.BossesListPage,
  })),
);
const BossEditorPage = lazy(() =>
  import('@/features/adminBosses/BossEditorPage').then((m) => ({
    default: m.BossEditorPage,
  })),
);
const BossActivityPage = lazy(() =>
  import('@/features/adminBosses/BossActivityPage').then((m) => ({
    default: m.BossActivityPage,
  })),
);
// Managed artwork: images uploaded through the Portal. Gated on `artwork.read`.
const ArtworkAssetsPage = lazy(() =>
  import('@/features/adminArtwork/ArtworkAssetsPage').then((m) => ({
    default: m.ArtworkAssetsPage,
  })),
);
// Result Presentations. Gated on its own permission — not `admin.access` or
// any encounter permission — so a presentation-only editor reaches it.
const ResultPresentationsPage = lazy(() =>
  import('@/features/adminResultPresentations/ResultPresentationsPage').then((m) => ({
    default: m.ResultPresentationsPage,
  })),
);
// Waifumon Gallery. Read-only content/artwork QA, gated on `gallery.read` and
// nothing else — no encounter or presentation permission reaches it.
const AdminGalleryPage = lazy(() =>
  import('@/features/adminGallery/AdminGalleryPage').then((m) => ({
    default: m.AdminGalleryPage,
  })),
);
const AdminGallerySpeciesPage = lazy(() =>
  import('@/features/adminGallery/AdminGallerySpeciesPage').then((m) => ({
    default: m.AdminGallerySpeciesPage,
  })),
);
// System Metrics. Owner-only by permission (`system.metrics.read` is not
// grantable). Lazy for the same reason as every admin page: an unprivileged
// bundle never downloads the dashboard.
const SystemMetricsPage = lazy(() =>
  import('@/features/adminSystemMetrics/SystemMetricsPage').then((m) => ({
    default: m.SystemMetricsPage,
  })),
);
// Load Testing. Owner-only by permission, and the permission itself is issued
// only where the server has LOAD_TESTING_ENABLED.
const LoadTestingPage = lazy(() =>
  import('@/features/adminLoadTesting/LoadTestingPage').then((m) => ({
    default: m.LoadTestingPage,
  })),
);
// Staging Test Controls. Owners and granted admins, via `players.testcontrols`,
// which the server issues only on a non-production deployment with
// ENABLE_TEST_ADMIN_CONTROLS — so production never renders these pages.
const TestControlsPickerPage = lazy(() =>
  import('@/features/adminTestControls/TestControlsPickerPage').then((m) => ({
    default: m.TestControlsPickerPage,
  })),
);
const TestControlsPlayerPage = lazy(() =>
  import('@/features/adminTestControls/TestControlsPlayerPage').then((m) => ({
    default: m.TestControlsPlayerPage,
  })),
);
// Owner-only. Guarded on `admin.roles.manage`, which the authorization service
// issues to the live guild owner and to nobody else — a role grant can never
// confer it, so a delegated admin hitting this path gets the not-found page.
const AdminRoleAccessPage = lazy(() =>
  import('@/features/adminAccess/AdminRoleAccessPage').then((m) => ({
    default: m.AdminRoleAccessPage,
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
          { path: 'expeditions', element: <ExpeditionsPage /> },
          { path: 'inventory', element: <InventoryPage /> },
          { path: 'equipment', element: <EquipmentPage /> },
          { path: 'shop', element: <ShopPage /> },
          { path: 'encyclopedia', element: <EncyclopediaPage /> },
          { path: 'encyclopedia/:slug', element: <SpeciesDetailPage /> },
          { path: 'profile', element: <ProfilePage /> },
          // `:playerId` is a route param, which §7's rules bar for the *acting*
          // player — and this is the one route that is deliberately not about
          // the acting player. The API decides whether the session may see it.
          { path: 'players', element: <PlayersPage /> },
          { path: 'players/:playerId', element: <PublicProfilePage /> },
          { path: 'players/:playerId/collection', element: <PublicCollectionPage /> },
          { path: 'players/:playerId/collection/:waifuId', element: <PublicWaifumonDetailPage /> },
          { path: 'guide', element: <GuidePage /> },
          { path: 'settings', element: <SettingsPage /> },

          { path: 'achievements', element: <AchievementsPage /> },
          { path: 'leaderboards', element: <LeaderboardsPage /> },

          // Reserved slots — see §25.12.
          {
            path: 'events',
            element: comingSoon(
              'Events',
              'Limited-time hunts, seasonal species and campaigns.',
              CalendarDays,
              'Event content exists in the data model but has no player-facing surface yet.',
            ),
          },
          // `/friends` was the reserved placeholder for this. It now redirects
          // to the real destination so an old bookmark or link still lands
          // somewhere useful rather than on the not-found page.
          { path: 'friends', element: <Navigate to="/players" replace /> },

          // Admin — World Encounters: one section with its own sub-navigation
          // (Encounters · Chains · Vendors · Settings · Import / Export).
          // Nested `<RequirePortalPermission>` is a UX affordance; the API
          // independently re-checks every request.
          {
            path: 'admin/encounters',
            element: (
              <RequirePortalPermission permission="admin.access">
                <WorldEncountersLayout />
              </RequirePortalPermission>
            ),
            children: [
              { index: true, element: <AdminEncountersListPage /> },
              {
                path: 'new',
                element: (
                  <RequirePortalPermission permission="encounters.write">
                    <AdminEncounterEditorPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: 'chains',
                element: (
                  <RequirePortalPermission permission="encounters.read">
                    <EncounterChainsPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: 'settings',
                element: (
                  <RequirePortalPermission permission="encounters.read">
                    <EncounterSettingsPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: 'import-export',
                element: (
                  <RequirePortalPermission permission="encounters.read">
                    <ImportExportPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: 'vendors',
                element: (
                  <RequirePortalPermission permission="encounters.read">
                    <VendorsListPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: 'vendors/new',
                element: (
                  <RequirePortalPermission permission="encounters.write">
                    <VendorEditorPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: 'vendors/:vendorKey',
                element: (
                  <RequirePortalPermission permission="encounters.read">
                    <VendorEditorPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: ':id',
                element: (
                  <RequirePortalPermission permission="encounters.read">
                    <AdminEncounterEditorPage />
                  </RequirePortalPermission>
                ),
              },
              {
                path: ':id/preview',
                element: (
                  <RequirePortalPermission permission="encounters.read">
                    <AdminEncounterPreviewPage />
                  </RequirePortalPermission>
                ),
              },
            ],
          },

          // Admin — Reward Tables. The API re-checks every request.
          {
            path: 'admin/reward-tables',
            element: (
              <RequirePortalPermission permission="rewards.read">
                <RewardTablesListPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/reward-tables/:kind/new',
            element: (
              <RequirePortalPermission permission="rewards.write">
                <RewardTableEditorPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/reward-tables/:kind/:id',
            element: (
              <RequirePortalPermission permission="rewards.read">
                <RewardTableEditorPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Dungeons. The API re-checks every request.
          {
            path: 'admin/dungeons',
            element: (
              <RequirePortalPermission permission="dungeons.read">
                <DungeonsListPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/dungeons/preview',
            element: (
              <RequirePortalPermission permission="dungeons.read">
                <Navigate to="/admin/dungeons" replace />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/dungeons/new',
            element: (
              <RequirePortalPermission permission="dungeons.write">
                <DungeonCreatePage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/dungeons/waifumon-pools',
            element: <RequirePortalPermission permission="dungeons.read"><SharedPoolsPage /></RequirePortalPermission>,
          },
          {
            path: 'admin/dungeons/waifumon-pools/:key',
            element: <RequirePortalPermission permission="dungeons.read"><SharedPoolsPage /></RequirePortalPermission>,
          },
          {
            path: 'admin/dungeons/scene-sprites',
            element: <RequirePortalPermission permission="dungeons.read"><SceneSpritesPage /></RequirePortalPermission>,
          },
          {
            path: 'admin/dungeons/loot',
            element: (
              <RequirePortalPermission permission="dungeons.read">
                <LootTablesListPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/dungeons/loot/new',
            element: (
              <RequirePortalPermission permission="dungeons.write">
                <LootTableEditorPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/dungeons/loot/:key',
            element: (
              <RequirePortalPermission permission="dungeons.read">
                <LootTableEditorPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/dungeons/definitions/:key',
            element: (
              <RequirePortalPermission permission="dungeons.read">
                <DungeonZoneEditorPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/dungeons/zones/:key',
            element: (
              <RequirePortalPermission permission="dungeons.read">
                <DungeonZoneEditorPage />
              </RequirePortalPermission>
            ),
          },

          // Enemy artwork used to be its own page under Dungeons. It is part of
          // the enemy editor now; the old path still lands somewhere useful.
          { path: 'admin/dungeons/enemies', element: <Navigate to="/admin/enemies" replace /> },

          // Admin — Enemies. The API re-checks every request.
          {
            path: 'admin/enemies',
            element: (
              <RequirePortalPermission permission="enemies.read">
                <EnemiesListPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/enemies/new',
            element: (
              <RequirePortalPermission permission="enemies.write">
                <EnemyCreatePage />
              </RequirePortalPermission>
            ),
          },
          // A package import (CP-3); declared before `:key`, and `import` is a reserved enemy key.
          {
            path: 'admin/enemies/import',
            element: (
              <RequirePortalPermission permission="enemies.write">
                <EnemyImportPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/enemies/:key',
            element: (
              <RequirePortalPermission permission="enemies.read">
                <EnemyEditorPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Equipment Catalogue. The API re-checks every request; the
          // editor is read-only without `equipment.write`. `new` and `import`
          // are declared before `:key`, so neither is read as a key.
          {
            path: 'admin/equipment',
            element: (
              <RequirePortalPermission permission="equipment.read">
                <EquipmentCataloguePage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/equipment/new',
            element: (
              <RequirePortalPermission permission="equipment.write">
                <EquipmentCreatePage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/equipment/import',
            element: (
              <RequirePortalPermission permission="equipment.write">
                <EquipmentImportPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/equipment/rarity-rules',
            element: <EquipmentRarityRulesPage />,
          },
          {
            path: 'admin/equipment/affix-libraries',
            element: <AffixLibrariesPage />,
          },
          {
            path: 'admin/equipment/affix-libraries/new',
            element: <AffixLibraryCreatePage />,
          },
          {
            path: 'admin/equipment/affix-libraries/import',
            element: <AffixLibraryImportPage />,
          },
          {
            path: 'admin/equipment/affix-libraries/:libraryKey',
            element: <AffixLibraryEditorPage />,
          },
          {
            path: 'admin/equipment/:key',
            element: (
              <RequirePortalPermission permission="equipment.read">
                <EquipmentEditorPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Region Pools. The API re-checks every request; the editor is
          // read-only without `regions.write`, and publishing needs `regions.publish`.
          {
            path: 'admin/region-pools',
            element: (
              <RequirePortalPermission permission="regions.read">
                <RegionPoolsListPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/region-pools/:regionId',
            element: (
              <RequirePortalPermission permission="regions.read">
                <RegionPoolEditorPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Boss Management. The API re-checks every request. `new` and
          // `activity` are reserved ids on the server, so neither shadows a boss.
          {
            path: 'admin/bosses',
            element: (
              <RequirePortalPermission permission="bosses.read">
                <BossesListPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/bosses/new',
            element: (
              <RequirePortalPermission permission="bosses.write">
                <BossEditorPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/bosses/activity',
            element: (
              <RequirePortalPermission permission="bosses.read">
                <BossActivityPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/bosses/:id',
            element: (
              <RequirePortalPermission permission="bosses.read">
                <BossEditorPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Artwork Assets (uploads). The API re-checks every request.
          {
            path: 'admin/artwork',
            element: (
              <RequirePortalPermission permission="artwork.read">
                <ArtworkAssetsPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Result Presentations. The API re-checks every request.
          {
            path: 'admin/result-presentations',
            element: (
              <RequirePortalPermission permission="presentations.read">
                <ResultPresentationsPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Waifumon Gallery. The API re-checks every request, images included.
          {
            path: 'admin/gallery',
            element: (
              <RequirePortalPermission permission="gallery.read">
                <AdminGalleryPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/gallery/:slug',
            element: (
              <RequirePortalPermission permission="gallery.read">
                <AdminGallerySpeciesPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — System Metrics. Owner-only by permission; the API re-checks
          // every poll.
          {
            path: 'admin/system',
            element: (
              <RequirePortalPermission permission="system.metrics.read">
                <SystemMetricsPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Load Testing. Owner-only; the API re-checks, and on a
          // deployment without LOAD_TESTING_ENABLED its routes do not exist.
          {
            path: 'admin/load-testing',
            element: (
              <RequirePortalPermission permission="system.loadtest.run">
                <LoadTestingPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Staging Test Controls. The API re-checks every request, and
          // on a deployment without the flag its routes do not exist.
          {
            path: 'admin/test-controls',
            element: (
              <RequirePortalPermission permission="players.testcontrols">
                <TestControlsPickerPage />
              </RequirePortalPermission>
            ),
          },
          {
            path: 'admin/test-controls/:playerId',
            element: (
              <RequirePortalPermission permission="players.testcontrols">
                <TestControlsPlayerPage />
              </RequirePortalPermission>
            ),
          },

          // Admin — Role Access. Owner-only, by virtue of the permission.
          {
            path: 'admin/access',
            element: (
              <RequirePortalPermission permission="admin.roles.manage">
                <AdminRoleAccessPage />
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
