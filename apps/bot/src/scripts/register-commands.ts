import { REST, Routes } from 'discord.js';

import { botEnv, hasRealDiscordCredentials, logger } from '../runtime';

/**
 * Register slash commands with Discord.
 *
 * Guild-scoped rather than global. Guild commands appear immediately, global
 * ones take up to an hour to propagate, and this platform serves one community
 * - so the only thing global registration would buy is a wait.
 *
 * Run it after changing `commandDefinitions`:
 *
 *   pnpm --filter @xenon/bot register
 */
async function main(): Promise<void> {
  const commandDefinitions =
    botEnv.BOT_RUNTIME_MODE === 'discord-only'
      ? (await import('../discord/discord-only-commands')).DISCORD_ONLY_COMMANDS
      : (await import('../discord/commands')).commandDefinitions;
  if (
    !hasRealDiscordCredentials() ||
    botEnv.DISCORD_BOT_TOKEN === undefined ||
    botEnv.DISCORD_APPLICATION_ID === undefined ||
    botEnv.DISCORD_GUILD_ID === undefined
  ) {
    logger.error(
      'Set DISCORD_MODE=enabled and provide the rotated bot token, application ID and guild ID before registering commands.',
    );
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(botEnv.DISCORD_BOT_TOKEN);

  const result = await rest.put(
    Routes.applicationGuildCommands(botEnv.DISCORD_APPLICATION_ID, botEnv.DISCORD_GUILD_ID),
    { body: commandDefinitions },
  );

  const count = Array.isArray(result) ? result.length : 0;
  logger.info(
    { count, guildId: botEnv.DISCORD_GUILD_ID },
    'Slash commands registered. They are available immediately.',
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Command registration failed');
  process.exit(1);
});
