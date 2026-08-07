/**
 * Provider composition (plan §9).
 *
 * Order matters: the session provider issues an API query, so it must sit
 * inside `QueryClientProvider`. Everything else is independent.
 *
 * `SessionProvider` is aliased rather than imported by name at call sites — the
 * v2 OAuth migration (§25.14) swaps the import on this one line and no other
 * file in the Portal changes.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { DevSessionProvider as SessionProvider } from '@/auth/DevSessionProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from './ThemeProvider';
import { createQueryClient } from './queryClient';

export interface ProvidersProps {
  children: ReactNode;
  /** Tests inject a client with retries disabled; the app makes its own. */
  client?: QueryClient;
}

export function Providers({ children, client }: ProvidersProps) {
  const [fallbackClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client ?? fallbackClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={200}>
          <SessionProvider>{children}</SessionProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
