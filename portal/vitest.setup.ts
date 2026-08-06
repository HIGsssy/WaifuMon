/**
 * Test environment setup.
 *
 * `onUnhandledRequest: 'error'` is deliberate: a request the handlers do not
 * describe means either a page called an endpoint nobody mocked, or the Portal
 * reached somewhere it should not. Both are failures worth surfacing (§24.3).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './msw/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
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
