import { defineConfig } from 'vitest/config';

// Integration tests live in test/**/*.integration.test.ts and are excluded
// from the default `vitest run` so unit-test runs stay hermetic. The
// `test:integration` script sets VITEST_INTEGRATION=1 to drop that exclude.
const includeIntegration = process.env.VITEST_INTEGRATION === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: includeIntegration
      ? ['**/node_modules/**', '**/dist/**']
      : ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
    },
  },
});
