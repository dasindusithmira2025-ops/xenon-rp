'use server';

import { revalidatePath } from 'next/cache';

import { serverEnv } from '@xenon/config/server';
import { ConflictError } from '@xenon/core';
import { prisma } from '@xenon/database';
import {
  resolveConflict,
  type RunMode,
  saveBlueprintFeatures,
  saveDepartmentSpace,
  saveEnforcementMode,
  saveOrganizationSpace,
} from '@xenon/discord/web';

import { type ActionResult, runAction } from '~/server/action';
import { currentActor } from '~/server/context';

/**
 * Discord provisioning from the Control Center.
 *
 * These actions only record intent: an operator decision, a setting.
 * Provisioning runs themselves belong to Xenon Guardian (`/xenon setup plan`
 * and `/xenon setup apply`), because only Guardian administers the Discord
 * server - the web tier never talks to Discord. Every service called here
 * re-checks `system.discord.bootstrap` (or the destructive capability) itself.
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

/**
 * Retired: web-triggered provisioning ran through the old integrated bot.
 * Kept as an explicit refusal so an open Control Center tab gets a clear
 * answer instead of a silently queued run that nothing will execute.
 */
export async function requestRunAction(
  _input: RunRequestInput,
): Promise<ActionResult<{ runId: string }>> {
  return runAction(async () => {
    await currentActor();
    throw new ConflictError(
      'Discord provisioning moved to Xenon Guardian',
      'Discord provisioning now runs in Xenon Guardian. Use /xenon setup plan and then /xenon setup apply in Discord.',
    );
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
