import { prisma } from '@xenon/database';
import { assetsRoot, desiredAssets, readAssetData, readManifest } from '@xenon/discord/assets';
import {
  blueprintFeatures,
  buildDesiredState,
  type DesiredPanel,
  type EmojiRef,
  loadDepartmentInputs,
  loadOrganizationSpaces,
  loadPanelData,
  type PanelContext,
  panelHash,
  type PanelPayload,
  planGuild,
  prismaRegistry,
  renderPanel,
} from '@xenon/discord/provisioning';

import { botEnv } from '../../runtime';

import { discordGuildAdapter } from './guild-adapter';

import type { Guild } from 'discord.js';

/**
 * Everything one provisioning pass needs, loaded the same way every time.
 *
 * The run executor, the live status refresher, the enforcement sweep and the
 * CLI all start here, which is what keeps "the plan" a single thing: same
 * registry, same blueprint inputs, same panel data, same engine.
 */

function isLocalhost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return true;
  }
}

export function linksAllowed(): boolean {
  return !(botEnv.NODE_ENV === 'production' && isLocalhost(botEnv.NEXT_PUBLIC_SITE_URL));
}

export async function loadProvisioningContext(guild: Guild) {
  const adapter = discordGuildAdapter(guild);
  const store = prismaRegistry(prisma, guild.id);
  const entries = await store.list();

  const panelRefs = entries.flatMap((entry) =>
    entry.resourceType === 'PANEL' && entry.discordId !== null && entry.channelId !== null
      ? [{ channelId: entry.channelId, messageId: entry.discordId }]
      : [],
  );

  const root = assetsRoot();
  const [snapshot, features, departments, organizations, manifest, mappings, panelData] =
    await Promise.all([
      adapter.snapshot(panelRefs),
      blueprintFeatures(prisma),
      loadDepartmentInputs(prisma),
      loadOrganizationSpaces(prisma, guild.id),
      readManifest(root),
      prisma.discordRoleMapping.findMany({
        where: { guild: { guildId: guild.id } },
        select: { discordRoleId: true, role: { select: { key: true } } },
      }),
      loadPanelData(prisma),
    ]);

  const state = buildDesiredState({
    features,
    guildFeatures: snapshot.features,
    departments,
    organizations,
    assets: desiredAssets(manifest, root),
  });

  const liveEmojiIds = new Set(snapshot.emojis.map((emoji) => emoji.id));
  const emojis = new Map<string, EmojiRef>();
  for (const asset of state.assets) {
    const entry = entries.find((candidate) => candidate.logicalKey === asset.key);
    if (asset.type === 'EMOJI' && entry?.discordId != null && liveEmojiIds.has(entry.discordId)) {
      emojis.set(asset.key, { id: entry.discordId, name: asset.name, animated: asset.animated });
    }
  }

  const selfRoles = state.roles.filter((role) => role.selfAssignable);
  const panelContext = (emojiMap: ReadonlyMap<string, EmojiRef>): PanelContext => ({
    ...panelData,
    siteUrl: botEnv.NEXT_PUBLIC_SITE_URL,
    linksAllowed: linksAllowed(),
    emojis: emojiMap,
    selfRoles,
  });
  const render = (
    panel: DesiredPanel,
    emojiMap: ReadonlyMap<string, EmojiRef> = emojis,
  ): PanelPayload => renderPanel(panel, panelContext(emojiMap));

  const panelHashes = new Map(
    state.panels
      .filter((panel) => !panel.live)
      .map((panel) => [panel.key, panelHash(render(panel))]),
  );

  const plan = planGuild({
    state,
    snapshot,
    registry: entries,
    panelHashes,
    roleMappings: mappings.map((mapping) => ({
      xenonRoleKey: mapping.role.key,
      discordRoleId: mapping.discordRoleId,
    })),
    siteUrl: botEnv.NEXT_PUBLIC_SITE_URL,
    production: botEnv.NODE_ENV === 'production',
  });

  return {
    adapter,
    store,
    entries,
    snapshot,
    state,
    plan,
    features,
    emojis,
    render,
    panelContext,
    readAsset: (asset: { file: string }) => readAssetData(asset, root),
  };
}

export type ProvisioningContext = Awaited<ReturnType<typeof loadProvisioningContext>>;
