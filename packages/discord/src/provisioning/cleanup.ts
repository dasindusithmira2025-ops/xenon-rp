import type { GuildAdapter, RegistryStore } from './ports';
import type { RegistryEntry } from './types';

/**
 * Remove what one failed provisioning run created.
 *
 * Not a rollback - Discord has no transactions and pretending otherwise would
 * be a lie. This deletes only resources whose registry row says this exact run
 * created them, and even then refuses anything that has acquired history:
 * a channel somebody has posted in or a role somebody holds needs `force`,
 * and "cannot tell" counts as "has history".
 *
 * Callers must already have checked the destructive capability and collected
 * an explicit confirmation.
 */

export interface CleanupOutcome {
  readonly deleted: readonly string[];
  readonly kept: readonly { readonly key: string; readonly reason: string }[];
  readonly failed: readonly { readonly key: string; readonly message: string }[];
}

const ORDER: Record<RegistryEntry['resourceType'], number> = {
  PANEL: 0,
  AUTOMOD: 1,
  CHANNEL: 2,
  CATEGORY: 3,
  EMOJI: 4,
  STICKER: 4,
  ROLE: 5,
  SPACE: 6,
};

export async function cleanupRun(
  runId: string,
  adapter: GuildAdapter,
  store: RegistryStore,
  options: { force: boolean },
): Promise<CleanupOutcome> {
  const entries = (await store.list())
    .filter((entry) => entry.createdByRunId === runId && entry.managed && entry.discordId !== null)
    .sort((a, b) => ORDER[a.resourceType] - ORDER[b.resourceType]);

  const deleted: string[] = [];
  const kept: { key: string; reason: string }[] = [];
  const failed: { key: string; message: string }[] = [];

  for (const entry of entries) {
    const id = entry.discordId;
    if (id === null) continue;
    try {
      switch (entry.resourceType) {
        case 'CHANNEL':
        case 'CATEGORY': {
          const history =
            entry.resourceType === 'CHANNEL' ? await adapter.channelHasHumanHistory(id) : false;
          if (history !== false && !options.force) {
            kept.push({
              key: entry.logicalKey,
              reason:
                history === null ? 'History could not be checked' : 'Members have posted here',
            });
            continue;
          }
          await adapter.deleteChannel(id);
          break;
        }
        case 'ROLE': {
          const members = await adapter.roleMemberCount(id);
          if (members !== 0 && !options.force) {
            kept.push({
              key: entry.logicalKey,
              reason:
                members === null
                  ? 'Membership could not be checked'
                  : `${String(members)} members hold it`,
            });
            continue;
          }
          await adapter.deleteRole(id);
          break;
        }
        case 'EMOJI':
          await adapter.deleteEmoji(id);
          break;
        case 'PANEL':
        case 'AUTOMOD':
        case 'STICKER':
        case 'SPACE':
          // Panels vanish with their channel; AutoMod and stickers are left for
          // an operator, since removing moderation silently is the wrong default.
          kept.push({ key: entry.logicalKey, reason: 'Not removed automatically' });
          continue;
      }
      await store.remove(entry.logicalKey);
      deleted.push(entry.logicalKey);
    } catch (error) {
      failed.push({
        key: entry.logicalKey,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return { deleted, kept, failed };
}
