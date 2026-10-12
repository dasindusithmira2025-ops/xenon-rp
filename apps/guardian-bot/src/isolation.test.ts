import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { buildOptions } from '../build-options.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Platform modules Guardian must never load. If any of these reaches the
 * production bundle, Guardian could no longer start (or keep protecting the
 * server) while the database, Redis, Core API or FiveM stack is down.
 */
const FORBIDDEN = [
  /(^|[\\/])@xenon[\\/]database\b|packages[\\/]database[\\/]/,
  /(^|[\\/]|@)prisma\b/,
  /(^|[\\/])bullmq\b/,
  /(^|[\\/])ioredis\b/,
  /(^|[\\/])@xenon[\\/]jobs\b|packages[\\/]jobs[\\/]/,
  /(^|[\\/])@xenon[\\/]fivem\b|packages[\\/]fivem[\\/]/,
  /(^|[\\/])@xenon[\\/]applications\b|packages[\\/]applications[\\/]/,
];

async function bundleGraph(entry: string): Promise<{ inputs: string[]; imports: string[] }> {
  const result = await build({
    ...buildOptions,
    absWorkingDir: root,
    entryPoints: [entry],
    outdir: 'dist-isolation-test',
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  const metafile: Metafile = result.metafile;
  const inputs = Object.keys(metafile.inputs);
  const imports = [
    ...Object.values(metafile.inputs).flatMap((input) => input.imports.map((edge) => edge.path)),
    ...Object.values(metafile.outputs).flatMap((output) => output.imports.map((edge) => edge.path)),
  ];
  return { inputs, imports };
}

describe('Guardian bundle isolation', () => {
  for (const entry of [
    'src/main.ts',
    'src/scripts/register-commands.ts',
    'src/scripts/discord-assets.ts',
  ]) {
    it(`${entry} pulls in no database, Redis, queue, FiveM or application modules`, async () => {
      const { inputs, imports } = await bundleGraph(entry);
      // The graph really was built from this entry, not an empty stub.
      expect(inputs).toContain(entry);
      const offenders = [...inputs, ...imports].filter((path) =>
        FORBIDDEN.some((pattern) => pattern.test(path)),
      );
      expect([...new Set(offenders)]).toEqual([]);
    }, 60_000);
  }
});
