import { AsyncLocalStorage } from 'node:async_hooks';

import {
  AuditLogEvent,
  DiscordAPIError,
  ChannelType,
  EmbedBuilder,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildVerificationLevel,
  OverwriteType,
  PermissionFlagsBits as P,
  RateLimitError,
  type PermissionOverwriteOptions,
  type PermissionsBitField,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildBasedChannel,
  type GuildMember,
  type NonThreadGuildBasedChannel,
  type Message,
} from 'discord.js';

import { synchronizeAutoModRules, type AutoModSyncResult } from './automod';
import { SecurityEngine } from './engine';
import {
  captureOverwrites,
  checkLink,
  correlateAuditEntry,
  createCase,
  createIncident,
  isAuthorized,
  isSnowflake,
  scanRolePermissions,
  type CaseAction,
  type EnforcementMode,
  type GuildSecuritySnapshot,
  type LinkAction,
  type LockdownChannelSnapshot,
  type LockdownSnapshot,
  type ModerationCase,
  type NukeAction,
  type NukeSignal,
  type OverwriteSnapshot,
  type PermissionFinding,
  type QuarantineSnapshot,
  type RaidResponseState,
  type SecurityConfig,
  type SecurityIncident,
  type SecurityOverwritePatch,
  type SecuritySeverity,
  type TrustLevel,
} from './model';

import type { DiscordRuntimeStore } from '../runtime-store';

const DANGEROUS_PERMISSIONS = [
  P.Administrator,
  P.ManageRoles,
  P.ManageChannels,
  P.ManageGuild,
  P.BanMembers,
  P.KickMembers,
  P.ManageWebhooks,
  P.MentionEveryone,
] as const;
const URL_PATTERN = /(?:https?:\/\/[^\s<>]+|discord\.gg\/[^\s<>]+)/gi;
const INVITE_PATTERN = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/gi;
const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};
const SPAM_ENFORCEMENT_COOLDOWN_MS = 15_000;
const LINK_WARNING_DM_COOLDOWN_MS = 60_000;
const UNATTRIBUTED_WINDOW_MS = 60_000;
const UNATTRIBUTED_ALERT_COOLDOWN_MS = 5 * 60_000;
const UNATTRIBUTED_THRESHOLDS = { CHANNEL_DELETE: 3, ROLE_DELETE: 2, MEMBER_BAN: 5 } as const;
const MAX_TRACKED_KEYS = 5_000;
const DANGEROUS_PERMISSION_NAMES = [
  ['Administrator', P.Administrator],
  ['Manage Roles', P.ManageRoles],
  ['Manage Channels', P.ManageChannels],
  ['Manage Server', P.ManageGuild],
  ['Ban Members', P.BanMembers],
  ['Kick Members', P.KickMembers],
  ['Manage Webhooks', P.ManageWebhooks],
  ['Mention Everyone', P.MentionEveryone],
] as const;
const BOT_RISKY_PERMISSIONS = [
  ['Manage Roles', P.ManageRoles],
  ['Manage Server', P.ManageGuild],
  ['Ban Members', P.BanMembers],
  ['Manage Webhooks', P.ManageWebhooks],
] as const;
const EVERYONE_MANAGEMENT_PERMISSIONS = [
  ['Manage Channels', P.ManageChannels],
  ['Manage Permissions', P.ManageRoles],
  ['Manage Webhooks', P.ManageWebhooks],
] as const;
const RAID_LEVEL_RANK = { NORMAL: 0, WARNING: 1, RAID: 2, CRITICAL: 3 } as const;
export const PUBLIC_EXCLUSION = /(?:staff|security|mod|admin|ticket|support|appeal|audit)/i;
const LOCKDOWN_PERMISSIONS = [
  ['SendMessages', P.SendMessages],
  ['SendMessagesInThreads', P.SendMessagesInThreads],
  ['CreatePublicThreads', P.CreatePublicThreads],
  ['CreatePrivateThreads', P.CreatePrivateThreads],
] as const;
const QUARANTINE_PERMISSIONS = [
  ['ViewChannel', P.ViewChannel],
  ['Connect', P.Connect],
  ['Speak', P.Speak],
] as const;
const LOCKDOWN_MASK = LOCKDOWN_PERMISSIONS.reduce((mask, [, permission]) => mask | permission, 0n);
type LockdownGuildChannel = Extract<
  NonThreadGuildBasedChannel,
  {
    type:
      | ChannelType.GuildText
      | ChannelType.GuildAnnouncement
      | ChannelType.GuildForum
      | ChannelType.GuildMedia;
  }
>;
export interface EnforcementModeChange {
  readonly previous: EnforcementMode;
  readonly current: EnforcementMode;
  readonly activeRestrictions: {
    readonly lockdown: boolean;
    readonly quarantines: number;
    readonly raidSlowmodeChannels: number;
  };
}
/** Thrown before an automatic Discord mutation when the guild is not in ENFORCE mode. */
export class EnforcementBlockedError extends Error {
  public constructor(
    public readonly mode: EnforcementMode,
    public readonly label: string,
  ) {
    super(`ENFORCEMENT_MODE_BLOCKED:${mode}:${label}`);
    this.name = 'EnforcementBlockedError';
  }
}
const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function describeWould(mode: EnforcementMode, steps: readonly string[]): string {
  return `${mode === 'ALERT' ? 'ALERT ONLY' : 'OBSERVED'}: would ${listFormat.format(steps)}`;
}

/** Human list of the automatic responses ENFORCE mode would activate under this configuration. */
export function enforcedProtections(config: SecurityConfig): readonly string[] {
  if (!config.enabled) return [];
  const protections: string[] = [];
  if (config.modules.raid) {
    protections.push(
      config.raidMode === 'ON'
        ? 'Raid mode ON: quarantine every untrusted arrival'
        : 'Raid quarantine of untrusted arrivals during RAID/CRITICAL join surges',
    );
    protections.push(
      config.raidSlowmodeSeconds > 0
        ? `Raid slowmode of ${String(config.raidSlowmodeSeconds)}s on configured lockdown channels`
        : 'Raid slowmode disabled',
    );
  }
  if (config.modules.lockdown && config.autoLockdownOnCritical)
    protections.push('Automatic lockdown on CRITICAL raid or anti-nuke incidents');
  if (config.modules.antiNuke)
    protections.push('Anti-nuke containment: dangerous-role removal or timeout of the actor');
  if (config.modules.spam) protections.push('Spam message deletion and member timeouts');
  if (config.modules.linkGuard && config.links.action !== 'ALLOW')
    protections.push(
      config.links.action === 'BLOCK'
        ? 'Link deletion for blocked links'
        : 'Private warnings for flagged links',
    );
  return protections;
}

export interface NativeSafetyCheck {
  readonly name: string;
  readonly status: 'OK' | 'WARN' | 'MANUAL ACTION REQUIRED';
  readonly detail: string;
}
export interface RaidStatus {
  readonly level: 'NORMAL' | 'WARNING' | 'RAID' | 'CRITICAL';
  readonly joins10s: number;
  readonly joins30s: number;
  readonly newAccountRatio: number;
  readonly activeSince: string | null;
  readonly slowmodeChannels: number;
  readonly recoveryAt: string | null;
}
interface AlertThrottleEntry {
  postedAt: number;
  severity: SecuritySeverity;
  suppressed: number;
  ids: string[];
}
export class SecurityService {
  private readonly engine = new SecurityEngine();
  private messageContentAvailable = false;
  private readonly incidentCooldowns = new Map<string, number>();
  private readonly auditEvaluations = new Map<
    string,
    ReturnType<SecurityEngine['observeAction']>
  >();
  private readonly incidentPending = new Set<string>();
  private readonly containmentTails = new Map<string, Promise<void>>();
  private readonly spamCooldowns = new Map<string, number>();
  private readonly spamSuppressed = new Map<string, number>();
  private readonly linkWarningDms = new Map<string, number>();
  private readonly alertThrottle = new Map<string, AlertThrottleEntry>();
  private readonly unattributedWindows = new Map<string, number[]>();
  private readonly unattributedAlerts = new Map<string, number>();
  private readonly completedAuditEntries = new Set<string>();
  private readonly raidRecoveryReported = new Set<string>();
  private readonly manualContext = new AsyncLocalStorage<{
    readonly origin: 'MANUAL';
    readonly actorId: string;
  }>();

  public constructor(private readonly store: DiscordRuntimeStore) {}

  /** Marks the operation as staff-initiated; automatic-only restrictions do not apply inside it. */
  public runManual<T>(actorId: string, operation: () => Promise<T>): Promise<T> {
    return this.manualContext.run({ origin: 'MANUAL', actorId }, operation);
  }

