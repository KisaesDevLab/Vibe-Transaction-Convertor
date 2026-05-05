import { defineConfig } from '@playwright/test';

// vibe-tx-converter is single-firm — there is no parallelism win to be had
// from running specs concurrently against the same backing API. workers=1
// also avoids the "two specs racing to register the first admin" footgun.
//
// `webServer` is intentionally OMITTED. The expectation is that the operator
// (or CI) already has the API running on PLAYWRIGHT_BASE_URL. If it isn't
// reachable, `e2e/global-setup.ts` writes a flag file and every spec calls
// `test.skip(!serverReachable, ...)` so the suite skips gracefully rather
// than failing 30s into each spec with a connection error.

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: isCI ? 1 : 0,
  reporter: 'list',
  timeout: 30_000,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4400',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
