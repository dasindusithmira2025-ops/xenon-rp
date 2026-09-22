import { Client, GatewayIntentBits, Partials } from 'discord.js';

import { botEnv, hasRealDiscordCredentials, logger } from '../runtime';

/**
 * The gateway client.
 *
 * Intents are least privilege, and the two that are absent are absent on
 * purpose:
 *
 *  - `MessageContent` is never requested. Every interaction is a slash command
 *    or a button, so the bot has no reason to read what anybody types, and
 *    asking for it would mean a privileged-intent review and a promise we do
 *    not need to make.
 *  - `GuildPresences` is never requested. Who is online is not something this
 *    platform models.
 *
 * `GuildMembers` is deliberately absent. Role and membership reconciliation
 * use one-member REST lookups and do not need the privileged Gateway intent.
 */

let client: Client | null = null;

export function discordClient(): Client | null {
  return client;
}

/** True once the gateway has connected. Workers check this before acting. */
export function isDiscordReady(): boolean {
  return client?.isReady() ?? false;
}

/**
 * Connect to the gateway.
 *
 * Returns null when the credentials are placeholders, which is the normal
 * state of a fresh clone. The rest of the process - the job workers, the
 * heartbeat, the FiveM sync - runs regardless, so the platform is fully
 * exercisable before anybody creates a Discord application.
 */
export async function connectDiscord(
  registerHandlers?: (instance: Client) => void,
): Promise<Client | null> {
  if (!hasRealDiscordCredentials()) {
    logger.warn(
      'DISCORD_MODE=disabled. Running without a gateway connection: ' +
        'Discord jobs will complete as no-ops and everything else works normally.',
    );
    return null;
  }

  const instance = new Client({
    intents: [GatewayIntentBits.Guilds],
    // Users and channels are partial until fetched; the bot never listens to
    // guild member gateway events.
    partials: [Partials.User, Partials.Channel],
  });

  // Register handlers before login can receive events.
  registerHandlers?.(instance);

  instance.once('clientReady', () => {
    logger.info(
      { user: instance.user?.tag, guilds: instance.guilds.cache.size },
      'Connected to Discord',
    );
  });

  instance.on('error', (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  instance.on('shardDisconnect', (event, shardId) => {
    // discord.js reconnects on its own; this exists so an operator reading the
    // logs can tell a disconnect from a crash.
    logger.warn({ shardId, code: event.code }, 'Shard disconnected, will reconnect');
  });

  const token = botEnv.DISCORD_BOT_TOKEN;
  if (token === undefined) {
    await instance.destroy();
    throw new Error('DISCORD_BOT_TOKEN is required when DISCORD_MODE=enabled.');
  }
  const ready = new Promise<void>((resolve) => {
    instance.once('clientReady', () => {
      resolve();
    });
  });

  await instance.login(token);

  if (!instance.isReady()) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Discord gateway did not become ready in time.'));
          }, 20_000);
        }),
      ]);
    } catch (error) {
      await instance.destroy();
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  if (instance.user?.id !== botEnv.DISCORD_APPLICATION_ID) {
    await instance.destroy();
    throw new Error(
      'The configured DISCORD_APPLICATION_ID does not match the bot user for DISCORD_BOT_TOKEN.',
    );
  }

  client = instance;
  return instance;
}

export async function disconnectDiscord(): Promise<void> {
  await client?.destroy();
  client = null;
}

/** The configured primary guild, or null when it cannot be reached. */
export async function primaryGuild() {
  const instance = discordClient();
  if (instance === null || botEnv.DISCORD_GUILD_ID === undefined) return null;

  try {
    return await instance.guilds.fetch(botEnv.DISCORD_GUILD_ID);
  } catch (error) {
    logger.error(
      { err: error, guildId: botEnv.DISCORD_GUILD_ID },
      'Cannot reach the configured guild',
    );
    return null;
  }
}