  public async setEnforcementMode(
    guild: Guild,
    mode: EnforcementMode,
    actorId: string,
  ): Promise<EnforcementModeChange> {
    return this.runManual(actorId, async () => {
      let previous: EnforcementMode = mode;
      await this.store.updateGuild(guild.id, (current) => {
        previous = current.security.config.enforcementMode;
        return {
          ...current,
          security: {
            ...current.security,
            config: { ...current.security.config, enforcementMode: mode },
          },
        };
      });
      const security = (await this.store.getGuild(guild.id)).security;
      const activeRestrictions = {
        lockdown: security.lockdown !== null,
        quarantines: security.quarantines.length,
        raidSlowmodeChannels: security.raidResponse?.slowmode.length ?? 0,
      };
      const incident = createIncident({
        severity: 'MEDIUM',
        title: `Enforcement mode changed to ${mode}`,
        source: 'SecurityCommand',
        rule: `ENFORCEMENT_MODE_${mode}`,
        actorId,
        targetId: guild.id,
        evidence: [
          `${previous} -> ${mode}`,
          `Active restrictions kept as-is: lockdown ${activeRestrictions.lockdown ? 'active' : 'none'}, ${String(activeRestrictions.quarantines)} quarantine record(s), ${String(activeRestrictions.raidSlowmodeChannels)} raid slowmode channel(s)`,
        ],
        automatic: false,
        actionTaken: ['Enforcement mode updated; existing restrictions were not changed'],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      await this.saveIncident(guild, incident);
      await this.logIncident(guild, incident, 'audit', true);
      return { previous, current: mode, activeRestrictions };
    });
  }

  private isAutomatic(): boolean {
    return this.manualContext.getStore() === undefined;
  }

  /** Fresh persisted mode when an automatic caller is not allowed to mutate; otherwise null. */
  private async automaticBlock(guildId: string): Promise<EnforcementMode | null> {
    if (!this.isAutomatic()) return null;
    const mode = (await this.store.getGuild(guildId)).security.config.enforcementMode;
    return mode === 'ENFORCE' ? null : mode;
  }

  private async assertMutationAllowed(guildId: string, label: string): Promise<void> {
    const blocked = await this.automaticBlock(guildId);
    if (blocked !== null) throw new EnforcementBlockedError(blocked, label);
  }

  private async mutate(guildId: string, label: string, run: () => Promise<unknown>): Promise<void> {
    await this.assertMutationAllowed(guildId, label);
    await run();
  }

  /** Like `mutate`, but converts any failure into a result; `blocked` carries the mode-block code. */
  private async tryMutate(
    guildId: string,
    label: string,
    run: () => Promise<unknown>,
  ): Promise<{ readonly done: boolean; readonly blocked: string | null }> {
    try {
      await this.mutate(guildId, label, run);
      return { done: true, blocked: null };
    } catch (error) {
      return {
        done: false,
        blocked: error instanceof EnforcementBlockedError ? error.message : null,
      };
    }
  }

  /** Automatic notifications are silent in OBSERVE; only the manual async context is exempt. */
  private async notificationsAllowed(guildId: string): Promise<boolean> {
    if (!this.isAutomatic()) return true;
    return (await this.store.getGuild(guildId)).security.config.enforcementMode !== 'OBSERVE';
  }

  public setMessageContentAvailable(available: boolean): void {
    this.messageContentAvailable = available;
  }

  public async handleJoin(member: GuildMember): Promise<void> {
    const state = await this.store.getGuild(member.guild.id);
    const config = state.security.config;
    if (!config.enabled || !config.modules.raid || config.raidMode === 'OFF') return;
    const mode = config.enforcementMode;
    const botId = member.guild.members.me?.id;
    if (config.raidMode === 'ON') {
      const trust = config.trustedActors[member.id];
      if (member.id !== member.guild.ownerId && (trust === undefined || trust === 'UNTRUSTED')) {
        if (mode !== 'ENFORCE') {
          const observed = createIncident({
            severity: 'HIGH',
            title: 'Raid mode arrival requires security review',
            source: 'RaidDetector',
            rule: 'RAID_MODE_ARRIVAL',
            actorId: null,
            targetId: member.id,
            evidence: ['Manual raid mode is active; this arrival would be quarantined.'],
            automatic: true,
            actionTaken: [describeWould(mode, ['quarantine'])],
            auditCorrelation: 'NOT_APPLICABLE',
          });
          await this.saveIncident(member.guild, observed);
          await this.logIncident(member.guild, observed, 'alerts');
          return;
        }
        const result =
          botId === undefined
            ? 'QUARANTINE_BOT_ID_UNAVAILABLE'
            : await this.guardAction('QUARANTINE', () =>
                this.quarantine(
                  member,
                  'Manual raid mode is active; arrival requires security review.',
                  botId,
                ),
              );
        if (!result.startsWith('QUARANTINED:') && result !== 'QUARANTINE_ALREADY_ACTIVE') {
          const caseRecordFailed = result.startsWith('QUARANTINE_CASE_RECORD_FAILED:');
          const incident = createIncident({
            severity: 'HIGH',
            title: caseRecordFailed
              ? 'Manual raid quarantine case record failed'
              : 'Manual raid quarantine failed',
            source: 'RaidDetector',
            rule: result.split(':', 1)[0] ?? 'QUARANTINE_FAILED',
            actorId: null,
            targetId: member.id,
            evidence: [
              caseRecordFailed
                ? 'Effective quarantine was applied, but its moderation case could not be persisted.'
                : 'Manual raid mode is active; this arrival could not be fully quarantined.',
            ],
            automatic: true,
            actionTaken: [result.slice(0, 200)],
            auditCorrelation: 'NOT_APPLICABLE',
          });
          const reportedIncident = caseRecordFailed
            ? { ...incident, status: 'CONTAINED' as const }
            : incident;
          await this.saveIncident(member.guild, reportedIncident);
          await this.logIncident(member.guild, reportedIncident, 'alerts');
        }
      }
      return;
    }

    const now = Date.now();
    const observation = this.engine.observeJoin(
      {
        userId: member.id,
        at: now,
        accountAgeMs: now - member.user.createdTimestamp,
        bot: member.user.bot,
      },
      config,
    );
    const evaluation = observation.evaluation;
    if (
      evaluation.level === 'NORMAL' ||
      (evaluation.level === 'WARNING' && !observation.transitioned)
    )
      return;
    let incident: SecurityIncident | null = null;
    if (observation.transitioned) {
      const severity: SecuritySeverity =
        evaluation.level === 'CRITICAL'
          ? 'CRITICAL'
          : evaluation.level === 'RAID'
            ? 'HIGH'
            : 'MEDIUM';
      incident = createIncident({
        severity,
        title: `Raid detection entered ${evaluation.level}`,
        source: 'RaidDetector',
        rule: `JOIN_WINDOW_${evaluation.level}`,
        actorId: null,
        targetId: member.id,
        evidence: [
          `${evaluation.joins10s} joins/10s`,
          `${evaluation.joins30s} joins/30s`,
          ...evaluation.reasons,
        ],
        automatic: true,
        actionTaken: [],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      await this.saveIncident(member.guild, incident);
    }
    const trust = config.trustedActors[member.id];
    const exemptArrival =
      member.id === member.guild.ownerId || (trust !== undefined && trust !== 'UNTRUSTED');
    if (mode !== 'ENFORCE') {
      if (incident === null) return;
      const raidElevated = evaluation.level === 'RAID' || evaluation.level === 'CRITICAL';
      const would: string[] = [];
      if (raidElevated && !exemptArrival) would.push('quarantine');
      if (
        observation.transitioned &&
        evaluation.level === 'CRITICAL' &&
        config.autoLockdownOnCritical &&
        config.modules.lockdown
      )
        would.push('lock down');
      if (raidElevated && config.raidSlowmodeSeconds > 0 && config.lockdownChannelIds.length > 0)
        would.push(`apply ${String(config.raidSlowmodeSeconds)}s slowmode`);
      const observedActions = would.length === 0 ? [] : [describeWould(mode, would)];
      if (observedActions.length > 0)
        await this.updateIncident(member.guild.id, incident.id, (current) => ({
          ...current,
          actionTaken: observedActions,
        }));
      await this.logIncident(
        member.guild,
        { ...incident, actionTaken: observedActions },
        evaluation.level === 'WARNING' ? 'audit' : 'alerts',
      );
      return;
    }
    const actions: string[] = [];
    const raidFailures: string[] = [];
    if (evaluation.level === 'RAID' || evaluation.level === 'CRITICAL') {
      if (!exemptArrival)
        actions.push(
          botId === undefined
            ? 'QUARANTINE_BOT_ID_UNAVAILABLE'
            : await this.guardAction('QUARANTINE', () =>
                this.quarantine(member, `Automatic raid quarantine (${evaluation.level})`, botId),
              ),
        );
    }
    if (
      observation.transitioned &&
      evaluation.level === 'CRITICAL' &&
      config.autoLockdownOnCritical &&
      config.modules.lockdown
    ) {
      actions.push(
        await this.guardAction('LOCKDOWN', () =>
          this.activateLockdown(
            member.guild,
            'Automatic critical raid response',
            incident?.id ?? null,
            true,
          ),
        ),
      );
    }
    if (evaluation.level === 'RAID' || evaluation.level === 'CRITICAL') {
      const raidActions = await this.refreshRaidResponse(
        member.guild,
        evaluation.level,
        incident?.id ?? null,
        config,
      ).catch((error: unknown) => [`RAID_SLOWMODE_FAILED:state:${describeDiscordError(error)}`]);
      if (incident === null)
        raidFailures.push(
          ...raidActions.filter((action) => action.startsWith('RAID_SLOWMODE_FAILED')),
        );
      else actions.push(...raidActions);
    }
    if (incident === null) {
      const failure = [...actions, ...raidFailures].find(
        (action) =>
          !containmentSucceeded([action]) || action.startsWith('QUARANTINE_CASE_RECORD_FAILED:'),
      );
      if (failure === undefined) return;
      incident = createIncident({
        severity: evaluation.level === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
        title: 'Sustained raid arrival containment needs review',
        source: 'RaidDetector',
        rule: failure.split(':', 1)[0] ?? 'QUARANTINE_FAILED',
        actorId: null,
        targetId: member.id,
        evidence: [
          `${evaluation.joins10s} joins/10s`,
          `${evaluation.joins30s} joins/30s`,
          ...evaluation.reasons,
        ].map((item) => item.slice(0, 500)),
        automatic: true,
        actionTaken: [failure.slice(0, 200)],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      await this.saveIncident(member.guild, incident);
      await this.logIncident(member.guild, incident, 'alerts');
      return;
    }
    const incidentStatus: SecurityIncident['status'] = containmentSucceeded(actions)
      ? 'CONTAINED'
      : 'OPEN';
    const completedIncident =
      actions.length === 0
        ? incident
        : {
            ...incident,
            actionTaken: actions.map((action) => action.slice(0, 200)),
            status: incidentStatus,
          };
    if (actions.length > 0)
      await this.updateIncident(member.guild.id, incident.id, (current) => ({
        ...current,
        actionTaken: actions.map((action) => action.slice(0, 200)),
        status: incidentStatus,
      }));
    await this.logIncident(
      member.guild,
      completedIncident,
      evaluation.level === 'WARNING' ? 'audit' : 'alerts',
    );
  }

  public recordManualRaidMode(
    guild: Guild,
    actorId: string,
    mode: 'ON' | 'OFF' | 'AUTO',
  ): Promise<void> {
    return this.runManual(actorId, () => this.recordManualRaidModeOnce(guild, actorId, mode));
  }

  private async recordManualRaidModeOnce(
    guild: Guild,
    actorId: string,
    mode: 'ON' | 'OFF' | 'AUTO',
  ): Promise<void> {
    const incident = createIncident({
      severity: mode === 'ON' ? 'HIGH' : 'INFO',
      title: `Raid mode manually set to ${mode}`,
      source: 'SecurityCommand',
      rule: `MANUAL_RAID_MODE_${mode}`,
      actorId,
      targetId: guild.id,
      evidence: ['Authorized slash command'],
      automatic: false,
      actionTaken: [
        mode === 'ON' ? 'New arrivals quarantined pending review' : 'Raid response state updated',
      ],
      auditCorrelation: 'NOT_APPLICABLE',
    });
    await this.saveIncident(guild, incident);
    await this.logIncident(guild, incident, mode === 'ON' ? 'alerts' : 'audit');
  }

  public handleLeave(userId: string): void {
    this.engine.observeLeave(userId, Date.now());
  }

  public async handleAuditEntry(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    const completionKey = `${guild.id}:${entry.id}`;
    if (this.completedAuditEntries.has(completionKey)) return;
    // A throw (for example failed incident persistence) leaves the entry retryable.
    await this.processAuditEntry(entry, guild);
    this.completedAuditEntries.add(completionKey);
    if (this.completedAuditEntries.size > MAX_TRACKED_KEYS) {
      const oldest = this.completedAuditEntries.values().next().value;
      if (oldest !== undefined) this.completedAuditEntries.delete(oldest);
    }
  }

  private async processAuditEntry(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    const state = await this.store.getGuild(guild.id);
    const config = state.security.config;
    if (
      !config.enabled ||
      !config.modules.antiNuke ||
      entry.executorId === null ||
      entry.targetId === null
    )
      return;
    if (entry.executorId === guild.client.user.id) return;
    const denyRemoval = this.dangerousPermissionDeniedRemoved(entry);
    const denyRemovalEffective = denyRemoval
      ? await this.effectivePermissionAfterDenyRemoval(entry, guild)
      : false;
    const action = this.classifyAuditAction(entry, guild, denyRemovalEffective === true);
    if (action === 'OTHER') {
      if (denyRemoval && denyRemovalEffective === null)
        await this.logUnverifiedPermissionEscalation(entry, guild);
      return;
    }
    const correlation = correlateAuditEntry(
      [
        {
          action: entry.action,
          targetId: entry.targetId,
          executorId: entry.executorId,
          createdTimestamp: entry.createdTimestamp,
        },
      ],
      entry.action,
      entry.targetId,
      entry.createdTimestamp,
    );
    if (correlation === null) return;
    const actorIsTrusted =
      entry.executorId === guild.ownerId ||
      ['SECURITY_ADMIN', 'TRUSTED_STAFF'].includes(
        config.trustedActors[entry.executorId] ?? 'UNTRUSTED',
      );
    const signal: NukeSignal = {
      actorId: entry.executorId,
      action,
      targetId: entry.targetId,
      at: entry.createdTimestamp,
    };
    const evaluationKey = `${guild.id}:${entry.id}`;
    let evaluation = this.auditEvaluations.get(evaluationKey);
    if (evaluation === undefined) {
      evaluation = this.engine.observeAction(signal, actorIsTrusted);
      this.auditEvaluations.set(evaluationKey, evaluation);
      if (this.auditEvaluations.size > 5_000) {
        const oldest = this.auditEvaluations.keys().next().value;
        if (oldest !== undefined) this.auditEvaluations.delete(oldest);
      }
    }
    if (evaluation.severity === 'INFO') return;
    const cooldownKey = `${guild.id}:${signal.actorId}:${signal.action}:${evaluation.severity}`;
    const last = this.incidentCooldowns.get(cooldownKey) ?? 0;
    if (Date.now() - last < 30_000 || this.incidentPending.has(cooldownKey)) return;
    this.incidentPending.add(cooldownKey);
    let incident: SecurityIncident;
    try {
      incident = createIncident({
        severity: evaluation.severity,
        title: `Anti-nuke: ${action.replaceAll('_', ' ').toLowerCase()}`,
        source: 'AntiNukeEngine',
        rule: evaluation.rule,
        actorId: signal.actorId,
        targetId: signal.targetId,
        evidence: [
          `${evaluation.count} matching actions within the configured window`,
          `Audit entry ${entry.id}`,
          ...(denyRemovalEffective === true
            ? [
                'Dangerous channel permission deny removed from a target with an effective base grant.',
              ]
            : []),
          ...(entry.reason === null ? [] : [`Audit reason: ${entry.reason.slice(0, 480)}`]),
        ],
        automatic: true,
        actionTaken: [],
        auditCorrelation: 'CONFIRMED',
      });
      await this.saveIncident(guild, incident);
      this.incidentCooldowns.set(cooldownKey, Date.now());
    } finally {
      this.incidentPending.delete(cooldownKey);
    }
    const actions: string[] = [];
    if (evaluation.severity === 'CRITICAL' && config.enforcementMode !== 'ENFORCE') {
      actions.push(
        describeWould(config.enforcementMode, [
          'remove dangerous roles',
          ...(config.autoLockdownOnCritical && config.modules.lockdown ? ['lock down'] : []),
        ]),
      );
    } else if (evaluation.severity === 'CRITICAL') {
      actions.push(
        ...(await this.containActor(guild, signal.actorId, incident.id).catch((error: unknown) => [
          `Containment failed: ${describeDiscordError(error)}`,
        ])),
      );
      if (config.autoLockdownOnCritical && config.modules.lockdown) {
        actions.push(
          await this.guardAction('LOCKDOWN', () =>
            this.activateLockdown(
              guild,
              `Critical anti-nuke incident ${incident.id}`,
              incident.id,
              true,
            ),
          ),
        );
      }
    }
    const incidentStatus: SecurityIncident['status'] = containmentSucceeded(actions)
      ? 'CONTAINED'
      : 'OPEN';
    const recordedActions = actions.map((action) => action.slice(0, 200));
    const completedIncident =
      actions.length === 0
        ? incident
        : { ...incident, actionTaken: recordedActions, status: incidentStatus };
    if (actions.length > 0)
      await this.updateIncident(guild.id, incident.id, (current) => ({
        ...current,
        actionTaken: recordedActions,
        status: incidentStatus,
      }));
    await this.logIncident(guild, completedIncident, 'alerts');
    await this.logAuditEntry(guild, entry, incident.id);
  }

  public async handleMessage(message: Message): Promise<void> {
    if (
      !this.messageContentAvailable ||
      message.guild === null ||
      message.author.bot ||
      message.webhookId !== null ||
      !message.inGuild()
    )
      return;
    const guild = message.guild;
    const state = await this.store.getGuild(guild.id);
    const config = state.security.config;
    if (!config.enabled || (!config.modules.spam && !config.modules.linkGuard)) return;
    const member =
      message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
    if (member === null) return;
    const trust = trustForActor(config, member.id, guild.ownerId);
    const trustedActor = trust !== undefined && trust !== 'UNTRUSTED';
    const spamExempt =
      trustedActor ||
      config.spam.exemptRoleIds.some((roleId) => member.roles.cache.has(roleId)) ||
      config.spam.exemptChannelIds.includes(message.channelId);
    const linkMatches = [...message.content.matchAll(URL_PATTERN)].map((match) => match[0]);
    if (config.modules.linkGuard && linkMatches.length > 0 && !trustedActor) {
      for (const rawUrl of linkMatches) {
        const result = checkLink(rawUrl, config);
        if (result.action === 'ALLOW') continue;
        await this.applyLinkPolicy(
          guild,
          message,
          member,
          result.action,
          result.reason,
          result.domain,
          config.enforcementMode,
        );
        if (result.action === 'BLOCK') break;
      }
    }
    if (!config.modules.spam || spamExempt) return;
    const now = message.createdTimestamp;
    const signal = {
      userId: member.id,
      channelId: message.channelId,
      content: message.content,
      at: now,
      mentionCount:
        message.mentions.users.size +
        message.mentions.roles.size +
        (message.mentions.everyone ? config.spam.mentionLimit : 0),
      linkCount: linkMatches.length,
      inviteCount: [...message.content.matchAll(INVITE_PATTERN)].length,
      emojiCount: [
        ...message.content.matchAll(/\p{Extended_Pictographic}|<a?:[a-zA-Z0-9_]+:\d{17,20}>/gu),
      ].length,
    };
    const result = this.engine.observeMessage(signal, config, false);
    if (result.severity === 'NONE' || result.severity === 'OBSERVE') return;
    await this.applySpamResponse(
      guild,
      message,
      member,
      result.severity,
      result.reasons.join(', '),
      config.enforcementMode,
    );
  }

  public async snapshotIfStale(guild: Guild, maxAgeMs = 24 * 60 * 60 * 1_000): Promise<boolean> {
    const state = await this.store.getGuild(guild.id);
    const last = state.security.snapshots.at(-1);
    if (last !== undefined && Date.now() - Date.parse(last.createdAt) < maxAgeMs) return false;
    await this.saveSnapshot(guild);
    return true;
  }

  public async saveSnapshot(guild: Guild): Promise<GuildSecuritySnapshot> {
    const state = await this.store.getGuild(guild.id);
    const snapshot: GuildSecuritySnapshot = {
      createdAt: new Date().toISOString(),
      roles: [...guild.roles.cache.values()].map((role) => ({
        id: role.id,
        name: role.name,
        permissions: role.permissions.bitfield.toString(),
        position: role.position,
      })),
      channels: [...guild.channels.cache.values()]
        .filter(hasPermissionOverwrites)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parentId: channel.parentId,
          overwrites: channel.permissionOverwrites.cache.map((overwrite) => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield.toString(),
            deny: overwrite.deny.bitfield.toString(),
          })),
        })),
      config: state.security.config,
    };
    await this.store.updateGuild(guild.id, (current) => ({
      ...current,
      security: {
        ...current.security,
        snapshots: [...current.security.snapshots, snapshot].slice(-5),
      },
    }));
    return snapshot;
  }

  public activateLockdown(
    guild: Guild,
    reason: string,
    incidentId: string | null,
    automatic: boolean,
    actorId: string | null = null,
  ): Promise<string> {
    return this.withContainmentLock(guild.id, () =>
      this.activateLockdownOnce(guild, reason, incidentId, automatic, actorId),
    );
  }

  private async activateLockdownOnce(
    guild: Guild,
    reason: string,
    incidentId: string | null,
    automatic: boolean,
    actorId: string | null,
  ): Promise<string> {
    const blockedMode = await this.automaticBlock(guild.id);
    if (blockedMode !== null) return `ENFORCEMENT_MODE_BLOCKED:${blockedMode}`;
    const state = await this.store.getGuild(guild.id);
    const journal = state.security.lockdown;
    const interrupted =
      journal?.channels.some((channel) =>
        channel.patches?.some((patch) => patch.status === 'APPLYING' || patch.status === 'PENDING'),
      ) === true;
    if (journal !== null && !interrupted) return 'LOCKDOWN_ALREADY_ACTIVE';
    const config = state.security.config;
    if (!config.modules.lockdown) return 'LOCKDOWN_DISABLED';
    const bot = guild.members.me;
    if (!bot?.permissions.has(P.ManageRoles)) return 'LOCKDOWN_MISSING_MANAGE_ROLES';
    if (journal !== null) {
      // An earlier activation was interrupted: reconcile with live overwrites, then finish it.
      const resumed = await this.reconcileLockdownJournal(guild, journal, 'resume');
      return this.applyAndVerifyLockdown(guild, resumed, {
        reason: journal.reason,
        config,
        incidentId: journal.incidentId,
        candidateCount: journal.targetCount ?? resumed.channels.length,
        inaccessible: journal.failures ?? [],
        adminBypassRoles: this.administratorBypassRoles(guild, bot),
        automatic,
      });
    }

    let effectiveIncidentId = incidentId;
    if (effectiveIncidentId === null) {
      const incident = createIncident({
        severity: 'HIGH',
        title: 'Manual lockdown requested',
        source: 'LockdownService',
        rule: 'MANUAL_LOCKDOWN',
        actorId,
        targetId: guild.id,
        evidence: [reason.slice(0, 500)],
        automatic: false,
        actionTaken: ['Lockdown snapshot captured before channel changes'],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      await this.saveIncident(guild, incident);
      effectiveIncidentId = incident.id;
    }
    const candidateIds =
      config.lockdownChannelIds.length > 0
        ? config.lockdownChannelIds.filter(
            (channelId) =>
              ![config.channels.alerts, config.channels.audit, config.channels.modLogs].includes(
                channelId,
              ),
          )
        : [...guild.channels.cache.values()]
            .filter((channel) => this.isLockdownCandidate(channel, config))
            .map((channel) => channel.id);
    if (candidateIds.length === 0) return 'LOCKDOWN_NO_PUBLIC_CHANNELS';

    const exceptionIds = new Set(
      Object.entries(config.trustedActors)
        .filter(([, trust]) => trust !== 'UNTRUSTED')
        .map(([userId]) => userId),
    );
    const botId = guild.client.user.id;
    exceptionIds.add(botId);
    exceptionIds.add(guild.ownerId);
    const quarantinedIds = new Set(
      state.security.quarantines
        .filter((record) => record.status !== 'RESTORING')
        .map((record) => record.targetId),
    );
    for (const userId of quarantinedIds) exceptionIds.delete(userId);

    const adminBypassRoles = this.administratorBypassRoles(guild, bot);
    const inaccessible: string[] = [];
    const snapshotChannels: LockdownChannelSnapshot[] = [];
    for (const channelId of candidateIds) {
      const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
      if (channel === null || !this.isLockdownCandidate(channel, config)) {
        inaccessible.push(`${channelId}: missing or unsupported`);
        continue;
      }
      const botChannelPermissions = bot.permissionsIn(channel);
      if (!botChannelPermissions.has(P.ViewChannel)) {
        inaccessible.push(`${channel.name}: Xenon cannot view channel permissions`);
        continue;
      }
      const missingAuthority = LOCKDOWN_PERMISSIONS.filter(
        ([, permission]) => !botChannelPermissions.has(permission),
      ).map(([name]) => name);
      if (missingAuthority.length > 0) {
        inaccessible.push(
          `${channel.name}: missing permission authority for ${missingAuthority.join(', ')}`,
        );
        continue;
      }
      const overwrites = channel.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      }));
      const current = new Map(
        overwrites.map((overwrite) => [`${overwrite.type}:${overwrite.id}`, overwrite]),
      );
      const patches: SecurityOverwritePatch[] = [];
      const addPatch = (id: string, type: 0 | 1, allowed: bigint): void => {
        const before = current.get(`${type}:${id}`) ?? null;
        const patch = makeOverwritePatch(id, type, before, LOCKDOWN_MASK, allowed);
        if (patch !== null) patches.push(patch);
      };
      addPatch(guild.roles.everyone.id, 0, 0n);
      for (const overwrite of overwrites) {
        if (overwrite.type === OverwriteType.Role && overwrite.id !== guild.roles.everyone.id) {
          const role = guild.roles.cache.get(overwrite.id);
          if (
            !role?.permissions.has(P.Administrator) &&
            (BigInt(overwrite.allow) & LOCKDOWN_MASK) !== 0n
          )
            addPatch(overwrite.id, 0, 0n);
        } else if (
          overwrite.type === OverwriteType.Member &&
          !exceptionIds.has(overwrite.id) &&
          (BigInt(overwrite.allow) & LOCKDOWN_MASK) !== 0n
        ) {
          addPatch(overwrite.id, 1, 0n);
        }
      }
      for (const userId of exceptionIds) {
        if (userId === guild.ownerId) continue;
        const member =
          userId === botId
            ? bot
            : (guild.members.cache.get(userId) ??
              (await guild.members.fetch(userId).catch(() => null)));
        if (member === null || member.permissions.has(P.Administrator)) continue;
        const allowed = member.permissionsIn(channel).bitfield & LOCKDOWN_MASK;
        if (allowed !== 0n) addPatch(userId, 1, allowed);
      }
      const saved = captureOverwrites(channel.id, overwrites);
      snapshotChannels.push({ ...saved, patches });
    }
    if (snapshotChannels.length === 0)
      return `LOCKDOWN_PARTIAL:0/${candidateIds.length};${inaccessible.slice(0, 4).join(';')}`;

    const active: LockdownSnapshot = {
      startedAt: new Date().toISOString(),
      reason: reason.slice(0, 1_000),
      incidentId: effectiveIncidentId,
      channels: snapshotChannels,
      targetCount: candidateIds.length,
      failures: inaccessible.slice(0, 20).map((failure) => failure.slice(0, 300)),
    };
    await this.saveSnapshot(guild);
    await this.persistLockdown(active, guild.id);
    return this.applyAndVerifyLockdown(guild, active, {
      reason,
      config,
      incidentId: effectiveIncidentId,
      candidateCount: candidateIds.length,
      inaccessible,
      adminBypassRoles,
      automatic,
    });
  }

