import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // Playwright E2E specs (apps/web/e2e/*.spec.ts) use the Playwright
    // runner, not Vitest. Exclude them from Vitest collection so we
    // don't try to import @playwright/test as if it were a Vitest API.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'apps/web/e2e/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        statements: 80,
        branches: 70,
      },
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/coverage/**',
        '**/*.config.{ts,js,cjs,mjs}',
        '**/*.test.{ts,tsx}',
        'tests/fixtures/**',
      ],
    },
  },
});
