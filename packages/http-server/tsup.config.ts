import { defineConfig } from 'tsup';

// Library + CLI binary outputs from one tsup invocation. The library bundle
// has no shebang (so Node won't choke on `import` of it); the CLI gets one
// so it can be invoked as `./dist/bin.js`.
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    shims: false,
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    shims: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
