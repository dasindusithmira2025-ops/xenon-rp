import { ConflictError, NotFoundError, ValidationError } from '@xenon/core';
import {
  type Db,
  type DiscordProvisionMode,
  type DiscordProvisionRun,
  type DiscordResourceType,
  type Prisma,
} from '@xenon/database';
import { publishedRulebook, recordAudit, setting, statusBoard } from '@xenon/domain';
import { type Actor, requirePermission } from '@xenon/permissions';

import {
  type BlueprintFeatures,
  CLEANUP_PHRASE,
  type EnforcementMode,
  enforcementModes,
  type OrganizationSpace,
  organizationSpaceSchema,
  parseDepartmentSpace,
  parseFeatures,
  PLAN_APPROVAL_TTL_MS,
  PROVISION_PHRASE,
  SETTING_ENFORCEMENT,
  SETTING_FEATURES,
  departmentSpaceSchema,
  blueprintFeaturesSchema,
} from './config';
import { BLUEPRINT_VERSION } from './types';

import type { DepartmentInput } from './blueprint';
import type { PanelContext } from './panels';
import type { RegistryStore } from './ports';
import type { PlanItem, RegistryEntry } from './types';

/**
 * Database side of provisioning.
 *
 * Everything here is Postgres and Xenon RBAC; nothing touches Discord. The web
 * tier imports this module to queue runs, resolve conflicts and configure
 * spaces, and the bot imports it to load inputs and record results - so both
 * sides agree on what a run, a resolution or a space is.
 *
 * Every mutation checks `system.discord.bootstrap` (or the destructive
 * capability) itself, the same way every other Xenon service does: the
 * surface calling it is never the thing that authorises it.
 */

export type RunMode = DiscordProvisionMode;

// --- Registry ------------------------------------------------------------------

function toEntry(row: {
  logicalKey: string;
  resourceType: DiscordResourceType;
  discordResourceId: string | null;
  channelId: string | null;
  managed: boolean;
  contentHash: string | null;
  configurationHash: string | null;
  createdByRunId: string | null;
  metadata: Prisma.JsonValue;
}): RegistryEntry {
  return {
    logicalKey: row.logicalKey,
    resourceType: row.resourceType,
    discordId: row.discordResourceId,
    channelId: row.channelId,
    managed: row.managed,
    contentHash: row.contentHash,
    configurationHash: row.configurationHash,
    createdByRunId: row.createdByRunId,
    metadata:
      row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
  };
}

export function prismaRegistry(db: Db, guildId: string): RegistryStore {
  return {
    async list() {
      const rows = await db.discordManagedResource.findMany({ where: { guildId } });
      return rows.map(toEntry);
    },
    async upsert(entry) {
      const data = {
        resourceType: entry.resourceType,
        discordResourceId: entry.discordId,
        channelId: entry.channelId,
        managed: entry.managed,
        contentHash: entry.contentHash,
        configurationHash: entry.configurationHash,
        createdByRunId: entry.createdByRunId,
        blueprintVersion: BLUEPRINT_VERSION,
        metadata: entry.metadata as Prisma.InputJsonValue,
        lastVerifiedAt: new Date(),
      };
      await db.discordManagedResource.upsert({
        where: { guildId_logicalKey: { guildId, logicalKey: entry.logicalKey } },
        create: { guildId, logicalKey: entry.logicalKey, ...data },
        update: data,
      });
    },
    async remove(logicalKey) {
      await db.discordManagedResource.deleteMany({ where: { guildId, logicalKey } });
    },
  };
}

// --- Settings ----------------------------------------------------------------------

async function readJsonSetting(db: Db, key: string): Promise<unknown> {
  const row = await db.systemSetting.findUnique({ where: { key } });
  if (row === null) return undefined;
  if (typeof row.value === 'string') {
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return row.value;
    }
  }
  return row.value;
}

export async function blueprintFeatures(db: Db): Promise<BlueprintFeatures> {
  return parseFeatures(await readJsonSetting(db, SETTING_FEATURES));
}

export async function enforcementMode(db: Db): Promise<EnforcementMode> {
  const value = await readJsonSetting(db, SETTING_ENFORCEMENT);
  return enforcementModes.find((mode) => mode === value) ?? 'OBSERVE';
}

