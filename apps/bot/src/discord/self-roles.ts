import { type ButtonInteraction, MessageFlags } from 'discord.js';

import { prisma } from '@xenon/database';
import type { XenonId } from '@xenon/discord';
import { recordAudit } from '@xenon/domain';
import { consumeRateLimit, rateLimits } from '@xenon/jobs';

import { logger } from '../runtime';

import { actorFromDiscord } from './actor';

/**
 * Self-assignable role buttons from the #choose-roles panel.
 *
 * Three independent guards, because a button id is user-controlled input:
 *  - the key must be a notification or language role by shape;
 *  - it must be a role Xenon provisioned and still manages;
 *  - the Discord role must carry no permissions at all, checked live, so an
 *    operator editing "Events" into a moderator role cannot turn this panel
 *    into a privilege escalation.
 */

const SELF_ASSIGNABLE = /^role\.(notify|lang)\.[a-z]{2,16}$/;

export async function handleRoleToggle(interaction: ButtonInteraction, id: XenonId): Promise<void> {
  const key = id.argument;
  const guild = interaction.guild;
  if (key === null || guild === null || !SELF_ASSIGNABLE.test(key)) {
    await interaction.reply({
      content: 'That button is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const limit = await consumeRateLimit(rateLimits.discordSelfRole, interaction.user.id);
  if (!limit.allowed) {
    await interaction.reply({
      content: 'Slow down a little and try again in a minute.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const entry = await prisma.discordManagedResource.findUnique({
    where: { guildId_logicalKey: { guildId: guild.id, logicalKey: key } },
    select: { discordResourceId: true, managed: true },
  });
  const roleId = entry?.managed === true ? entry.discordResourceId : null;
  const role = roleId === null ? null : await guild.roles.fetch(roleId);
  if (role?.permissions.bitfield !== 0n || role.managed) {
    logger.warn(
      { key, roleId: entry?.discordResourceId },
      'Refused a self-role toggle for an unsafe or missing role',
    );
    await interaction.reply({
      content: 'That role is not available right now.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await guild.members.fetch(interaction.user.id);
  const has = member.roles.cache.has(role.id);
  if (has) await member.roles.remove(role, 'Self-role via #choose-roles');
  else await member.roles.add(role, 'Self-role via #choose-roles');

  const actor = await actorFromDiscord(interaction.user.id);
  await recordAudit(prisma, actor, {
    action: has ? 'SELF_ROLE_REMOVED' : 'SELF_ROLE_ADDED',
    entityType: 'discord_self_role',
    entityId: key,
    entityLabel: role.name,
    after: { guildId: guild.id, roleId: role.id, assigned: !has },
  });

  await interaction.reply({
    content: has
      ? `You will no longer be pinged for **${role.name}**.`
      : `You will now be pinged for **${role.name}**.`,
    flags: MessageFlags.Ephemeral,
  });
}