  private administratorBypassRoles(guild: Guild, bot: GuildMember): string[] {
    return [...guild.roles.cache.values()]
      .filter((role) => role.permissions.has(P.Administrator) && !bot.roles.cache.has(role.id))
      .map((role) => `${role.name} (${role.id})`);
  }

  private async applyAndVerifyLockdown(
    guild: Guild,
    initial: LockdownSnapshot,
    context: {
      readonly reason: string;
      readonly config: SecurityConfig;
      readonly incidentId: string | null;
      readonly candidateCount: number;
      readonly inaccessible: readonly string[];
      readonly adminBypassRoles: readonly string[];
      readonly automatic: boolean;
    },
  ): Promise<string> {
    const { reason, config, incidentId, candidateCount, inaccessible, adminBypassRoles } = context;
    let active = initial;
    const failures = [...inaccessible];
    for (const channelSnapshot of initial.channels) {
      for (const patch of channelSnapshot.patches ?? []) {
        if (patch.status === 'CONFLICT') {
          failures.push(`${channelSnapshot.channelId}/${patch.id}: conflicting overwrite state`);
          continue;
        }
        if (patch.status !== 'PENDING') continue;
        active = await this.setLockdownPatchStatus(
          active,
          guild.id,
          channelSnapshot.channelId,
          patch.id,
          'APPLYING',
        );
        const result = await this.applyOverwritePatch(
          guild,
          channelSnapshot.channelId,
          patch,
          'after',
          `Xenon lockdown: ${reason.slice(0, 300)}`,
        );
        if (result.blocked !== undefined) {
          // Mode changed after the journal entry: leave the patch APPLYING so recovery reconciles it.
          const blockedAction = result.blocked;
          if (incidentId !== null)
            await this.updateIncident(guild.id, incidentId, (current) => ({
              ...current,
              actionTaken: [...current.actionTaken, blockedAction],
              status: 'OPEN',
            }));
          return blockedAction;
        }
        active = await this.setLockdownPatchStatus(
          active,
          guild.id,
          channelSnapshot.channelId,
          patch.id,
          result.applied ? 'APPLIED' : 'CONFLICT',
        );
        if (!result.applied)
          failures.push(`${channelSnapshot.channelId}/${patch.id}: ${result.detail}`);
      }
    }

    let verified = 0;
    for (const channelSnapshot of active.channels) {
      const channel = await guild.channels
        .fetch(channelSnapshot.channelId, { force: true })
        .catch(() => null);
      if (
        channel !== null &&
        this.isLockdownCandidate(channel, config) &&
        (channelSnapshot.patches ?? []).every(
          (patch) =>
            patch.status === 'APPLIED' &&
            overwriteMatches(
              overwriteSnapshot(channel, patch.id, patch.type),
              patch.after,
              BigInt(patch.mask),
            ),
        )
      )
        verified += 1;
      else if (channel !== null && this.isLockdownCandidate(channel, config)) {
        for (const patch of channelSnapshot.patches ?? []) {
          if (
            patch.status === 'APPLIED' &&
            !overwriteMatches(
              overwriteSnapshot(channel, patch.id, patch.type),
              patch.after,
              BigInt(patch.mask),
            )
          ) {
            active = await this.setLockdownPatchStatus(
              active,
              guild.id,
              channelSnapshot.channelId,
              patch.id,
              'CONFLICT',
            );
            failures.push(`${channelSnapshot.channelId}/${patch.id}: changed after application`);
          }
        }
      }
    }
    const fullyContained =
      verified === candidateCount && failures.length === 0 && adminBypassRoles.length === 0;
    const lockdownAction = fullyContained
      ? `LOCKDOWN_ACTIVE:${verified}/${candidateCount}`
      : `LOCKDOWN_PARTIAL:${verified}/${candidateCount};${[
          ...failures.slice(0, 3),
          ...(adminBypassRoles.length === 0
            ? []
            : [`ADMINISTRATOR_BYPASS:${adminBypassRoles.length}`]),
        ].join(';')}`.slice(0, 500);
    if (incidentId !== null)
      await this.updateIncident(guild.id, incidentId, (current) => ({
        ...current,
        actionTaken: [...current.actionTaken, lockdownAction],
        status: containmentSucceeded([lockdownAction]) ? 'CONTAINED' : 'OPEN',
      }));
    await this.writeLog(
      guild,
      'alerts',
      new EmbedBuilder()
        .setColor(fullyContained ? 0x9b1c1c : 0xd97706)
        .setTitle(context.automatic ? 'Automatic lockdown result' : 'Lockdown result')
        .setDescription(reason.slice(0, 1_000))
        .addFields(
          { name: 'Incident', value: incidentId ?? 'none', inline: true },
          { name: 'Verified channels', value: `${verified}/${candidateCount}`, inline: true },
          {
            name: 'Exceptions / failures',
            value:
              [...adminBypassRoles, ...failures].slice(0, 8).join('\n').slice(0, 1_000) || 'None',
            inline: false,
          },
        )
        .setTimestamp(),
    );
    return lockdownAction;
  }

  /**
   * Compares transitional journal entries with live overwrite bits so an interrupted
   * apply/restore is never trusted blindly: after-state is APPLIED, before-state is
   * not applied (resume) or restored (release), anything else is a conflict.
   */
  private async reconcilePatchStatus(
    guild: Guild,
    channelId: string,
    patch: SecurityOverwritePatch,
    mode: 'resume' | 'release',
  ): Promise<SecurityOverwritePatch['status']> {
    if (patch.status !== 'PENDING' && patch.status !== 'APPLYING' && patch.status !== 'RESTORING')
      return patch.status;
    const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
    if (channel === null || !hasPermissionOverwrites(channel)) return patch.status;
    const mask = BigInt(patch.mask);
    const live = overwriteSnapshot(channel, patch.id, patch.type);
    if (overwriteMatches(live, patch.after, mask)) return 'APPLIED';
    if (overwriteMatches(live, patch.before, mask))
      return patch.status === 'RESTORING' || mode === 'release' ? 'RESTORED' : 'PENDING';
    return 'CONFLICT';
  }

  private async reconcileLockdownJournal(
    guild: Guild,
    snapshot: LockdownSnapshot,
    mode: 'resume' | 'release',
  ): Promise<LockdownSnapshot> {
    let active = snapshot;
    for (const channelSnapshot of snapshot.channels) {
      for (const patch of channelSnapshot.patches ?? []) {
        const status = await this.reconcilePatchStatus(
          guild,
          channelSnapshot.channelId,
          patch,
          mode,
        );
        if (status !== patch.status)
          active = await this.setLockdownPatchStatus(
            active,
            guild.id,
            channelSnapshot.channelId,
            patch.id,
            status,
          );
      }
    }
    return active;
  }

  private async reconcileQuarantineJournal(
    guild: Guild,
    snapshot: QuarantineSnapshot,
    mode: 'resume' | 'release',
  ): Promise<QuarantineSnapshot> {
    let active = snapshot;
    for (const channelSnapshot of snapshot.channels) {
      const status = await this.reconcilePatchStatus(
        guild,
        channelSnapshot.channelId,
        channelSnapshot.patch,
        mode,
      );
      if (status !== channelSnapshot.patch.status)
        active = await this.setQuarantinePatchStatus(
          active,
          guild.id,
          channelSnapshot.channelId,
          status,
        );
    }
    return active;
  }

  private async planQuarantinePatches(
    guild: Guild,
    bot: GuildMember,
    member: GuildMember,
    targetChannels: readonly GuildBasedChannel[],
    inaccessible: string[],
  ): Promise<QuarantineSnapshot['channels'][number][]> {
    const channelSnapshots: QuarantineSnapshot['channels'][number][] = [];
    for (const cachedChannel of targetChannels) {
      const channel = await guild.channels
        .fetch(cachedChannel.id, { force: true })
        .catch(() => null);
      if (channel === null || !this.isQuarantineCandidate(channel)) {
        inaccessible.push(`${cachedChannel.id}: inaccessible or unsupported`);
        continue;
      }
      const voiceChannel =
        channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
      const neededPermissions = voiceChannel ? QUARANTINE_PERMISSIONS : [QUARANTINE_PERMISSIONS[0]];
      const botChannelPermissions = bot.permissionsIn(channel);
      const missing = neededPermissions.filter(
        ([, permission]) => !botChannelPermissions.has(permission),
      );
      if (missing.length > 0) {
        inaccessible.push(
          `${channel.name}: missing permission authority for ${missing.map(([name]) => name).join(', ')}`,
        );
        continue;
      }
      const before = overwriteSnapshot(channel, member.id, 1);
      const mask = voiceChannel
        ? QUARANTINE_PERMISSIONS.reduce((value, [, permission]) => value | permission, 0n)
        : P.ViewChannel;
      const patch = makeOverwritePatch(member.id, 1, before, mask, 0n);
      if (patch !== null) channelSnapshots.push({ channelId: channel.id, patch });
    }
    return channelSnapshots;
  }

  public releaseLockdown(
    guild: Guild,
    actorId: string | null = null,
  ): Promise<{ readonly restored: number; readonly conflicts: readonly string[] }> {
    return this.withContainmentLock(guild.id, () => this.releaseLockdownOnce(guild, actorId));
  }