async function writeSetting(
  db: Db,
  actor: Actor,
  key: string,
  value: Prisma.InputJsonValue,
  label: string,
) {
  await db.systemSetting.upsert({
    where: { key },
    create: { key, value, kind: 'JSON', category: 'discord', label, updatedBy: actor.userId },
    update: { value, updatedBy: actor.userId },
  });
  await recordAudit(db, actor, {
    action: 'discord.provisioning_setting_updated',
    entityType: 'setting',
    entityId: key,
    entityLabel: key,
    after: value,
  });
}

export async function saveBlueprintFeatures(
  db: Db,
  actor: Actor,
  raw: unknown,
): Promise<BlueprintFeatures> {
  requirePermission(actor, 'system.discord.bootstrap');
  const parsed = blueprintFeaturesSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError({ _form: ['Those features are not valid.'] });
  await writeSetting(db, actor, SETTING_FEATURES, parsed.data, 'Discord blueprint features');
  return parsed.data;
}

export async function saveEnforcementMode(
  db: Db,
  actor: Actor,
  mode: string,
): Promise<EnforcementMode> {
  requirePermission(actor, 'system.discord.bootstrap');
  const valid = enforcementModes.find((candidate) => candidate === mode);
  if (valid === undefined)
    throw new ValidationError({ mode: ['Choose OBSERVE, REPAIR or ENFORCE.'] });
  await writeSetting(db, actor, SETTING_ENFORCEMENT, valid, 'Discord enforcement mode');
  return valid;
}

// --- Blueprint inputs ----------------------------------------------------------

export async function loadDepartmentInputs(db: Db): Promise<DepartmentInput[]> {
  const rows = await db.department.findMany({ orderBy: { sortOrder: 'asc' } });
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    shortName: row.shortName,
    accentColour: row.accentColour,
    roleKey: row.roleKey,
    recruitmentState: row.recruitmentState,
    published: row.status === 'PUBLISHED',
    space: parseDepartmentSpace(row.discordSpace),
  }));
}

/** Organisation spaces are registry rows of type SPACE until Xenon models organisations. */
export async function loadOrganizationSpaces(
  db: Db,
  guildId: string,
): Promise<OrganizationSpace[]> {
  const rows = await db.discordManagedResource.findMany({
    where: { guildId, resourceType: 'SPACE', logicalKey: { startsWith: 'space.org.' } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.flatMap((row) => {
    const parsed = organizationSpaceSchema.safeParse(row.metadata);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function saveDepartmentSpace(
  db: Db,
  actor: Actor,
  departmentId: string,
  raw: unknown,
) {
  requirePermission(actor, 'system.discord.bootstrap');
  const parsed = departmentSpaceSchema.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError({ _form: ['That Discord space configuration is not valid.'] });
  const department = await db.department.update({
    where: { id: departmentId },
    data: { discordSpace: parsed.data },
    select: { id: true, slug: true },
  });
  await recordAudit(db, actor, {
    action: 'discord.department_space_configured',
    entityType: 'department',
    entityId: department.id,
    entityLabel: department.slug,
    after: parsed.data,
  });
  return parsed.data;
}

/**
 * Record (or update) an organisation space. Nothing is created in Discord
 * until the next approved apply, and archiving never deletes: the category is
 * locked to management with its history intact.
 */
export async function saveOrganizationSpace(db: Db, actor: Actor, guildId: string, raw: unknown) {
  requirePermission(actor, 'system.discord.bootstrap');
  const parsed = organizationSpaceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join('.') || '_form', [issue.message]]),
      ),
    );
  }
  const logicalKey = `space.org.${parsed.data.key}`;
  const previous = await db.discordManagedResource.findUnique({
    where: { guildId_logicalKey: { guildId, logicalKey } },
  });
  await db.discordManagedResource.upsert({
    where: { guildId_logicalKey: { guildId, logicalKey } },
    create: {
      guildId,
      logicalKey,
      resourceType: 'SPACE',
      blueprintVersion: BLUEPRINT_VERSION,
      metadata: parsed.data,
    },
    update: { metadata: parsed.data },
  });
  await recordAudit(db, actor, {
    action: parsed.data.archived
      ? 'DISCORD_SPACE_ARCHIVED'
      : previous === null
        ? 'DISCORD_SPACE_CREATED'
        : 'DISCORD_SPACE_UPDATED',
    entityType: 'discord_space',
    entityId: logicalKey,
    entityLabel: parsed.data.name,
    after: parsed.data,
  });
  return parsed.data;
}

// --- Panels ------------------------------------------------------------------------

/** Everything panels render, read from Xenon's canonical services. */
export async function loadPanelData(
  db: Db,
): Promise<Omit<PanelContext, 'siteUrl' | 'linksAllowed' | 'emojis' | 'selfRoles'>> {
  const [board, rulebook, connectUrl, globallyOpen, templates, departments] = await Promise.all([
    statusBoard(db),
    publishedRulebook(db),
    setting(db, 'community.connectUrl'),
    setting(db, 'applications.globallyOpen'),
    db.applicationTemplate.findMany({
      where: { status: 'OPEN', archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      select: { name: true, slug: true, grantsWhitelist: true, opensAt: true, closesAt: true },
    }),
    db.department.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { sortOrder: 'asc' },
      select: { slug: true, name: true, tagline: true, recruitmentState: true },
    }),
  ]);

  const now = Date.now();
  const open = templates.filter(
    (template) =>
      (template.opensAt === null || template.opensAt.getTime() <= now) &&
      (template.closesAt === null || template.closesAt.getTime() > now),
  );
  const online = board.servers.filter((server) => server.state === 'ONLINE');
  const queues = online.map((server) => server.queueLength);
  const reported = queues.filter((queue): queue is number => queue !== null);
  const restarts = board.servers
    .map((server) => server.nextRestartAt)
    .filter((value): value is string => value !== null)
    .sort();

  return {
    connectUrl: /^https?:\/\//.test(connectUrl) ? connectUrl : null,
    rules: {
      version: rulebook.version,
      retrievedAt:
        rulebook.sourceRetrievedAt === null ? null : new Date(rulebook.sourceRetrievedAt),
    },
    applications: {
      globallyOpen: globallyOpen !== 'false',
      whitelistOpen: open.some((template) => template.grantsWhitelist),
      open: open.map((template) => ({ name: template.name, slug: template.slug })),
    },
    departments,
    status: {
      aggregate: board.aggregate,
      totalPlayers: board.totalPlayers,
      totalCapacity: board.totalCapacity,
      // Only a real sum: if any online server did not report a queue, say nothing.
      queue:
        queues.length > 0 && reported.length === queues.length
          ? reported.reduce((sum, q) => sum + q, 0)
          : null,
      nextRestartAt: restarts[0] ?? null,
      checkedAt: board.checkedAt,
      servers: board.servers.map((server) => ({
        name: server.name,
        state: server.state,
        players: server.playerCount,
        max: server.maxPlayers,
      })),
    },
  };
}

