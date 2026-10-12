import { readFileSync } from 'node:fs';

/**
 * esbuild options shared by `build.mjs` and the bundle isolation test, so the
 * test inspects exactly the module graph production ships.
 *
 * Third-party dependencies stay external: they are installed by pnpm on the
 * deployment target. Sharp is also an explicit runtime dependency because
 * bundled workspace code imports it from the output directory. Its
 * platform-specific @img packages must remain normal pnpm dependencies too.
 * The externals list is derived from package.json so it cannot drift.
 */
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export const external = [
  ...Object.keys(manifest.dependencies ?? {}).filter((name) => !name.startsWith('@xenon/')),
  '@img/*',
];

export const buildOptions = {
  bundle: true,
  platform: 'node',
  // Matches the engines field; no transpilation down to anything older.
  target: 'node24',
  format: 'esm',
  external,
  banner: {
    // Bundled CommonJS dependencies expect these to exist in an ESM output.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
};
