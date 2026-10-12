// First: in development this loads the root .env, which the datastore clients
// imported below read as soon as they are evaluated.
// eslint-disable-next-line import-x/no-duplicates -- evaluation order: must run before the datastore imports
import './runtime';

import { once } from 'node:events';
import { createServer } from 'node:http';

import { linkGatewayTarget } from '@xenon/config/worker';
import { prisma } from '@xenon/database';
import { recordHeartbeat } from '@xenon/domain';
import { pollServerStatus } from '@xenon/fivem';
import { closeQueue, closeRedis, createRedisLinkRelayStore, enqueue, redis } from '@xenon/jobs';

import { createGatewayClient, type GatewayCall } from './gateway-client';
import { createRelayGatewayClient } from './gateway-relay-client';
import { createHandlers } from './handlers';
import { type LinkProbeResult, probeLink, probeLinkRelay, recordLinkHeartbeat } from './link-probe';
import { relayOutbox } from './outbox-relay';
import { startQueueWorker } from './queue-worker';
// eslint-disable-next-line import-x/no-duplicates -- see the side-effect import at the top
import { logger, workerEnv } from './runtime';

import type { Worker } from 'bullmq';

/**
 * The Xenon worker.
 *
 * Consumes the job queue, relays the transactional outbox onto it, runs the
 * scheduled sweeps and status polling, and writes the `worker` and `link`
 * heartbeats. It holds the database and Redis but no Discord token: every
 * Discord effect is a signed call to Xenon Link's gateway.
 */

/** Outbox latency budget: a decision's side effect starts within about a second. */
const RELAY_MS = 1_000;
const HEARTBEAT_MS = 30_000;
/** Frequent enough to feel live, gentle on the game server. */
const STATUS_POLL_MS = 60_000;
/** Expiry and cleanup. Neither is time-critical. */
const SWEEP_MS = 15 * 60_000;

function linksAllowed(): boolean {
  if (workerEnv.NODE_ENV !== 'production') return true;
  const host = new URL(workerEnv.NEXT_PUBLIC_SITE_URL).hostname;
  return host !== 'localhost' && host !== '127.0.0.1';
}

const gatewayTarget = linkGatewayTarget(workerEnv);
// Relay: requests are queued in Redis and Link pulls them through Core, so
// Link needs no public listener. HTTP: the worker POSTs to Link directly.
let gateway: GatewayCall;
let probeLinkTransport: () => Promise<LinkProbeResult>;
if (gatewayTarget.mode === 'relay') {
  const relayStore = createRedisLinkRelayStore(redis());
  gateway = createRelayGatewayClient({
    store: relayStore,
    secret: workerEnv.LINK_GATEWAY_SECRET,
  });
  probeLinkTransport = () => probeLinkRelay(relayStore);
} else {
  const { url } = gatewayTarget;
  gateway = createGatewayClient({ baseUrl: url, secret: workerEnv.LINK_GATEWAY_SECRET });
  probeLinkTransport = () => probeLink(url);
}
const handlers = createHandlers({
  db: prisma,
  gateway,
  logger,
  siteUrl: workerEnv.NEXT_PUBLIC_SITE_URL,
  guildId: workerEnv.DISCORD_GUILD_ID,
  linksAllowed: linksAllowed(),
});

const timers: NodeJS.Timeout[] = [];
const relayState = { lastSuccessAt: 0, lastError: null as string | null };

/** Run `task` every `ms`, never overlapping itself; failures are logged, not fatal. */
function every(name: string, ms: number, task: () => Promise<void>): void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void task()
      .catch((error: unknown) => {
        logger.warn({ err: error, task: name }, 'Scheduled task failed');
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  timers.push(setInterval(tick, ms));
}

async function relay(): Promise<void> {
  try {
    await relayOutbox({
      db: prisma,
      logger,
      enqueue: (name, payload, options) => enqueue(name, payload, options),
    });
    relayState.lastSuccessAt = Date.now();
    relayState.lastError = null;
  } catch (error) {
    relayState.lastError = error instanceof Error ? error.name : 'Error';
    throw error;
  }
}

async function pollAllServers(): Promise<void> {
  const servers = await prisma.server.findMany({ select: { id: true } });
  for (const server of servers) {
    try {
      await pollServerStatus(prisma, server.id);
    } catch (error) {
      // The probe failure is already recorded as a snapshot; one bad server
      // must not stop the others being polled.
      logger.warn({ err: error, serverId: server.id }, 'Status poll failed');
    }
  }
}

async function beat(): Promise<void> {
  await recordHeartbeat(prisma, 'worker', 'HEALTHY', { node: process.version });
}

let queueWorker: Worker | null = null;

function relayHealthy(): boolean {
  return Date.now() - relayState.lastSuccessAt < 30_000;
}

const healthServer = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  if (request.method !== 'GET' || path !== '/healthz') {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"not found"}');
    return;
  }
  const running = queueWorker?.isRunning() === true;
  const ok = running && relayHealthy();
  const body = JSON.stringify({
    service: 'worker',
    status: ok ? 'ok' : 'degraded',
    queueWorker: running ? 'running' : 'stopped',
    relay: relayHealthy() ? 'ok' : (relayState.lastError ?? 'starting'),
  });
  response
    .writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(body);
});

async function main(): Promise<void> {
  logger.info({ env: workerEnv.NODE_ENV }, 'Starting the Xenon worker');

  // Fail fast: nothing this process does is meaningful without the database.
  await prisma.$queryRaw`SELECT 1`;

  queueWorker = startQueueWorker(handlers, logger);

  healthServer.listen(workerEnv.WORKER_HEALTH_PORT, workerEnv.WORKER_HEALTH_HOST);
  await once(healthServer, 'listening');

  every('outbox-relay', RELAY_MS, relay);
  every('worker-heartbeat', HEARTBEAT_MS, beat);
  every('link-probe', HEARTBEAT_MS, async () => {
    const result = await recordLinkHeartbeat(prisma, probeLinkTransport);
    if (result.status !== 'HEALTHY')
      logger.warn(result.detail, 'Xenon Link gateway is not healthy');
  });
  every('status-poll', STATUS_POLL_MS, pollAllServers);
  every('sweeps', SWEEP_MS, async () => {
    await handlers['applications.expire']({});
    await handlers['maintenance.cleanup']({});
  });

  logger.info(
    { healthHost: workerEnv.WORKER_HEALTH_HOST, healthPort: workerEnv.WORKER_HEALTH_PORT },
    'Xenon worker ready',
  );
}

/**
 * Graceful shutdown: the queue worker closes first so an in-flight job
 * finishes rather than being killed halfway through a Discord call.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  for (const timer of timers) clearInterval(timer);

  await queueWorker?.close();
  const closed = once(healthServer, 'close');
  healthServer.close();
  await closed;
  await recordHeartbeat(prisma, 'worker', 'UNKNOWN', { reason: signal }).catch(() => undefined);
  await closeQueue();
  await closeRedis();
  await prisma.$disconnect();

  logger.info('Stopped');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start');
  process.exit(1);
});
