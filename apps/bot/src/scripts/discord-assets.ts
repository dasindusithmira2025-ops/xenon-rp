import { parseArgs } from 'node:util';

import { prisma } from '@xenon/database';
import { generateBrandEmojis, importAssetZip, scanManifest } from '@xenon/discord/assets';
import { createRun, PROVISION_PHRASE } from '@xenon/discord/provisioning';

import { loadProvisioningContext } from '../discord/provisioning/context';
import { executeProvisionRun } from '../discord/provisioning/runner';
import { logger } from '../runtime';

import { cliActor, connectCli, guildId, operatorPath, print } from './cli-support';

/**
 * pnpm discord:assets:<scan|import|generate|sync>
 *
 *   pnpm discord:assets:scan
 *   pnpm discord:assets:import ./assets/discord/imports/xenon-pack.zip [--enable]
 *   pnpm discord:assets:generate
 *   pnpm discord:assets:sync -- --confirm "PROVISION XENON"
 *
 * Import never touches Discord: it validates the pack, writes normalised
 * files and records them (disabled by default) in the manifest. Sync uploads
 * enabled assets through the normal plan and apply, capacity permitting.
 */

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    enable: { type: 'boolean', default: false },
    confirm: { type: 'string' },
  },
});

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
        throw new Error('Usage: discord:assets:import <pack.zip> [--enable]');
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

    case 'sync': {
      const client = await connectCli();
      try {
        const guild = await client.guilds.fetch(guildId());
        const plan = await createRun(prisma, cliActor(), { guildId: guild.id, mode: 'PLAN' });
        const planned = await executeProvisionRun(client, plan.id);
        const context = await loadProvisioningContext(guild);
        const assetKeys = new Set(context.state.assets.map((asset) => asset.key));
        const pending = context.plan.items.filter(
          (item) => item.phase === 'ASSETS' && item.kind !== 'UNCHANGED',
        );
        for (const item of pending)
          print(`  ${item.kind.padEnd(16)} ${item.label} ${item.summary}`);
        if (values.confirm !== PROVISION_PHRASE) {
          print(`\nNothing uploaded. Re-run with --confirm "${PROVISION_PHRASE}" to upload.`);
          return;
        }
        const run = await createRun(prisma, cliActor(), {
          guildId: guild.id,
          mode: 'APPLY',
          basedOnRunId: planned.id,
          confirmation: values.confirm,
          acknowledgeEstablished: true,
        });
        const result = await executeProvisionRun(client, run.id, { onlyKeys: assetKeys });
        print(`\n${result.status}: ${JSON.stringify(result.summary)}`);
      } finally {
        await client.destroy();
      }
      return;
    }

    default:
      throw new Error('Use scan, import <zip>, generate or sync.');
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Discord assets command failed');
    process.exit(1);
  });