  private async releaseLockdownOnce(
    guild: Guild,
    actorId: string | null,
  ): Promise<{ readonly restored: number; readonly conflicts: readonly string[] }> {
    const state = await this.store.getGuild(guild.id);
    const stored = state.security.lockdown;
    if (stored === null) return { restored: 0, conflicts: ['No active lockdown snapshot exists.'] };
    // Reconcile interrupted APPLYING/RESTORING entries with live bits before restoring.
    let active = await this.reconcileLockdownJournal(guild, stored, 'release');
    const snapshot = active;
    const conflicts: string[] = [];
    let restored = 0;
    for (const channelSnapshot of snapshot.channels) {
      if (channelSnapshot.patches === undefined) {
        conflicts.push(
          `${channelSnapshot.channelId}: legacy whole-overwrite snapshot requires manual recovery`,
        );
        continue;
      }
      for (const patch of channelSnapshot.patches) {
        if (patch.status === 'RESTORED') continue;
        if (patch.status !== 'APPLIED') {
          conflicts.push(
            `${channelSnapshot.channelId}/${patch.id}: ${patch.status} patch is not safe to restore automatically`,
          );
          continue;
        }
        active = await this.setLockdownPatchStatus(
          active,
          guild.id,
          channelSnapshot.channelId,
          patch.id,
          'RESTORING',
        );
        const result = await this.applyOverwritePatch(
          guild,
          channelSnapshot.channelId,
          patch,
          'before',
          `Restore Xenon lockdown bits: ${snapshot.reason.slice(0, 200)}`,
        );
        if (result.blocked !== undefined)
          return { restored, conflicts: [...conflicts, result.blocked] };
        const status = result.applied ? 'RESTORED' : 'CONFLICT';
        active = await this.setLockdownPatchStatus(
          active,
          guild.id,
          channelSnapshot.channelId,
          patch.id,
          status,
        );
        if (!result.applied)
          conflicts.push(`${channelSnapshot.channelId}/${patch.id}: ${result.detail}`);
      }
      const currentChannel = active.channels.find(
        (channel) => channel.channelId === channelSnapshot.channelId,
      );
      if (currentChannel?.patches?.every((patch) => patch.status === 'RESTORED') === true)
        restored += 1;
    }
    const remaining = active.channels.filter(
      (channel) =>
        channel.patches === undefined ||
        channel.patches.some((patch) => patch.status !== 'RESTORED'),
    );
    active = { ...active, channels: remaining };
    await this.persistLockdown(remaining.length === 0 ? null : active, guild.id);
    const complete = conflicts.length === 0 && remaining.length === 0;
    const incident = createIncident({
      severity: complete ? 'INFO' : 'HIGH',
      title: complete ? 'Lockdown restored' : 'Lockdown restoration needs review',
      source: 'LockdownService',
      rule: complete ? 'MANUAL_UNLOCK' : 'LOCKDOWN_RESTORE_CONFLICT',
      actorId,
      targetId: guild.id,
      evidence: [
        snapshot.reason.slice(0, 500),
        `${String(restored)} channel overwrite policies restored`,
        ...conflicts.slice(0, 8).map((conflict) => conflict.slice(0, 500)),
      ],
      automatic: false,
      actionTaken: complete
        ? ['Xenon-managed permission bits restored; unrelated overwrites preserved']
        : ['Restored only unchanged Xenon-managed bits; unresolved changes retained'],
      auditCorrelation: 'NOT_APPLICABLE',
    });
    await this.saveIncident(guild, { ...incident, status: complete ? 'RESOLVED' : 'OPEN' });
    await this.writeLog(
      guild,
      'alerts',
      new EmbedBuilder()
        .setColor(complete ? 0x2f855a : 0xd97706)
        .setTitle(complete ? 'Lockdown released' : 'Lockdown partially restored')
        .setDescription(
          `Restored ${restored}/${snapshot.channels.length} channels. ${conflicts.slice(0, 8).join('\n')}`.slice(
            0,
            4_000,
          ),
        )
        .setTimestamp(),
    );
    return { restored, conflicts };
  }

  public quarantine(member: GuildMember, reason: string, actorId: string): Promise<string> {
    return this.withContainmentLock(member.guild.id, () =>
      this.quarantineOnce(member, reason, actorId),
    );
  }

  private async quarantineOnce(
    member: GuildMember,
    reason: string,
    actorId: string,
  ): Promise<string> {
    const blockedMode = await this.automaticBlock(member.guild.id);
    if (blockedMode !== null) return `ENFORCEMENT_MODE_BLOCKED:${blockedMode}`;
    const guild = member.guild;
    const currentMember = await guild.members
      .fetch({ user: member.id, force: true })
      .catch(() => null);
    if (currentMember === null) return 'QUARANTINE_MEMBER_UNAVAILABLE';
    member = currentMember;
    const bot = guild.members.me;
    const state = await this.store.getGuild(guild.id);
    const existing = state.security.quarantines.find((record) => record.targetId === member.id);
    if (existing?.status === 'ACTIVE') return 'QUARANTINE_ALREADY_ACTIVE';
    if (existing !== undefined && existing.status !== 'APPLYING') {
      await this.reconcileQuarantineJournal(guild, existing, 'release');
      return 'QUARANTINE_REQUIRES_RECOVERY';
    }
    if (member.id === guild.ownerId || member.permissions.has(P.Administrator))
      return 'QUARANTINE_ADMINISTRATOR_TARGET_UNSUPPORTED';
    if (!bot?.permissions.has(P.ManageRoles)) return 'QUARANTINE_MISSING_MANAGE_ROLES';
    if (!member.manageable) {
      await this.logHierarchyBlocked(
        guild,
        `PROTECTION_BLOCKED_BY_ROLE_HIERARCHY: ${member.id} is above or equal to XenonBot and cannot be quarantined.`,
      );
      return 'PROTECTION_BLOCKED_BY_ROLE_HIERARCHY';
    }
    const botId = bot.id;
    if (actorId !== botId && !(await this.actorOutranksTarget(guild, actorId, member)))
      return 'PROTECTION_BLOCKED_BY_MODERATOR_HIERARCHY';

    const logChannelIds = [
      state.security.config.channels.alerts,
      state.security.config.channels.audit,
      state.security.config.channels.modLogs,
    ];
    const targetChannels = [...guild.channels.cache.values()].filter(
      (channel) => this.isQuarantineCandidate(channel) && !logChannelIds.includes(channel.id),
    );
    if (targetChannels.length === 0) return 'QUARANTINE_NO_COMMUNICATION_CHANNELS';
    const inaccessible: string[] = [];
    let active: QuarantineSnapshot;
    if (existing === undefined) {
      const channelSnapshots = await this.planQuarantinePatches(
        guild,
        bot,
        member,
        targetChannels,
        inaccessible,
      );
      active = {
        targetId: member.id,
        actorId,
        roleId: state.security.config.quarantineRoleId,
        markerRoleAdded: false,
        startedAt: new Date().toISOString(),
        reason: reason.slice(0, 1_000),
        status: 'APPLYING',
        channels: channelSnapshots,
      };
      await this.persistQuarantine(active, guild.id);
    } else {
      // Interrupted earlier attempt: reconcile with live overwrites, then apply what remains.
      active = await this.reconcileQuarantineJournal(guild, existing, 'resume');
    }
    const failures = [...inaccessible];
    for (const channelSnapshot of active.channels) {
      if (channelSnapshot.patch.status === 'CONFLICT') {
        failures.push(`${channelSnapshot.channelId}: conflicting overwrite state`);
        continue;
      }
      if (channelSnapshot.patch.status !== 'PENDING') continue;
      active = await this.setQuarantinePatchStatus(
        active,
        guild.id,
        channelSnapshot.channelId,
        'APPLYING',
      );
      const result = await this.applyOverwritePatch(
        guild,
        channelSnapshot.channelId,
        channelSnapshot.patch,
        'after',
        `Xenon quarantine for ${member.id}: ${reason.slice(0, 250)}`,
      );
      if (result.blocked !== undefined) return result.blocked;
      active = await this.setQuarantinePatchStatus(
        active,
        guild.id,
        channelSnapshot.channelId,
        result.applied ? 'APPLIED' : 'CONFLICT',
      );
      if (!result.applied) failures.push(`${channelSnapshot.channelId}: ${result.detail}`);
    }
    let verified = 0;
    const freshMember = await guild.members
      .fetch({ user: member.id, force: true })
      .catch(() => null);
    if (freshMember === null)
      failures.push('Member state could not be refetched after applying restrictions');
    for (const cachedChannel of targetChannels) {
      const channel = await guild.channels
        .fetch(cachedChannel.id, { force: true })
        .catch(() => null);
      if (channel === null || !this.isQuarantineCandidate(channel)) continue;
      const voiceChannel =
        channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
      const permissionBlocked =
        freshMember !== null &&
        !freshMember.permissionsIn(channel).has(P.ViewChannel) &&
        (!voiceChannel ||
          (!freshMember.permissionsIn(channel).has(P.Connect) &&
            !freshMember.permissionsIn(channel).has(P.Speak)));
      const stillConnected =
        freshMember !== null && voiceChannel && freshMember.voice.channelId === channel.id;
      if (freshMember !== null && permissionBlocked && !stillConnected) verified += 1;
      else failures.push(`${channel.name}: effective access or active voice session remains`);
    }
    let markerNote = '';
    const markerRole =
      active.roleId === null
        ? undefined
        : ((await guild.roles.fetch(active.roleId, { force: true }).catch(() => null)) ??
          undefined);
    if (
      verified === targetChannels.length &&
      failures.length === 0 &&
      freshMember !== null &&
      markerRole !== undefined &&
      !markerRole.managed &&
      markerRole.permissions.bitfield === 0n &&
      bot.permissions.has(P.ManageRoles) &&
      markerRole.position < bot.roles.highest.position &&
      freshMember.manageable &&
      !freshMember.roles.cache.has(markerRole.id)
    ) {
      try {
        await this.mutate(guild.id, 'MARKER_ROLE_ADD', () =>
          freshMember.roles.add(markerRole, reason.slice(0, 500)),
        );
        active = { ...active, markerRoleAdded: true };
        try {
          await this.persistQuarantine(active, guild.id);
        } catch {
          active = { ...active, markerRoleAdded: false };
          markerNote =
            ' Quarantine restrictions are active; marker assignment could not be recorded and may need manual removal.';
        }
      } catch {
        markerNote = ' Quarantine restrictions are active; marker role assignment failed.';
      }
    } else if (
      markerRole !== undefined &&
      (markerRole.managed || markerRole.permissions.bitfield !== 0n)
    ) {
      markerNote =
        ' QUARANTINE_MARKER_HAS_PERMISSIONS: marker role skipped because it is managed or grants permissions; restrictions are enforced by channel overwrites only.';
    } else if (active.roleId !== null && markerRole === undefined) {
      markerNote = ' Quarantine restrictions are active without the configured marker role.';
    } else if (markerRole !== undefined && !bot.permissions.has(P.ManageRoles)) {
      markerNote =
        ' Quarantine restrictions are active; Xenon lacks ManageRoles for the marker role.';
    } else if (
      freshMember !== null &&
      markerRole !== undefined &&
      (markerRole.position >= bot.roles.highest.position || !freshMember.manageable)
    ) {
      markerNote = ' Quarantine restrictions are active; Discord hierarchy blocks the marker role.';
    }
    const fullyQuarantined = verified === targetChannels.length && failures.length === 0;
    active = { ...active, status: fullyQuarantined ? 'ACTIVE' : 'PARTIAL' };
    await this.persistQuarantine(active, guild.id);
    const record = createCase({
      action: 'QUARANTINE',
      moderatorId: actorId,
      targetId: member.id,
      reason: reason.slice(0, 1_000),
      durationSeconds: null,
      evidenceReference: fullyQuarantined
        ? markerNote.includes('QUARANTINE_MARKER_HAS_PERMISSIONS')
          ? markerNote.trim().slice(0, 500)
          : null
        : `Partial effective quarantine: ${failures.slice(0, 3).join('; ')}`.slice(0, 500),
    });
    try {
      await this.saveCase(guild.id, record);
    } catch {
      return `QUARANTINE_CASE_RECORD_FAILED:${record.id}`;
    }
    await this.writeLog(
      guild,
      'modLogs',
      new EmbedBuilder()
        .setColor(fullyQuarantined ? 0xd97706 : 0xdc2626)
        .setTitle(`Quarantine case · ${record.id}`)
        .setDescription(
          `Member: <@${member.id}>\nModerator: <@${actorId}>\nReason: ${reason.slice(0, 1_000)}\nVerified channels: ${verified}/${targetChannels.length}\n${failures.slice(0, 5).join('\n')}`.slice(
            0,
            4_000,
          ),
        )
        .setTimestamp(),
    );
    return fullyQuarantined
      ? `QUARANTINED:${record.id}${markerNote}`
      : `QUARANTINE_PARTIAL:${record.id}:${verified}/${targetChannels.length}`;
  }

  public unquarantine(member: GuildMember, actorId: string, reason: string): Promise<string> {
    return this.withContainmentLock(member.guild.id, () =>
      this.unquarantineOnce(member, actorId, reason),
    );
  }

  private async unquarantineOnce(
    member: GuildMember,
    actorId: string,
    reason: string,
  ): Promise<string> {
    const guild = member.guild;
    const currentMember = await guild.members
      .fetch({ user: member.id, force: true })
      .catch(() => null);
    if (currentMember === null) return 'MEMBER_UNAVAILABLE';
    member = currentMember;
    const state = await this.store.getGuild(guild.id);
    let active = state.security.quarantines.find((record) => record.targetId === member.id);
    if (active === undefined) {
      const configuredRole = state.security.config.quarantineRoleId;
      return configuredRole !== null && member.roles.cache.has(configuredRole)
        ? 'QUARANTINE_LEGACY_REQUIRES_MANUAL_RECOVERY'
        : 'MEMBER_NOT_QUARANTINED';
    }
    if (!(await this.actorOutranksTarget(guild, actorId, member)))
      return 'PROTECTION_BLOCKED_BY_MODERATOR_HIERARCHY';
    const bot = guild.members.me;
    if (!bot?.permissions.has(P.ManageRoles)) return 'UNQUARANTINE_MISSING_MANAGE_ROLES';
    const role =
      active.roleId === null
        ? undefined
        : ((await guild.roles.fetch(active.roleId, { force: true }).catch(() => null)) ??
          undefined);
    if (
      active.markerRoleAdded &&
      member.roles.cache.has(active.roleId ?? '') &&
      (role === undefined ||
        !bot.permissions.has(P.ManageRoles) ||
        !member.manageable ||
        role.position >= bot.roles.highest.position)
    ) {
      await this.logHierarchyBlocked(
        guild,
        `Unquarantine blocked for member ${member.id}: Xenon cannot remove the recorded marker role.`,
      );
      return 'PROTECTION_BLOCKED_BY_ROLE_HIERARCHY';
    }
    active = await this.reconcileQuarantineJournal(guild, active, 'release');
    active = { ...active, status: 'RESTORING' };
    await this.persistQuarantine(active, guild.id);
    const conflicts: string[] = [];
    for (const channelSnapshot of active.channels) {
      const patch = channelSnapshot.patch;
      if (patch.status === 'RESTORED') continue;
      if (patch.status !== 'APPLIED') {
        conflicts.push(
          `${channelSnapshot.channelId}: ${patch.status} overwrite is not safe to restore`,
        );
        continue;
      }
      active = await this.setQuarantinePatchStatus(
        active,
        guild.id,
        channelSnapshot.channelId,
        'RESTORING',
      );
      const result = await this.applyOverwritePatch(
        guild,
        channelSnapshot.channelId,
        patch,
        'before',
        `Restore Xenon quarantine bits: ${reason.slice(0, 200)}`,
      );
      if (result.blocked !== undefined) return result.blocked;
      active = await this.setQuarantinePatchStatus(
        active,
        guild.id,
        channelSnapshot.channelId,
        result.applied ? 'RESTORED' : 'CONFLICT',
      );
      if (!result.applied) conflicts.push(`${channelSnapshot.channelId}: ${result.detail}`);
    }
    if (conflicts.length > 0) {
      active = { ...active, status: 'PARTIAL' };
      await this.persistQuarantine(active, guild.id);
      return `UNQUARANTINE_PARTIAL:${conflicts.slice(0, 4).join('; ')}`.slice(0, 1_800);
    }
    if (active.markerRoleAdded && role !== undefined && member.roles.cache.has(role.id)) {
      try {
        await this.mutate(guild.id, 'MARKER_ROLE_REMOVE', () =>
          member.roles.remove(role, reason.slice(0, 500)),
        );
      } catch (error) {
        return `UNQUARANTINE_FAILED:${error instanceof Error ? error.message.slice(0, 160) : 'Discord rejected the marker removal'}`;
      }
    }
    const record = createCase({
      action: 'UNQUARANTINE',
      moderatorId: actorId,
      targetId: member.id,
      reason: reason.slice(0, 1_000),
      durationSeconds: null,
      evidenceReference: null,
    });
    await this.store.updateGuild(guild.id, (current) => ({
      ...current,
      security: {
        ...current.security,
        cases: [...current.security.cases, record].slice(-5_000),
        quarantines: current.security.quarantines.filter(
          (snapshot) => snapshot.targetId !== member.id,
        ),
      },
    }));
    await this.writeLog(
      guild,
      'modLogs',
      new EmbedBuilder()
        .setColor(0x2f855a)
        .setTitle(`Unquarantine case · ${record.id}`)
        .setDescription(
          `Member: <@${member.id}>\nModerator: <@${actorId}>\nReason: ${reason.slice(0, 1_000)}`.slice(
            0,
            4_000,
          ),
        )
        .setTimestamp(),
    );
    return 'UNQUARANTINED';
  }

