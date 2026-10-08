import { randomUUID } from 'node:crypto';

export type TrustLevel = 'SECURITY_ADMIN' | 'TRUSTED_STAFF' | 'NORMAL_STAFF' | 'UNTRUSTED';
export type SecuritySeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RaidMode = 'AUTO' | 'ON' | 'OFF';
export type LinkAction = 'ALLOW' | 'WARN' | 'BLOCK';
export type IncidentStatus = 'OPEN' | 'CONTAINED' | 'RESOLVED';
export type CaseAction =
  | 'WARN'
  | 'TIMEOUT'
  | 'UNTIMEOUT'
  | 'KICK'
  | 'BAN'
  | 'UNBAN'
  | 'SOFTBAN'
  | 'PURGE'
  | 'QUARANTINE'
  | 'UNQUARANTINE';
const CASE_ACTIONS: readonly CaseAction[] = [
  'WARN',
  'TIMEOUT',
  'UNTIMEOUT',
  'KICK',
  'BAN',
  'UNBAN',
  'SOFTBAN',
  'PURGE',
  'QUARANTINE',
  'UNQUARANTINE',
];
const SECURITY_SEVERITIES: readonly SecuritySeverity[] = [
  'INFO',
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
];
const DANGEROUS_ROLE_PERMISSIONS = [
  'Administrator',
  'ManageRoles',
  'ManageChannels',
  'ManageGuild',
  'BanMembers',
  'KickMembers',
  'ManageWebhooks',
  'MentionEveryone',
] as const;

export interface SecurityConfig {
  readonly enabled: boolean;
  readonly modules: {
    readonly raid: boolean;
    readonly antiNuke: boolean;
    readonly spam: boolean;
    readonly linkGuard: boolean;
    readonly permissionGuard: boolean;
    readonly autoMod: boolean;
    readonly lockdown: boolean;
  };
  readonly channels: {
    readonly alerts: string | null;
    readonly audit: string | null;
    readonly modLogs: string | null;
  };
  readonly quarantineRoleId: string | null;
  readonly trustedActors: Readonly<Record<string, TrustLevel>>;
  readonly protectedRoleIds: readonly string[];
  readonly lockdownChannelIds: readonly string[];
  readonly ownedAutoModRuleIds: readonly string[];
  readonly prohibitedKeywords: readonly string[];
  readonly raidMode: RaidMode;
  /** Minutes without a further elevated join before automatic raid response is released. */
  readonly raidRecoveryMinutes: number;
  /** Slowmode applied to lockdown channels during a raid; 0 disables. */
  readonly raidSlowmodeSeconds: number;
  readonly raidThresholds: {
    readonly warning10s: number;
    readonly raid10s: number;
    readonly critical10s: number;
    readonly warning30s: number;
    readonly raid30s: number;
    readonly critical30s: number;
    readonly newAccountRatio: number;
  };
  readonly spam: {
    readonly messagesPer8Seconds: number;
    readonly duplicateLimit: number;
    readonly mentionLimit: number;
    readonly linksPer30Seconds: number;
    readonly emojiLimit: number;
    readonly exemptRoleIds: readonly string[];
    readonly exemptChannelIds: readonly string[];
  };
  readonly links: {
    readonly action: LinkAction;
    readonly trustedDomains: readonly string[];
    readonly blockedDomains: readonly string[];
    readonly blockInvites: boolean;
    readonly blockShorteners: boolean;
  };
  readonly autoLockdownOnCritical: boolean;
}

export interface SecurityIncident {
  readonly id: string;
  readonly severity: SecuritySeverity;
  readonly title: string;
  readonly source: string;
  readonly rule: string;
  readonly createdAt: string;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly evidence: readonly string[];
  readonly automatic: boolean;
  readonly actionTaken: readonly string[];
  readonly auditCorrelation: 'CONFIRMED' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  readonly status: IncidentStatus;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly resolution?: string;
}

export interface ModerationCase {
  readonly id: string;
  readonly action: CaseAction;
  readonly moderatorId: string;
  readonly targetId: string | null;
  readonly reason: string;
  readonly createdAt: string;
  readonly durationSeconds: number | null;
  readonly evidenceReference: string | null;
}

export interface OverwriteSnapshot {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: string;
  readonly deny: string;
}

export type SecurityPatchStatus =
  'PENDING' | 'APPLYING' | 'APPLIED' | 'RESTORING' | 'RESTORED' | 'CONFLICT';

export interface SecurityOverwritePatch {
  readonly id: string;
  readonly type: 0 | 1;
  readonly mask: string;
  readonly before: OverwriteSnapshot | null;
  readonly after: OverwriteSnapshot;
  readonly status: SecurityPatchStatus;
}

export interface LockdownChannelSnapshot {
  readonly channelId: string;
  readonly overwrites: readonly OverwriteSnapshot[];
  /** Missing only on legacy snapshots that cannot be safely restored automatically. */
  readonly patches?: readonly SecurityOverwritePatch[];
}

export interface QuarantineChannelSnapshot {
  readonly channelId: string;
  readonly patch: SecurityOverwritePatch;
}

export interface QuarantineSnapshot {
  readonly targetId: string;
  readonly actorId: string;
  readonly roleId: string | null;
  readonly markerRoleAdded: boolean;
  readonly startedAt: string;
  readonly reason: string;
  readonly status: 'APPLYING' | 'ACTIVE' | 'PARTIAL' | 'RESTORING';
  readonly channels: readonly QuarantineChannelSnapshot[];
}

export interface LockdownSnapshot {
  readonly startedAt: string;
  readonly reason: string;
  readonly incidentId: string | null;
  /** Complete intended target count, so an interrupted activation cannot resume as fully contained. */
  readonly targetCount?: number;
  /** Targets that could not be protected at planning time (bounded). */
  readonly failures?: readonly string[];
  readonly channels: readonly LockdownChannelSnapshot[];
}

