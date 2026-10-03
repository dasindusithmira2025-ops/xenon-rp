'use server';

import { revalidatePath } from 'next/cache';

import { serverEnv } from '@xenon/config/server';
import { ConflictError } from '@xenon/core';
import { prisma } from '@xenon/database';
import {
  createRun,
  resolveConflict,
  type RunMode,
  saveBlueprintFeatures,
  saveDepartmentSpace,
  saveEnforcementMode,
  saveOrganizationSpace,
} from '@xenon/discord/web';
import { enqueue } from '@xenon/jobs';

import { type ActionResult, runAction } from '~/server/action';
import { currentActor } from '~/server/context';

/**
 * Discord provisioning from the Control Center.
 *
 * These actions only record intent: a run row, an operator decision, a
 * setting. The bot executes runs, because only the bot holds the token -
 * the web tier never talks to Discord. Every service called here re-checks
 * `system.discord.bootstrap` (or the destructive capability) itself.
 */

const PATH = '/control/discord/setup';

function guildId(): string {
  const id = serverEnv.DISCORD_GUILD_ID;
  if (id === undefined) {
    throw new ConflictError(
      'DISCORD_GUILD_ID is not configured',
      'Configure DISCORD_GUILD_ID before provisioning.',
    );
  }
  return id;
}

export interface RunRequestInput {
  readonly mode: RunMode;
  readonly basedOnRunId?: string;
  readonly confirmation?: string;
  readonly acknowledgeEstablished?: boolean;
  readonly includeSoft?: boolean;
  readonly force?: boolean;
}

export async function requestRunAction(
  input: RunRequestInput,
): Promise<ActionResult<{ runId: string }>> {
  return runAction(async () => {
    const actor = await currentActor();
    const run = await createRun(prisma, actor, { guildId: guildId(), ...input });
    try {
      await enqueue('discord.setup.run', { runId: run.id });
    } catch {
      await prisma.discordProvisionRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          failure: 'The job queue is unavailable.',
        },
      });
      throw new ConflictError(
        'Job queue unavailable',
        'The job queue is unavailable. Check Redis and try again.',
      );
    }
    revalidatePath(PATH);
    return { runId: run.id };
  });
}

export async function resolveConflictAction(input: {
  planRunId: string;
  key: string;
  resolution: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await resolveConflict(prisma, await currentActor(), { guildId: guildId(), ...input });
    revalidatePath(PATH);
  });
}

export async function saveFeaturesAction(features: Record<string, boolean>): Promise<ActionResult> {
  return runAction(async () => {
    await saveBlueprintFeatures(prisma, await currentActor(), features);
    revalidatePath(PATH);
  });
}

export async function saveEnforcementAction(mode: string): Promise<ActionResult> {
  return runAction(async () => {
    await saveEnforcementMode(prisma, await currentActor(), mode);
    revalidatePath(PATH);
  });
}

export async function saveDepartmentSpaceAction(input: {
  departmentId: string;
  space: Record<string, unknown>;
}): Promise<ActionResult> {
  return runAction(async () => {
    await saveDepartmentSpace(prisma, await currentActor(), input.departmentId, input.space);
    revalidatePath(PATH);
  });
}

export async function saveOrganizationAction(
  input: Record<string, unknown>,
): Promise<ActionResult> {
  return runAction(async () => {
    await saveOrganizationSpace(prisma, await currentActor(), guildId(), input);
    revalidatePath(PATH);
  });
}