  public async saveCase(guildId: string, record: ModerationCase): Promise<void> {
    await this.store.updateGuild(guildId, (current) => ({
      ...current,
      security: { ...current.security, cases: [...current.security.cases, record].slice(-5_000) },
    }));
  }

  public async syncAutoMod(guild: Guild): Promise<AutoModSyncResult> {
    await this.assertMutationAllowed(guild.id, 'AUTOMOD_SYNC');
    return synchronizeAutoModRules(guild, this.store, () =>
      this.assertMutationAllowed(guild.id, 'AUTOMOD_SYNC'),
    );
  }

  public async scanPermissions(guild: Guild): Promise<readonly PermissionFinding[]> {
    const state = await this.store.getGuild(guild.id);
    const config = state.security.config;
    const bot = guild.members.me;
    const roleFacts = [...guild.roles.cache.values()].map((role) => ({
      id: role.id,
      name: role.name,
      permissions: new Set([
        ...(role.permissions.has(P.Administrator) ? ['Administrator'] : []),
        ...(role.permissions.has(P.ManageRoles) ? ['ManageRoles'] : []),
        ...(role.permissions.has(P.ManageChannels) ? ['ManageChannels'] : []),
        ...(role.permissions.has(P.ManageGuild) ? ['ManageGuild'] : []),
        ...(role.permissions.has(P.BanMembers) ? ['BanMembers'] : []),
        ...(role.permissions.has(P.KickMembers) ? ['KickMembers'] : []),
        ...(role.permissions.has(P.ManageWebhooks) ? ['ManageWebhooks'] : []),
        ...(role.permissions.has(P.MentionEveryone) ? ['MentionEveryone'] : []),
        ...(role.permissions.has(P.ViewAuditLog) ? ['ViewAuditLog'] : []),
      ]),
      managed: role.managed,
      position: role.position,
    }));
    const findings: PermissionFinding[] = scanRolePermissions(
      roleFacts,
      guild.roles.everyone.id,
      new Set(config.protectedRoleIds),
      bot?.roles.highest.position ?? -1,
      true,
    );
    if (bot?.permissions.has(P.Administrator) === true)
      findings.push({
        severity: 'CRITICAL',
        code: 'BOT_ADMINISTRATOR_GRANTED',
        subject: 'XenonBot',
        detail:
          'Remove Administrator and grant only the feature permissions listed in the deployment guide.',
        remediation:
          'Server Settings › Roles › XenonBot › Permissions: turn off Administrator and enable only the permissions Xenon needs.',
      });
    const requiredPermissions = [
      {
        flag: P.ViewAuditLog,
        label: 'View Audit Log',
        code: 'BOT_MISSING_VIEW_AUDIT_LOG',
        severity: 'HIGH' as const,
        detail: 'Audit-log actor correlation is unavailable.',
      },
      {
        flag: P.ManageRoles,
        label: 'Manage Roles',
        code: 'BOT_MISSING_MANAGE_ROLES',
        severity: 'HIGH' as const,
        detail:
          'Channel overwrite containment, dangerous-role containment, and optional quarantine marker assignment are unavailable.',
      },
      {
        flag: P.ManageChannels,
        label: 'Manage Channels',
        code: 'BOT_MISSING_MANAGE_CHANNELS',
        severity: 'HIGH' as const,
        detail: 'Security channel creation and raid slowmode are unavailable.',
      },
      {
        flag: P.ManageMessages,
        label: 'Manage Messages',
        code: 'BOT_MISSING_MANAGE_MESSAGES',
        severity: 'MEDIUM' as const,
        detail: 'Spam message deletion and purge are unavailable.',
      },
      {
        flag: P.ModerateMembers,
        label: 'Timeout Members',
        code: 'BOT_MISSING_MODERATE_MEMBERS',
        severity: 'MEDIUM' as const,
        detail: 'Automated and manual timeout actions are unavailable.',
      },
      {
        flag: P.KickMembers,
        label: 'Kick Members',
        code: 'BOT_MISSING_KICK_MEMBERS',
        severity: 'LOW' as const,
        detail: 'Manual kick actions are unavailable.',
      },
      {
        flag: P.BanMembers,
        label: 'Ban Members',
        code: 'BOT_MISSING_BAN_MEMBERS',
        severity: 'LOW' as const,
        detail: 'Manual ban actions are unavailable.',
      },
      {
        flag: P.ManageGuild,
        label: 'Manage Server',
        code: 'BOT_MISSING_MANAGE_GUILD',
        severity: 'MEDIUM' as const,
        detail: 'AutoMod reconciliation and security setup are unavailable.',
      },
      {
        flag: P.SendMessages,
        label: 'Send Messages',
        code: 'BOT_MISSING_SEND_MESSAGES',
        severity: 'HIGH' as const,
        detail: 'Configured security and moderation logs may not be delivered.',
      },
      {
        flag: P.EmbedLinks,
        label: 'Embed Links',
        code: 'BOT_MISSING_EMBED_LINKS',
        severity: 'LOW' as const,
        detail: 'Structured incident logging is unavailable.',
      },
      {
        flag: P.ViewChannel,
        label: 'View Channels',
        code: 'BOT_MISSING_VIEW_CHANNEL',
        severity: 'HIGH' as const,
        detail: 'Configured security channels cannot be inspected.',
      },
      {
        flag: P.ReadMessageHistory,
        label: 'Read Message History',
        code: 'BOT_MISSING_READ_HISTORY',
        severity: 'LOW' as const,
        detail: 'Security channel history cannot be inspected.',
      },
    ];
    for (const permission of requiredPermissions) {
      if (!bot?.permissions.has(permission.flag))
        findings.push({
          severity: permission.severity,
          code: permission.code,
          subject: 'XenonBot',
          detail: permission.detail,
          remediation: `Server Settings › Roles › XenonBot: enable ${permission.label}.`,
        });
    }
    if (
      config.channels.alerts === null ||
      guild.channels.cache.get(config.channels.alerts) === undefined
    )
      findings.push({
        severity: 'HIGH',
        code: 'MISSING_SECURITY_ALERT_CHANNEL',
        subject: 'Security configuration',
        detail: 'Incident alerts cannot be delivered.',
        remediation:
          'Create a private staff channel and set it as the alerts channel with /security setup.',
      });
    if (
      config.channels.audit === null ||
      guild.channels.cache.get(config.channels.audit) === undefined
    )
      findings.push({
        severity: 'MEDIUM',
        code: 'MISSING_AUDIT_LOG_CHANNEL',
        subject: 'Security configuration',
        detail: 'Security audit records and incident resolutions cannot be delivered.',
        remediation:
          'Create a private staff channel and set it as the audit channel with /security setup.',
      });
    if (
      config.channels.modLogs === null ||
      guild.channels.cache.get(config.channels.modLogs) === undefined
    )
      findings.push({
        severity: 'MEDIUM',
        code: 'MISSING_MOD_LOG_CHANNEL',
        subject: 'Security configuration',
        detail: 'Automatic moderation cases cannot be delivered to a log channel.',
        remediation:
          'Create a private staff channel and set it as the mod-log channel with /security setup.',
      });
    if (config.quarantineRoleId === null || !guild.roles.cache.has(config.quarantineRoleId))
      findings.push({
        severity: 'LOW',
        code: 'MISSING_QUARANTINE_ROLE',
        subject: 'Security configuration',
        detail:
          'Quarantine enforcement still uses member-specific overwrites; the optional marker role is unavailable.',
        remediation:
          'Create a role without permissions for labeling and set it with /security setup.',
      });
    const quarantineRole =
      config.quarantineRoleId === null ? undefined : guild.roles.cache.get(config.quarantineRoleId);
    if (
      quarantineRole !== undefined &&
      bot !== null &&
      quarantineRole.position >= bot.roles.highest.position
    ) {
      findings.push({
        severity: 'LOW',
        code: 'QUARANTINE_MARKER_ROLE_ABOVE_BOT',
        subject: quarantineRole.name,
        detail:
          'Member-specific quarantine restrictions remain available; move XenonBot above the marker role if role labeling is required.',
        remediation:
          'Drag the XenonBot role above the quarantine marker role in Server Settings › Roles.',
      });
    }
    if (quarantineRole !== undefined && quarantineRole.permissions.bitfield !== 0n)
      findings.push({
        severity: 'HIGH',
        code: 'QUARANTINE_ROLE_HAS_PERMISSIONS',
        subject: quarantineRole.name,
        detail:
          'The configured quarantine marker role grants permissions, so assigning it could widen a quarantined member’s access; Xenon skips assigning it.',
        remediation:
          'Server Settings › Roles: remove every permission from the quarantine marker role, or set a different permission-less role.',
      });
    for (const role of guild.roles.cache.values()) {
      if (
        !role.managed &&
        role.permissions.has(P.Administrator) &&
        role.id !== guild.roles.everyone.id &&
        !config.protectedRoleIds.includes(role.id)
      )
        findings.push({
          severity: 'HIGH',
          code: 'UNEXPECTED_ADMINISTRATOR_ROLE',
          subject: role.name,
          detail: 'Role is not recorded as a protected security role; review manually.',
          remediation:
            'Remove Administrator from this role if it is not required, or record it as a protected role.',
        });
    }
    for (const member of guild.members.cache.values()) {
      if (!member.user.bot || member.id === guild.client.user.id) continue;
      if (member.permissions.has(P.Administrator))
        findings.push({
          severity: 'HIGH',
          code: 'BOT_WITH_ADMINISTRATOR',
          subject: member.user.tag,
          detail: 'Bot member has Administrator; review whether this is required.',
          remediation:
            "Replace Administrator on this bot's role with only the permissions its features require, or remove the bot.",
        });
      else {
        const risky = BOT_RISKY_PERMISSIONS.filter(([, flag]) => member.permissions.has(flag)).map(
          ([name]) => name,
        );
        if (risky.length > 0)
          findings.push({
            severity: 'MEDIUM',
            code: 'BOT_OVERPRIVILEGED',
            subject: member.user.tag,
            detail: `Bot member holds ${risky.join(', ')}.`,
            remediation: `Remove ${risky.join(', ')} from this bot's role unless a feature needs it, or kick the bot.`,
          });
      }
    }
    for (const channel of guild.channels.cache.values()) {
      if (!hasPermissionOverwrites(channel)) continue;
      const everyone = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      if (everyone?.allow.has(P.MentionEveryone) === true)
        findings.push({
          severity: 'MEDIUM',
          code: 'MENTION_EVERYONE_CHANNEL_OVERWRITE',
          subject: channel.name,
          detail: '@everyone can mention everyone in this channel.',
          remediation: `Edit Channel › Permissions › @everyone on ${channel.name} and reset Mention @everyone to neutral or deny.`,
        });
      const everyoneManagement = EVERYONE_MANAGEMENT_PERMISSIONS.filter(
        ([, flag]) => everyone?.allow.has(flag) === true,
      ).map(([name]) => name);
      if (everyoneManagement.length > 0)
        findings.push({
          severity: 'HIGH',
          code: 'EVERYONE_CHANNEL_MANAGEMENT_OVERWRITE',
          subject: channel.name,
          detail: `The @everyone overwrite grants ${everyoneManagement.join(', ')}.`,
          remediation: `Edit Channel › Permissions › @everyone on ${channel.name} and reset ${everyoneManagement.join(', ')} to neutral or deny.`,
        });
      if (everyone?.deny.has(P.ViewChannel) === true) {
        const delegates = [...channel.permissionOverwrites.cache.values()]
          .filter(
            (overwrite) =>
              overwrite.type === OverwriteType.Member &&
              (overwrite.allow.has(P.ManageChannels) || overwrite.allow.has(P.ManageRoles)),
          )
          .map((overwrite) => overwrite.id);
        if (delegates.length > 0)
          findings.push({
            severity: 'MEDIUM',
            code: 'PRIVATE_CHANNEL_PERMISSION_DELEGATION',
            subject: channel.name,
            detail: `Member-specific overwrites grant Manage Channel or Manage Permissions in a private channel: ${delegates.slice(0, 5).join(', ')}.`,
            remediation: `Remove the member-specific Manage Channel / Manage Permissions overwrites on ${channel.name} and delegate through a reviewed staff role instead.`,
          });
      }
      if (
        channel.type === ChannelType.GuildText &&
        channel.name.toLowerCase().includes('staff') &&
        everyone?.allow.has(P.ViewChannel) === true
      )
        findings.push({
          severity: 'HIGH',
          code: 'STAFF_CHANNEL_PUBLIC',
          subject: channel.name,
          detail: 'The @everyone overwrite exposes a channel named as staff-only.',
          remediation: `Deny View Channel for @everyone on ${channel.name} and allow only staff roles.`,
        });
      if (
        [config.channels.alerts, config.channels.audit, config.channels.modLogs].includes(
          channel.id,
        ) &&
        everyone?.allow.has(P.ViewChannel) === true
      )
        findings.push({
          severity: 'HIGH',
          code: 'SECURITY_LOG_CHANNEL_PUBLIC',
          subject: channel.name,
          detail: 'A configured security log is visible to @everyone; review its overwrites.',
          remediation: `Deny View Channel for @everyone on ${channel.name} and allow only security staff.`,
        });
    }
    for (const check of this.nativeChecks(guild)) {
      // @everyone permission exposure is already reported by the dedicated role findings above.
      if (check.status === 'OK' || check.code === 'NATIVE_EVERYONE_PERMISSIONS') continue;
      findings.push({
        severity: check.status === 'WARN' ? 'MEDIUM' : 'LOW',
        code: check.code,
        subject: check.name,
        detail: check.detail,
        remediation: check.remediation,
      });
    }
    return findings;
  }

  /** Read-only report of Discord-native safety settings; never changes the guild. */
  public nativeSafety(guild: Guild): readonly NativeSafetyCheck[] {
    return this.nativeChecks(guild).map(({ name, status, detail }) => ({ name, status, detail }));
  }

  private nativeChecks(guild: Guild): readonly (NativeSafetyCheck & {
    readonly code: string;
    readonly remediation: string;
  })[] {
    const features = (guild.features as readonly string[] | undefined) ?? [];
    const exposed = DANGEROUS_PERMISSION_NAMES.filter(([, flag]) =>
      guild.roles.everyone.permissions.has(flag),
    ).map(([name]) => name);
    const missingCommunity = [
      ...(features.includes('COMMUNITY') ? [] : ['Community']),
      ...(features.includes('MEMBER_VERIFICATION_GATE_ENABLED') ? [] : ['Rules screening']),
    ];
    return [
      {
        code: 'NATIVE_VERIFICATION_LEVEL',
        name: 'Verification level',
        status: guild.verificationLevel >= GuildVerificationLevel.Medium ? 'OK' : 'WARN',
        detail:
          guild.verificationLevel >= GuildVerificationLevel.Medium
            ? 'Verification level is Medium or higher.'
            : 'Verification level is below Medium; throwaway accounts can join and post immediately.',
        remediation:
          'Server Settings › Safety Setup › Verification Level: choose Medium or higher.',
      },
      {
        code: 'NATIVE_MFA_REQUIREMENT',
        name: '2FA requirement for moderators',
        status: guild.mfaLevel === GuildMFALevel.Elevated ? 'OK' : 'MANUAL ACTION REQUIRED',
        detail:
          guild.mfaLevel === GuildMFALevel.Elevated
            ? 'Moderation actions require 2FA.'
            : 'Moderation actions do not require 2FA; only the server owner can change this.',
        remediation:
          'The server owner must enable Server Settings › Safety Setup › Require 2FA for moderation.',
      },
      {
        code: 'NATIVE_CONTENT_FILTER',
        name: 'Explicit media content filter',
        status:
          guild.explicitContentFilter === GuildExplicitContentFilter.AllMembers ? 'OK' : 'WARN',
        detail:
          guild.explicitContentFilter === GuildExplicitContentFilter.AllMembers
            ? 'Media from all members is scanned.'
            : 'Explicit media is not scanned for all members.',
        remediation:
          'Server Settings › Safety Setup › Explicit Media Content Filter: scan media from all members.',
      },
      {
        code: 'NATIVE_COMMUNITY_RULES_SCREENING',
        name: 'Community and rules screening',
        status: missingCommunity.length === 0 ? 'OK' : 'MANUAL ACTION REQUIRED',
        detail:
          missingCommunity.length === 0
            ? 'Community is enabled with rules screening.'
            : `Not enabled: ${missingCommunity.join(', ')}.`,
        remediation:
          'Enable Community in Server Settings › Enable Community, then turn on Rules Screening (Membership Screening).',
      },
      {
        code: 'NATIVE_RAID_PROTECTION',
        name: 'Discord Raid Protection / Safety Setup',
        status: 'MANUAL ACTION REQUIRED',
        detail:
          'Discord does not expose this setting to bots; it cannot be verified automatically.',
        remediation:
          'Verify in Server Settings › Safety Setup that raid and spam protections and DM-spam filtering are on.',
      },
      {
        code: 'NATIVE_EVERYONE_PERMISSIONS',
        name: '@everyone dangerous permissions',
        status: exposed.length === 0 ? 'OK' : 'WARN',
        detail:
          exposed.length === 0
            ? '@everyone holds no dangerous permissions.'
            : `@everyone holds ${exposed.join(', ')}.`,
        remediation: 'Server Settings › Roles › @everyone: turn off every dangerous permission.',
      },
    ];
  }

