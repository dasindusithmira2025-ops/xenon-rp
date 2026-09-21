import { readFile } from 'node:fs/promises';

import * as esbuild from 'esbuild';

/**
 * Bundle the bot for production.
 *
 * `tsc` cannot build this on its own. Workspace packages ship TypeScript
 * sources rather than compiled output, so a plain emit would produce a `dist`
 * that imports `@xenon/domain` and resolves it to a `.ts` file at runtime.
 * esbuild bundles those sources into the output instead.
 *
 * Third-party dependencies stay external: they are already in `node_modules`
 * on the deployment target, several ship native binaries (Prisma's query
 * engine, sharp), and bundling them would multiply the build time for no
 * benefit. The externals list is derived from package.json so it cannot drift.
 */
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

const external = Object.keys(manifest.dependencies ?? {}).filter(
  (name) => !name.startsWith('@xenon/'),
);

const result = await esbuild.build({
  entryPoints: ['src/main.ts', 'src/scripts/register-commands.ts'],
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