export interface GuildSecuritySnapshot {
  readonly createdAt: string;
  readonly roles: readonly {
    readonly id: string;
    readonly name: string;
    readonly permissions: string;
    readonly position: number;
  }[];
  readonly channels: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: number;
    readonly parentId: string | null;
    readonly overwrites: readonly OverwriteSnapshot[];
  }[];
  readonly config: SecurityConfig;
}

export interface RaidResponseState {
  readonly level: 'RAID' | 'CRITICAL';
  readonly since: string;
  readonly lastEscalationAt: string;
  readonly incidentId: string | null;
  readonly slowmode: readonly {
    readonly channelId: string;
    readonly before: number;
    readonly applied: number;
  }[];
}

export interface SecurityGuildState {
  readonly config: SecurityConfig;
  readonly incidents: readonly SecurityIncident[];
  readonly cases: readonly ModerationCase[];
  readonly lockdown: LockdownSnapshot | null;
  readonly quarantines: readonly QuarantineSnapshot[];
  readonly snapshots: readonly GuildSecuritySnapshot[];
  readonly raidResponse: RaidResponseState | null;
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  modules: {
    raid: true,
    antiNuke: true,
    spam: true,
    linkGuard: true,
    permissionGuard: true,
    autoMod: true,
    lockdown: true,
  },
  channels: { alerts: null, audit: null, modLogs: null },
  quarantineRoleId: null,
  trustedActors: {},
  protectedRoleIds: [],
  lockdownChannelIds: [],
  ownedAutoModRuleIds: [],
  prohibitedKeywords: [],
  raidMode: 'AUTO',
  raidRecoveryMinutes: 10,
  raidSlowmodeSeconds: 30,
  raidThresholds: {
    warning10s: 5,
    raid10s: 9,
    critical10s: 15,
    warning30s: 10,
    raid30s: 18,
    critical30s: 28,
    newAccountRatio: 0.6,
  },
  spam: {
    messagesPer8Seconds: 7,
    duplicateLimit: 3,
    mentionLimit: 6,
    linksPer30Seconds: 4,
    emojiLimit: 20,
    exemptRoleIds: [],
    exemptChannelIds: [],
  },
  links: {
    action: 'WARN',
    trustedDomains: [],
    blockedDomains: [],
    blockInvites: true,
    blockShorteners: false,
  },
  autoLockdownOnCritical: true,
};

export const EMPTY_SECURITY_STATE: SecurityGuildState = {
  config: DEFAULT_SECURITY_CONFIG,
  incidents: [],
  cases: [],
  lockdown: null,
  quarantines: [],
  snapshots: [],
  raidResponse: null,
};

export function createIncident(
  fields: Omit<SecurityIncident, 'id' | 'createdAt' | 'status'> & {
    readonly id?: string;
    readonly createdAt?: string;
  },
): SecurityIncident {
  return {
    ...fields,
    id: fields.id ?? `XEN-SEC-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
    createdAt: fields.createdAt ?? new Date().toISOString(),
    status: 'OPEN',
  };
}

export function createCase(
  fields: Omit<ModerationCase, 'id' | 'createdAt'> & {
    readonly id?: string;
    readonly createdAt?: string;
  },
): ModerationCase {
  return {
    ...fields,
    id: fields.id ?? `XEN-MOD-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
    createdAt: fields.createdAt ?? new Date().toISOString(),
  };
}

export function validateSecurityState(value: unknown, strict: boolean): SecurityGuildState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    if (strict) throw new Error('Invalid security state.');
    return EMPTY_SECURITY_STATE;
  }
  const raw = value as Record<string, unknown>;
  const config = parseConfig(raw.config, strict);
  const incidents = parseList(raw.incidents, parseIncident, strict, 500);
  const cases = parseList(raw.cases, parseCase, strict, 5_000);
  const snapshots = parseList(raw.snapshots, parseSnapshot, strict, 5).slice(-5);
  const quarantines = parseList(raw.quarantines, parseQuarantine, strict, 5_000);
  const lockdown =
    raw.lockdown === null || raw.lockdown === undefined
      ? null
      : parseLockdown(raw.lockdown, strict);
  const raidResponse = parseRaidResponse(raw.raidResponse, strict);
  return { config, incidents, cases, snapshots, lockdown, quarantines, raidResponse };
}