  /**
   * Releases raid slowmode once no elevated join has occurred for the recovery period,
   * or immediately once staff turn raid protection OFF/disabled. Manual ON keeps it.
   */
  public checkRaidRecovery(guild: Guild): Promise<boolean> {
    return this.withContainmentLock(guild.id, async () => {
      const state = (await this.store.getGuild(guild.id)).security;
      const response = state.raidResponse;
      if (response === null || state.config.raidMode === 'ON') return false;
      if (this.isAutomatic() && state.config.enforcementMode !== 'ENFORCE') return false;
      const manuallyReleased = state.config.raidMode === 'OFF' || !state.config.modules.raid;
      const recoveryMs = state.config.raidRecoveryMinutes * 60_000;
      if (!manuallyReleased && Date.now() - Date.parse(response.lastEscalationAt) < recoveryMs)
        return false;
      const conflicts: string[] = [];
      const failures: string[] = [];
      const retained: RaidResponseState['slowmode'][number][] = [];
      let restored = 0;
      for (const entry of response.slowmode) {
        let channel: GuildBasedChannel | null = guild.channels.cache.get(entry.channelId) ?? null;
        if (channel === null) {
          try {
            channel = await guild.channels.fetch(entry.channelId);
          } catch (error) {
            if (error instanceof DiscordAPIError && error.code === 10003)
              conflicts.push(`${entry.channelId}: channel no longer exists; nothing to restore`);
            else {
              retained.push(entry);
              failures.push(`${entry.channelId}: lookup failed (${describeDiscordError(error)})`);
            }
            continue;
          }
        }
        if (
          channel === null ||
          (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
        ) {
          conflicts.push(`${entry.channelId}: channel unavailable; slowmode not restored`);
          continue;
        }
        const live = channel.rateLimitPerUser ?? 0;
        // The apply was journaled first; an unchanged value means it never happened.
        if (live === entry.before) continue;
        if (live !== entry.applied) {
          conflicts.push(
            `${channel.name}: slowmode is ${String(live)}s, expected ${String(entry.applied)}s; left unchanged`,
          );
          continue;
        }
        try {
          await this.mutate(guild.id, 'SLOWMODE_RESTORE', () =>
            channel.setRateLimitPerUser(entry.before, 'Xenon raid response ended'),
          );
          restored += 1;
        } catch (error) {
          retained.push(entry);
          failures.push(`${channel.name}: restore failed (${describeDiscordError(error)})`);
        }
      }
      if (retained.length > 0) {
        await this.store.updateGuild(guild.id, (current) => ({
          ...current,
          security: {
            ...current.security,
            raidResponse:
              current.security.raidResponse === null
                ? null
                : { ...current.security.raidResponse, slowmode: retained },
          },
        }));
        if (conflicts.length > 0 || !this.raidRecoveryReported.has(guild.id)) {
          this.raidRecoveryReported.add(guild.id);
          const partial = createIncident({
            severity: 'MEDIUM',
            title: 'Raid slowmode restore incomplete',
            source: 'RaidDetector',
            rule: 'RAID_RECOVERY_PARTIAL',
            actorId: null,
            targetId: null,
            evidence: [...failures, ...conflicts].map((line) => line.slice(0, 500)).slice(0, 30),
            automatic: true,
            actionTaken: [
              `Slowmode restored on ${String(restored)} channel(s); ${String(retained.length)} retained for retry`,
            ],
            auditCorrelation: 'NOT_APPLICABLE',
          });
          await this.saveIncident(guild, partial);
          await this.logIncident(guild, partial, 'alerts');
        }
        return false;
      }
      this.raidRecoveryReported.delete(guild.id);
      await this.store.updateGuild(guild.id, (current) => ({
        ...current,
        security: { ...current.security, raidResponse: null },
      }));
      this.engine.resetRaidLevel();
      const incident = createIncident({
        severity: 'INFO',
        title: 'Raid response ended',
        source: 'RaidDetector',
        rule: 'RAID_RECOVERY',
        actorId: null,
        targetId: null,
        evidence: [
          `Raid response active since ${response.since}; last elevated join ${response.lastEscalationAt}`,
          ...conflicts.map((conflict) => conflict.slice(0, 500)),
        ].slice(0, 30),
        automatic: true,
        actionTaken: [`Slowmode restored on ${String(restored)} channel(s)`],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      await this.saveIncident(guild, incident);
      await this.logIncident(guild, incident, 'audit');
      return true;
    });
  }

  public async raidStatus(guildId: string): Promise<RaidStatus> {
    const state = (await this.store.getGuild(guildId)).security;
    const current = this.engine.currentRaid(state.config, Date.now());
    const response = state.raidResponse;
    const level =
      response !== null && RAID_LEVEL_RANK[response.level] > RAID_LEVEL_RANK[current.level]
        ? response.level
        : current.level;
    return {
      level,
      joins10s: current.joins10s,
      joins30s: current.joins30s,
      newAccountRatio: current.newAccountRatio,
      activeSince: response?.since ?? null,
      slowmodeChannels: response?.slowmode.length ?? 0,
      recoveryAt:
        response === null
          ? null
          : new Date(
              Date.parse(response.lastEscalationAt) + state.config.raidRecoveryMinutes * 60_000,
            ).toISOString(),
    };
  }

  private async refreshRaidResponse(
    guild: Guild,
    level: RaidResponseState['level'],
    incidentId: string | null,
    config: SecurityConfig,
  ): Promise<readonly string[]> {
    return this.withContainmentLock(guild.id, async () => {
      const now = new Date().toISOString();
      const current = (await this.store.getGuild(guild.id)).security.raidResponse;
      if (current !== null) {
        await this.store.updateGuild(guild.id, (state) => ({
          ...state,
          security: {
            ...state.security,
            raidResponse:
              state.security.raidResponse === null
                ? null
                : {
                    ...state.security.raidResponse,
                    level: level === 'CRITICAL' ? 'CRITICAL' : state.security.raidResponse.level,
                    lastEscalationAt: now,
                  },
          },
        }));
        return [];
      }
      await this.assertMutationAllowed(guild.id, 'SLOWMODE_SET');
      const actions: string[] = [];
      const planned: RaidResponseState['slowmode'][number][] = [];
      const appliers = new Map<string, () => Promise<unknown>>();
      const applied = config.raidSlowmodeSeconds;
      if (applied > 0) {
        const logChannels = [
          config.channels.alerts,
          config.channels.audit,
          config.channels.modLogs,
        ];
        for (const channelId of config.lockdownChannelIds) {
          if (logChannels.includes(channelId)) continue;
          const channel =
            guild.channels.cache.get(channelId) ??
            (await guild.channels.fetch(channelId).catch(() => null));
          if (
            channel === null ||
            (channel.type !== ChannelType.GuildText &&
              channel.type !== ChannelType.GuildAnnouncement)
          )
            continue;
          const before = channel.rateLimitPerUser ?? 0;
          if (before >= applied) continue;
          planned.push({ channelId, before, applied });
          appliers.set(channelId, () =>
            this.mutate(guild.id, 'SLOWMODE_SET', () =>
              channel.setRateLimitPerUser(applied, `Xenon raid response (${level})`),
            ),
          );
        }
      }
      // Write-ahead: the journal exists before any channel is changed.
      await this.store.updateGuild(guild.id, (state) => ({
        ...state,
        security: {
          ...state.security,
          raidResponse: {
            level,
            since: now,
            lastEscalationAt: now,
            incidentId,
            slowmode: planned,
          },
        },
      }));
      let appliedCount = 0;
      for (const entry of planned) {
        try {
          await appliers.get(entry.channelId)?.();
          appliedCount += 1;
        } catch (error) {
          actions.push(`RAID_SLOWMODE_FAILED:${entry.channelId}:${describeDiscordError(error)}`);
          // A lost response may still have applied the change: keep the entry unless the live
          // value is confirmed to be the original one.
          const live = await guild.channels
            .fetch(entry.channelId, { force: true })
            .catch(() => null);
          const liveValue =
            live !== null &&
            (live.type === ChannelType.GuildText || live.type === ChannelType.GuildAnnouncement)
              ? (live.rateLimitPerUser ?? 0)
              : null;
          if (liveValue === null || liveValue === entry.applied) continue;
          await this.store.updateGuild(guild.id, (state) => ({
            ...state,
            security: {
              ...state.security,
              raidResponse:
                state.security.raidResponse === null
                  ? null
                  : {
                      ...state.security.raidResponse,
                      slowmode: state.security.raidResponse.slowmode.filter(
                        (item) => item.channelId !== entry.channelId,
                      ),
                    },
            },
          }));
        }
      }
      if (appliedCount > 0) actions.push(`RAID_SLOWMODE_APPLIED:${String(appliedCount)}`);
      return actions;
    });
  }

  public resolveIncident(
    guild: Guild,
    incidentId: string,
    actorId: string,
    note: string,
  ): Promise<'RESOLVED' | 'NOT_FOUND' | 'ALREADY_RESOLVED'> {
    return this.runManual(actorId, () =>
      this.resolveIncidentOnce(guild, incidentId, actorId, note),
    );
  }

  private async resolveIncidentOnce(
    guild: Guild,
    incidentId: string,
    actorId: string,
    note: string,
  ): Promise<'RESOLVED' | 'NOT_FOUND' | 'ALREADY_RESOLVED'> {
    let outcome = 'NOT_FOUND' as 'RESOLVED' | 'NOT_FOUND' | 'ALREADY_RESOLVED';
    const resolution = note.trim().slice(0, 500) || 'Resolved without a note';
    const resolvedAt = new Date().toISOString();
    await this.store.updateGuild(guild.id, (current) => ({
      ...current,
      security: {
        ...current.security,
        incidents: current.security.incidents.map((incident) => {
          if (incident.id !== incidentId) return incident;
          if (incident.status === 'RESOLVED') {
            outcome = 'ALREADY_RESOLVED';
            return incident;
          }
          outcome = 'RESOLVED';
          return { ...incident, status: 'RESOLVED', resolvedAt, resolvedBy: actorId, resolution };
        }),
      },
    }));
    if (outcome === 'RESOLVED')
      await this.writeLog(
        guild,
        'audit',
        new EmbedBuilder()
          .setColor(0x15803d)
          .setTitle('Security incident resolved')
          .addFields(
            { name: 'Incident ID', value: incidentId, inline: true },
            { name: 'Resolved by', value: `<@${actorId}>`, inline: true },
            { name: 'Resolution', value: resolution.slice(0, 1_000), inline: false },
          )
          .setTimestamp(),
      );
    return outcome;
  }

  /**
   * Alert-only detection for destructive events when Discord audit attribution is unavailable.
   * Never contains or locks down: the actor is unknown and guessing would punish the wrong member.
   */
  public async handleUnattributedEvent(
    guild: Guild,
    kind: 'CHANNEL_DELETE' | 'ROLE_DELETE' | 'MEMBER_BAN',
    targetId: string,
  ): Promise<void> {
    if (guild.members.me?.permissions.has(P.ViewAuditLog) === true) return;
    const config = (await this.store.getGuild(guild.id)).security.config;
    if (!config.enabled || !config.modules.antiNuke) return;
    const now = Date.now();
    const key = `${guild.id}:${kind}`;
    const window = [...(this.unattributedWindows.get(key) ?? []), now]
      .filter((at) => now - at <= UNATTRIBUTED_WINDOW_MS)
      .slice(-100);
    boundedSet(this.unattributedWindows, key, window, MAX_TRACKED_KEYS);
    if (window.length < UNATTRIBUTED_THRESHOLDS[kind]) return;
    if (now - (this.unattributedAlerts.get(key) ?? 0) < UNATTRIBUTED_ALERT_COOLDOWN_MS) return;
    boundedSet(this.unattributedAlerts, key, now, MAX_TRACKED_KEYS);
    const incident = createIncident({
      severity: 'HIGH',
      title: `Possible mass ${kind.replace('_', ' ').toLowerCase()} (unattributed)`,
      source: 'AntiNukeEngine',
      rule: `UNATTRIBUTED_${kind}`,
      actorId: null,
      targetId: isSnowflake(targetId) ? targetId : null,
      evidence: [
        `${String(window.length)} ${kind} events in 60 seconds`,
        'Attribution unavailable: XenonBot lacks View Audit Log, so the responsible actor is unknown.',
        'Alert only; no containment or lockdown was applied.',
      ],
      automatic: true,
      actionTaken: ['Alert only; no automatic containment'],
      auditCorrelation: 'UNAVAILABLE',
    });
    await this.saveIncident(guild, incident);
    await this.logIncident(guild, incident, 'alerts');
  }

  private async guardAction(label: string, run: () => Promise<string>): Promise<string> {
    try {
      return await run();
    } catch (error) {
      return `${label}_FAILED:${describeDiscordError(error)}`.slice(0, 200);
    }
  }

  public isMessageContentAvailable(): boolean {
    return this.messageContentAvailable;
  }

  private classifyAuditAction(
    entry: GuildAuditLogsEntry,
    guild: Guild,
    denyRemovalEffective = false,
  ): NukeAction {
    if (entry.action === AuditLogEvent.ChannelDelete) return 'CHANNEL_DELETE';
    if (entry.action === AuditLogEvent.ChannelCreate) return 'CHANNEL_CREATE';
    if (entry.action === AuditLogEvent.RoleDelete) return 'ROLE_DELETE';
    if (entry.action === AuditLogEvent.RoleCreate) return 'ROLE_CREATE';
    if (entry.action === AuditLogEvent.MemberBanAdd) return 'MASS_BAN';
    if (entry.action === AuditLogEvent.MemberKick) return 'MASS_KICK';
    if (entry.action === AuditLogEvent.MemberRoleUpdate) {
      return this.dangerousRoleAdded(entry, guild)
        ? 'ROLE_PERMISSION_ESCALATION'
        : 'MEMBER_ROLE_CHANGE';
    }
    if (
      entry.action === AuditLogEvent.WebhookCreate ||
      entry.action === AuditLogEvent.WebhookUpdate ||
      entry.action === AuditLogEvent.WebhookDelete
    )
      return 'WEBHOOK_CHANGE';
    if (
      entry.action === AuditLogEvent.IntegrationCreate ||
      entry.action === AuditLogEvent.IntegrationUpdate ||
      entry.action === AuditLogEvent.IntegrationDelete
    )
      return 'INTEGRATION_CHANGE';
    if (entry.action === AuditLogEvent.BotAdd) return 'BOT_ADD';
    if (entry.action === AuditLogEvent.RoleUpdate) {
      return this.dangerousPermissionAdded(entry) ? 'ROLE_PERMISSION_ESCALATION' : 'OTHER';
    }
    if (
      entry.action === AuditLogEvent.ChannelOverwriteCreate ||
      entry.action === AuditLogEvent.ChannelOverwriteUpdate ||
      entry.action === AuditLogEvent.ChannelOverwriteDelete
    )
      return this.dangerousPermissionAdded(entry) || denyRemovalEffective
        ? 'GUILD_PERMISSION_CHANGE'
        : 'OTHER';
    if (entry.action === AuditLogEvent.GuildUpdate)
      return this.dangerousPermissionAdded(entry) ? 'GUILD_PERMISSION_CHANGE' : 'OTHER';
    return 'OTHER';
  }

  private dangerousRoleAdded(entry: GuildAuditLogsEntry, guild: Guild): boolean {
    const addedRoles = entry.changes
      .filter((change) => change.key === '$add')
      .flatMap((change) => (Array.isArray(change.new) ? change.new : []));
    for (const addedRole of addedRoles) {
      if (typeof addedRole !== 'object' || !('id' in addedRole) || typeof addedRole.id !== 'string')
        continue;
      const role = guild.roles.cache.get(addedRole.id);
      if (
        role !== undefined &&
        DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission))
      )
        return true;
    }
    return false;
  }

  private dangerousPermissionAdded(entry: GuildAuditLogsEntry): boolean {
    const permissionChanges = entry.changes.filter((change) =>
      ['permissions', 'allow'].includes(change.key),
    );
    for (const change of permissionChanges) {
      const previous = permissionBitfield(change.old);
      const next = permissionBitfield(change.new);
      if (previous === null || next === null) continue;
      const added = next & ~previous;
      if (DANGEROUS_PERMISSIONS.some((permission) => (added & permission) !== 0n)) return true;
    }
    return false;
  }

  private dangerousPermissionDeniedRemoved(entry: GuildAuditLogsEntry): boolean {
    if (
      entry.action !== AuditLogEvent.ChannelOverwriteUpdate &&
      entry.action !== AuditLogEvent.ChannelOverwriteDelete
    )
      return false;
    return entry.changes.some((change) => {
      if (change.key !== 'deny') return false;
      const previous = permissionBitfield(change.old);
      const next = permissionBitfield(change.new);
      if (previous === null || next === null) return false;
      const removed = previous & ~next;
      return DANGEROUS_PERMISSIONS.some((permission) => (removed & permission) !== 0n);
    });
  }

  private async effectivePermissionAfterDenyRemoval(
    entry: GuildAuditLogsEntry,
    guild: Guild,
  ): Promise<boolean | null> {
    const removedPermissions = entry.changes
      .filter((change) => change.key === 'deny')
      .reduce((removed, change) => {
        const previous = permissionBitfield(change.old);
        const next = permissionBitfield(change.new);
        return previous === null || next === null ? removed : removed | (previous & ~next);
      }, 0n);
    const relevantPermissions = DANGEROUS_PERMISSIONS.filter(
      (permission) => (removedPermissions & permission) !== 0n,
    );
    if (relevantPermissions.length === 0) return false;
    const extra = entry.extra;
    if (extra === null || typeof extra !== 'object' || !('id' in extra)) return null;
    const subjectId = extra.id;
    if (typeof subjectId !== 'string' || entry.targetId === null) return null;
    // Effective access is channel-specific: a guild-level grant can be denied by another overwrite.
    const channel = await guild.channels.fetch(entry.targetId, { force: true }).catch(() => null);
    if (channel === null || !hasPermissionOverwrites(channel)) return null;
    const role = guild.roles.cache.get(subjectId);
    if (role !== undefined) {
      const everyoneRole = guild.roles.everyone;
      let bits = everyoneRole.permissions.bitfield | role.permissions.bitfield;
      if ((bits & P.Administrator) !== 0n) return true;
      const overwrites = [
        channel.permissionOverwrites.cache.get(everyoneRole.id),
        role.id === everyoneRole.id ? undefined : channel.permissionOverwrites.cache.get(role.id),
      ];
      for (const overwrite of overwrites)
        if (overwrite !== undefined)
          bits = (bits & ~overwrite.deny.bitfield) | overwrite.allow.bitfield;
      return relevantPermissions.some((permission) => (bits & permission) !== 0n);
    }
    const member =
      guild.members.cache.get(subjectId) ??
      (await guild.members.fetch(subjectId).catch(() => null));
    if (member === null) return null;
    const effective = member.permissionsIn(channel);
    return relevantPermissions.some((permission) => effective.has(permission));
  }

  private async logUnverifiedPermissionEscalation(
    entry: GuildAuditLogsEntry,
    guild: Guild,
  ): Promise<void> {
    const extra = entry.extra;
    const subjectId =
      extra !== null && typeof extra === 'object' && 'id' in extra && typeof extra.id === 'string'
        ? extra.id
        : 'unknown';
    const incident = createIncident({
      severity: 'MEDIUM',
      title: 'Potential channel permission escalation (unverified)',
      source: 'PermissionGuard',
      rule: 'UNVERIFIED_DANGEROUS_DENY_REMOVAL',
      actorId: entry.executorId ?? null,
      targetId: subjectId,
      evidence: [
        `Audit entry ${entry.id}`,
        'A dangerous permission deny was removed; effective base permissions for the overwrite target could not be confirmed.',
      ],
      automatic: true,
      actionTaken: ['No automatic containment; effective permission escalation is unverified.'],
      auditCorrelation: 'CONFIRMED',
    });
    await this.saveIncident(guild, incident);
    await this.logIncident(guild, incident, 'audit');
  }

  private async containActor(guild: Guild, actorId: string, incidentId: string): Promise<string[]> {
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (actor === null) return ['ACTOR_NOT_IN_GUILD'];
    if (!actor.manageable) {
      await this.logHierarchyBlocked(
        guild,
        `PROTECTION_BLOCKED_BY_ROLE_HIERARCHY: actor ${actorId} cannot be managed during ${incidentId}.`,
      );
      return ['PROTECTION_BLOCKED_BY_ROLE_HIERARCHY'];
    }
    const dangerousRoles = actor.roles.cache.filter(
      (role) =>
        !role.managed &&
        role.id !== guild.roles.everyone.id &&
        DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission)),
    );
    const bot = guild.members.me;
    const removable = dangerousRoles.filter(
      (role) => bot !== null && role.position < bot.roles.highest.position,
    );
    const actions: string[] = [];
    if (removable.size > 0) {
      try {
        await this.mutate(guild.id, 'ROLES_REMOVE', () =>
          actor.roles.remove([...removable.keys()], `Xenon anti-nuke containment ${incidentId}`),
        );
        actions.push(`Removed ${String(removable.size)} dangerous role(s)`);
      } catch (error) {
        actions.push(
          error instanceof EnforcementBlockedError
            ? error.message
            : `Dangerous-role removal failed (${describeDiscordError(error)}); inspect role hierarchy and permissions`,
        );
      }
    }
    if (removable.size < dangerousRoles.size) {
      await this.logHierarchyBlocked(
        guild,
        `PROTECTION_BLOCKED_BY_ROLE_HIERARCHY: ${String(dangerousRoles.size - removable.size)} role(s) on actor ${actorId} are above XenonBot during ${incidentId}.`,
      );
      actions.push('PROTECTION_BLOCKED_BY_ROLE_HIERARCHY');
    }
    if (actions.length === 0 && actor.moderatable) {
      try {
        await this.mutate(guild.id, 'TIMEOUT', () =>
          actor.timeout(10 * 60 * 1_000, `Xenon anti-nuke containment ${incidentId}`),
        );
        actions.push('Actor timed out for 10 minutes');
      } catch (error) {
        actions.push(
          error instanceof EnforcementBlockedError
            ? error.message
            : `Timeout failed (${describeDiscordError(error)}); inspect bot permissions`,
        );
      }
    }
    return actions;
  }

  private async applyLinkPolicy(
    guild: Guild,
    message: Message,
    member: GuildMember,
    action: LinkAction,
    reason: string,
    domain: string | null,
    mode: EnforcementMode,
  ): Promise<void> {
    let actionTaken: string;
    if (mode !== 'ENFORCE') {
      actionTaken = describeWould(mode, [
        action === 'BLOCK' ? 'delete the message' : 'send a warning DM',
      ]);
    } else if (action === 'BLOCK') {
      const result = await this.tryMutate(guild.id, 'MESSAGE_DELETE', () => message.delete());
      actionTaken = result.done ? 'Message deleted' : (result.blocked ?? 'Message deletion failed');
    } else {
      const dmKey = `${guild.id}:${member.id}`;
      const now = Date.now();
      if (now - (this.linkWarningDms.get(dmKey) ?? 0) < LINK_WARNING_DM_COOLDOWN_MS) {
        actionTaken = 'Warning not re-sent (recently warned)';
      } else {
        boundedSet(this.linkWarningDms, dmKey, now, MAX_TRACKED_KEYS);
        const result = await this.tryMutate(guild.id, 'DM_SEND', () =>
          member.send(
            `A link in <#${message.channelId}> was flagged: ${reason}. Local URL checks are not malware detection.`,
          ),
        );
        actionTaken = result.done
          ? 'Warning sent privately'
          : (result.blocked ?? 'Private warning delivery failed');
      }
    }
    const incident = createIncident({
      severity: action === 'BLOCK' ? 'MEDIUM' : 'LOW',
      title: action === 'BLOCK' ? 'Link blocked by local policy' : 'Link requires moderator review',
      source: 'LinkGuard',
      rule: `LINK_${action}`,
      actorId: member.id,
      targetId: message.channelId,
      evidence: [
        reason,
        ...(domain === null ? [] : [`Domain: ${domain}`]),
        `Message ${message.id}`,
      ],
      automatic: true,
      actionTaken: [actionTaken],
      auditCorrelation: 'NOT_APPLICABLE',
    });
    await this.saveIncident(guild, incident);
    await this.logIncident(guild, incident, 'audit');
  }

  private async applySpamResponse(
    guild: Guild,
    message: Message,
    member: GuildMember,
    level: 'WARN' | 'DELETE' | 'TIMEOUT' | 'ESCALATE',
    reason: string,
    mode: EnforcementMode,
  ): Promise<void> {
    const cooldownKey = `${guild.id}:${member.id}`;
    const startedAt = Date.now();
    if (startedAt < (this.spamCooldowns.get(cooldownKey) ?? 0)) {
      if (level !== 'WARN' && mode === 'ENFORCE')
        await this.tryMutate(guild.id, 'MESSAGE_DELETE', () => message.delete());
      boundedSet(
        this.spamSuppressed,
        cooldownKey,
        (this.spamSuppressed.get(cooldownKey) ?? 0) + 1,
        MAX_TRACKED_KEYS,
      );
      return;
    }
    boundedSet(
      this.spamCooldowns,
      cooldownKey,
      startedAt + SPAM_ENFORCEMENT_COOLDOWN_MS,
      MAX_TRACKED_KEYS,
    );
    const suppressed = this.spamSuppressed.get(cooldownKey) ?? 0;
    this.spamSuppressed.delete(cooldownKey);
    const recentTimeouts = (await this.store.getGuild(guild.id)).security.cases.filter(
      (record) =>
        record.targetId === member.id &&
        record.action === 'TIMEOUT' &&
        Date.now() - Date.parse(record.createdAt) <= 60 * 60 * 1_000,
    ).length;
    const caseReason =
      suppressed > 0 ? `${reason} (+${String(suppressed)} suppressed detections)` : reason;
    const timeoutEligible = (level === 'TIMEOUT' || level === 'ESCALATE') && member.moderatable;
    const timeoutSeconds =
      recentTimeouts === 0 ? 10 * 60 : recentTimeouts === 1 ? 60 * 60 : 6 * 60 * 60;
    if (mode !== 'ENFORCE') {
      const steps = [
        ...(level === 'WARN' ? [] : ['delete the message']),
        timeoutEligible
          ? `time out the member for ${String(timeoutSeconds)} seconds`
          : 'send a warning DM',
      ];
      const observed = createIncident({
        severity: level === 'WARN' ? 'LOW' : level === 'DELETE' ? 'MEDIUM' : 'HIGH',
        title: `Spam detected (${level.toLowerCase()})`,
        source: 'SpamGuard',
        rule: `SPAM_${level}`,
        actorId: member.id,
        targetId: message.channelId,
        evidence: [caseReason.slice(0, 500), `Message ${message.id}`],
        automatic: true,
        actionTaken: [describeWould(mode, steps)],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      await this.saveIncident(guild, observed);
      await this.logIncident(
        guild,
        observed,
        level === 'TIMEOUT' || level === 'ESCALATE' ? 'alerts' : 'audit',
      );
      return;
    }
    let action: CaseAction = 'WARN';
    let duration: number | null = null;
    let deletion = 'Message not deleted';
    let blocked: string | null = null;
    if (level !== 'WARN') {
      const result = await this.tryMutate(guild.id, 'MESSAGE_DELETE', () => message.delete());
      deletion = result.done ? 'Message deleted' : (result.blocked ?? 'Message deletion failed');
      blocked = result.blocked;
    }
    if (timeoutEligible && blocked === null) {
      duration = timeoutSeconds;
      const result = await this.tryMutate(guild.id, 'TIMEOUT', () =>
        member.timeout(timeoutSeconds * 1_000, `Xenon spam protection: ${reason}`),
      );
      if (result.done) action = 'TIMEOUT';
      else {
        duration = null;
        blocked = result.blocked;
      }
    }
    if (action === 'WARN' && blocked === null) {
      const result = await this.tryMutate(guild.id, 'DM_SEND', () =>
        member.send(
          `Xenon spam protection flagged a message in <#${message.channelId}>: ${reason}.`,
        ),
      );
      blocked = result.blocked;
    }
    if (blocked !== null) {
      // The mode changed after the boundary check: record what happened without a moderation case.
      const interrupted = createIncident({
        severity: 'MEDIUM',
        title: `Spam response blocked by enforcement mode (${level.toLowerCase()})`,
        source: 'SpamGuard',
        rule: `SPAM_${level}`,
        actorId: member.id,
        targetId: message.channelId,
        evidence: [caseReason.slice(0, 500), `Message ${message.id}`],
        automatic: true,
        actionTaken: [deletion, blocked],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      await this.saveIncident(guild, interrupted);
      await this.logIncident(guild, interrupted, 'alerts');
      return;
    }
    const record = createCase({
      action,
      moderatorId: guild.client.user.id,
      targetId: member.id,
      reason: `Automatic spam guard (${level}): ${caseReason}`.slice(0, 1_000),
      durationSeconds: duration,
      evidenceReference: `Message ${message.id}`,
    });
    await this.saveCase(guild.id, record);
    await this.writeLog(
      guild,
      'modLogs',
      new EmbedBuilder()
        .setColor(level === 'ESCALATE' ? 0xb91c1c : 0xd97706)
        .setTitle(`Automatic spam action · ${record.id}`)
        .setDescription(
          `Member: <@${member.id}>\nAction: ${action}${duration === null ? '' : ` (${String(duration)} seconds)`}\nReason: ${caseReason}`,
        )
        .setTimestamp(),
    );
    if (level === 'ESCALATE') {
      const incident = {
        ...createIncident({
          severity: 'HIGH',
          title: 'Spam escalated for moderator review',
          source: 'SpamGuard',
          rule: 'SPAM_ESCALATE',
          actorId: member.id,
          targetId: message.channelId,
          evidence: [caseReason.slice(0, 500), `Message ${message.id}`, `Case ${record.id}`],
          automatic: true,
          actionTaken: [
            deletion,
            action === 'TIMEOUT' ? 'Member timed out' : 'Timeout not applied',
          ],
          auditCorrelation: 'NOT_APPLICABLE',
        }),
        status: action === 'TIMEOUT' ? ('CONTAINED' as const) : ('OPEN' as const),
      };
      await this.saveIncident(guild, incident);
      await this.logIncident(guild, incident, 'alerts');
    }
  }

  private async saveIncident(guild: Guild, incident: SecurityIncident): Promise<void> {
    await this.store.updateGuild(guild.id, (current) => ({
      ...current,
      security: {
        ...current.security,
        incidents: [...current.security.incidents, incident].slice(-500),
      },
    }));
  }

  private async updateIncident(
    guildId: string,
    incidentId: string,
    update: (incident: SecurityIncident) => SecurityIncident,
  ): Promise<void> {
    await this.store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        incidents: current.security.incidents.map((incident) =>
          incident.id === incidentId ? update(incident) : incident,
        ),
      },
    }));
  }

  private async logIncident(
    guild: Guild,
    incident: SecurityIncident,
    destination: 'alerts' | 'audit',
    unthrottled = false,
  ): Promise<void> {
    if (!(await this.notificationsAllowed(guild.id))) return;
    const carried = unthrottled ? { suppressed: 0, ids: [] } : this.throttleAlert(incident);
    if (carried === null) return;
    const config = (await this.store.getGuild(guild.id)).security.config;
    const channelId = destination === 'alerts' ? config.channels.alerts : config.channels.audit;
    const channel = channelId === null ? null : guild.channels.cache.get(channelId);
    const fields = [
      { name: 'Incident ID', value: incident.id, inline: true },
      { name: 'Severity', value: incident.severity, inline: true },
      { name: 'Status', value: incident.status, inline: true },
      {
        name: 'Actor',
        value: incident.actorId === null ? 'Unknown / not applicable' : `<@${incident.actorId}>`,
        inline: true,
      },
      {
        name: 'Target',
        value: incident.targetId === null ? 'Unknown / not applicable' : `<@${incident.targetId}>`,
        inline: true,
      },
      {
        name: 'Detection',
        value: `${incident.source} · ${incident.rule}`.slice(0, 1_000),
        inline: false,
      },
      {
        name: 'Evidence',
        value: incident.evidence.slice(0, 8).join('\n').slice(0, 1_000) || 'None',
        inline: false,
      },
      {
        name: 'Response',
        value: [...incident.actionTaken, incident.automatic ? 'Automatic' : 'Manual']
          .join('\n')
          .slice(0, 1_000),
        inline: false,
      },
      { name: 'Audit correlation', value: incident.auditCorrelation, inline: true },
    ];
    if (carried.suppressed > 0)
      fields.push({
        name: 'Suppressed similar alerts',
        value:
          `${String(carried.suppressed)} similar alert(s) not posted: ${carried.ids.join(', ')}`.slice(
            0,
            1_000,
          ),
        inline: false,
      });
    const embed = new EmbedBuilder()
      .setColor(
        incident.severity === 'CRITICAL'
          ? 0xb91c1c
          : incident.severity === 'HIGH'
            ? 0xea580c
            : 0xd97706,
      )
      .setTitle(`${incident.severity} · ${incident.title}`.slice(0, 256))
      .addFields(fields)
      .setTimestamp(new Date(incident.createdAt));
    if (channel === null || channel === undefined || !('send' in channel)) return;
    // The mode may have changed while the embed was prepared: decide again right before sending.
    if (!(await this.notificationsAllowed(guild.id))) return;
    await channel.send({ embeds: [embed] }).catch(() => undefined);
  }

  /** Returns null when a similar alert was posted recently; otherwise the suppressed tally to attach. */
  private throttleAlert(
    incident: SecurityIncident,
  ): { readonly suppressed: number; readonly ids: readonly string[] } | null {
    const key = `${incident.source}:${incident.rule}:${incident.actorId ?? '-'}`;
    const now = Date.now();
    const entry = this.alertThrottle.get(key);
    const windowMs = incident.severity === 'CRITICAL' ? 10_000 : 60_000;
    if (
      entry !== undefined &&
      now - entry.postedAt < windowMs &&
      SEVERITY_RANK[incident.severity] <= SEVERITY_RANK[entry.severity]
    ) {
      entry.suppressed += 1;
      if (entry.ids.length < 5) entry.ids.push(incident.id);
      return null;
    }
    boundedSet(
      this.alertThrottle,
      key,
      { postedAt: now, severity: incident.severity, suppressed: 0, ids: [] },
      MAX_TRACKED_KEYS,
    );
    return { suppressed: entry?.suppressed ?? 0, ids: entry?.ids ?? [] };
  }

  private async logAuditEntry(
    guild: Guild,
    entry: GuildAuditLogsEntry,
    incidentId: string,
  ): Promise<void> {
    if (!(await this.notificationsAllowed(guild.id))) return;
    const state = await this.store.getGuild(guild.id);
    const channelId = state.security.config.channels.audit;
    const channel = channelId === null ? null : guild.channels.cache.get(channelId);
    if (channel === null || channel === undefined || !('send' in channel)) return;
    const description = [
      `Entry ${entry.id}`,
      `Action ${String(entry.action)}`,
      `Target ${entry.targetId ?? 'unknown'}`,
      `Reason ${entry.reason ?? 'not provided'}`,
      `Incident ${incidentId}`,
    ].join('\n');
    if (!(await this.notificationsAllowed(guild.id))) return;
    await channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7f1d1d)
            .setTitle('Correlated Discord audit evidence')
            .setDescription(description.slice(0, 4_000))
            .setTimestamp(entry.createdAt),
        ],
      })
      .catch(() => undefined);
  }

  private async writeLog(
    guild: Guild,
    key: 'alerts' | 'audit' | 'modLogs',
    embed: EmbedBuilder,
  ): Promise<void> {
    if (!(await this.notificationsAllowed(guild.id))) return;
    const config = (await this.store.getGuild(guild.id)).security.config;
    const channelId = config.channels[key];
    const channel = channelId === null ? null : guild.channels.cache.get(channelId);
    if (channel === null || channel === undefined || !('send' in channel)) return;
    if (!(await this.notificationsAllowed(guild.id))) return;
    await channel.send({ embeds: [embed] }).catch(() => undefined);
  }

  private async logHierarchyBlocked(guild: Guild, detail: string): Promise<void> {
    const incident = createIncident({
      severity: 'HIGH',
      title: 'Protection blocked by Discord role hierarchy',
      source: 'PermissionGuard',
      rule: 'PROTECTION_BLOCKED_BY_ROLE_HIERARCHY',
      actorId: null,
      targetId: null,
      evidence: [detail],
      automatic: true,
      actionTaken: ['PROTECTION_BLOCKED_BY_ROLE_HIERARCHY'],
      auditCorrelation: 'NOT_APPLICABLE',
    });
    await this.saveIncident(guild, incident);
    await this.logIncident(guild, incident, 'alerts');
  }

  private async withContainmentLock<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.containmentTails.get(guildId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.containmentTails.set(guildId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.containmentTails.get(guildId) === tail) this.containmentTails.delete(guildId);
    }
  }

  private async persistLockdown(snapshot: LockdownSnapshot | null, guildId: string): Promise<void> {
    await this.store.updateGuild(guildId, (current) => ({
      ...current,
      security: { ...current.security, lockdown: snapshot },
    }));
  }

  private async setLockdownPatchStatus(
    snapshot: LockdownSnapshot,
    guildId: string,
    channelId: string,
    patchId: string,
    status: SecurityOverwritePatch['status'],
  ): Promise<LockdownSnapshot> {
    const next: LockdownSnapshot = {
      ...snapshot,
      channels: snapshot.channels.map((channel) =>
        channel.channelId !== channelId || channel.patches === undefined
          ? channel
          : {
              ...channel,
              patches: channel.patches.map((patch) =>
                patch.id === patchId ? { ...patch, status } : patch,
              ),
            },
      ),
    };
    await this.persistLockdown(next, guildId);
    return next;
  }

  private async persistQuarantine(snapshot: QuarantineSnapshot, guildId: string): Promise<void> {
    await this.store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        quarantines: [
          ...current.security.quarantines.filter((record) => record.targetId !== snapshot.targetId),
          snapshot,
        ],
      },
    }));
  }

  private async setQuarantinePatchStatus(
    snapshot: QuarantineSnapshot,
    guildId: string,
    channelId: string,
    status: SecurityOverwritePatch['status'],
  ): Promise<QuarantineSnapshot> {
    const next: QuarantineSnapshot = {
      ...snapshot,
      channels: snapshot.channels.map((channel) =>
        channel.channelId === channelId
          ? { ...channel, patch: { ...channel.patch, status } }
          : channel,
      ),
    };
    await this.persistQuarantine(next, guildId);
    return next;
  }

  private async applyOverwritePatch(
    guild: Guild,
    channelId: string,
    patch: SecurityOverwritePatch,
    direction: 'after' | 'before',
    reason: string,
  ): Promise<{ readonly applied: boolean; readonly detail: string; readonly blocked?: string }> {
    const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
    if (channel === null || !hasPermissionOverwrites(channel))
      return { applied: false, detail: 'channel is unavailable for overwrite recovery' };
    const mask = BigInt(patch.mask);
    const expected = direction === 'after' ? patch.before : patch.after;
    const desired = direction === 'after' ? patch.after : patch.before;
    const current = overwriteSnapshot(channel, patch.id, patch.type);
    if (!overwriteMatches(current, expected, mask))
      return {
        applied: false,
        detail: 'owned permission bits changed since the last confirmed state',
      };
    const options = overwriteOptions(patch, desired);
    if (Object.keys(options).length === 0) return { applied: true, detail: '' };
    try {
      await this.mutate(guild.id, 'PERMISSION_OVERWRITE', () =>
        channel.permissionOverwrites.edit(patch.id, options, {
          type: patch.type,
          reason: reason.slice(0, 500),
        }),
      );
    } catch (error) {
      if (error instanceof EnforcementBlockedError)
        return { applied: false, detail: error.message, blocked: error.message };
      return {
        applied: false,
        detail:
          error instanceof Error
            ? error.message.slice(0, 160)
            : 'Discord rejected the overwrite update',
      };
    }
    const refreshed = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
    if (refreshed === null || !hasPermissionOverwrites(refreshed))
      return {
        applied: false,
        detail: 'channel could not be refetched after the overwrite update',
      };
    if (!overwriteMatches(overwriteSnapshot(refreshed, patch.id, patch.type), desired, mask))
      return {
        applied: false,
        detail: 'Discord state differs from Xenon’s intended permission bits',
      };
    return { applied: true, detail: '' };
  }

  private async actorOutranksTarget(
    guild: Guild,
    actorId: string,
    target: GuildMember,
  ): Promise<boolean> {
    if (actorId === guild.ownerId) return true;
    if (target.id === guild.ownerId) return false;
    const actor = await guild.members.fetch({ user: actorId, force: true }).catch(() => null);
    return actor !== null && actor.roles.highest.comparePositionTo(target.roles.highest) > 0;
  }

  private isQuarantineCandidate(channel: GuildBasedChannel): channel is NonThreadGuildBasedChannel {
    return (
      hasPermissionOverwrites(channel) &&
      [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.GuildVoice,
        ChannelType.GuildStageVoice,
      ].includes(channel.type)
    );
  }

  private isLockdownCandidate(
    channel: GuildBasedChannel,
    config: SecurityConfig,
  ): channel is LockdownGuildChannel {
    if (!this.isSendableGuildChannel(channel)) return false;
    if (
      [config.channels.alerts, config.channels.audit, config.channels.modLogs].includes(channel.id)
    )
      return false;
    if (
      PUBLIC_EXCLUSION.test(channel.name) ||
      (channel.parent?.name !== undefined && PUBLIC_EXCLUSION.test(channel.parent.name))
    )
      return false;
    return true;
  }

  private isSendableGuildChannel(channel: GuildBasedChannel): channel is LockdownGuildChannel {
    return (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement ||
      channel.type === ChannelType.GuildForum ||
      channel.type === ChannelType.GuildMedia
    );
  }
}
function hasPermissionOverwrites(
  channel: GuildBasedChannel,
): channel is NonThreadGuildBasedChannel {
  return 'permissionOverwrites' in channel;
}

