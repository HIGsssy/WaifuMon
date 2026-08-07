/**
 * Portal entry point.
 *
 * The error boundary wraps the router (plan §19), so a render failure anywhere
 * — including inside a provider — still produces the friendly fallback rather
 * than a blank page.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { Providers } from './providers';
import { router } from './router';

import '@/styles/globals.css';

const container = document.getElementById('root');
if (!container) throw new Error('Portal root element is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <Providers>
        <RouterProvider router={router} />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
);