function parseConfig(value: unknown, strict: boolean): SecurityConfig {
  if (!isRecord(value))
    return strict ? fail('Invalid security configuration.') : DEFAULT_SECURITY_CONFIG;
  try {
    const raw = value;
    const prohibitedKeywords =
      Array.isArray(raw.prohibitedKeywords) &&
      raw.prohibitedKeywords.length <= 98 &&
      raw.prohibitedKeywords.every(
        (entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 60,
      )
        ? [...new Set(raw.prohibitedKeywords.map((entry) => (entry as string).trim()))]
        : strict
          ? fail('Invalid prohibited keyword list.')
          : [];
    const modules = readRecord(raw.modules, 'modules');
    const channels = readRecord(raw.channels, 'channels');
    const thresholds = readRecord(raw.raidThresholds, 'raidThresholds');
    const spam = readRecord(raw.spam, 'spam');
    const links = readRecord(raw.links, 'links');
    const trust: Record<string, TrustLevel> = {};
    if (isRecord(raw.trustedActors) && Object.keys(raw.trustedActors).length <= 500) {
      for (const [userId, level] of Object.entries(raw.trustedActors)) {
        if (isSnowflake(userId) && isTrustLevel(level)) trust[userId] = level;
        else if (strict) fail('Invalid trusted actor.');
      }
    } else if (strict) fail('Invalid trusted actors.');
    const raidMode = isRaidMode(raw.raidMode)
      ? raw.raidMode
      : strict
        ? fail('Invalid raid mode.')
        : DEFAULT_SECURITY_CONFIG.raidMode;
    const linkAction = isLinkAction(links.action)
      ? links.action
      : strict
        ? fail('Invalid link action.')
        : DEFAULT_SECURITY_CONFIG.links.action;
    const config: SecurityConfig = {
      enabled: configBoolean(raw.enabled, strict, true),
      modules: {
        raid: configBoolean(modules.raid, strict, true),
        antiNuke: configBoolean(modules.antiNuke, strict, true),
        spam: configBoolean(modules.spam, strict, true),
        linkGuard: configBoolean(modules.linkGuard, strict, true),
        permissionGuard: configBoolean(modules.permissionGuard, strict, true),
        autoMod: configBoolean(modules.autoMod, strict, true),
        lockdown: configBoolean(modules.lockdown, strict, true),
      },
      channels: {
        alerts: configId(channels.alerts, strict, null),
        audit: configId(channels.audit, strict, null),
        modLogs: configId(channels.modLogs, strict, null),
      },
      quarantineRoleId: configId(raw.quarantineRoleId, strict, null),
      trustedActors: trust,
      protectedRoleIds: configIds(raw.protectedRoleIds, strict),
      lockdownChannelIds: configIds(raw.lockdownChannelIds, strict),
      ownedAutoModRuleIds:
        Array.isArray(raw.ownedAutoModRuleIds) &&
        raw.ownedAutoModRuleIds.length <= 100 &&
        raw.ownedAutoModRuleIds.every(isSnowflake)
          ? raw.ownedAutoModRuleIds
          : strict
            ? fail('Invalid AutoMod rule IDs.')
            : [],
      prohibitedKeywords,
      raidRecoveryMinutes: optionalConfigInteger(
        raw.raidRecoveryMinutes,
        1,
        1_440,
        strict,
        DEFAULT_SECURITY_CONFIG.raidRecoveryMinutes,
      ),
      raidSlowmodeSeconds: optionalConfigInteger(
        raw.raidSlowmodeSeconds,
        0,
        21_600,
        strict,
        DEFAULT_SECURITY_CONFIG.raidSlowmodeSeconds,
      ),
      raidMode,
      raidThresholds: {
        warning10s: configNumber(
          thresholds.warning10s,
          1,
          1_000,
          strict,
          DEFAULT_SECURITY_CONFIG.raidThresholds.warning10s,
        ),
        raid10s: configNumber(
          thresholds.raid10s,
          2,
          1_000,
          strict,
          DEFAULT_SECURITY_CONFIG.raidThresholds.raid10s,
        ),
        critical10s: configNumber(
          thresholds.critical10s,
          3,
          1_000,
          strict,
          DEFAULT_SECURITY_CONFIG.raidThresholds.critical10s,
        ),
        warning30s: configNumber(
          thresholds.warning30s,
          1,
          2_000,
          strict,
          DEFAULT_SECURITY_CONFIG.raidThresholds.warning30s,
        ),
        raid30s: configNumber(
          thresholds.raid30s,
          2,
          2_000,
          strict,
          DEFAULT_SECURITY_CONFIG.raidThresholds.raid30s,
        ),
        critical30s: configNumber(
          thresholds.critical30s,
          3,
          2_000,
          strict,
          DEFAULT_SECURITY_CONFIG.raidThresholds.critical30s,
        ),
        newAccountRatio: configNumber(
          thresholds.newAccountRatio,
          0,
          1,
          strict,
          DEFAULT_SECURITY_CONFIG.raidThresholds.newAccountRatio,
        ),
      },
      spam: {
        messagesPer8Seconds: configNumber(
          spam.messagesPer8Seconds,
          2,
          100,
          strict,
          DEFAULT_SECURITY_CONFIG.spam.messagesPer8Seconds,
        ),
        duplicateLimit: configNumber(
          spam.duplicateLimit,
          2,
          20,
          strict,
          DEFAULT_SECURITY_CONFIG.spam.duplicateLimit,
        ),
        mentionLimit: configNumber(
          spam.mentionLimit,
          1,
          50,
          strict,
          DEFAULT_SECURITY_CONFIG.spam.mentionLimit,
        ),
        linksPer30Seconds: configNumber(
          spam.linksPer30Seconds,
          2,
          100,
          strict,
          DEFAULT_SECURITY_CONFIG.spam.linksPer30Seconds,
        ),
        emojiLimit: configNumber(
          spam.emojiLimit,
          1,
          100,
          strict,
          DEFAULT_SECURITY_CONFIG.spam.emojiLimit,
        ),
        exemptRoleIds: configIds(spam.exemptRoleIds, strict),
        exemptChannelIds: configIds(spam.exemptChannelIds, strict),
      },
      links: {
        action: linkAction,
        trustedDomains: stringList(links.trustedDomains, strict),
        blockedDomains: stringList(links.blockedDomains, strict),
        blockInvites: configBoolean(links.blockInvites, strict, true),
        blockShorteners: configBoolean(links.blockShorteners, strict, false),
      },
      autoLockdownOnCritical: configBoolean(raw.autoLockdownOnCritical, strict, true),
    };
    if (
      strict &&
      (config.raidThresholds.warning10s >= config.raidThresholds.raid10s ||
        config.raidThresholds.raid10s >= config.raidThresholds.critical10s ||
        config.raidThresholds.warning30s >= config.raidThresholds.raid30s ||
        config.raidThresholds.raid30s >= config.raidThresholds.critical30s)
    )
      throw new Error('Raid thresholds must increase by severity.');
    return config;
  } catch (error) {
    if (strict) throw error;
    return DEFAULT_SECURITY_CONFIG;
  }
}

function configBoolean(value: unknown, strict: boolean, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (strict) throw new Error('Invalid security boolean.');
  return fallback;
}

function configNumber(
  value: unknown,
  min: number,
  max: number,
  strict: boolean,
  fallback: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
    return value;
  if (strict) throw new Error('Invalid security threshold.');
  return fallback;
}

function optionalConfigInteger(
  value: unknown,
  min: number,
  max: number,
  strict: boolean,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)
    return value;
  if (strict) throw new Error('Invalid security setting.');
  return fallback;
}

