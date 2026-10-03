import { Events } from 'discord.js';

import { prisma } from '@xenon/database';
import { parseXenonId } from '@xenon/discord';
import { recordHeartbeat } from '@xenon/domain';
import { closeQueue, closeRedis } from '@xenon/jobs';

import { connectDiscord, disconnectDiscord } from './discord/client';
import { handleCommand } from './discord/commands';
import {
  handleButton,
  handleModal,
  handleStringSelect,
  handleTicketClose,
} from './discord/interactions';
import { liveHealth, refreshStatusPanel, rotatePresence, sweepDrift } from './discord/live';
import { failInterruptedRuns } from './discord/provisioning/runner';
import { handleRoleToggle } from './discord/self-roles';
import { handleSetupComponent } from './discord/setup-command';
import { handleVoiceState, sweepRooms } from './discord/temp-voice';
import { handleMemberJoin, welcomeEvent } from './discord/welcome';
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
/** Presence rotation. Slow on purpose: a status that flickers reads as a bug. */
const PRESENCE_MS = 5 * 60_000;
/** Desired-versus-actual comparison of the managed server. */
const DRIFT_MS = 30 * 60_000;

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
          return;
        }
        if (interaction.isStringSelectMenu()) {
          await handleStringSelect(interaction);
          return;
        }
        if (!interaction.isButton() && !interaction.isModalSubmit()) return;

        // Persistent Xenon components carry structured ids; review cards keep
        // their original `app:` ids and handlers.
        const xenonId = parseXenonId(interaction.customId);
        if (xenonId?.namespace === 'role' && interaction.isButton()) {
          await handleRoleToggle(interaction, xenonId);
        } else if (xenonId?.namespace === 'setup') {
          await handleSetupComponent(interaction, xenonId);
        } else if (
          xenonId?.namespace === 'ticket' &&
          xenonId.action === 'close' &&
          interaction.isButton()
        ) {
          await handleTicketClose(interaction, xenonId.argument ?? '');
        } else if (interaction.isButton()) {
          await handleButton(interaction);
        } else {
          await handleModal(interaction);
        }
      };

      void run().catch((error: unknown) => {
        logger.error({ err: error }, 'Interaction handler failed');
      });
    });

    instance.on(Events.VoiceStateUpdate, (before, after) => {
      void handleVoiceState(before, after).catch((error: unknown) => {
        logger.warn({ err: error }, 'Temporary voice handling failed');
      });
    });

    instance.on(welcomeEvent, (member) => {
      void handleMemberJoin(member).catch((error: unknown) => {
        logger.warn({ err: error, guildId: member.guild.id }, 'Member welcome handling failed');
      });
    });
  });

  // A run that was mid-flight when the process stopped will never finish.
  const interrupted = await failInterruptedRuns();
  if (interrupted > 0)
    logger.warn({ interrupted }, 'Marked interrupted provisioning runs as failed');

  const installation = client === null ? null : await inspectDiscordInstallation(client);
  if (installation !== null) {
    logger.info(
      { ...installation.detail, status: installation.status },
      'Discord installation diagnostics complete',
    );
  }

  const currentBotStatus = (): 'HEALTHY' | 'DEGRADED' => {
    if (botEnv.DISCORD_MODE === 'disabled') return 'DEGRADED';
    // Liveness reflects the connected bot and configured guild. Channel and
    // role setup issues remain visible in installation diagnostics below.
    if (client?.isReady() !== true || installation?.detail.guildReachable !== true) {
      return 'DEGRADED';
    }
    return 'HEALTHY';
  };
  const currentBotDetail = (): Record<string, string | number | boolean> => ({
    discordMode: botEnv.DISCORD_MODE,
    gatewayReady: client?.isReady() ?? false,
    gatewayLatencyMs: client?.ws.ping ?? -1,
    ...(installation?.detail ?? {}),
    managedDrift: liveHealth.drift,
    managedCritical: liveHealth.critical,
    ...(liveHealth.checkedAt === null ? {} : { driftCheckedAt: liveHealth.checkedAt }),
  });

  await beat(currentBotStatus(), currentBotDetail());

  timers.push(
    setInterval(() => {
      void beat(currentBotStatus(), currentBotDetail());
    }, HEARTBEAT_MS),
  );

  timers.push(
    setInterval(() => {
      void pollAllServers()
        .then(() => (client === null ? undefined : refreshStatusPanel(client)))
        .catch((error: unknown) => {
          logger.warn({ err: error }, 'Status poll sweep failed');
        });
    }, STATUS_POLL_MS),
  );

  if (client !== null) {
    void sweepRooms(client).catch((error: unknown) => {
      logger.warn({ err: error }, 'Temporary room sweep failed');
    });
    void rotatePresence(client).catch(() => undefined);
    timers.push(
      setInterval(() => {
        void rotatePresence(client).catch((error: unknown) => {
          logger.debug({ err: error }, 'Presence rotation failed');
        });
      }, PRESENCE_MS),
      setInterval(() => {
        void sweepDrift(client).catch((error: unknown) => {
          logger.warn({ err: error }, 'Drift sweep failed');
        });
      }, DRIFT_MS),
    );
  }

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
