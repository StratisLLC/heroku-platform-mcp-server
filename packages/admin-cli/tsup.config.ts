import { defineConfig } from 'tsup';

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
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    target: 'node24',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    shims: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