function parseRaidResponse(value: unknown, strict: boolean): RaidResponseState | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    (value.level !== 'RAID' && value.level !== 'CRITICAL') ||
    !validDate(value.since) ||
    !validDate(value.lastEscalationAt) ||
    !optionalIncidentId(value.incidentId ?? null) ||
    !Array.isArray(value.slowmode) ||
    value.slowmode.length > 500
  ) {
    if (strict) fail('Invalid raid response state.');
    return null;
  }
  const slowmode: { channelId: string; before: number; applied: number }[] = [];
  for (const entry of value.slowmode) {
    if (
      isRecord(entry) &&
      isSnowflake(entry.channelId) &&
      typeof entry.before === 'number' &&
      Number.isInteger(entry.before) &&
      entry.before >= 0 &&
      entry.before <= 21_600 &&
      typeof entry.applied === 'number' &&
      Number.isInteger(entry.applied) &&
      entry.applied >= 0 &&
      entry.applied <= 21_600
    )
      slowmode.push({ channelId: entry.channelId, before: entry.before, applied: entry.applied });
    else if (strict) fail('Invalid raid slowmode record.');
  }
  return {
    level: value.level,
    since: value.since,
    lastEscalationAt: value.lastEscalationAt,
    incidentId: (value.incidentId as string | null | undefined) ?? null,
    slowmode,
  };
}

function configId(value: unknown, strict: boolean, fallback: string | null): string | null {
  if (value === null) return null;
  if (isSnowflake(value)) return value;
  if (strict) throw new Error('Invalid security channel or role ID.');
  return fallback;
}

function configIds(
  value: unknown,
  strict: boolean,
  fallback: readonly string[] = [],
): readonly string[] {
  if (Array.isArray(value) && value.length <= 500 && value.every(isSnowflake)) return value;
  if (strict) throw new Error('Invalid security ID list.');
  return fallback;
}

function parseList<T>(
  value: unknown,
  parse: (entry: unknown) => T | null,
  strict: boolean,
  maximum: number,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return strict ? fail('Invalid security list.') : [];
  if (strict && value.length > maximum) throw new Error('Security list limit exceeded.');
  const parsed: T[] = [];
  for (const entry of value.slice(-maximum)) {
    const item = parse(entry);
    if (item === null) {
      if (strict) fail('Invalid security record.');
    } else parsed.push(item);
  }
  return parsed;
}

function parseIncident(value: unknown): SecurityIncident | null {
  if (
    !isRecord(value) ||
    !shortString(value.id, 80) ||
    !severity(value.severity) ||
    !shortString(value.title, 200) ||
    !shortString(value.source, 80) ||
    !shortString(value.rule, 120) ||
    !validDate(value.createdAt) ||
    !optionalSnowflake(value.actorId) ||
    !optionalSnowflake(value.targetId) ||
    !stringArray(value.evidence, 30, 500) ||
    typeof value.automatic !== 'boolean' ||
    !stringArray(value.actionTaken, 20, 200) ||
    (value.resolvedAt !== undefined && !validDate(value.resolvedAt)) ||
    (value.resolvedBy !== undefined && !optionalSnowflake(value.resolvedBy)) ||
    (value.resolution !== undefined && !shortString(value.resolution, 500)) ||
    !['CONFIRMED', 'UNAVAILABLE', 'NOT_APPLICABLE'].includes(String(value.auditCorrelation)) ||
    !['OPEN', 'CONTAINED', 'RESOLVED'].includes(String(value.status))
  )
    return null;
  return value as unknown as SecurityIncident;
}
function parseCase(value: unknown): ModerationCase | null {
  if (
    !isRecord(value) ||
    !shortString(value.id, 80) ||
    !isCaseAction(value.action) ||
    !isSnowflake(value.moderatorId) ||
    !optionalSnowflake(value.targetId) ||
    !shortString(value.reason, 1_000) ||
    !validDate(value.createdAt) ||
    !(
      value.durationSeconds === null ||
      (Number.isSafeInteger(value.durationSeconds) && Number(value.durationSeconds) > 0)
    ) ||
    !(value.evidenceReference === null || shortString(value.evidenceReference, 500))
  )
    return null;
  return value as unknown as ModerationCase;
}
function parseLockdown(value: unknown, strict: boolean): LockdownSnapshot | null {
  if (
    !isRecord(value) ||
    !validDate(value.startedAt) ||
    !shortString(value.reason, 1_000) ||
    !optionalIncidentId(value.incidentId) ||
    !Array.isArray(value.channels)
  )
    return strict ? fail('Invalid lockdown snapshot.') : null;
  const channels = value.channels.map(parseLockdownChannel);
  if (channels.some((channel) => channel === null))
    return strict ? fail('Invalid lockdown channel snapshot.') : null;
  const targetCount =
    typeof value.targetCount === 'number' &&
    Number.isInteger(value.targetCount) &&
    value.targetCount >= 0 &&
    value.targetCount <= 1_000
      ? value.targetCount
      : undefined;
  const failures = stringArray(value.failures, 20, 300) ? value.failures : undefined;
  return {
    startedAt: value.startedAt,
    reason: value.reason,
    incidentId: value.incidentId,
    channels: channels as LockdownChannelSnapshot[],
    ...(targetCount === undefined ? {} : { targetCount }),
    ...(failures === undefined ? {} : { failures }),
  };
}
function parseLockdownChannel(value: unknown): LockdownChannelSnapshot | null {
  if (
    !isRecord(value) ||
    !isSnowflake(value.channelId) ||
    !Array.isArray(value.overwrites) ||
    value.overwrites.length > 1_000
  )
    return null;
  const overwrites = value.overwrites.map(parseOverwriteSnapshot);
  if (overwrites.some((entry) => entry === null)) return null;
  if (value.patches === undefined)
    return { channelId: value.channelId, overwrites: overwrites as OverwriteSnapshot[] };
  if (!Array.isArray(value.patches) || value.patches.length > 1_000) return null;
  const patches = value.patches.map(parseSecurityOverwritePatch);
  return patches.some((patch) => patch === null)
    ? null
    : {
        channelId: value.channelId,
        overwrites: overwrites as OverwriteSnapshot[],
        patches: patches as SecurityOverwritePatch[],
      };
}

