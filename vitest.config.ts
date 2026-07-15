import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // DB test files each get their own database; run files in parallel is fine,
    // but keep a sane bound so a laptop Docker daemon isn't overwhelmed.
    maxConcurrency: 5,
  },
});
