import type { Db, ServiceStatus } from '@xenon/database';
import { pingRedis, queueDepth } from '@xenon/jobs';

/**
 * Platform health.
 *
 * Read by /control/system/health and by the container health probe. Every check
 * is bounded and independent: one unreachable dependency must not make the
 * health page itself time out, which is exactly when it is most needed.
 */

export interface HealthCheck {
  readonly name: string;
  readonly status: ServiceStatus;
  readonly detail: string;
  readonly latencyMs: number | null;
}

export interface HealthReport {
  readonly status: ServiceStatus;
  readonly checks: readonly HealthCheck[];
  readonly checkedAt: string;
}

/** A heartbeat older than this means the process is gone, not just quiet. */
const HEARTBEAT_STALE_MS = 90 * 1000;

/** An outbox row waiting longer than this means the relay is stuck or Redis is down. */
const OUTBOX_STALE_MS = 5 * 60 * 1000;

/**
 * Services that write a heartbeat row. `link` is written by the worker after
 * probing Xenon Link's gateway, because Link holds no database credential.
 * Xenon Guardian has no database at all and reports only on its own endpoint.
 */
const HEARTBEAT_SERVICES: Readonly<Record<string, string>> = {
  'core-api': 'Never reported. Start it with `pnpm --filter @xenon/core-api dev`.',
  worker: 'Never reported. Start it with `pnpm --filter @xenon/worker dev`.',
  link: 'Never reported. The worker records it after probing the Xenon Link gateway.',
};

async function timed<T>(run: () => Promise<T>): Promise<{ value: T | undefined; ms: number }> {
  const started = Date.now();
  try {
    return { value: await run(), ms: Date.now() - started };
  } catch {
    return { value: undefined, ms: Date.now() - started };
  }
}

async function checkDatabase(db: Db): Promise<HealthCheck> {
  const { value, ms } = await timed(() => db.$queryRaw`SELECT 1`);
  return {
    name: 'database',
    status: value === undefined ? 'UNHEALTHY' : ms > 500 ? 'DEGRADED' : 'HEALTHY',
    detail: value === undefined ? 'Query failed' : `Responded in ${String(ms)}ms`,
    latencyMs: ms,
  };
}

async function checkRedis(): Promise<HealthCheck> {
  const { value, ms } = await timed(pingRedis);
  const ok = value === true;
  return {
    name: 'redis',
    status: ok ? (ms > 300 ? 'DEGRADED' : 'HEALTHY') : 'UNHEALTHY',
    detail: ok ? `PONG in ${String(ms)}ms` : 'No response',
    latencyMs: ms,
  };
}

async function checkQueue(): Promise<HealthCheck> {
  const { value, ms } = await timed(queueDepth);
  if (value === undefined) {
    return { name: 'jobs', status: 'UNHEALTHY', detail: 'Queue unreachable', latencyMs: ms };
  }

  // A backlog is not a failure; a backlog that never drains is. The threshold
  // is a signal for a human, not an alarm.
  const status: ServiceStatus =
    value.failed > 50 ? 'DEGRADED' : value.waiting > 500 ? 'DEGRADED' : 'HEALTHY';

  return {
    name: 'jobs',
    status,
    detail: `${String(value.waiting)} waiting, ${String(value.active)} active, ${String(value.failed)} failed`,
    latencyMs: ms,
  };
}

/**
 * Long-running processes report in rather than being probed.
 *
 * The web tier cannot reach the bots' gateway connections, and trying to would
 * couple the deployments. Core API and the worker write a heartbeat row; the
 * worker writes Link's after probing its gateway.
 */
async function checkHeartbeats(db: Db): Promise<readonly HealthCheck[]> {
  const rows = await db.serviceHeartbeat.findMany();
  const now = Date.now();

  const expected = Object.keys(HEARTBEAT_SERVICES);
  return expected.map((service): HealthCheck => {
    const row = rows.find((candidate) => candidate.service === service);
    if (row === undefined) {
      return {
        name: service,
        status: 'UNKNOWN',
        detail: HEARTBEAT_SERVICES[service] ?? 'Never reported.',
        latencyMs: null,
      };
    }

    const age = now - row.beatAt.getTime();
    if (age > HEARTBEAT_STALE_MS) {
      return {
        name: service,
        status: 'UNHEALTHY',
        detail: `Last heartbeat ${String(Math.round(age / 1000))}s ago`,
        latencyMs: null,
      };
    }

    return {
      name: service,
      status: row.status,
      detail: `Healthy, last beat ${String(Math.round(age / 1000))}s ago`,
      latencyMs: null,
    };
  });
}

