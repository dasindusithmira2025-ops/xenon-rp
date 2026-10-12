import * as esbuild from 'esbuild';

import { buildOptions } from './build-options.mjs';

/**
 * Bundle Xenon Guardian for production.
 *
 * `tsc` cannot build this on its own. Workspace packages ship TypeScript
 * sources rather than compiled output, so a plain emit would produce a `dist`
 * that imports `@xenon/discord` and resolves it to a `.ts` file at runtime.
 * esbuild bundles those sources into the output instead.
 */
const result = await esbuild.build({
  ...buildOptions,
  entryPoints: ['src/main.ts', 'src/scripts/register-commands.ts', 'src/scripts/discord-assets.ts'],
  outdir: 'dist',
  sourcemap: true,
  // Readable stack traces matter more than a few kilobytes in a long-running
  // service that logs its own failures.
  minify: false,
  logLevel: 'info',
});

if (result.errors.length > 0) process.exit(1);