function overwriteSnapshot(
  channel: NonThreadGuildBasedChannel,
  id: string,
  type: 0 | 1,
): OverwriteSnapshot | null {
  const overwrite = channel.permissionOverwrites.cache.get(id);
  return overwrite?.type !== (type === 0 ? OverwriteType.Role : OverwriteType.Member)
    ? null
    : {
        id,
        type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      };
}

function makeOverwritePatch(
  id: string,
  type: 0 | 1,
  before: OverwriteSnapshot | null,
  policyMask: bigint,
  allowed: bigint,
): SecurityOverwritePatch | null {
  const beforeAllow = BigInt(before?.allow ?? '0');
  const beforeDeny = BigInt(before?.deny ?? '0');
  const afterAllow = (beforeAllow & ~policyMask) | (allowed & policyMask);
  const afterDeny = (beforeDeny & ~policyMask) | (policyMask & ~allowed);
  const changedMask = ((beforeAllow ^ afterAllow) | (beforeDeny ^ afterDeny)) & policyMask;
  if (changedMask === 0n) return null;
  return {
    id,
    type,
    mask: changedMask.toString(),
    before,
    after: {
      id,
      type,
      allow: afterAllow.toString(),
      deny: afterDeny.toString(),
    },
    status: 'PENDING',
  };
}