/**
 * The transactional outbox. Rows waiting is normal; rows waiting for minutes
 * means the relay is not running or cannot reach Redis, and side effects
 * (Discord, FiveM) are being delayed - never lost.
 */
async function checkOutbox(db: Db): Promise<HealthCheck> {
  const now = new Date();
  const { value, ms } = await timed(() =>
    Promise.all([
      db.outboxMessage.count({ where: { dispatchedAt: null } }),
      db.outboxMessage.findFirst({
        where: { dispatchedAt: null, availableAt: { lte: now } },
        orderBy: { availableAt: 'asc' },
        select: { availableAt: true },
      }),
    ]),
  );
  if (value === undefined) {
    return { name: 'outbox', status: 'UNHEALTHY', detail: 'Outbox unreadable', latencyMs: ms };
  }

  const [pending, oldest] = value;
  const ageMs = oldest === null ? 0 : Math.max(0, now.getTime() - oldest.availableAt.getTime());
  const ageSeconds = Math.round(ageMs / 1000);
  return {
    name: 'outbox',
    status: ageMs > OUTBOX_STALE_MS ? 'DEGRADED' : 'HEALTHY',
    detail:
      pending === 0
        ? 'Nothing pending'
        : `${String(pending)} pending, oldest due ${String(ageSeconds)}s ago`,
    latencyMs: ms,
  };
}

async function checkGameServers(db: Db): Promise<HealthCheck> {
  const servers = await db.server.count();
  if (servers === 0) {
    return {
      name: 'fivem',
      status: 'UNKNOWN',
      detail: 'No game server configured yet. Add one in /control/integrations/fivem.',
      latencyMs: null,
    };
  }

  const stale = await db.whitelist.count({
    where: { state: { in: ['APPROVED', 'REVOKED'] }, syncFailedAt: { not: null } },
  });

  return {
    name: 'fivem',
    status: stale > 0 ? 'DEGRADED' : 'HEALTHY',
    detail: stale > 0 ? `${String(stale)} whitelist records failed to sync` : 'Whitelist in sync',
    latencyMs: null,
  };
}

async function checkDiscord(db: Db): Promise<HealthCheck> {
  const guild = await db.discordGuild.findFirst({ where: { isPrimary: true } });
  if (guild === null) {
    return {
      name: 'discord',
      status: 'UNKNOWN',
      detail: 'No guild configured. Add one in /control/integrations/discord.',
      latencyMs: null,
    };
  }

  const blocked = await db.discordRoleMapping.count({ where: { hierarchyBlocked: true } });
  if (blocked > 0) {
    return {
      name: 'discord',
      status: 'DEGRADED',
      detail: `${String(blocked)} role mappings are above the bot in the hierarchy`,
      latencyMs: null,
    };
  }

  return {
    name: 'discord',
    status: guild.syncError === null ? 'HEALTHY' : 'DEGRADED',
    detail: guild.syncError ?? `Guild ${guild.name} linked`,
    latencyMs: null,
  };
}

/** The worst status wins, with UNKNOWN treated as "not yet a problem". */
function worst(checks: readonly HealthCheck[]): ServiceStatus {
  if (checks.some((check) => check.status === 'UNHEALTHY')) return 'UNHEALTHY';
  if (checks.some((check) => check.status === 'DEGRADED')) return 'DEGRADED';
  if (checks.every((check) => check.status === 'UNKNOWN')) return 'UNKNOWN';
  return 'HEALTHY';
}

export async function healthReport(db: Db): Promise<HealthReport> {
  const [database, redis, jobs, outbox, heartbeats, fivem, discord] = await Promise.all([
    checkDatabase(db),
    checkRedis(),
    checkQueue(),
    checkOutbox(db),
    checkHeartbeats(db),
    checkGameServers(db),
    checkDiscord(db),
  ]);

  const checks = [database, redis, jobs, outbox, ...heartbeats, fivem, discord];

  return {
    status: worst(checks),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

/** Called by long-running processes to report liveness. */
export async function recordHeartbeat(
  db: Db,
  service: string,
  status: ServiceStatus,
  detail?: Record<string, string | number | boolean>,
): Promise<void> {
  await db.serviceHeartbeat.upsert({
    where: { service },
    create: { service, status, beatAt: new Date(), ...(detail === undefined ? {} : { detail }) },
    update: { status, beatAt: new Date(), ...(detail === undefined ? {} : { detail }) },
  });
}
