/**
 * Desktop sidebar (≥ lg). Below that breakpoint the same `NavList` is rendered
 * inside the header's drawer instead (plan §18).
 */
import { NavList } from './NavList';

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r border-border lg:block">
      <div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto px-3 py-6">
        <NavList />
      </div>
    </aside>
  );
}
