import { once } from 'node:events';

import { Events } from 'discord.js';

import { connectLinkClient, createLinkClient, registerGuildCommands } from './client';
import { handleCommand } from './commands';
import { createCoreClient } from './core-client';
import { waitForCore } from './core-readiness';
import { createGatewayExecutor } from './gateway/execute';
import { createGatewayOperations } from './gateway/operations';
import { startGatewayRelay, type GatewayRelay } from './gateway/relay';
import { createGatewayServer } from './gateway/server';
import { handleComponent } from './interactions';
import { startPresence } from './presence';
import { linkEnv, logger } from './runtime';

import type { Server } from 'node:http';

/**
 * Xenon Link: the platform Discord application.
 *
 * Starts without Core: commands answer with the "temporarily unavailable"
 * message until Core is back, and slash commands are (re)registered only once
 * Core answers, so no whitelist or identity command is advertised while it is
 * unreachable. Worker requests arrive either on the gateway HTTP server
 * (`LINK_GATEWAY_MODE=http`) or by pulling them from Core (`relay`, which opens
 * no listening socket). Nothing here holds a database or Redis credential.
 */
async function start(): Promise<void> {
  logger.info({ gatewayMode: linkEnv.LINK_GATEWAY_MODE }, 'Starting Xenon Link');

  const core = createCoreClient({
    baseUrl: linkEnv.CORE_API_URL,
    secret: linkEnv.LINK_CORE_SECRET,
    logger,
  });
  const client = createLinkClient();
  const guildId = linkEnv.DISCORD_GUILD_ID;

  client.on(Events.InteractionCreate, (interaction) => {
    // Interactions from any other guild (or a DM, for commands) are not ours to serve.
    if (interaction.guildId !== null && interaction.guildId !== guildId) return;

    const run = interaction.isChatInputCommand()
      ? interaction.guildId === null
        ? Promise.resolve()
        : handleCommand(interaction, { core, siteUrl: linkEnv.NEXT_PUBLIC_SITE_URL, logger })
      : handleComponent(interaction, { core, logger });
    run.catch((error: unknown) => {
      logger.error({ err: error }, 'Interaction handler failed');
    });
  });
  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  const handlers = createGatewayOperations({
    client,
    guildId,
    eventsChannelId: linkEnv.LINK_EVENTS_CHANNEL_ID,
    staffLogChannelId: linkEnv.LINK_STAFF_LOG_CHANNEL_ID,
    logger,
  });

  let server: Server | null = null;
  let relay: GatewayRelay | null = null;
  if (linkEnv.LINK_GATEWAY_MODE === 'relay') {
    relay = startGatewayRelay({
      core,
      execute: createGatewayExecutor({
        secret: linkEnv.LINK_GATEWAY_SECRET,
        handlers,
        logger,
      }),
      isDiscordReady: () => client.isReady(),
      logger,
    });
  } else {
    server = createGatewayServer({
      secret: linkEnv.LINK_GATEWAY_SECRET,
      guildId,
      handlers,
      isDiscordReady: () => client.isReady(),
      logger,
    });
    server.listen(linkEnv.LINK_GATEWAY_PORT, linkEnv.LINK_GATEWAY_HOST);
    // Rejects with the listen error (e.g. EADDRINUSE).
    await once(server, 'listening');
    logger.info(
      { host: linkEnv.LINK_GATEWAY_HOST, port: linkEnv.LINK_GATEWAY_PORT },
      'Link gateway listening',
    );
  }

  const lifecycle = new AbortController();
  let stopPresence: (() => void) | null = null;
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down Xenon Link');
    lifecycle.abort();
    stopPresence?.();
    try {
      await relay?.stop();
      server?.close();
      server?.closeAllConnections();
      await client.destroy();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await connectLinkClient(
      client,
      linkEnv.LINK_DISCORD_TOKEN,
      linkEnv.LINK_DISCORD_APPLICATION_ID,
    );
  } catch (error) {
    await relay?.stop();
    server?.close();
    throw error;
  }
  logger.info({ user: client.user?.tag }, 'Discord connected');

  // Commands are registered only once Core is reachable; a shutdown while
  // waiting ends startup quietly.
  if (!(await waitForCore({ core, logger, signal: lifecycle.signal }))) return;

  const guild = await client.guilds.fetch(guildId);
  await registerGuildCommands(guild);
  logger.info({ guildId: guild.id }, 'Link commands registered');

  stopPresence = startPresence(client, core, logger);
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start Xenon Link');
  process.exit(1);
});
