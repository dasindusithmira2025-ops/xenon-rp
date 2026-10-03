import { ActivityType, type Client } from 'discord.js';

import { prisma } from '@xenon/database';
import {
  blueprintFeatures,
  type EmojiRef,
  enforcementMode,
  loadPanelData,
  panelHash,
  presenceLines,
  renderPanel,
  stableHash,
} from '@xenon/discord/provisioning';
import { systemActor } from '@xenon/permissions';

import { botEnv, logger } from '../runtime';

import { primaryGuild } from './client';
import { linksAllowed, loadProvisioningContext } from './provisioning/context';
import { executeProvisionRun } from './provisioning/runner';

/**
 * The living layer: the city-status card, the bot's presence, and the drift
 * sweep that keeps Xenon honest about the server it manages.
 *
 * Every automated post here has a purpose, a rate and a switch. The status
 * card is edited, never re-posted, and only when something a reader would
 * notice has changed (or ten minutes have passed, to keep "last updated"
 * truthful). Presence rotates every five minutes. Drift is reported to
 * #bot-logs only when it changes, so a known issue is not re-announced hourly.
 */

const STATUS_REFRESH_FLOOR_MS = 10 * 60_000;

let lastStatusHash: string | null = null;
let lastStatusEdit = 0;
let presenceIndex = 0;
let lastDriftSignature = '';

/** What the heartbeat reports about the managed server. */
export const liveHealth: { drift: number; critical: number; checkedAt: string | null } = {
  drift: 0,
  critical: 0,
  checkedAt: null,
};

async function emojiRefs(guildId: string): Promise<Map<string, EmojiRef>> {
  const rows = await prisma.discordManagedResource.findMany({
    where: { guildId, resourceType: 'EMOJI', managed: true, discordResourceId: { not: null } },
    select: { logicalKey: true, discordResourceId: true },
  });
  return new Map(
    rows.flatMap((row) =>
      row.discordResourceId === null
        ? []
        : [
            [
              row.logicalKey,
              {
                id: row.discordResourceId,
                name: row.logicalKey.replace(/^emoji\./, ''),
                animated: false,
              },
            ] as const,
          ],
    ),
  );
}

export async function refreshStatusPanel(client: Client): Promise<void> {
  const guildId = botEnv.DISCORD_GUILD_ID;
  if (guildId === undefined || !client.isReady()) return;

  const panel = await prisma.discordManagedResource.findUnique({
    where: { guildId_logicalKey: { guildId, logicalKey: 'panel.city-status' } },
  });
  if (panel?.discordResourceId == null || panel.channelId === null || !panel.managed) return;

  const data = await loadPanelData(prisma);
  const payload = renderPanel(
    { key: 'panel.city-status', kind: 'city-status', channel: 'channel.city-status', live: true },
    {
      ...data,
      siteUrl: botEnv.NEXT_PUBLIC_SITE_URL,
      linksAllowed: linksAllowed(),
      emojis: await emojiRefs(guildId),
      selfRoles: [],
    },
  );
  // The timestamp alone changing is not news; it is refreshed on the floor.
  const meaningful = stableHash({ ...data.status, checkedAt: null });
  if (meaningful === lastStatusHash && Date.now() - lastStatusEdit < STATUS_REFRESH_FLOOR_MS)
    return;

  const channel = await client.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  try {
    await channel.messages.edit(panel.discordResourceId, {
      embeds: payload.embeds,
      components: payload.components,
    });
    lastStatusHash = meaningful;
    lastStatusEdit = Date.now();
    await prisma.discordManagedResource.update({
      where: { id: panel.id },
      data: { contentHash: panelHash(payload), lastVerifiedAt: new Date() },
    });
  } catch (error) {
    // A deleted card is drift; the sweep reports it and repair restores it.
    logger.debug({ err: error }, 'City status panel could not be edited');
  }
}

export async function rotatePresence(client: Client): Promise<void> {
  if (!client.isReady()) return;
  const features = await blueprintFeatures(prisma);
  if (!features.livePresence) {
    client.user.setPresence({ activities: [] });
    return;
  }
  const data = await loadPanelData(prisma);
  const lines = presenceLines({
    status: data.status,
    applications: data.applications,
    siteUrl: botEnv.NEXT_PUBLIC_SITE_URL,
  });
  const line = lines[presenceIndex % lines.length] ?? 'XenonRP';
  presenceIndex += 1;
  client.user.setPresence({
    activities: [{ name: line, state: line, type: ActivityType.Custom }],
    status: 'online',
  });
}

/**
 * Compare desired with actual, report drift, and - only in ENFORCE mode -
 * restore the critical integration resources without waiting for a human.
 */
export async function sweepDrift(client: Client): Promise<void> {
  const guild = await primaryGuild();
  if (guild === null) return;
  const registered = await prisma.discordManagedResource.count({
    where: { guildId: guild.id, discordResourceId: { not: null } },
  });
  if (registered === 0) return; // never provisioned; nothing to watch

  const context = await loadProvisioningContext(guild);
  const drift = context.plan.items.filter((item) => item.kind === 'DRIFT');
  const critical = context.plan.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'critical',
  );
  liveHealth.drift = drift.length;
  liveHealth.critical = critical.length;
  liveHealth.checkedAt = new Date().toISOString();

  const signature = [...drift.map((item) => item.key), ...critical.map((d) => d.message)]
    .sort()
    .join('|');
  if (signature !== lastDriftSignature) {
    lastDriftSignature = signature;
    if (signature.length > 0) {
      logger.warn(
        { drift: drift.length, critical: critical.length },
        'Discord server drift detected',
      );
      const settings = await prisma.discordGuild.findUnique({
        where: { guildId: guild.id },
        select: { logChannelId: true },
      });
      const channel =
        settings?.logChannelId == null
          ? null
          : await client.channels.fetch(settings.logChannelId).catch(() => null);
      if (channel?.isSendable() === true) {
        await channel.send({
          content: [
            `**Drift detected** · ${String(drift.length)} managed resources differ from the blueprint${critical.length > 0 ? `, ${String(critical.length)} critical permission issues` : ''}.`,
            ...drift.slice(0, 5).map((item) => `• ${item.label} — ${item.summary}`),
            ...critical.slice(0, 3).map((d) => `• ⚠️ ${d.message}`),
            'Review with `/xenon setup status`; restore with `/xenon setup repair`.',
          ].join('\n'),
        });
      }
    }
  }

  if ((await enforcementMode(prisma)) !== 'ENFORCE') return;
  const criticalKeys = new Set([
    ...context.state.channels
      .filter((channel) => channel.critical === true)
      .map((channel) => channel.key),
    'panel.city-status',
    'role.whitelisted',
    ...context.state.roles
      .filter((role) => role.xenonRoleKey !== undefined)
      .map((role) => role.key),
  ]);
  const enforceable = drift.filter(
    (item) => criticalKeys.has(item.key) && item.strictDrift === true,
  );
  if (enforceable.length === 0) return;

  const run = await prisma.discordProvisionRun.create({
    data: {
      guildId: guild.id,
      mode: 'REPAIR',
      source: 'SYSTEM',
      actorId: null,
      actorLabel: `${systemActor.label} (enforcement)`,
      blueprintVersion: context.state.version,
      options: { enforce: true },
    },
  });
  await executeProvisionRun(client, run.id, {
    onlyKeys: new Set(enforceable.map((item) => item.key)),
  });
}
