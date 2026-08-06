/**
 * Primary navigation (plan §7).
 *
 * All thirteen entries are declared here, including the four that are not built
 * yet. The "Coming Soon" entries render as inert rows on purpose: they reserve
 * the visual space now so the sidebar does not have to be redesigned when
 * Achievements, Events and Friends land (§25.12).
 *
 * The order is the plan's order, and the divider position is part of it.
 */
import {
  Backpack,
  BookOpen,
  CalendarDays,
  Compass,
  Heart,
  LayoutDashboard,
  LibraryBig,
  Settings,
  Store,
  Trophy,
  User,
  Users,
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
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/collection', label: 'Collection', icon: LibraryBig },
  { to: '/buddy', label: 'Buddy', icon: Heart },
  { to: '/inventory', label: 'Inventory', icon: Backpack },
  { to: '/shop', label: 'Shop', icon: Store },
  { to: '/encyclopedia', label: 'Encyclopedia', icon: BookOpen },
  { to: '/guide', label: 'Guide', icon: Compass },
  { to: '/profile', label: 'Profile', icon: User },
  {
    to: '/achievements',
    label: 'Achievements',
    icon: Trophy,
    comingSoon: true,
    dividerBefore: true,
  },
  { to: '/events', label: 'Events', icon: CalendarDays, comingSoon: true },
  { to: '/friends', label: 'Friends', icon: Users, comingSoon: true },
  { to: '/settings', label: 'Settings', icon: Settings },
];
