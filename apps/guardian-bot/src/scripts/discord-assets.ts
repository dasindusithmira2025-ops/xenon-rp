import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { generateBrandEmojis, importAssetZip, scanManifest } from '@xenon/discord/assets';
import { createLogger } from '@xenon/logger';

/**
 * pnpm guardian:assets:<scan|import|generate>
 *
 *   pnpm guardian:assets:scan
 *   pnpm guardian:assets:import ./assets/discord/imports/xenon-pack.zip [--enable]
 *   pnpm guardian:assets:generate
 *
 * Filesystem only: nothing here touches Discord or needs Guardian credentials.
 * Import validates the pack, writes normalised files and records them
 * (disabled by default) in the manifest. Enabled assets are uploaded by
 * Guardian's `/xenon setup apply`.
 */

const logger = createLogger({ service: 'guardian', level: 'info', pretty: false });

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    enable: { type: 'boolean', default: false },
  },
});

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Paths given on the command line are relative to where the operator typed
 * them, not to apps/guardian-bot where pnpm runs the script.
 */
function operatorPath(path: string): string {
  // pnpm records the invoking directory here; it is not configuration.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const base = process.env.INIT_CWD ?? process.cwd();
  return isAbsolute(path) ? path : resolve(base, path);
}

async function main(): Promise<void> {
  const [command = '', argument] = positionals;

  switch (command) {
    case 'scan': {
      const result = await scanManifest();
      print(`${String(result.ok.length)} assets valid`);
      for (const problem of result.problems) print(`  ✗ ${problem.key}: ${problem.problem}`);
      if (result.problems.length > 0) process.exitCode = 1;
      return;
    }

    case 'import': {
      if (argument === undefined)
        throw new Error('Usage: guardian:assets:import <pack.zip> [--enable]');
      const report = await importAssetZip(operatorPath(argument), { enable: values.enable });
      print(
        `Pack ${report.pack}: ${String(report.added.length)} added${values.enable ? '' : ' (disabled until curated)'}`,
      );
      for (const entry of report.added)
        print(`  + ${entry.key}${entry.animated ? ' (animated)' : ''}`);
      for (const entry of report.duplicates) print(`  = ${entry.path} duplicates ${entry.of}`);
      for (const entry of report.renamed) print(`  ~ ${entry.path} renamed to ${entry.name}`);
      for (const entry of report.review) print(`  ? ${entry.path}: ${entry.reason}`);
      for (const entry of report.rejected) print(`  ✗ ${entry.path}: ${entry.reason}`);
      return;
    }

    case 'generate': {
      const keys = await generateBrandEmojis();
      print(`Rendered ${String(keys.length)} Xenon emoji: ${keys.join(', ')}`);
      return;
    }

    default:
      throw new Error('Use scan, import <zip> or generate.');
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Guardian assets command failed');
    process.exit(1);
  });
