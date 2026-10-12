import { REST, Routes } from 'discord.js';

import { assertCommandOwnership } from '@xenon/contracts';

import { GUARDIAN_COMMANDS } from '../discord/discord-only-commands';
import { guardianEnv, logger } from '../runtime';

/**
 * Register Xenon Guardian's slash commands with Discord.
 *
 * Guild-scoped rather than global. Guild commands appear immediately, global
 * ones take up to an hour to propagate, and this platform serves one community
 * - so the only thing global registration would buy is a wait.
 *
 * The runtime also registers on every start; this is for operators who want to
 * push a changed registry without restarting the gateway:
 *
 *   pnpm guardian:register
 */
async function main(): Promise<void> {
  assertCommandOwnership('guardian', GUARDIAN_COMMANDS);
  const rest = new REST({ version: '10' }).setToken(guardianEnv.GUARDIAN_DISCORD_TOKEN);

  const result = await rest.put(
    Routes.applicationGuildCommands(
      guardianEnv.GUARDIAN_DISCORD_APPLICATION_ID,
      guardianEnv.DISCORD_GUILD_ID,
    ),
    { body: GUARDIAN_COMMANDS },
  );

  const count = Array.isArray(result) ? result.length : 0;
  logger.info(
    { count, guildId: guardianEnv.DISCORD_GUILD_ID },
    'Guardian slash commands registered. They are available immediately.',
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Guardian command registration failed');
  process.exit(1);
});