function parseQuarantine(value: unknown): QuarantineSnapshot | null {
  if (
    !isRecord(value) ||
    !isSnowflake(value.targetId) ||
    !isSnowflake(value.actorId) ||
    !optionalSnowflake(value.roleId) ||
    !validDate(value.startedAt) ||
    !shortString(value.reason, 1_000) ||
    !['APPLYING', 'ACTIVE', 'PARTIAL', 'RESTORING'].includes(String(value.status)) ||
    !Array.isArray(value.channels) ||
    value.channels.length > 1_000
  )
    return null;
  const channels = value.channels.map((entry) => {
    if (!isRecord(entry) || !isSnowflake(entry.channelId)) return null;
    const patch = parseSecurityOverwritePatch(entry.patch);
    return patch === null ? null : { channelId: entry.channelId, patch };
  });
  return channels.some((entry) => entry === null)
    ? null
    : {
        targetId: value.targetId,
        actorId: value.actorId,
        roleId: value.roleId,
        markerRoleAdded: value.markerRoleAdded === true,
        startedAt: value.startedAt,
        reason: value.reason,
        status: value.status as QuarantineSnapshot['status'],
        channels: channels as QuarantineChannelSnapshot[],
      };
}

function parseSecurityOverwritePatch(value: unknown): SecurityOverwritePatch | null {
  if (
    !isRecord(value) ||
    !isSnowflake(value.id) ||
    (value.type !== 0 && value.type !== 1) ||
    !decimalBitfield(value.mask) ||
    !['PENDING', 'APPLYING', 'APPLIED', 'RESTORING', 'RESTORED', 'CONFLICT'].includes(
      String(value.status),
    )
  )
    return null;
  const before = value.before === null ? null : parseOverwriteSnapshot(value.before);
  const after = parseOverwriteSnapshot(value.after);
  if (
    after?.id !== value.id ||
    after.type !== value.type ||
    (before !== null && (before.id !== value.id || before.type !== value.type))
  )
    return null;
  return {
    id: value.id,
    type: value.type,
    mask: value.mask,
    before,
    after,
    status: value.status as SecurityPatchStatus,
  };
}

function parseOverwriteSnapshot(value: unknown): OverwriteSnapshot | null {
  if (
    !isRecord(value) ||
    !isSnowflake(value.id) ||
    (value.type !== 0 && value.type !== 1) ||
    !decimalBitfield(value.allow) ||
    !decimalBitfield(value.deny)
  )
    return null;
  return value as unknown as OverwriteSnapshot;
}
function parseSnapshot(value: unknown): GuildSecuritySnapshot | null {
  if (
    !isRecord(value) ||
    !validDate(value.createdAt) ||
    !Array.isArray(value.roles) ||
    !Array.isArray(value.channels)
  )
    return null;
  const roles = value.roles.map((entry) =>
    isRecord(entry) &&
    isSnowflake(entry.id) &&
    shortString(entry.name, 100) &&
    shortString(entry.permissions, 100) &&
    Number.isSafeInteger(entry.position)
      ? (entry as unknown as GuildSecuritySnapshot['roles'][number])
      : null,
  );
  const channels = value.channels.map((entry) => {
    if (
      !isRecord(entry) ||
      !isSnowflake(entry.id) ||
      !shortString(entry.name, 100) ||
      !Number.isSafeInteger(entry.type) ||
      !optionalSnowflake(entry.parentId) ||
      !Array.isArray(entry.overwrites)
    )
      return null;
    const overwrites = entry.overwrites.map((overwrite) =>
      isRecord(overwrite) &&
      isSnowflake(overwrite.id) &&
      (overwrite.type === 0 || overwrite.type === 1) &&
      shortString(overwrite.allow, 100) &&
      shortString(overwrite.deny, 100)
        ? (overwrite as unknown as OverwriteSnapshot)
        : null,
    );
    return overwrites.some((overwrite) => overwrite === null)
      ? null
      : ({
          ...entry,
          overwrites: overwrites as OverwriteSnapshot[],
        } as unknown as GuildSecuritySnapshot['channels'][number]);
  });
  const config = parseConfig(value.config, false);
  if (roles.some((entry) => entry === null) || channels.some((entry) => entry === null))
    return null;
  return {
    createdAt: value.createdAt,
    roles: roles as GuildSecuritySnapshot['roles'],
    channels: channels as GuildSecuritySnapshot['channels'],
    config,
  };
}

export function isAuthorized(
  trust: TrustLevel | undefined,
  required: TrustLevel,
  isOwner: boolean,
  hasDiscordPermission: boolean,
): boolean {
  if (!hasDiscordPermission) return false;
  if (isOwner) return true;
  if (trust === undefined) return false;
  const rank: Record<TrustLevel, number> = {
    UNTRUSTED: 0,
    NORMAL_STAFF: 1,
    TRUSTED_STAFF: 2,
    SECURITY_ADMIN: 3,
  };
  return rank[trust] >= rank[required] && trust !== 'UNTRUSTED';
}

