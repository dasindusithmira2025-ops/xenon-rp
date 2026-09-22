import { Events } from 'discord.js';

import { prisma } from '@xenon/database';
import { recordHeartbeat } from '@xenon/domain';
import { closeQueue, closeRedis } from '@xenon/jobs';

import { connectDiscord, disconnectDiscord } from './discord/client';
import { handleCommand } from './discord/commands';
import { handleButton, handleModal } from './discord/interactions';
import { inspectDiscordInstallation } from './health/diagnostics';
import { botEnv, logger } from './runtime';
import { startWorker, stopWorker } from './workers';
import { handlers, pollAllServers } from './workers/handlers';

/**
 * The persistent Xenon service.
 *
 * Two responsibilities in one process: the Discord gateway connection and the
 * job worker. They are together because both need a long-lived process with the
 * bot token, and running two containers to avoid one import is a worse trade
 * than the coupling.
 *
 * It must never run as a serverless function. A gateway connection is a
 * WebSocket that has to stay open, and a function that is frozen between
 * invocations cannot hold one.
 *
 * The process is useful even with no Discord credentials at all: the worker,
 * the sweeps and FiveM synchronisation all run, which is what makes the
 * platform fully exercisable on a fresh clone.
 */

/** How often the web tier's health page expects to see us. */
const HEARTBEAT_MS = 30_000;
/** Status polling. Frequent enough to feel live, gentle on the game server. */
const STATUS_POLL_MS = 60_000;
/** Expiry and cleanup. Neither is time-critical. */
const SWEEP_MS = 15 * 60_000;

const timers: ReturnType<typeof setInterval>[] = [];

async function beat(
  botStatus: 'HEALTHY' | 'DEGRADED',
  botDetail: Record<string, string | number | boolean>,
): Promise<void> {
  try {
    await recordHeartbeat(prisma, 'bot', botStatus, {
      ...botDetail,
      node: process.version,
    });
    await recordHeartbeat(prisma, 'worker', 'HEALTHY', { node: process.version });
  } catch (error) {
    // A heartbeat failure means the database is unreachable, which the health
    // page will notice on its own. Logging and continuing is correct: the
    // process may still be doing useful work when the database returns.
    logger.warn({ err: error }, 'Could not write heartbeat');
  }
}

async function main(): Promise<void> {
  logger.info(
    { env: botEnv.NODE_ENV, discordMode: botEnv.DISCORD_MODE },
    'Starting the Xenon service',
  );

  // Fail fast on the database: nothing this process does is meaningful without
  // it, and a silent start followed by every job failing is worse.
  await prisma.$queryRaw`SELECT 1`;
  logger.info('Database reachable');

  startWorker();

  const client = await connectDiscord((instance) => {
    instance.on(Events.InteractionCreate, (interaction) => {
      // Handlers are async and discord.js does not await the listener, so each
      // is explicitly caught; an unhandled rejection here would take the
      // process down and stop the worker with it.
      const run = async (): Promise<void> => {
        if (interaction.isChatInputCommand()) {
          await handleCommand(interaction);
        } else if (interaction.isButton()) {
          await handleButton(interaction);
        } else if (interaction.isModalSubmit()) {
          await handleModal(interaction);
        }
      };

      void run().catch((error: unknown) => {
        logger.error({ err: error }, 'Interaction handler failed');
      });
    });
  });

  const installation = client === null ? null : await inspectDiscordInstallation(client);
  if (installation !== null) {
    logger.info(
      { ...installation.detail, status: installation.status },
      'Discord installation diagnostics complete',
    );
  }

  const currentBotStatus = (): 'HEALTHY' | 'DEGRADED' => {
    if (botEnv.DISCORD_MODE === 'disabled') return 'DEGRADED';
    if (client?.isReady() !== true || installation?.status !== 'HEALTHY') return 'DEGRADED';
    return 'HEALTHY';
  };
  const currentBotDetail = (): Record<string, string | number | boolean> => ({
    discordMode: botEnv.DISCORD_MODE,
    gatewayReady: client?.isReady() ?? false,
    gatewayLatencyMs: client?.ws.ping ?? -1,
    ...(installation?.detail ?? {}),
  });

  await beat(currentBotStatus(), currentBotDetail());

  timers.push(
    setInterval(() => {
      void beat(currentBotStatus(), currentBotDetail());
    }, HEARTBEAT_MS),
  );

  timers.push(
    setInterval(() => {
      void pollAllServers().catch((error: unknown) => {
        logger.warn({ err: error }, 'Status poll sweep failed');
      });
    }, STATUS_POLL_MS),
  );

  timers.push(
    setInterval(() => {
      void (async (): Promise<void> => {
        await handlers['applications.expire']({});
        await handlers['maintenance.cleanup']({});
      })().catch((error: unknown) => {
        logger.warn({ err: error }, 'Maintenance sweep failed');
      });
    }, SWEEP_MS),
  );

  // One poll immediately so a fresh start does not leave the status page
  // reading "unavailable" for a minute.
  void pollAllServers().catch(() => undefined);

  logger.info('Xenon service ready');
}

/**
 * Graceful shutdown.
 *
 * The worker is closed first so an in-flight job finishes rather than being
 * killed halfway through a Discord call; everything else follows.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');

  for (const timer of timers) clearInterval(timer);

  await recordHeartbeat(prisma, 'bot', 'UNKNOWN', { reason: signal }).catch(() => undefined);

  await stopWorker();
  await disconnectDiscord();
  await closeQueue();
  await closeRedis();
  await prisma.$disconnect();

  logger.info('Stopped');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
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
