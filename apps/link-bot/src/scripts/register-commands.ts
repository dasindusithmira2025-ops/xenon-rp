import { REST, Routes } from 'discord.js';

import { assertCommandOwnership } from '@xenon/contracts';

import { linkCommands } from '../commands';
import { linkEnv, logger } from '../runtime';

/**
 * Register Link's guild commands over REST without opening a gateway session.
 * Uses Link's own application id and token; ownership is asserted first so a
 * Guardian command name can never be pushed from here.
 */
async function register(): Promise<void> {
  assertCommandOwnership('link', linkCommands);
  const rest = new REST({ version: '10' }).setToken(linkEnv.LINK_DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(linkEnv.LINK_DISCORD_APPLICATION_ID, linkEnv.DISCORD_GUILD_ID),
    { body: linkCommands },
  );
  logger.info(
    { guildId: linkEnv.DISCORD_GUILD_ID, commands: linkCommands.length },
    'Link commands registered',
  );
}

register().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Command registration failed');
  process.exit(1);
});