export function maySetTrust(
  actorIsOwner: boolean,
  actorTrust: TrustLevel | undefined,
  requested: TrustLevel,
  targetTrust: TrustLevel | undefined,
): boolean {
  if (!actorIsOwner && actorTrust !== 'SECURITY_ADMIN') return false;
  if (requested === 'SECURITY_ADMIN' || targetTrust === 'SECURITY_ADMIN') return actorIsOwner;
  return true;
}

export interface JoinSignal {
  readonly userId: string;
  readonly at: number;
  readonly accountAgeMs: number;
  readonly bot: boolean;
}
export interface RaidEvaluation {
  readonly level: 'NORMAL' | 'WARNING' | 'RAID' | 'CRITICAL';
  readonly joins10s: number;
  readonly joins30s: number;
  readonly newAccountRatio: number;
  readonly reasons: readonly string[];
}
export function evaluateRaid(
  events: readonly JoinSignal[],
  now: number,
  config: SecurityConfig,
): RaidEvaluation {
  const recent10 = events.filter((event) => now - event.at >= 0 && now - event.at <= 10_000);
  const recent30 = events.filter((event) => now - event.at >= 0 && now - event.at <= 30_000);
  const newCount = recent30.filter(
    (event) => event.accountAgeMs >= 0 && event.accountAgeMs < 7 * 24 * 60 * 60 * 1_000,
  ).length;
  const newAccountRatio = recent30.length === 0 ? 0 : newCount / recent30.length;
  let rank = 0;
  const reasons: string[] = [];
  const t = config.raidThresholds;
  if (recent10.length >= t.warning10s) {
    rank = 1;
    reasons.push(`${recent10.length} joins in 10 seconds`);
  }
  if (recent30.length >= t.warning30s) {
    rank = Math.max(rank, 1);
    reasons.push(`${recent30.length} joins in 30 seconds`);
  }
  if (recent10.length >= t.raid10s || recent30.length >= t.raid30s) {
    rank = Math.max(rank, 2);
  }
  if (recent10.length >= t.critical10s || recent30.length >= t.critical30s) {
    rank = 3;
  }
  // Account age is only a corroborating signal; it never creates a raid state by itself.
  if (rank >= 1 && recent30.length >= 5 && newAccountRatio >= t.newAccountRatio) {
    rank = Math.min(3, rank + 1);
    reasons.push(
      `${Math.round(newAccountRatio * 100)}% of recent arrivals have accounts under 7 days old`,
    );
  }
  const bots = recent30.filter((event) => event.bot).length;
  if (rank >= 1 && bots >= 2) {
    rank = Math.min(3, rank + 1);
    reasons.push(`${bots} bot accounts joined in 30 seconds`);
  }
  const level = (['NORMAL', 'WARNING', 'RAID', 'CRITICAL'] as const)[rank];
  if (level === undefined) throw new Error('Invalid raid severity rank.');
  return {
    level,
    joins10s: recent10.length,
    joins30s: recent30.length,
    newAccountRatio,
    reasons,
  };
}

export type NukeAction =
  | 'CHANNEL_DELETE'
  | 'CHANNEL_CREATE'
  | 'ROLE_DELETE'
  | 'ROLE_CREATE'
  | 'ROLE_PERMISSION_ESCALATION'
  | 'MASS_BAN'
  | 'MASS_KICK'
  | 'WEBHOOK_CHANGE'
  | 'INTEGRATION_CHANGE'
  | 'MEMBER_ROLE_CHANGE'
  | 'GUILD_PERMISSION_CHANGE'
  | 'BOT_ADD'
  | 'OTHER';
export interface NukeSignal {
  readonly actorId: string;
  readonly action: NukeAction;
  readonly targetId: string;
  readonly at: number;
}
export interface NukeEvaluation {
  readonly severity: SecuritySeverity;
  readonly count: number;
  readonly rule: string;
}
const NUKE_THRESHOLDS: Partial<
  Record<
    NukeAction,
    { readonly windowMs: number; readonly critical: number; readonly high: number }
  >
> = {
  CHANNEL_DELETE: { windowMs: 30_000, high: 2, critical: 3 },
  CHANNEL_CREATE: { windowMs: 30_000, high: 5, critical: 8 },
  ROLE_DELETE: { windowMs: 30_000, high: 1, critical: 2 },
  ROLE_CREATE: { windowMs: 30_000, high: 4, critical: 7 },
  ROLE_PERMISSION_ESCALATION: { windowMs: 60_000, high: 1, critical: 2 },
  MASS_BAN: { windowMs: 30_000, high: 2, critical: 4 },
  INTEGRATION_CHANGE: { windowMs: 60_000, high: 2, critical: 4 },
  MASS_KICK: { windowMs: 30_000, high: 3, critical: 6 },
  WEBHOOK_CHANGE: { windowMs: 30_000, high: 4, critical: 8 },
  MEMBER_ROLE_CHANGE: { windowMs: 30_000, high: 8, critical: 15 },
  GUILD_PERMISSION_CHANGE: { windowMs: 60_000, high: 1, critical: 2 },
  BOT_ADD: { windowMs: 30_000, high: 1, critical: 2 },
};
export function evaluateNuke(
  signals: readonly NukeSignal[],
  candidate: NukeSignal,
  actorIsTrusted: boolean,
  now: number,
): NukeEvaluation {
  if (actorIsTrusted) return { severity: 'INFO', count: 0, rule: 'TRUSTED_ACTOR_EXEMPT' };
  const threshold = NUKE_THRESHOLDS[candidate.action];
  if (threshold === undefined) return { severity: 'INFO', count: 0, rule: 'UNMONITORED_ACTION' };
  const count = signals.filter(
    (signal) =>
      signal.actorId === candidate.actorId &&
      signal.action === candidate.action &&
      now - signal.at >= 0 &&
      now - signal.at <= threshold.windowMs,
  ).length;
  if (count >= threshold.critical)
    return {
      severity: 'CRITICAL',
      count,
      rule: `${candidate.action}_${threshold.critical}_IN_${threshold.windowMs}MS`,
    };
  if (count >= threshold.high)
    return {
      severity: 'HIGH',
      count,
      rule: `${candidate.action}_${threshold.high}_IN_${threshold.windowMs}MS`,
    };
  return { severity: 'INFO', count, rule: 'BELOW_CONTAINMENT_THRESHOLD' };
}