// --- Runs ----------------------------------------------------------------------------

export interface RunRequest {
  readonly guildId: string;
  readonly mode: RunMode;
  /** Required for APPLY, REPAIR and CLEANUP. */
  readonly basedOnRunId?: string;
  readonly confirmation?: string;
  readonly acknowledgeEstablished?: boolean;
  readonly includeSoft?: boolean;
  readonly force?: boolean;
}

const MUTATING_MODES: ReadonlySet<RunMode> = new Set(['APPLY', 'REPAIR', 'CLEANUP']);

/**
 * Queue a provisioning run after checking everything a surface could forget.
 *
 * Mutating runs need the typed phrase and a recent successful plan to execute
 * against; an established guild with no Xenon history additionally needs an
 * explicit acknowledgement, because that is the server most likely to hold a
 * community's history.
 */
export async function createRun(
  db: Db,
  actor: Actor,
  request: RunRequest,
): Promise<DiscordProvisionRun> {
  requirePermission(
    actor,
    request.mode === 'CLEANUP'
      ? 'system.discord.bootstrap.destructive'
      : 'system.discord.bootstrap',
  );

  if (MUTATING_MODES.has(request.mode)) {
    const phrase = request.mode === 'CLEANUP' ? CLEANUP_PHRASE : PROVISION_PHRASE;
    if (request.confirmation?.trim() !== phrase) {
      throw new ValidationError({ confirmation: [`Type ${phrase} to continue.`] });
    }
    if (request.basedOnRunId === undefined) {
      throw new ValidationError({ _form: ['Generate and review a plan first.'] });
    }
    const basis = await db.discordProvisionRun.findUnique({ where: { id: request.basedOnRunId } });
    if (basis?.guildId !== request.guildId)
      throw new NotFoundError('provision run', request.basedOnRunId);

    if (request.mode === 'CLEANUP') {
      if (basis.mode !== 'APPLY' && basis.mode !== 'REPAIR') {
        throw new ConflictError(
          'Only apply or repair runs can be cleaned up',
          'Choose the failed apply run to clean up.',
        );
      }
    } else {
      if (basis.mode !== 'PLAN' || basis.status !== 'SUCCEEDED' || basis.completedAt === null) {
        throw new ConflictError(
          'The basis is not a completed plan',
          'Generate a fresh plan and review it before applying.',
        );
      }
      if (Date.now() - basis.completedAt.getTime() > PLAN_APPROVAL_TTL_MS) {
        throw new ConflictError(
          'Plan approval expired',
          'That plan is more than 30 minutes old. Generate a fresh one.',
        );
      }
      const profile = planProfile(basis.plannedChanges);
      if (profile === 'ESTABLISHED' && request.acknowledgeEstablished !== true) {
        throw new ValidationError({
          acknowledgeEstablished: [
            'This server already has substantial structure. Confirm you reviewed every conflict.',
          ],
        });
      }
    }
  }

  const running = await db.discordProvisionRun.findFirst({
    where: {
      guildId: request.guildId,
      status: { in: ['QUEUED', 'RUNNING'] },
      mode: { in: ['APPLY', 'REPAIR', 'CLEANUP'] },
    },
    select: { id: true },
  });
  if (running !== null && MUTATING_MODES.has(request.mode)) {
    throw new ConflictError(
      'A provisioning run is already in progress',
      'Wait for the current run to finish.',
    );
  }

  const run = await db.discordProvisionRun.create({
    data: {
      guildId: request.guildId,
      mode: request.mode,
      source: actor.source,
      actorId: actor.userId,
      actorLabel: actor.label,
      blueprintVersion: BLUEPRINT_VERSION,
      basedOnRunId: request.basedOnRunId ?? null,
      options: {
        includeSoft: request.includeSoft === true,
        force: request.force === true,
        acknowledgeEstablished: request.acknowledgeEstablished === true,
      },
    },
  });

  if (MUTATING_MODES.has(request.mode)) {
    await recordAudit(db, actor, {
      action: `DISCORD_SETUP_${request.mode}_REQUESTED`,
      entityType: 'discord_provision_run',
      entityId: run.id,
      entityLabel: request.guildId,
      metadata: { basedOnRunId: request.basedOnRunId ?? null },
    });
  }
  return run;
}

