import { type DiscordProvisionRun, prisma } from '@xenon/database';
import { type EmbedTone, xenonEmbed } from '@xenon/discord';
import { planItems } from '@xenon/discord/provisioning';

import { botEnv } from '../../runtime';

import type { Client } from 'discord.js';

/**
 * How a provisioning run reads in Discord: one compact embed for the operator
 * who ran the command, and the same summary in #bot-logs so the rest of
 * management can see what changed without opening the Control Center.
 */

const titles: Record<DiscordProvisionRun['mode'], string> = {
  PLAN: 'SETUP PLAN',
  APPLY: 'SETUP APPLY',
  STATUS: 'SERVER STATUS',
  REPAIR: 'SETUP REPAIR',
  VALIDATE: 'SERVER VALIDATION',
  CLEANUP: 'SETUP CLEANUP',
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function controlUrl(runId?: string): string {
  return new URL(
    `/control/discord/setup${runId === undefined ? '' : `?run=${runId}`}`,
    botEnv.NEXT_PUBLIC_SITE_URL,
  ).toString();
}

export function buildRunEmbed(run: DiscordProvisionRun) {
  const tone: EmbedTone =
    run.status === 'SUCCEEDED'
      ? 'success'
      : run.status === 'FAILED' || run.status === 'VALIDATION_FAILED'
        ? 'danger'
        : 'info';
  const embed = xenonEmbed(tone).setTitle(titles[run.mode]).setURL(controlUrl(run.id));

  const planned = record(run.plannedChanges);
  const counts = record(planned.counts);
  const summary = record(run.summary);

  if (run.mode === 'APPLY' || run.mode === 'REPAIR') {
    const remaining = record(summary.remaining);
    embed.setDescription(
      [
        `**${String(number(summary.applied))}** changes applied`,
        number(summary.failed) > 0 ? `**${String(number(summary.failed))}** failed` : null,
        number(summary.skipped) > 0 ? `${String(number(summary.skipped))} skipped` : null,
        run.status === 'VALIDATION_FAILED' ? '⚠️ **Health validation failed**' : null,
        run.status === 'SUCCEEDED' ? 'Permissions validated.' : null,
        number(remaining.drift) > 0
          ? `${String(number(remaining.drift))} drift left for repair`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  } else if (run.mode !== 'CLEANUP' && Object.keys(counts).length > 0) {
    const line = [
      [counts.unchanged, 'unchanged'],
      [counts.create, 'to create'],
      [counts.update, 'to update'],
      [counts.move, 'to reorder'],
      [counts.permission, 'permission changes'],
      [counts.drift, 'drifted'],
      [counts.conflict, 'conflicts'],
      [counts.manual, 'need review'],
      [counts.capacity, 'over capacity'],
    ]
      .filter(([value]) => number(value) > 0)
      .map(([value, label]) => `**${String(number(value))}** ${String(label)}`)
      .join(' · ');
    embed.setDescription(line || 'Nothing to report.');

    const items = planItems(run.plannedChanges);
    const conflicts = items.filter((item) => item.kind === 'CONFLICT').slice(0, 5);
    if (conflicts.length > 0) {
      embed.addFields({
        name: 'Conflicts',
        value: conflicts.map((item) => `• ${item.summary}`).join('\n'),
      });
    }
    const drift = items.filter((item) => item.kind === 'DRIFT').slice(0, 5);
    if (drift.length > 0) {
      embed.addFields({
        name: 'Drift',
        value: drift.map((item) => `• ${item.label} — ${item.summary}`).join('\n'),
      });
    }
    const diagnostics = (Array.isArray(planned.diagnostics) ? planned.diagnostics : [])
      .map(record)
      .filter((diagnostic) => diagnostic.severity === 'critical' || diagnostic.severity === 'error')
      .slice(0, 5);
    if (diagnostics.length > 0) {
      embed.addFields({
        name: 'Needs attention',
        value: diagnostics
          .map((diagnostic) => `• ${String(diagnostic.message).slice(0, 180)}`)
          .join('\n'),
      });
    }
    const profile = typeof planned.profile === 'string' ? planned.profile : null;
    if (profile === 'ESTABLISHED') {
      embed.addFields({
        name: 'Existing server',
        value:
          'This server already has structure Xenon does not manage. Review every conflict before applying.',
      });
    }
  }

  if (run.failure !== null) embed.addFields({ name: 'Stopped', value: run.failure.slice(0, 900) });
  embed.addFields(
    { name: 'Blueprint', value: run.blueprintVersion, inline: true },
    { name: 'By', value: run.actorLabel, inline: true },
  );
  return embed;
}

/** Post the outcome of a mutating run to #bot-logs, when it is configured. */
export async function postRunReport(client: Client, run: DiscordProvisionRun): Promise<void> {
  const guild = await prisma.discordGuild.findUnique({
    where: { guildId: run.guildId },
    select: { logChannelId: true },
  });
  if (guild?.logChannelId == null) return;
  const channel = await client.channels.fetch(guild.logChannelId);
  if (!channel?.isSendable()) return;
  await channel.send({ embeds: [buildRunEmbed(run)] });
}
