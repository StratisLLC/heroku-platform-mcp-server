import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index-stdio.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // index-stdio.ts begins with a `#!/usr/bin/env node` shebang; tsup preserves
  // it as-is so the produced dist/index-stdio.js is directly executable when
  // chmod +x'd (the workspace's tsup runs on a Unix filesystem; on Windows the
  // shebang is ignored and the file is invoked via `node dist/index-stdio.js`).
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
});
