import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * Link must never carry a datastore client. Building the production entry
 * points with the same externals as `build.mjs` and inspecting the metafile
 * proves no Prisma, Redis or BullMQ module is reachable from Link's code, even
 * through a transitive workspace import.
 */

const FORBIDDEN = [
  /(^|[\\/])@xenon[\\/]database/,
  /(^|[\\/])packages[\\/]database[\\/]/,
  /(^|[\\/])packages[\\/]jobs[\\/]/,
  /(^|[\\/])packages[\\/]domain[\\/]/,
  /(^|[\\/])packages[\\/]applications[\\/]/,
  /@prisma[\\/]/,
  /(^|[\\/])bullmq([\\/]|$)/,
  /(^|[\\/])ioredis([\\/]|$)/,
  /(^|[\\/])@xenon[\\/]jobs/,
];

describe('link bundle isolation', () => {
  it('bundles no database, Redis, BullMQ or job-queue module', async () => {
    const root = new URL('..', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const external = Object.keys(manifest.dependencies).filter(
      (name) => !name.startsWith('@xenon/'),
    );

    const result = await build({
      absWorkingDir: fileURLToPath(root),
      entryPoints: ['src/main.ts', 'src/scripts/register-commands.ts'],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outdir: 'dist-isolation',
      write: false,
      metafile: true,
      logLevel: 'silent',
      external,
    });

    const inputs = Object.keys(result.metafile.inputs);
    const imports = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.map((entry) => entry.path),
    );
    expect(inputs.length).toBeGreaterThan(5);
    for (const path of [...inputs, ...imports]) {
      for (const pattern of FORBIDDEN) expect(path, path).not.toMatch(pattern);
    }
    for (const name of ['@xenon/database', '@xenon/jobs', '@xenon/domain', 'bullmq', 'ioredis']) {
      expect(manifest.dependencies).not.toHaveProperty(name);
    }
  }, 60_000);
});
