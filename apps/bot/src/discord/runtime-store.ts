import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BlueprintFeatures, RegistryEntry, RegistryStore } from '@xenon/discord/provisioning/pure';

export interface TemporaryRoomRecord {
  readonly guildId: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly createdAt: string;
}

export type TicketStatus = 'OPEN' | 'CLOSED';

/** One Discord-only support ticket. Keyed by `ticketId` in the guild state. */
export interface TicketRecord {
  readonly ticketId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly category: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
  /** Member who closed it; null when the system closed a ticket whose channel vanished. */
  readonly closedBy: string | null;
  readonly status: TicketStatus;
}

/**
 * Existing Discord resources selected with `/xenon tickets publish`. Never
 * created by Xenon. Documents written before per-type categories may still
 * carry a `ticketCategoryId`; it is ignored on load.
 */
export interface TicketConfig {
  readonly ticketPanelChannelId: string;
  readonly ticketLogChannelId: string;
  readonly ticketStaffRoleId: string;
  readonly ticketPanelMessageId: string | null;
}

export interface DiscordGuildRuntimeState {
  readonly entries: readonly RegistryEntry[];
  readonly features: Partial<BlueprintFeatures>;
  readonly welcomeEnabled: boolean;
  readonly welcomeDmEnabled: boolean;
  readonly rooms: Readonly<Record<string, TemporaryRoomRecord>>;
  readonly ticketConfig: TicketConfig | null;
  /** Ticket type value → id of the Discord category Xenon created for it. */
  readonly ticketCategories: Readonly<Record<string, string>>;
  readonly tickets: Readonly<Record<string, TicketRecord>>;
  /** Last issued ticket number; only ever increases so references are never reused. */
  readonly ticketSequence: number;
}

/** Storage contract so the PostgreSQL service can replace JSON without feature changes. */
export interface DiscordRuntimeStore {
  getGuild(guildId: string): Promise<DiscordGuildRuntimeState>;
  updateGuild(
    guildId: string,
    update: (state: DiscordGuildRuntimeState) => DiscordGuildRuntimeState,
  ): Promise<void>;
  registry(guildId: string): RegistryStore;
  saveFeatures(guildId: string, features: Partial<BlueprintFeatures>): Promise<void>;
  saveWelcome(
    guildId: string,
    settings: Pick<DiscordGuildRuntimeState, 'welcomeEnabled' | 'welcomeDmEnabled'>,
  ): Promise<void>;
  saveRoom(room: TemporaryRoomRecord): Promise<void>;
  removeRoom(guildId: string, channelId: string): Promise<void>;
  saveTicketConfig(guildId: string, config: TicketConfig): Promise<void>;
  /** Records a ticket category Xenon created, as soon as it exists. */
  saveTicketCategory(guildId: string, ticketType: string, categoryId: string): Promise<void>;
  /** Allocates the next `XN-TK-NNNN` reference; gaps are fine, reuse never happens. */
  reserveTicketId(guildId: string): Promise<string>;
  /** Inserts an OPEN ticket unless the owner already has one; false when rejected. */
  openTicket(ticket: TicketRecord): Promise<boolean>;
  /** OPEN → CLOSED transition; null when the ticket is missing or already closed. */
  closeTicket(
    guildId: string,
    ticketId: string,
    closedBy: string | null,
    closedAt: string,
  ): Promise<TicketRecord | null>;
}

interface RuntimeDocument {
  readonly version: 1;
  readonly guilds: Readonly<Record<string, DiscordGuildRuntimeState>>;
}

const EMPTY_GUILD: DiscordGuildRuntimeState = {
  entries: [],
  features: {},
  welcomeEnabled: true,
  welcomeDmEnabled: false,
  rooms: {},
  ticketConfig: null,
  tickets: {},
  ticketSequence: 0,
  ticketCategories: {},
};

const TICKET_ID = /^XN-TK-(\d{4,9})$/;
const TICKET_TYPE = /^[A-Z_]{1,32}$/;

