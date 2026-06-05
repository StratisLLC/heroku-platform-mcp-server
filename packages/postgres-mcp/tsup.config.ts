import { defineConfig } from 'tsup';

// Single library entrypoint (re-exports). Postgres MCP ships no standalone CLI
// — it is registered into the hosted HTTP server alongside @heroku-mcp/platform.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  shims: false,
});
