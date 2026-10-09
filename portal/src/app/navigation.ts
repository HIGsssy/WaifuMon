/**
 * Primary navigation (plan §7).
 *
 * All thirteen entries are declared here, including the ones that are not built
 * yet. The "Coming Soon" entries render as inert rows on purpose: they reserve
 * the visual space now so the sidebar does not have to be redesigned when
 * Achievements and Events land (§25.12).
 *
 * **Players, not Friends.** The reserved "Friends" slot has become a real
 * "Players" destination. The rename is the feature: there is no friendship in
 * Waifumon and none is planned for this phase — no requests, no accepting, no
 * mutual state. What exists is the guild you are already in, so the entry says
 * what it lists.
 *
 * The order is the plan's order, and the divider position is part of it.
 */
import {
  Backpack,
  BookOpen,
  CalendarDays,
  Compass,
  Crown,
  FlaskConical,
  Gauge,
  Heart,
  Images,
  LayoutDashboard,
  LibraryBig,
  Map as MapIcon,
  Medal,
  Settings,
  Shield,
  Sparkles,
  Store,
  Trophy,
  User,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Rendered but non-interactive, with a "Coming Soon" chip. */
  comingSoon?: boolean;
  /** Draws a divider above this entry. */
  dividerBefore?: boolean;
  /** Only rendered when the current session holds this permission. */
  requiresPermission?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/collection', label: 'Collection', icon: LibraryBig },
  { to: '/buddy', label: 'Buddy', icon: Heart },
  { to: '/expeditions', label: 'Expeditions', icon: MapIcon },
  { to: '/inventory', label: 'Inventory', icon: Backpack },
  { to: '/shop', label: 'Shop', icon: Store },
  { to: '/encyclopedia', label: 'Encyclopedia', icon: BookOpen },
  { to: '/guide', label: 'Guide', icon: Compass },
  { to: '/profile', label: 'Profile', icon: User },
  { to: '/players', label: 'Players', icon: Users },
  {
    to: '/admin/encounters',
    label: 'Admin — World Encounters',
    icon: Shield,
    dividerBefore: true,
    requiresPermission: 'admin.access',
  },
  {
    to: '/admin/result-presentations',
    label: 'Admin — Result Presentations',
    icon: Sparkles,
    requiresPermission: 'presentations.read',
  },
  {
    to: '/admin/gallery',
    label: 'Admin — Waifumon Gallery',
    icon: Images,
    requiresPermission: 'gallery.read',
  },
  {
    // Boss definitions, their availability schedules, and live boss activity.
    to: '/admin/bosses',
    label: 'Admin — Boss Management',
    icon: Crown,
    requiresPermission: 'bosses.read',
  },
  {
    // Owner-only: `system.metrics.read` is not grantable, so a delegated admin
    // never sees this entry. Live process and host telemetry, not game data.
    to: '/admin/system',
    label: 'Admin — System Metrics',
    icon: Gauge,
    requiresPermission: 'system.metrics.read',
  },
  {
    // Owner-only, and only on a deployment with LOAD_TESTING_ENABLED: the
    // server issues `system.loadtest.run` to nobody otherwise, so production
    // never shows this entry. Hiding it is a courtesy — the API is the lock.
    to: '/admin/load-testing',
    label: 'Admin — Load Testing',
    icon: FlaskConical,
    requiresPermission: 'system.loadtest.run',
  },
  {
    // Owners and granted admins — but only on a non-production deployment with
    // ENABLE_TEST_ADMIN_CONTROLS: the server issues `players.testcontrols` to
    // nobody otherwise, so production never shows this entry.
    to: '/admin/test-controls',
    label: 'Admin — Staging Test Controls',
    icon: Wrench,
    requiresPermission: 'players.testcontrols',
  },
  {
    // Owner-only: `admin.roles.manage` is the one permission that cannot be
    // delegated to a role, so a granted admin never sees this entry.
    to: '/admin/access',
    label: 'Admin — Role Access',
    icon: Shield,
    requiresPermission: 'admin.roles.manage',
  },
  {
    to: '/achievements',
    label: 'Achievements',
    icon: Trophy,
    dividerBefore: true,
  },
  { to: '/leaderboards', label: 'Leaderboards', icon: Medal },
  { to: '/events', label: 'Events', icon: CalendarDays, comingSoon: true },
  { to: '/settings', label: 'Settings', icon: Settings },
];
