import { setupServer } from 'msw/node';

import { handlers } from './handlers';

/** Shared across the suite; lifecycle hooks live in `vitest.setup.ts`. */
export const server = setupServer(...handlers);
