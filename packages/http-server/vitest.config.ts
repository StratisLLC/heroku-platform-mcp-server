import { defineConfig } from 'vitest/config';

// Integration tests (test/integration/*) hit a real Postgres and share the
// same `DROP TABLE … CASCADE` reset across files. Running them in parallel
// produces deadlocks. Run files serially in a single fork so DDL doesn't
// race; unit tests still benefit from parallel collection within each file.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
  },
});
