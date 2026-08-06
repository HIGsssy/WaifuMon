/**
 * The global header (plan §21 Phase 0): wordmark, dev-mode marker, theme
 * toggle, and the mobile navigation trigger.
 *
 * Kept deliberately thin — §17 wants the chrome quiet enough that the artwork
 * on the page below it is the loudest thing on screen.
 */
import { Menu, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useTheme } from '@/app/useTheme';
import { useSession } from '@/auth/useSession';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DevModeChip } from './DevModeBanner';
import { NavList } from './NavList';

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const nextLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={nextLabel}
      title={nextLabel}
    >
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  );
}

export function Header() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { session } = useSession();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-canvas/85 backdrop-blur-md">
      <div className="flex h-14 items-center gap-2 px-4 sm:h-16 sm:px-6">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-4">
            <SheetTitle className="mb-5 px-3 font-display text-lg text-ink">Waifumon</SheetTitle>
            <NavList onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>

        <Link
          to="/dashboard"
          className="flex items-center gap-2.5 rounded-md px-1 py-1 font-display text-lg tracking-tight text-ink"
        >
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--accent)]"
          />
          Waifumon
        </Link>

        <DevModeChip className="ml-1" />

        <div className="ml-auto flex items-center gap-1.5">
          {session && (
            <span className="hidden text-sm text-ink-muted sm:inline" title="Acting player">
              {session.displayName}
            </span>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
