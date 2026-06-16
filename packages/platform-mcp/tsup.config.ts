import { defineConfig } from 'tsup';

// Two outputs:
//   dist/index.js       — library entrypoint (re-exports), no shebang
//   dist/index-stdio.js — stdio CLI entrypoint, shebang-prefixed
//
// tsup applies the global `banner` option to every entry, so we split the CLI
// into its own config to avoid prepending the shebang to the library bundle
// (where it would break `import` from Node).
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node24',
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    shims: false,
  },
  {
    entry: { 'index-stdio': 'src/index-stdio.ts' },
    format: ['esm'],
    target: 'node24',
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    shims: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
