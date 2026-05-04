import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
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