const SENSITIVE_KEY = /(?:secret|token|password|credential|database|redis|auth|pepper|private.?key)/i;
const SNOWFLAKE = /^\d{17,20}$/;
const RESOURCE_TYPES = new Set([
  'ROLE', 'CATEGORY', 'CHANNEL', 'EMOJI', 'STICKER', 'PANEL', 'SPACE', 'AUTOMOD',
]);
const FEATURES = new Set<keyof BlueprintFeatures>([
  'faq', 'introductions', 'media', 'clips', 'screenshots', 'offTopic', 'suggestions',
  'communityHelp', 'departmentsDirectory', 'cityGuide', 'businessDirectory', 'laws', 'commands',
  'whitelistInfo', 'recruitment', 'patchNotes', 'events', 'voiceLounges', 'tempVoice',
  'languageRoles', 'applicationReview', 'staffResources', 'automod', 'livePresence',
]);

export function defaultRuntimeStorePath(start = process.cwd()): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')))
      return join(current, '.data', 'discord-runtime.json');
    const parent = dirname(current);
    if (parent === current) return join(resolve(start), '.data', 'discord-runtime.json');
    current = parent;
  }
}

/** Local, atomic persistence for Discord-owned state only. Never accepts secrets. */
export class JsonDiscordRuntimeStore implements DiscordRuntimeStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = defaultRuntimeStorePath()) {}

  public async getGuild(guildId: string): Promise<DiscordGuildRuntimeState> {
    assertSnowflake(guildId, 'guildId');
    await this.writes;
    const document = await this.read();
    return cloneGuild(document.guilds[guildId] ?? EMPTY_GUILD);
  }

  public async updateGuild(
    guildId: string,
    update: (state: DiscordGuildRuntimeState) => DiscordGuildRuntimeState,
  ): Promise<void> {
    assertSnowflake(guildId, 'guildId');
    return this.enqueue(async () => {
      const document = await this.read();
      const current = cloneGuild(document.guilds[guildId] ?? EMPTY_GUILD);
      const nextGuild = update(current);
      assertSafe(nextGuild);
      const next: RuntimeDocument = {
        version: 1,
        guilds: { ...document.guilds, [guildId]: validateGuild(nextGuild, true) },
      };
      await this.write(next);
    });
  }

  public registry(guildId: string): RegistryStore {
    assertSnowflake(guildId, 'guildId');
    return {
      list: async () => [...(await this.getGuild(guildId)).entries],
      upsert: async (entry) => {
        assertSafe(entry);
        await this.updateGuild(guildId, (state) => ({
          ...state,
          entries: [...state.entries.filter((item) => item.logicalKey !== entry.logicalKey), entry],
        }));
      },
      remove: async (logicalKey) => {
        await this.updateGuild(guildId, (state) => ({
          ...state,
          entries: state.entries.filter((entry) => entry.logicalKey !== logicalKey),
        }));
      },
    };
  }

  public async saveFeatures(
    guildId: string,
    features: Partial<BlueprintFeatures>,
  ): Promise<void> {
    await this.updateGuild(guildId, (state) => ({ ...state, features }));
  }

  public async saveWelcome(
    guildId: string,
    settings: Pick<DiscordGuildRuntimeState, 'welcomeEnabled' | 'welcomeDmEnabled'>,
  ): Promise<void> {
    await this.updateGuild(guildId, (state) => ({ ...state, ...settings }));
  }

  public async saveRoom(room: TemporaryRoomRecord): Promise<void> {
    assertSnowflake(room.guildId, 'room.guildId');
    assertSnowflake(room.channelId, 'room.channelId');
    assertSnowflake(room.ownerId, 'room.ownerId');
    await this.updateGuild(room.guildId, (state) => ({
      ...state,
      rooms: { ...state.rooms, [room.channelId]: room },
    }));
  }

  public async removeRoom(guildId: string, channelId: string): Promise<void> {
    await this.updateGuild(guildId, (state) => {
      const rooms = { ...state.rooms };
      delete rooms[channelId];
      return { ...state, rooms };
    });
  }

  public async saveTicketConfig(guildId: string, config: TicketConfig): Promise<void> {
    await this.updateGuild(guildId, (state) => ({ ...state, ticketConfig: config }));
  }

  public async saveTicketCategory(guildId: string, ticketType: string, categoryId: string): Promise<void> {
    assertSnowflake(categoryId, 'categoryId');
    if (!TICKET_TYPE.test(ticketType)) throw new Error('Invalid ticket type.');
    await this.updateGuild(guildId, (state) => ({
      ...state,
      ticketCategories: { ...state.ticketCategories, [ticketType]: categoryId },
    }));
  }

  public async reserveTicketId(guildId: string): Promise<string> {
    let sequence = 0;
    await this.updateGuild(guildId, (state) => {
      sequence = state.ticketSequence + 1;
      return { ...state, ticketSequence: sequence };
    });
    return `XN-TK-${String(sequence).padStart(4, '0')}`;
  }

  public async openTicket(ticket: TicketRecord): Promise<boolean> {
    let opened = false;
    await this.updateGuild(ticket.guildId, (state) => {
      const duplicate = Object.values(state.tickets).some(
        (existing) =>
          existing.ticketId === ticket.ticketId ||
          (existing.ownerId === ticket.ownerId && existing.status === 'OPEN'),
      );
      if (duplicate) return state;
      opened = true;
      return { ...state, tickets: { ...state.tickets, [ticket.ticketId]: ticket } };
    });
    return opened;
  }

  public async closeTicket(
    guildId: string,
    ticketId: string,
    closedBy: string | null,
    closedAt: string,
  ): Promise<TicketRecord | null> {
    let closed: TicketRecord | null = null;
    await this.updateGuild(guildId, (state) => {
      const current = state.tickets[ticketId];
      if (current?.status !== 'OPEN') return state;
      closed = { ...current, status: 'CLOSED', closedAt, closedBy };
      return { ...state, tickets: { ...state.tickets, [ticketId]: closed } };
    });
    return closed;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<RuntimeDocument> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      assertSafe(raw);
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.guilds))
        throw new Error('Unsupported Discord runtime persistence document.');
      const guilds: Record<string, DiscordGuildRuntimeState> = {};
      for (const [guildId, state] of Object.entries(raw.guilds)) {
        assertSnowflake(guildId, 'guildId');
        guilds[guildId] = validateGuild(state, false);
      }
      return { version: 1, guilds };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, guilds: {} };
      throw error;
    }
  }

  private async write(document: RuntimeDocument): Promise<void> {
    assertSafe(document);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * `strict` is used for writes. Reads tolerate documents written before tickets
 * existed and drop malformed ticket data instead of taking the whole bot down.
 */
function validateGuild(value: unknown, strict: boolean): DiscordGuildRuntimeState {
  if (!isRecord(value) || !Array.isArray(value.entries) || !isRecord(value.features))
    throw new Error('Invalid Discord guild runtime state.');
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) || typeof entry.logicalKey !== 'string' ||
      !RESOURCE_TYPES.has(String(entry.resourceType)) ||
      !(entry.discordId === null || typeof entry.discordId === 'string') ||
      !(entry.channelId === null || typeof entry.channelId === 'string') ||
      typeof entry.managed !== 'boolean' || !isRecord(entry.metadata)
    ) throw new Error('Invalid Discord resource registry entry.');
    for (const key of ['contentHash', 'configurationHash', 'createdByRunId'])
      if (!(entry[key] === null || typeof entry[key] === 'string'))
        throw new Error(`Invalid Discord resource registry field ${key}.`);
    return entry as unknown as RegistryEntry;
  });
  const features: Partial<BlueprintFeatures> = {};
  for (const [key, enabled] of Object.entries(value.features)) {
    if (!FEATURES.has(key as keyof BlueprintFeatures) || typeof enabled !== 'boolean')
      throw new Error('Invalid Discord feature configuration.');
    features[key as keyof BlueprintFeatures] = enabled;
  }
  const welcomeEnabled = value.welcomeEnabled ?? true;
  const welcomeDmEnabled = value.welcomeDmEnabled ?? false;
  if (typeof welcomeEnabled !== 'boolean' || typeof welcomeDmEnabled !== 'boolean')
    throw new Error('Invalid Discord welcome configuration.');
  const rooms: Record<string, TemporaryRoomRecord> = {};
  if (value.rooms !== undefined) {
    if (!isRecord(value.rooms)) throw new Error('Invalid temporary voice room registry.');
    for (const [channelId, room] of Object.entries(value.rooms)) {
      if (!isRecord(room) || room.channelId !== channelId || typeof room.createdAt !== 'string')
        throw new Error('Invalid temporary voice room registry entry.');
      assertSnowflake(room.guildId, 'room.guildId');
      assertSnowflake(room.ownerId, 'room.ownerId');
      assertSnowflake(channelId, 'room.channelId');
      rooms[channelId] = room as unknown as TemporaryRoomRecord;
    }
  }
  const ticketConfig = parseTicketConfig(value.ticketConfig);
  if (ticketConfig === undefined && strict) throw new Error('Invalid ticket configuration.');
  const tickets: Record<string, TicketRecord> = {};
  if (value.tickets !== undefined) {
    if (!isRecord(value.tickets)) {
      if (strict) throw new Error('Invalid ticket registry.');
    } else {
      for (const [ticketId, ticket] of Object.entries(value.tickets)) {
        const parsed = parseTicket(ticketId, ticket);
        if (parsed !== null) tickets[ticketId] = parsed;
        else if (strict) throw new Error('Invalid ticket registry entry.');
      }
    }
  }
  const storedSequence =
    typeof value.ticketSequence === 'number' && Number.isSafeInteger(value.ticketSequence) && value.ticketSequence >= 0
      ? value.ticketSequence
      : 0;
  if (strict && storedSequence !== value.ticketSequence) throw new Error('Invalid ticket sequence.');
  // Never hand out a reference that already exists, even if the counter was lost.
  const ticketSequence = Object.keys(tickets).reduce(
    (highest, ticketId) => Math.max(highest, Number(TICKET_ID.exec(ticketId)?.[1] ?? 0)),
    storedSequence,
  );
  const ticketCategories: Record<string, string> = {};
  if (value.ticketCategories !== undefined) {
    if (!isRecord(value.ticketCategories)) {
      if (strict) throw new Error('Invalid ticket categories.');
    } else {
      for (const [ticketType, categoryId] of Object.entries(value.ticketCategories)) {
        if (TICKET_TYPE.test(ticketType) && isSnowflake(categoryId)) ticketCategories[ticketType] = categoryId;
        else if (strict) throw new Error('Invalid ticket category entry.');
      }
    }
  }
  return {
    entries,
    features,
    welcomeEnabled,
    welcomeDmEnabled,
    rooms,
    ticketConfig: ticketConfig ?? null,
    ticketCategories,
    tickets,
    ticketSequence,
  };
}

