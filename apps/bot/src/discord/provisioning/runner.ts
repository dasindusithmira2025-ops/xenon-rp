import { prisma, type DiscordProvisionRun, type Prisma } from '@xenon/database';
import {
  type AppliedChange,
  cleanupRun,
  executePlan,
  planSignatureOf,
  type PlanResult,
  saveIntegration,
  selectExecutable,
  unapprovedChanges,
} from '@xenon/discord/provisioning';
import { recordAudit } from '@xenon/domain';
import { redis } from '@xenon/jobs';
import { type Actor, systemActor } from '@xenon/permissions';

import { logger } from '../../runtime';

import { loadProvisioningContext } from './context';
import { postRunReport } from './report';

import type { Client } from 'discord.js';

/**
 * Execute one provisioning run.
 *
 * The single entry point for every surface: the job worker (Control Center),
 * the `/xenon setup` commands and the CLI all create a run row and hand its id
 * here. State lives in Postgres - the approved plan, progress, results - so a
 * restart mid-run loses nothing but the in-flight Discord call, and the next
 * apply picks up from the registry.
 */

const LOCK_TTL_SECONDS = 30 * 60;

/** Plans are stored without bigints and with the audits trimmed to what the UI shows. */
export function serialisePlan(plan: PlanResult): Prisma.InputJsonValue {
  const { blueprintAudit, liveAudit, ...rest } = plan;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      blueprintAudit: { passed: blueprintAudit.passed, matrix: blueprintAudit.matrix },
      liveAudit: { passed: liveAudit.passed, matrix: liveAudit.matrix },
    }),
  ) as Prisma.InputJsonValue;
}

function actorOf(run: DiscordProvisionRun): Actor {
  return { ...systemActor, userId: run.actorId, label: run.actorLabel, source: run.source };
}

function auditAction(change: AppliedChange): string {
  if (change.action === 'permissions') return 'DISCORD_PERMISSION_UPDATED';
  if (change.resourceType === 'PANEL') {
    return change.action === 'created' || change.action === 'posted'
      ? 'PANEL_CREATED'
      : 'PANEL_UPDATED';
  }
  if (change.resourceType === 'EMOJI' || change.resourceType === 'STICKER') {
    return `DISCORD_${change.resourceType}_UPLOADED`;
  }
  const verb = change.action === 'created' || change.action === 'posted' ? 'CREATED' : 'UPDATED';
  return `DISCORD_${change.resourceType === 'CATEGORY' ? 'CHANNEL' : change.resourceType}_${verb}`;
}

async function acquireLock(guildId: string): Promise<boolean> {
  try {
    return (
      (await redis().set(`discord:setup:lock:${guildId}`, '1', 'EX', LOCK_TTL_SECONDS, 'NX')) ===
      'OK'
    );
  } catch (error) {
    // The run row check in createRun already refuses a second queued apply;
    // Redis being down should not make provisioning impossible.
    logger.warn({ err: error }, 'Provisioning lock unavailable; relying on the run table');
    return true;
  }
}

async function releaseLock(guildId: string): Promise<void> {
  await redis()
    .del(`discord:setup:lock:${guildId}`)
    .catch(() => undefined);
}

async function finish(
  runId: string,
  status: DiscordProvisionRun['status'],
  data: Omit<Prisma.DiscordProvisionRunUpdateInput, 'status'> = {},
): Promise<DiscordProvisionRun> {
  return prisma.discordProvisionRun.update({
    where: { id: runId },
    data: { ...data, status, completedAt: new Date() },
  });
}

