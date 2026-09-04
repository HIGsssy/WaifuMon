/**
 * The primary navigation list, shared by the desktop sidebar and the mobile
 * drawer so the two can never drift (plan §7).
 *
 * "Coming Soon" entries render as `<span aria-disabled>` rather than links:
 * they reserve the space now, are visible to a screen reader as present but
 * unavailable, and are not focus stops that lead nowhere.
 */
import { NavLink } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { NAV_ITEMS } from '@/app/navigation';
import { useSession } from '@/auth/useSession';
import { cn } from '@/lib/cn';

const ROW = 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors sm:py-2';

export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { session } = useSession();
  const permissions = session?.permissions ?? [];
  const visible = NAV_ITEMS.filter(
    (item) => !item.requiresPermission || permissions.includes(item.requiresPermission),
  );
  return (
    <nav aria-label="Primary">
      <ul className="space-y-0.5">
        {visible.map((item) => (
          <li key={item.to}>
            {item.dividerBefore && <hr className="my-3 border-border" />}
            {item.comingSoon ? (
              <span
                aria-disabled="true"
                className={cn(ROW, 'cursor-default text-ink-subtle select-none')}
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">{item.label}</span>
                <Badge variant="outline" className="px-1.5 py-0 text-[0.625rem]">
                  Soon
                </Badge>
              </span>
            ) : (
              <NavLink
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    ROW,
                    isActive
                      ? 'bg-surface-raised font-medium text-ink'
                      : 'text-ink-muted hover:bg-surface-raised/60 hover:text-ink',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      className={cn('size-4 shrink-0', isActive && 'text-accent')}
                      aria-hidden="true"
                    />
                    <span className="flex-1">{item.label}</span>
                  </>
                )}
              </NavLink>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
