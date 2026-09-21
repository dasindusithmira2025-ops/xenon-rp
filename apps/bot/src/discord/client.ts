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
 * `GuildMembers` *is* requested, because role reconciliation has to know who
 * is in the guild and what they currently hold. It is the one privileged
 * intent the bot genuinely needs.
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
export async function connectDiscord(): Promise<Client | null> {
  if (!hasRealDiscordCredentials()) {
    logger.warn(
      'Discord credentials look like placeholders. Running without a gateway connection: ' +
        'Discord jobs will complete as no-ops and everything else works normally.',
    );
    return null;
  }

  const instance = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    // Members and users are partial until fetched; without this a DM to
    // somebody the bot has not seen this session fails to resolve.
    partials: [Partials.GuildMember, Partials.User, Partials.Channel],
  });

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

  await instance.login(botEnv.DISCORD_BOT_TOKEN);
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
  if (instance === null) return null;

  try {
    return await instance.guilds.fetch(botEnv.DISCORD_GUILD_ID);
  } catch (error) {
    logger.error({ err: error, guildId: botEnv.DISCORD_GUILD_ID }, 'Cannot reach the guild');
    return null;
  }
}
