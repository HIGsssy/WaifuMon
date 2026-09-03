/**
 * `AppShell` — the layout every route renders inside (plan §7, §9).
 *
 * The shell is painted the instant the URL changes, before any query resolves.
 * That is what §14 means by "route navigation renders the destination shell as
 * soon as the URL changes; individual cards fill in as their queries resolve" —
 * there is no full-page loading state anywhere in the Portal.
 *
 * Adding a page is one folder in `features/` plus one route entry; this file is
 * never touched (§24 subjective criteria).
 */
import { Suspense } from 'react';
import { Outlet } from 'react-router';

import { Footer } from '@/components/layout/Footer';
import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { Skeleton } from '@/components/ui/skeleton';

/** Shown only while a lazy route chunk is in flight — milliseconds, not a page. */
function RouteChunkFallback() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      {/*
        Skip link: the sidebar is twelve focus stops, and a keyboard user should
        not have to walk them on every page. Visually hidden until focused,
        which is the point — it appears exactly when it is useful.
      */}
      <a
        href="#main"
        className="sr-only z-50 focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:rounded-lg focus:border focus:border-border focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm focus:text-ink"
      >
        Skip to main content
      </a>
      <Header />
      <div className="flex flex-1">
        <Sidebar />
        <main
          id="main"
          // Focusable only as the skip link's target, never as a tab stop.
          tabIndex={-1}
          className="min-w-0 flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8 lg:px-10"
        >
          <div className="mx-auto w-full max-w-[88rem]">
            <Suspense fallback={<RouteChunkFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}
