/**
 * The job catalogue.
 *
 * Every external side effect in the platform is one of these. Domain services
 * never call Discord or FXServer inline: they commit the canonical decision to
 * Postgres and enqueue here, which is what makes "Discord was down when the
 * application was approved" a delayed notification rather than a lost approval.
 *
 * Payloads carry database ids, never rendered content. The worker re-reads the
 * current row, so a job that sits in the queue through three state changes
 * delivers the state that is true when it runs rather than the state that was
 * true when it was queued.
 */

export interface JobPayloads {
  /** Post (or refresh) the staff review card for a submission. */
  'discord.review.post': { submissionId: string };
  /** Re-render an existing review card after a decision. */
  'discord.review.update': { submissionId: string };
  /** Deliver a stored notification as a direct message. */
  'discord.dm': { notificationId: string };
  /** Post a message into a configured channel. */
  'discord.channel.post': {
    channelId: string;
    kind: 'ANNOUNCEMENT' | 'STATUS_BOARD';
    entityType: string;
    entityId: string;
  };
  /** Reconcile one user's Discord roles against their Xenon roles. */
  'discord.role.sync': { userId: string; reason: string };
  /** Refresh cached guild metadata and member counts. */
  'discord.guild.sync': { guildId: string };

  /** Push one user's whitelist state to every configured game server. */
  'fivem.whitelist.sync': { userId: string; reason: string };
  /** Poll a game server and write a normalised status snapshot. */
  'fivem.status.poll': { serverId: string };

  /** Move submissions past their expiry window to EXPIRED. */
  'applications.expire': Record<string, never>;
  /** Delete spent link tokens and stale snapshots. */
  'maintenance.cleanup': Record<string, never>;
}

export type JobName = keyof JobPayloads;

export interface JobEnvelope<TName extends JobName = JobName> {
  readonly name: TName;
  readonly payload: JobPayloads[TName];
}

/** Queue name. One queue keeps ordering and observability in a single place. */
export const QUEUE_NAME = 'xenon';

/**
 * Retry policy per job family.
 *
 * Discord and FXServer both rate-limit and both have short outages, so the
 * backoff is exponential and the attempt count is generous. Maintenance sweeps
 * run on a schedule and a missed run costs nothing, so they retry once.
 */
export const retryPolicy: Record<JobName, { attempts: number; backoffMs: number }> = {
  'discord.review.post': { attempts: 8, backoffMs: 5_000 },
  'discord.review.update': { attempts: 8, backoffMs: 5_000 },
  'discord.dm': { attempts: 5, backoffMs: 10_000 },
  'discord.channel.post': { attempts: 6, backoffMs: 5_000 },
  'discord.role.sync': { attempts: 8, backoffMs: 5_000 },
  'discord.guild.sync': { attempts: 3, backoffMs: 30_000 },
  'fivem.whitelist.sync': { attempts: 10, backoffMs: 10_000 },
  'fivem.status.poll': { attempts: 2, backoffMs: 5_000 },
  'applications.expire': { attempts: 2, backoffMs: 60_000 },
  'maintenance.cleanup': { attempts: 2, backoffMs: 60_000 },
};

/**
 * Deterministic job id, so the same intent enqueued twice collapses into one.
 *
 * Approving an application writes the decision, updates the review card and
 * syncs roles; if a reviewer double-clicks, or a retry re-runs the service, the
 * second enqueue must not produce a second Discord message. Jobs whose id is
 * `undefined` are genuinely independent and are allowed to run once each.
 *
 * The separator is `~` rather than the obvious `:`, because BullMQ builds Redis
 * keys out of job ids and refuses any id containing a colon.
 */
export function jobIdFor<TName extends JobName>(
  name: TName,
  payload: JobPayloads[TName],
): string | undefined {
  switch (name) {
    case 'discord.review.post':
    case 'discord.review.update':
      return `${name}~${(payload as JobPayloads['discord.review.post']).submissionId}`;
    case 'discord.dm':
      return `${name}~${(payload as JobPayloads['discord.dm']).notificationId}`;
    case 'discord.guild.sync':
      return `${name}~${(payload as JobPayloads['discord.guild.sync']).guildId}`;
    // Role and whitelist syncs deliberately do not collapse: two changes in
    // quick succession must both be reconciled, and each run is idempotent.
    case 'discord.channel.post':
    case 'discord.role.sync':
    case 'fivem.whitelist.sync':
    case 'fivem.status.poll':
    case 'applications.expire':
    case 'maintenance.cleanup':
      return undefined;
  }
}