export function planProfile(planned: Prisma.JsonValue | null): string | null {
  if (planned === null || typeof planned !== 'object' || Array.isArray(planned)) return null;
  const profile = (planned as Record<string, unknown>).profile;
  return typeof profile === 'string' ? profile : null;
}

export function planSignatureOf(planned: Prisma.JsonValue | null): string[] {
  if (planned === null || typeof planned !== 'object' || Array.isArray(planned)) return [];
  const signature = (planned as Record<string, unknown>).signature;
  return Array.isArray(signature)
    ? signature.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function recentRuns(db: Db, guildId: string, take = 20) {
  return db.discordProvisionRun.findMany({
    where: { guildId },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

// --- Conflict resolution -----------------------------------------------------

export const conflictResolutions = [
  'ADOPT',
  'KEEP_UNMANAGED',
  'CREATE_ALTERNATIVE',
  'MANUAL',
] as const;
export type ConflictResolution = (typeof conflictResolutions)[number];

/**
 * Record an operator's decision on a conflict from a plan.
 *
 * ADOPT puts the existing resource under Xenon management (history kept, next
 * apply brings it to the blueprint). KEEP_UNMANAGED records a hands-off
 * decision so the plan stops asking. CREATE_ALTERNATIVE makes the next apply
 * create a separately named resource. MANUAL clears any decision.
 */
export async function resolveConflict(
  db: Db,
  actor: Actor,
  input: { guildId: string; planRunId: string; key: string; resolution: string },
): Promise<void> {
  requirePermission(actor, 'system.discord.bootstrap');
  const resolution = conflictResolutions.find((candidate) => candidate === input.resolution);
  if (resolution === undefined) throw new ValidationError({ resolution: ['Unknown resolution.'] });

  const run = await db.discordProvisionRun.findUnique({ where: { id: input.planRunId } });
  if (run?.guildId !== input.guildId || run.mode !== 'PLAN')
    throw new NotFoundError('plan', input.planRunId);
  const item = planItems(run.plannedChanges).find((candidate) => candidate.key === input.key);
  if (item?.kind !== 'CONFLICT' || item.conflict === undefined) {
    throw new ConflictError(
      'Not a conflict in that plan',
      'Regenerate the plan; this conflict is no longer current.',
    );
  }

  const where = { guildId_logicalKey: { guildId: input.guildId, logicalKey: input.key } };
  if (resolution === 'MANUAL') {
    await db.discordManagedResource.deleteMany({
      where: { guildId: input.guildId, logicalKey: input.key, createdByRunId: null },
    });
  } else {
    const alternativeName =
      item.resourceType === 'ROLE'
        ? `${item.conflict.name} · Xenon`
        : `${item.conflict.name}-xenon`.slice(0, 100);
    const base = {
      resourceType: item.resourceType,
      blueprintVersion: BLUEPRINT_VERSION,
      managed: resolution !== 'KEEP_UNMANAGED',
      discordResourceId: resolution === 'CREATE_ALTERNATIVE' ? null : item.conflict.id,
      metadata:
        resolution === 'CREATE_ALTERNATIVE'
          ? { alternativeName }
          : { adoptedFrom: item.conflict.name },
    };
    await db.discordManagedResource.upsert({
      where,
      create: { guildId: input.guildId, logicalKey: input.key, ...base },
      update: base,
    });
  }

  await recordAudit(db, actor, {
    action: resolution === 'ADOPT' ? 'DISCORD_RESOURCE_ADOPTED' : `DISCORD_CONFLICT_${resolution}`,
    entityType: 'discord_resource',
    entityId: input.key,
    entityLabel: item.conflict.name,
    metadata: { discordId: item.conflict.id, planRunId: input.planRunId },
  });
}

export function planItems(planned: Prisma.JsonValue | null): PlanItem[] {
  if (planned === null || typeof planned !== 'object' || Array.isArray(planned)) return [];
  const items = (planned as Record<string, unknown>).items;
  return Array.isArray(items) ? (items as PlanItem[]) : [];
}

// --- Integration write-back ------------------------------------------------------

/**
 * Point Xenon at what was provisioned: review, announcement and log channels,
 * and Xenon-role → Discord-role mappings. An existing mapping to a different
 * Discord role is an operator's choice and is left alone.
 */
export async function saveIntegration(
  db: Db,
  actor: Actor,
  input: {
    guildId: string;
    guildName: string;
    channels: Partial<Record<'reviewChannel' | 'announcementChannel' | 'logChannel', string>>;
    roleMappings: readonly {
      xenonRoleKey: string;
      discordRoleId: string;
      discordRoleName: string;
    }[];
  },
): Promise<{ mapped: number; skipped: number }> {
  const guild = await db.discordGuild.upsert({
    where: { guildId: input.guildId },
    create: {
      guildId: input.guildId,
      name: input.guildName,
      isPrimary: true,
      reviewChannelId: input.channels.reviewChannel ?? null,
      announcementChannelId: input.channels.announcementChannel ?? null,
      logChannelId: input.channels.logChannel ?? null,
    },
    update: {
      name: input.guildName,
      ...(input.channels.reviewChannel === undefined
        ? {}
        : { reviewChannelId: input.channels.reviewChannel }),
      ...(input.channels.announcementChannel === undefined
        ? {}
        : { announcementChannelId: input.channels.announcementChannel }),
      ...(input.channels.logChannel === undefined
        ? {}
        : { logChannelId: input.channels.logChannel }),
    },
  });

  let mapped = 0;
  let skipped = 0;
  for (const mapping of input.roleMappings) {
    const role = await db.role.findUnique({
      where: { key: mapping.xenonRoleKey },
      select: { id: true },
    });
    if (role === null) {
      skipped += 1;
      continue;
    }
    const existing = await db.discordRoleMapping.findUnique({
      where: { guildId_roleId: { guildId: guild.id, roleId: role.id } },
    });
    if (existing !== null && existing.discordRoleId !== mapping.discordRoleId) {
      skipped += 1;
      continue;
    }
    const taken = await db.discordRoleMapping.findUnique({
      where: { guildId_discordRoleId: { guildId: guild.id, discordRoleId: mapping.discordRoleId } },
    });
    if (taken !== null && taken.roleId !== role.id) {
      skipped += 1;
      continue;
    }
    await db.discordRoleMapping.upsert({
      where: { guildId_roleId: { guildId: guild.id, roleId: role.id } },
      create: {
        guildId: guild.id,
        roleId: role.id,
        discordRoleId: mapping.discordRoleId,
        discordRoleName: mapping.discordRoleName,
      },
      update: { discordRoleName: mapping.discordRoleName },
    });
    mapped += 1;
  }

  await recordAudit(db, actor, {
    action: 'discord.integration_configured',
    entityType: 'discord_guild',
    entityId: guild.id,
    entityLabel: guild.name,
    after: { ...input.channels, mappedRoles: mapped },
  });
  return { mapped, skipped };
}
