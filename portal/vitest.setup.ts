/**
 * Test environment setup.
 *
 * `onUnhandledRequest: 'error'` is deliberate: a request the handlers do not
 * describe means either a page called an endpoint nobody mocked, or the Portal
 * reached somewhere it should not. Both are failures worth surfacing (§24.3).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import { DEV_IDENTITY_STORAGE_KEY } from './src/auth/dev/devIdentity';
import * as fixtures from './msw/fixtures';
import { server } from './msw/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

/**
 * Vitest runs with `import.meta.env.DEV === true`, so the session provider is
 * the developer-login one and resolves from `localStorage`. Seeding the pair is
 * this suite's "already signed in" — the state every page test assumes, and the
 * equivalent of what `VITE_DEFAULT_PLAYER_ID` used to do for it.
 *
 * A test that wants the login screen clears it first (`localStorage.clear()`)
 * before rendering.
 */
beforeEach(() => {
  localStorage.setItem(
    DEV_IDENTITY_STORAGE_KEY,
    JSON.stringify({
      discordUserId: fixtures.DISCORD_USER_ID,
      discordGuildId: fixtures.DISCORD_GUILD_ID,
    }),
  );
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  // The theme provider writes to `localStorage` and to the <html> class. Both
  // outlive `cleanup()`, so reset them or a Settings test would decide what
  // theme every later test starts in.
  localStorage.clear();
  document.documentElement.className = '';
});

afterAll(() => server.close());

// jsdom implements neither, and Radix + the theme provider both read them.
// Deliberately plain functions rather than `vi.fn()`: `restoreMocks: true`
// would reset a mock's implementation between tests and leave `matchMedia`
// returning `undefined`.
if (!window.matchMedia) {
  const noop = () => {};
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Radix uses these for popovers and dialogs; jsdom ships neither.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