export async function executeProvisionRun(
  client: Client,
  runId: string,
  options: { pacingMs?: number; onlyKeys?: ReadonlySet<string> } = {},
): Promise<DiscordProvisionRun> {
  const run = await prisma.discordProvisionRun.findUnique({ where: { id: runId } });
  if (run === null) throw new Error(`Provision run ${runId} does not exist`);
  if (run.status !== 'QUEUED') return run;

  const mutating = run.mode === 'APPLY' || run.mode === 'REPAIR' || run.mode === 'CLEANUP';
  if (mutating && !(await acquireLock(run.guildId))) {
    return finish(run.id, 'FAILED', {
      failure: 'Another provisioning run is in progress for this server.',
    });
  }

  await prisma.discordProvisionRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  try {
    const guild = await client.guilds.fetch(run.guildId);
    const context = await loadProvisioningContext(guild);
    const { plan } = context;
    const runOptions = (run.options ?? {}) as { includeSoft?: boolean; force?: boolean };
    const actor = actorOf(run);

    if (run.mode === 'PLAN' || run.mode === 'STATUS' || run.mode === 'VALIDATE') {
      const failedValidation =
        run.mode === 'VALIDATE' && (!plan.liveAudit.passed || !plan.blueprintAudit.passed);
      return await finish(run.id, failedValidation ? 'VALIDATION_FAILED' : 'SUCCEEDED', {
        plannedChanges: serialisePlan(plan),
        summary: {
          counts: { ...plan.counts },
          profile: plan.profile,
          livePassed: plan.liveAudit.passed,
        },
      });
    }

    const basis =
      run.basedOnRunId === null
        ? null
        : await prisma.discordProvisionRun.findUnique({ where: { id: run.basedOnRunId } });

    if (run.mode === 'CLEANUP') {
      if (basis === null)
        return await finish(run.id, 'FAILED', { failure: 'The run to clean up no longer exists.' });
      const outcome = await cleanupRun(basis.id, context.adapter, context.store, {
        force: runOptions.force === true,
      });
      for (const key of outcome.deleted) {
        await recordAudit(prisma, actor, {
          action: 'DISCORD_RESOURCE_DELETED',
          entityType: 'discord_resource',
          entityId: key,
          metadata: { cleanupOf: basis.id, runId: run.id },
        });
      }
      return await finish(run.id, outcome.failed.length > 0 ? 'FAILED' : 'SUCCEEDED', {
        appliedChanges: {
          deleted: [...outcome.deleted],
          kept: [...outcome.kept],
          failed: [...outcome.failed],
        },
      });
    }

    // APPLY / REPAIR: execute only what the operator approved.
    const mode = run.mode === 'APPLY' ? 'apply' : 'repair';
    const executable = selectExecutable(plan.items, {
      mode,
      includeSoft: runOptions.includeSoft === true,
      ...(options.onlyKeys === undefined ? {} : { onlyKeys: options.onlyKeys }),
    });
    if (options.onlyKeys === undefined) {
      const unapproved = unapprovedChanges(
        executable.map((item) => `${item.key}:${item.kind}`),
        planSignatureOf(basis?.plannedChanges ?? null),
      );
      if (unapproved.length > 0) {
        return await finish(run.id, 'FAILED', {
          plannedChanges: serialisePlan(plan),
          failure: `The server changed since the plan was approved (${unapproved.slice(0, 5).join(', ')}${unapproved.length > 5 ? ', …' : ''}). Generate a new plan and review it.`,
        });
      }
    }
    if (!plan.blueprintAudit.passed) {
      return await finish(run.id, 'VALIDATION_FAILED', {
        plannedChanges: serialisePlan(plan),
        failure: 'The blueprint itself failed the critical permission tests; nothing was applied.',
      });
    }

    let lastWrite = 0;
    const result = await executePlan(
      plan.items,
      context.state,
      context.snapshot,
      context.entries,
      context.adapter,
      context.store,
      {
        mode,
        runId: run.id,
        blueprintVersion: run.blueprintVersion,
        includeSoft: runOptions.includeSoft === true,
        ...(options.onlyKeys === undefined ? {} : { onlyKeys: options.onlyKeys }),
        pacingMs: options.pacingMs ?? 350,
        renderPanel: (panel, emojis) => context.render(panel, emojis),
        readAsset: context.readAsset,
        onProgress: async (progress) => {
          if (Date.now() - lastWrite < 1_000 && progress.current !== null) return;
          lastWrite = Date.now();
          await prisma.discordProvisionRun.update({
            where: { id: run.id },
            data: { progress: JSON.parse(JSON.stringify(progress)) as Prisma.InputJsonValue },
          });
        },
      },
    );

    // Point Xenon at what now exists: review cards, announcements, logs, and
    // role mappings for the roles that mirror Xenon roles.
    const channels: Partial<
      Record<'reviewChannel' | 'announcementChannel' | 'logChannel', string>
    > = {};
    for (const channel of context.state.channels) {
      const id = channel.integration === undefined ? undefined : result.ids.get(channel.key);
      if (channel.integration !== undefined && id !== undefined) channels[channel.integration] = id;
    }
    await saveIntegration(prisma, actor, {
      guildId: guild.id,
      guildName: guild.name,
      channels,
      roleMappings: context.state.roles.flatMap((role) => {
        const id = result.ids.get(role.key);
        return role.xenonRoleKey === undefined || id === undefined
          ? []
          : [{ xenonRoleKey: role.xenonRoleKey, discordRoleId: id, discordRoleName: role.name }];
      }),
    });

    for (const change of result.applied) {
      await recordAudit(prisma, actor, {
        action: auditAction(change),
        entityType: 'discord_resource',
        entityId: change.key,
        entityLabel: change.discordId,
        metadata: { runId: run.id, action: change.action },
      });
    }

    // Validate what actually exists now, not what we meant to create.
    const after = await loadProvisioningContext(guild);
    const critical = after.plan.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'critical',
    );
    const status = !after.plan.liveAudit.passed
      ? 'VALIDATION_FAILED'
      : result.failed.length > 0
        ? 'FAILED'
        : 'SUCCEEDED';

    await recordAudit(prisma, actor, {
      action: run.mode === 'APPLY' ? 'DISCORD_SETUP_APPLIED' : 'DISCORD_DRIFT_REPAIRED',
      entityType: 'discord_provision_run',
      entityId: run.id,
      entityLabel: guild.name,
      after: { applied: result.applied.length, failed: result.failed.length, status },
    });

    const finished = await finish(run.id, status, {
      appliedChanges: JSON.parse(
        JSON.stringify({ applied: result.applied, failed: result.failed, skipped: result.skipped }),
      ) as Prisma.InputJsonValue,
      summary: {
        applied: result.applied.length,
        failed: result.failed.length,
        skipped: result.skipped.length,
        aborted: result.aborted,
        remaining: { ...after.plan.counts },
        critical: critical.map((diagnostic) => diagnostic.message),
      },
      ...(result.aborted
        ? { failure: 'Stopped after repeated failures; fix the cause and apply again to resume.' }
        : {}),
      ...(status === 'VALIDATION_FAILED'
        ? {
            failure: `Health validation failed: ${critical[0]?.message ?? 'critical permission test'}`,
          }
        : {}),
    });

    await postRunReport(client, finished).catch((error: unknown) => {
      logger.warn({ err: error }, 'Could not post the provisioning report');
    });
    return finished;
  } catch (error) {
    logger.error({ err: error, runId }, 'Provisioning run failed');
    return await finish(run.id, 'FAILED', {
      failure: error instanceof Error ? error.message.slice(0, 500) : 'Unexpected error',
    });
  } finally {
    if (mutating) await releaseLock(run.guildId);
  }
}

/**
 * A run that was RUNNING when the process died will never finish by itself.
 * Marking it failed is honest; the registry already records what succeeded.
 */
export async function failInterruptedRuns(): Promise<number> {
  const { count } = await prisma.discordProvisionRun.updateMany({
    where: { status: 'RUNNING' },
    data: {
      status: 'FAILED',
      completedAt: new Date(),
      failure: 'Interrupted by a restart. Apply again to resume.',
    },
  });
  return count;
}
