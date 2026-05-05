// Vitest is the unit-test runner for the web package; Playwright owns
// `e2e/`. Exclude that directory so vitest doesn't try to import
// `@playwright/test` as if it were vitest.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
