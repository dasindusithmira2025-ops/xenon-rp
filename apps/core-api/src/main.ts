// First: in development this loads the root .env, which the datastore clients
// imported below read as soon as they are evaluated.
// eslint-disable-next-line import-x/no-duplicates -- evaluation order: must run before the datastore imports
import './runtime';

import { once } from 'node:events';
import { createServer } from 'node:http';

import { prisma } from '@xenon/database';
import { recordHeartbeat } from '@xenon/domain';
import {
  closeQueue,
  closeRedis,
  createRedisLinkRelayStore,
  enforceRateLimit,
  redis,
} from '@xenon/jobs';

import { createOperations } from './operations';
import { createRelayOperations } from './relay';
import { createReplayGuard } from './replay';
// eslint-disable-next-line import-x/no-duplicates -- see the side-effect import at the top
import { coreApiEnv, logger } from './runtime';
import { createCoreRequestListener } from './server';

/**
 * The Xenon Core API process.
 *
 * Xenon Link's only way into the platform: it holds the database and Redis
 * credentials Link deliberately lacks, runs the shared domain services, and
 * records side effects in the outbox for the worker.
 */

const HEARTBEAT_MS = 30_000;

let heartbeat: NodeJS.Timeout | undefined;

async function beat(): Promise<void> {
  try {
    await recordHeartbeat(prisma, 'core-api', 'HEALTHY', { node: process.version });
  } catch (error) {
    // The database being down is visible on its own; keep serving what we can.
    logger.warn({ err: error }, 'Could not write heartbeat');
  }
}

const relay = createRelayOperations({ store: createRedisLinkRelayStore(redis()), logger });

const server = createServer(
  createCoreRequestListener({
    secret: coreApiEnv.LINK_CORE_SECRET,
    handlers: createOperations(prisma, { siteUrl: coreApiEnv.NEXT_PUBLIC_SITE_URL }),
    relay: relay.handlers,
    replay: createReplayGuard(redis(), {
      onFallback: (error) => {
        logger.warn({ err: error }, 'Redis unavailable; using the in-process nonce cache');
      },
    }),
    logger,
    ready: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    rateLimit: (actorDiscordId) => enforceRateLimit('discordCommand', actorDiscordId),
  }),
);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

async function main(): Promise<void> {
  // Fail fast: nothing Core does is meaningful without the database.
  await prisma.$queryRaw`SELECT 1`;

  server.listen(coreApiEnv.CORE_API_PORT, coreApiEnv.CORE_API_HOST);
  await once(server, 'listening');

  await beat();
  heartbeat = setInterval(() => {
    void beat();
  }, HEARTBEAT_MS);

  logger.info(
    { host: coreApiEnv.CORE_API_HOST, port: coreApiEnv.CORE_API_PORT },
    'Core API listening',
  );
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  clearInterval(heartbeat);

  // Stop accepting, let in-flight decisions finish, then release the pools.
  const closed = once(server, 'close');
  // End long-polls first, or server.close() would wait out their 20 s holds.
  relay.close();
  server.close();
  server.closeIdleConnections();
  await closed;
  await recordHeartbeat(prisma, 'core-api', 'UNKNOWN', { reason: signal }).catch(() => undefined);
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
