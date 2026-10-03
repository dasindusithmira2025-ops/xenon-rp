import type { PanelPayload } from './panels';
import type {
  ChannelKind,
  DesiredAutoModRule,
  ForumTag,
  GuildSnapshot,
  Overwrite,
  RegistryEntry,
} from './types';

/**
 * The two ports the engine talks through.
 *
 * `GuildAdapter` is Discord; `RegistryStore` is Postgres. The engine never
 * imports discord.js's client or Prisma directly, which is what lets the full
 * plan → apply → status → repair cycle run in tests against an in-memory guild
 * - and what guarantees the real Xenon server is never touched by a test run.
 */

export interface RolePayload {
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  readonly permissions: bigint;
}

export interface ChannelPayload {
  readonly name: string;
  readonly kind: 'category' | ChannelKind;
  readonly parentId: string | null;
  readonly topic?: string | null;
  readonly overwrites: readonly Overwrite[];
  readonly userLimit?: number;
  readonly slowmodeSeconds?: number;
  readonly forumTags?: readonly ForumTag[];
}

export interface AutoModPayload {
  readonly name: string;
  readonly trigger: DesiredAutoModRule['trigger'];
  readonly alertChannelId: string | null;
  readonly exemptRoleIds: readonly string[];
}

export interface GuildAdapter {
  snapshot(panelRefs: readonly { channelId: string; messageId: string }[]): Promise<GuildSnapshot>;

  createRole(payload: RolePayload): Promise<string>;
  editRole(id: string, payload: Partial<RolePayload>): Promise<void>;
  /** Place these roles directly below the bot's highest role, first = highest. */
  orderRoles(idsTopToBottom: readonly string[]): Promise<void>;
  deleteRole(id: string): Promise<void>;

  createChannel(payload: ChannelPayload): Promise<string>;
  editChannel(id: string, payload: Partial<ChannelPayload>): Promise<void>;
  deleteChannel(id: string): Promise<void>;

  createEmoji(name: string, data: Buffer): Promise<string>;
  createSticker(name: string, tags: string, description: string, data: Buffer): Promise<string>;
  deleteEmoji(id: string): Promise<void>;

  sendMessage(channelId: string, payload: PanelPayload): Promise<string>;
  /** False when the message no longer exists. */
  editMessage(channelId: string, messageId: string, payload: PanelPayload): Promise<boolean>;

  createAutoModRule(payload: AutoModPayload): Promise<string>;
  editAutoModRule(id: string, payload: AutoModPayload & { enabled: boolean }): Promise<void>;
  setAutoModEnabled(id: string, enabled: boolean): Promise<void>;

  /** Whether any non-bot member has posted. Null when it cannot be determined. */
  channelHasHumanHistory(id: string): Promise<boolean | null>;
  /** Members holding the role, or null when it cannot be determined without privileged intents. */
  roleMemberCount(id: string): Promise<number | null>;
}

export interface RegistryStore {
  list(): Promise<RegistryEntry[]>;
  upsert(entry: RegistryEntry): Promise<void>;
  remove(logicalKey: string): Promise<void>;
}

/** In-memory registry, for tests and dry runs. */
export function memoryRegistry(initial: readonly RegistryEntry[] = []): RegistryStore & {
  readonly entries: Map<string, RegistryEntry>;
} {
  const entries = new Map(initial.map((entry) => [entry.logicalKey, entry]));
  return {
    entries,
    list: () => Promise.resolve([...entries.values()]),
    upsert: (entry) => {
      entries.set(entry.logicalKey, entry);
      return Promise.resolve();
    },
    remove: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}