/** null when absent; undefined when present but malformed. */
function parseTicketConfig(value: unknown): TicketConfig | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const ids = [value.ticketPanelChannelId, value.ticketLogChannelId, value.ticketStaffRoleId];
  if (!ids.every(isSnowflake)) return undefined;
  if (!(value.ticketPanelMessageId === null || isSnowflake(value.ticketPanelMessageId))) return undefined;
  return {
    ticketPanelChannelId: value.ticketPanelChannelId as string,
    ticketLogChannelId: value.ticketLogChannelId as string,
    ticketStaffRoleId: value.ticketStaffRoleId as string,
    ticketPanelMessageId: value.ticketPanelMessageId,
  };
}

function parseTicket(ticketId: string, value: unknown): TicketRecord | null {
  if (
    !isRecord(value) ||
    value.ticketId !== ticketId ||
    !TICKET_ID.test(ticketId) ||
    !isSnowflake(value.guildId) ||
    !isSnowflake(value.channelId) ||
    !isSnowflake(value.ownerId) ||
    typeof value.category !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !(value.closedAt === null || typeof value.closedAt === 'string') ||
    !(value.closedBy === null || isSnowflake(value.closedBy)) ||
    (value.status !== 'OPEN' && value.status !== 'CLOSED')
  )
    return null;
  return {
    ticketId,
    guildId: value.guildId,
    channelId: value.channelId,
    ownerId: value.ownerId,
    category: value.category,
    createdAt: value.createdAt,
    closedAt: value.closedAt,
    closedBy: value.closedBy,
    status: value.status,
  };
}

function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

function cloneGuild(state: DiscordGuildRuntimeState): DiscordGuildRuntimeState {
  return structuredClone(state);
}

function assertSafe(value: unknown, parent = ''): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafe(item, parent);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`Sensitive field ${parent}${key} cannot be persisted.`);
    assertSafe(item, `${parent}${key}.`);
  }
}

function assertSnowflake(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value))
    throw new Error(`${name} must be a Discord snowflake.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
