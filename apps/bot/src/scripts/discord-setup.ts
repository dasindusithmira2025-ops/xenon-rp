import { parseArgs } from 'node:util';

import { prisma, type DiscordProvisionRun } from '@xenon/database';
import { createRun, planItems, type RunMode } from '@xenon/discord/provisioning';

import { executeProvisionRun } from '../discord/provisioning/runner';
import { logger } from '../runtime';

import { cliActor, connectCli, guildId, print } from './cli-support';

/**
 * pnpm discord:setup:<plan|apply|status|repair|validate|cleanup>
 *
 * The same engine and run table as `/xenon setup` and the Control Center.
 * Mutations take the id of a plan you have read plus the typed phrase:
 *
 *   pnpm discord:setup:plan
 *   pnpm discord:setup:apply -- --plan <runId> --confirm "PROVISION XENON"
 *   pnpm discord:setup:repair -- --plan <runId> --confirm "PROVISION XENON" [--soft]
 *   pnpm discord:setup:cleanup -- --run <failedRunId> --confirm "DELETE XENON RESOURCES" [--force]
 *
 * Point DISCORD_GUILD_ID at a development server first.
 */

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: 'string' },
    run: { type: 'string' },
    confirm: { type: 'string' },
    soft: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'ack-established': { type: 'boolean', default: false },
  },
});

function report(run: DiscordProvisionRun): void {
  print(`\n${run.mode} ${run.id} → ${run.status}`);
  if (run.failure !== null) print(`  ${run.failure}`);
  const groups = new Map<string, string[]>();
  for (const item of planItems(run.plannedChanges)) {
    if (item.kind === 'UNCHANGED') continue;
    const lines = groups.get(item.kind) ?? [];
    lines.push(`  ${item.label.padEnd(34)} ${item.summary}`);
    groups.set(item.kind, lines);
  }
  for (const [kind, lines] of groups) {
    print(`\n${kind} (${String(lines.length)})`);
    for (const line of lines) print(line);
  }
  const planned = (run.plannedChanges ?? {}) as {
    diagnostics?: { severity: string; message: string }[];
    profile?: string;
  };
  const important = (planned.diagnostics ?? []).filter(
    (d) => d.severity === 'critical' || d.severity === 'error' || d.severity === 'warning',
  );
  if (important.length > 0) {
    print('\nDiagnostics');
    for (const diagnostic of important) print(`  [${diagnostic.severity}] ${diagnostic.message}`);
  }
  if (run.summary !== null) print(`\nSummary ${JSON.stringify(run.summary)}`);
  if (run.mode === 'PLAN' && run.status === 'SUCCEEDED') {
    print(
      `\nReview it, then: pnpm discord:setup:apply -- --plan ${run.id} --confirm "PROVISION XENON"${planned.profile === 'ESTABLISHED' ? ' --ack-established' : ''}`,
    );
  }
}

async function main(): Promise<void> {
  const command = positionals[0] ?? 'plan';
  const modes: Record<string, RunMode> = {
    plan: 'PLAN',
    status: 'STATUS',
    validate: 'VALIDATE',
    apply: 'APPLY',
    repair: 'REPAIR',
    cleanup: 'CLEANUP',
  };
  const mode = modes[command];
  if (mode === undefined)
    throw new Error(
      `Unknown command ${command}. Use plan, apply, status, repair, validate or cleanup.`,
    );

  const client = await connectCli();
  try {
    const needsPlan = mode === 'APPLY' || mode === 'REPAIR';
    if (needsPlan && values.plan === undefined) {
      // Never a blind apply: produce the plan and say how to approve it.
      const run = await createRun(prisma, cliActor(), { guildId: guildId(), mode: 'PLAN' });
      report(await executeProvisionRun(client, run.id));
      return;
    }
    const basedOnRunId = mode === 'CLEANUP' ? values.run : values.plan;
    const run = await createRun(prisma, cliActor(), {
      guildId: guildId(),
      mode,
      ...(basedOnRunId === undefined ? {} : { basedOnRunId }),
      ...(values.confirm === undefined ? {} : { confirmation: values.confirm }),
      acknowledgeEstablished: values['ack-established'],
      includeSoft: values.soft,
      force: values.force,
    });
    report(await executeProvisionRun(client, run.id));
  } finally {
    await client.destroy();
    await prisma.$disconnect();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    logger.error({ err: error }, 'Discord setup failed');
    process.exit(1);
  },
);
