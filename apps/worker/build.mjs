import { readFile } from 'node:fs/promises';

import * as esbuild from 'esbuild';

/**
 * Bundle the Xenon Core API for production.
 *
 * Workspace packages ship TypeScript sources, so esbuild bundles them into the
 * output; third-party dependencies stay external and are installed by pnpm on
 * the deployment target (`pnpm deploy --prod`). The externals list is derived
 * from package.json, so every runtime dependency the bundle imports must be
 * listed there.
 */
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

const external = Object.keys(manifest.dependencies ?? {}).filter(
  (name) => !name.startsWith('@xenon/'),
);

const result = await esbuild.build({
  entryPoints: ['src/main.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  // Matches the engines field; no transpilation down to anything older.
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // Readable stack traces matter more than a few kilobytes in a long-running
  // service that logs its own failures.
  minify: false,
  external,
  logLevel: 'info',
  banner: {
    // Bundled CommonJS dependencies expect these to exist in an ESM output.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

if (result.errors.length > 0) process.exit(1);