export interface AuditCandidate {
  readonly action: number;
  readonly targetId: string | null;
  readonly executorId: string | null;
  readonly createdTimestamp: number;
}
export function correlateAuditEntry(
  entries: readonly AuditCandidate[],
  action: number,
  targetId: string,
  eventAt: number,
  maxAgeMs = 15_000,
): AuditCandidate | null {
  return (
    entries
      .filter(
        (entry) =>
          entry.action === action &&
          entry.targetId === targetId &&
          entry.executorId !== null &&
          Math.abs(eventAt - entry.createdTimestamp) <= maxAgeMs,
      )
      .sort(
        (a, b) => Math.abs(eventAt - a.createdTimestamp) - Math.abs(eventAt - b.createdTimestamp),
      )[0] ?? null
  );
}

export function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      counts.set(gram, left - 1);
      overlap += 1;
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

export interface MessageSignal {
  readonly userId: string;
  readonly channelId: string;
  readonly content: string;
  readonly at: number;
  readonly mentionCount: number;
  readonly linkCount: number;
  readonly inviteCount: number;
  readonly emojiCount: number;
}
export interface SpamEvaluation {
  readonly severity: 'NONE' | 'OBSERVE' | 'WARN' | 'DELETE' | 'TIMEOUT' | 'ESCALATE';
  readonly reasons: readonly string[];
}
export function evaluateSpam(
  history: readonly MessageSignal[],
  candidate: MessageSignal,
  config: SecurityConfig,
  exempt: boolean,
): SpamEvaluation {
  if (exempt || config.spam.exemptChannelIds.includes(candidate.channelId))
    return { severity: 'NONE', reasons: [] };
  const recent = history.filter(
    (message) =>
      message.userId === candidate.userId &&
      candidate.at - message.at >= 0 &&
      candidate.at - message.at <= 30_000,
  );
  const candidateText = normalizedMessage(candidate.content);
  const same = recent.filter((message) => normalizedMessage(message.content) === candidateText);
  const near =
    candidateText.length >= 12
      ? recent.filter((message) => {
          const text = normalizedMessage(message.content);
          return text.length >= 12 && bigramDice(text, candidateText) >= 0.85;
        })
      : [];
  const reasons: string[] = [];
  let rank = 0;
  if (
    recent.filter((message) => candidate.at - message.at <= 8_000).length + 1 >=
    config.spam.messagesPer8Seconds
  ) {
    rank = Math.max(rank, SPAM_RANK.DELETE);
    reasons.push('message flood');
  }
  if (same.length + 1 >= config.spam.duplicateLimit) {
    rank = Math.max(rank, SPAM_RANK.DELETE);
    reasons.push('repeated identical message');
  } else if (near.length + 1 >= config.spam.duplicateLimit) {
    rank = Math.max(rank, SPAM_RANK.DELETE);
    reasons.push('near-duplicate message');
  }
  if (candidate.inviteCount > 0 && recent.some((message) => message.inviteCount > 0)) {
    rank = Math.max(rank, SPAM_RANK.DELETE);
    reasons.push('repeated invites');
  }
  if (candidate.mentionCount >= config.spam.mentionLimit) {
    rank = Math.max(rank, SPAM_RANK.TIMEOUT);
    reasons.push('excessive mentions');
  }
  if (
    candidate.linkCount > 0 &&
    recent.filter((message) => message.linkCount > 0).length + 1 >= config.spam.linksPer30Seconds
  ) {
    rank = Math.max(rank, SPAM_RANK.TIMEOUT);
    reasons.push('repeated links');
  }
  if (candidate.emojiCount >= config.spam.emojiLimit) {
    rank = Math.max(rank, SPAM_RANK.WARN);
    reasons.push('emoji flood');
  }
  const channels = new Set(
    recent
      .filter((message) => message.at >= candidate.at - 30_000)
      .map((message) => message.channelId),
  );
  channels.add(candidate.channelId);
  if (channels.size >= 4 && recent.length >= 4) {
    rank = Math.max(rank, SPAM_RANK.ESCALATE);
    reasons.push('rapid cross-channel activity');
  }
  if (reasons.length === 0 && recent.length >= Math.floor(config.spam.messagesPer8Seconds / 2)) {
    rank = SPAM_RANK.OBSERVE;
    reasons.push('elevated message rate');
  }
  const severity = SPAM_LEVELS[rank];
  if (severity === undefined) throw new Error('Invalid spam severity rank.');
  return { severity, reasons };
}

const SPAM_LEVELS = ['NONE', 'OBSERVE', 'WARN', 'DELETE', 'TIMEOUT', 'ESCALATE'] as const;
const SPAM_RANK: Record<SpamEvaluation['severity'], number> = {
  NONE: 0,
  OBSERVE: 1,
  WARN: 2,
  DELETE: 3,
  TIMEOUT: 4,
  ESCALATE: 5,
};

