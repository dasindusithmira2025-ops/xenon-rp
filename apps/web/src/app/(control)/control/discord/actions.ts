'use server';

import { revalidatePath } from 'next/cache';

import { serverEnv } from '@xenon/config/server';
import { ConflictError } from '@xenon/core';
import { prisma } from '@xenon/database';
import { recordAudit } from '@xenon/domain';
import { enqueueBestEffort } from '@xenon/jobs';
import { requirePermission } from '@xenon/permissions';
import { cuid, guildSettingsInput, roleMappingInput } from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { currentActor } from '~/server/context';

/**
 * Discord integration configuration.
 *
 * Role mappings live here and nowhere else. A Discord role snowflake appears in
 * exactly one table, which is what lets authorization stay capability-based and
 * lets a community reorganise its Discord without touching any code.
 */

export async function saveGuildAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(guildSettingsInput, raw);
    const actor = await currentActor();
    requirePermission(actor, 'discord.manage');

    if (serverEnv.DISCORD_GUILD_ID !== undefined && input.guildId !== serverEnv.DISCORD_GUILD_ID) {
      throw new ConflictError(
        'Configured Discord guild does not match the runtime guild',
        'Use the server ID configured in DISCORD_GUILD_ID, then try again.',
      );
    }

    const guild = await prisma.discordGuild.upsert({
      where: { guildId: input.guildId },
      create: {
        guildId: input.guildId,
        name: input.name,
        isPrimary: true,
        reviewChannelId: input.reviewChannelId ?? null,
        announcementChannelId: input.announcementChannelId ?? null,
        logChannelId: input.logChannelId ?? null,
      },
      update: {
        name: input.name,
        reviewChannelId: input.reviewChannelId ?? null,
        announcementChannelId: input.announcementChannelId ?? null,
        logChannelId: input.logChannelId ?? null,
      },
    });

    // Exactly one guild is primary, and the newest configured one wins.
    await prisma.discordGuild.updateMany({
      where: { id: { not: guild.id } },
      data: { isPrimary: false },
    });

    await recordAudit(prisma, actor, {
      action: 'discord.guild_configured',
      entityType: 'discord_guild',
      entityId: guild.id,
      entityLabel: guild.name,
      after: { guildId: guild.guildId },
    });

    await enqueueBestEffort('discord.guild.sync', { guildId: guild.id });
    revalidatePath('/control/discord');
  });
}

export async function saveRoleMappingAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(roleMappingInput, raw);
    const actor = await currentActor();
    requirePermission(actor, 'discord.manage');

    const guild = await prisma.discordGuild.findUnique({
      where: { id: input.guildId },
      select: { guildId: true, isPrimary: true },
    });
    if (
      guild === null ||
      !guild.isPrimary ||
      (serverEnv.DISCORD_GUILD_ID !== undefined && guild.guildId !== serverEnv.DISCORD_GUILD_ID)
    ) {
      throw new ConflictError(
        'Discord role mapping targets a non-primary guild',
        'Role mappings can only target the configured Xenon guild.',
      );
    }

    const mapping = await prisma.discordRoleMapping.upsert({
      where: { guildId_roleId: { guildId: input.guildId, roleId: input.roleId } },
      create: {
        guildId: input.guildId,
        roleId: input.roleId,
        discordRoleId: input.discordRoleId,
        discordRoleName: input.discordRoleName ?? null,
        syncToDiscord: input.syncToDiscord,
        syncFromDiscord: input.syncFromDiscord,
      },
      update: {
        discordRoleId: input.discordRoleId,
        discordRoleName: input.discordRoleName ?? null,
        syncToDiscord: input.syncToDiscord,
        syncFromDiscord: input.syncFromDiscord,
        // A remapping invalidates the previous hierarchy verdict.
        hierarchyBlocked: false,
        lastError: null,
      },
    });

    await recordAudit(prisma, actor, {
      action: 'discord.role_mapped',
      entityType: 'discord_role_mapping',
      entityId: mapping.id,
      after: { discordRoleId: mapping.discordRoleId, syncToDiscord: mapping.syncToDiscord },
    });

    revalidatePath('/control/discord');
  });
}

export async function deleteRoleMappingAction(mappingId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, mappingId);
    const actor = await currentActor();
    requirePermission(actor, 'discord.manage');

    const mapping = await prisma.discordRoleMapping.findUnique({
      where: { id },
      select: { guild: { select: { guildId: true, isPrimary: true } } },
    });
    if (
      mapping === null ||
      !mapping.guild.isPrimary ||
      (serverEnv.DISCORD_GUILD_ID !== undefined &&
        mapping.guild.guildId !== serverEnv.DISCORD_GUILD_ID)
    ) {
      throw new ConflictError(
        'Discord role mapping targets a non-primary guild',
        'That mapping does not belong to the configured Xenon guild.',
      );
    }

    await prisma.discordRoleMapping.delete({ where: { id } });
    await recordAudit(prisma, actor, {
      action: 'discord.role_unmapped',
      entityType: 'discord_role_mapping',
      entityId: id,
    });

    revalidatePath('/control/discord');
  });
}

/**
 * Queue a full reconciliation.
 *
 * One job per user rather than one enormous job: each is idempotent, each
 * retries independently, and a single member the bot cannot manage does not
 * stall everybody else's roles.
 */
export async function resyncAllRolesAction(): Promise<ActionResult<{ queued: number }>> {
  return runAction(async () => {
    const actor = await currentActor();
    requirePermission(actor, 'discord.manage');

    const users = await prisma.user.findMany({
      where: { deletedAt: null, discordAccount: { isNot: null } },
      select: { id: true },
    });

    for (const user of users) {
      await enqueueBestEffort('discord.role.sync', { userId: user.id, reason: 'manual.resync' });
    }

    await recordAudit(prisma, actor, {
      action: 'discord.resync_requested',
      entityType: 'discord_guild',
      entityId: 'all',
      metadata: { users: users.length },
    });

    return { queued: users.length };
  });
}
