import { defineConfig } from 'vitest/config';

// API tests share a live Postgres schema, so they must not run in parallel
// with each other. Run them sequentially via a single fork.
export default defineConfig({
  test: {
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