export function checkLink(
  rawUrl: string,
  config: SecurityConfig,
): { readonly action: LinkAction; readonly reason: string; readonly domain: string | null } {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return {
      action: config.links.action === 'ALLOW' ? 'ALLOW' : 'WARN',
      reason: 'malformed URL; local policy cannot verify it',
      domain: null,
    };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (config.links.trustedDomains.some((domain) => domainMatches(host, domain)))
    return { action: 'ALLOW', reason: 'trusted domain', domain: host };
  if (config.links.blockedDomains.some((domain) => domainMatches(host, domain)))
    return { action: 'BLOCK', reason: 'domain is configured as blocked', domain: host };
  if (config.links.blockInvites && /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/i.test(rawUrl))
    return {
      action: 'BLOCK',
      reason: 'Discord invite links are prohibited by policy',
      domain: host,
    };
  if (
    config.links.blockShorteners &&
    ['bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'ow.ly', 'buff.ly'].some((domain) =>
      domainMatches(host, domain),
    )
  )
    return { action: 'BLOCK', reason: 'URL shortener is disabled by policy', domain: host };
  if (
    host.startsWith('xn--') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    url.username.includes('@')
  )
    return {
      action: config.links.action === 'ALLOW' ? 'WARN' : config.links.action,
      reason: 'URL has a suspicious local pattern; not a malware verdict',
      domain: host,
    };
  return {
    action: config.links.action,
    reason:
      config.links.action === 'ALLOW' ? 'allowed by policy' : 'URL requires local policy review',
    domain: host,
  };
}

export function captureOverwrites(
  channelId: string,
  overwrites: readonly OverwriteSnapshot[],
): LockdownChannelSnapshot {
  if (!isSnowflake(channelId)) throw new Error('Invalid lockdown channel ID.');
  return { channelId, overwrites: overwrites.map((overwrite) => ({ ...overwrite })) };
}

export interface PermissionFinding {
  readonly severity: SecuritySeverity;
  readonly code: string;
  readonly subject: string;
  readonly detail: string;
  readonly remediation: string;
}
export interface PermissionRoleFact {
  readonly id: string;
  readonly name: string;
  readonly permissions: ReadonlySet<string>;
  readonly managed: boolean;
  readonly position: number;
}
export function scanRolePermissions(
  roles: readonly PermissionRoleFact[],
  everyoneRoleId: string,
  managedRoleIds: ReadonlySet<string>,
  botHighestRolePosition: number,
  needsAuditLog: boolean,
): PermissionFinding[] {
  const findings: PermissionFinding[] = [];
  for (const role of roles) {
    const exposed = DANGEROUS_ROLE_PERMISSIONS.filter((permission) =>
      role.permissions.has(permission),
    );
    if (role.id === everyoneRoleId && exposed.length > 0)
      findings.push({
        severity: role.permissions.has('Administrator') ? 'CRITICAL' : 'HIGH',
        code: 'DANGEROUS_EVERYONE_PERMISSION',
        subject: role.name,
        detail: exposed.join(', '),
        remediation: `Remove ${exposed.join(', ')} from @everyone in Server Settings › Roles › @everyone, and grant them only to specific staff roles.`,
      });
    else if (!managedRoleIds.has(role.id) && exposed.length > 0)
      findings.push({
        severity: role.permissions.has('Administrator') ? 'HIGH' : 'MEDIUM',
        code: 'UNEXPECTED_DANGEROUS_ROLE',
        subject: role.name,
        detail: exposed.join(', '),
        remediation: `Review whether this role needs ${exposed.join(', ')}; remove unneeded permissions or add the role to the protected role list.`,
      });
  }
  const above = roles.filter(
    (role) => managedRoleIds.has(role.id) && role.position >= botHighestRolePosition,
  );
  for (const role of above)
    findings.push({
      severity: 'HIGH',
      code: 'ROLE_ABOVE_BOT',
      subject: role.name,
      detail: 'Xenon cannot manage this role because it is at or above its highest role.',
      remediation: 'Drag the XenonBot role above this role in Server Settings › Roles.',
    });
  if (needsAuditLog && !roles.some((role) => role.permissions.has('ViewAuditLog')))
    findings.push({
      severity: 'HIGH',
      code: 'MISSING_VIEW_AUDIT_LOG',
      subject: 'XenonBot',
      detail: 'Audit-log correlation is unavailable.',
      remediation: 'Grant the XenonBot role View Audit Log in Server Settings › Roles.',
    });
  return findings;
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`Invalid security ${name}.`);
}
function fail(message: string): never {
  throw new Error(message);
}
function isTrustLevel(value: unknown): value is TrustLevel {
  return (
    value === 'SECURITY_ADMIN' ||
    value === 'TRUSTED_STAFF' ||
    value === 'NORMAL_STAFF' ||
    value === 'UNTRUSTED'
  );
}
function isRaidMode(value: unknown): value is RaidMode {
  return value === 'AUTO' || value === 'ON' || value === 'OFF';
}
function isLinkAction(value: unknown): value is LinkAction {
  return value === 'ALLOW' || value === 'WARN' || value === 'BLOCK';
}
function isCaseAction(value: unknown): value is CaseAction {
  return CASE_ACTIONS.includes(value as CaseAction);
}
function severity(value: unknown): value is SecuritySeverity {
  return SECURITY_SEVERITIES.includes(value as SecuritySeverity);
}
function optionalSnowflake(value: unknown): value is string | null {
  return value === null || isSnowflake(value);
}
function optionalIncidentId(value: unknown): value is string | null {
  return value === null || shortString(value, 80);
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function decimalBitfield(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,30}$/.test(value);
}
function shortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function stringArray(value: unknown, maxCount: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxCount &&
    value.every((item) => typeof item === 'string' && item.length <= maxLength)
  );
}
function stringList(value: unknown, strict: boolean): readonly string[] {
  if (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (entry) => typeof entry === 'string' && entry.length <= 253 && /^[a-z0-9.-]+$/i.test(entry),
    )
  )
    return [...new Set(value.map((entry) => (entry as string).toLowerCase()))];
  if (strict) throw new Error('Invalid security domain list.');
  return [];
}
function normalizedMessage(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 1_000);
}
function domainMatches(host: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return host === normalized || host.endsWith(`.${normalized}`);
}
