import * as esbuild from 'esbuild';

/**
 * Build the resource.
 *
 * CommonJS, because FiveM's server script loader expects it. Bundled into one
 * file so the resource can be copied into a server's resources directory with
 * no install step - an operator should not have to run pnpm on their game box.
 *
 * `node:crypto` stays external: it is provided by the fxserver runtime.
 */
const result = await esbuild.build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: ['node:crypto'],
  banner: {
    js: '// Built from src/. Do not edit: run `pnpm --filter @xenon/fivem-bridge build`.',
  },
  logLevel: 'info',
});

if (result.errors.length > 0) process.exit(1);