function overwriteMatches(
  current: OverwriteSnapshot | null,
  expected: OverwriteSnapshot | null,
  mask: bigint,
): boolean {
  return (
    (BigInt(current?.allow ?? '0') & mask) === (BigInt(expected?.allow ?? '0') & mask) &&
    (BigInt(current?.deny ?? '0') & mask) === (BigInt(expected?.deny ?? '0') & mask)
  );
}

function overwriteOptions(
  patch: SecurityOverwritePatch,
  desired: OverwriteSnapshot | null,
): PermissionOverwriteOptions {
  const mask = BigInt(patch.mask);
  const allowed = BigInt(desired?.allow ?? '0');
  const denied = BigInt(desired?.deny ?? '0');
  const options: PermissionOverwriteOptions = {};
  for (const [name, permission] of [...LOCKDOWN_PERMISSIONS, ...QUARANTINE_PERMISSIONS]) {
    if ((mask & permission) === 0n) continue;
    const value =
      (allowed & permission) !== 0n ? true : (denied & permission) !== 0n ? false : null;
    (options as Record<string, boolean | null>)[name] = value;
  }
  return options;
}
function permissionBitfield(value: unknown): bigint | null {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function containmentSucceeded(actions: readonly string[]): boolean {
  for (const action of actions) {
    if (
      action.startsWith('QUARANTINED:') ||
      action.startsWith('QUARANTINE_CASE_RECORD_FAILED:') ||
      action === 'QUARANTINE_ALREADY_ACTIVE' ||
      action.startsWith('Removed ') ||
      action.startsWith('Actor timed out')
    )
      return true;
    if (
      action.startsWith('LOCKDOWN_ACTIVE:') &&
      Number(action.slice('LOCKDOWN_ACTIVE:'.length).split('/')[0]) > 0
    )
      return true;
  }
  return false;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function describeDiscordError(error: unknown): string {
  if (error instanceof RateLimitError) return 'rate limited (HTTP 429)';
  if (error instanceof DiscordAPIError)
    return `Discord API error ${String(error.code)}: ${error.message}`.slice(0, 120);
  return (error instanceof Error ? error.message : 'unknown error').slice(0, 120);
}

export function trustForActor(
  config: SecurityConfig,
  actorId: string,
  guildOwnerId: string,
): TrustLevel | undefined {
  return actorId === guildOwnerId ? 'SECURITY_ADMIN' : config.trustedActors[actorId];
}

export function permissionCheck(
  memberPermissions: Readonly<PermissionsBitField> | null,
  required: bigint,
  trust: TrustLevel | undefined,
  owner: boolean,
  minimum: TrustLevel,
): boolean {
  const hasPermission = memberPermissions?.has(required) === true;
  return isAuthorized(trust, minimum, owner, hasPermission);
}
