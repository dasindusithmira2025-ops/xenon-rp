import { once } from 'node:events';

import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';

import { assertCommandOwnership } from '@xenon/contracts';

import { linkCommands } from './commands';

/**
 * Link needs the `Guilds` intent only. It reads members on demand through
 * REST, never through the privileged member stream, and never reads message
 * content — that is Guardian's job.
 */
export const LINK_INTENTS = [GatewayIntentBits.Guilds] as const;

export const READY_TIMEOUT_MS = 30_000;

export function createLinkClient(): Client {
  return new Client({
    intents: [...LINK_INTENTS],
    // Never parse mentions unless a send explicitly allows them.
    allowedMentions: { parse: [] },
  });
}

/**
 * Log in, wait for READY and prove the token belongs to the configured
 * application. A Guardian token pasted into Link's slot would otherwise run
 * Link's commands under Guardian's identity and wipe Guardian's registrations.
 */
export async function connectLinkClient(
  client: Client,
  token: string,
  applicationId: string,
): Promise<void> {
  // Listen before login: READY can arrive while `login` is still resolving.
  const ready = once(client, Events.ClientReady, {
    signal: AbortSignal.timeout(READY_TIMEOUT_MS),
  });
  // Observed below only when login returns before READY.
  void ready.catch(() => undefined);
  await client.login(token);

  if (!client.isReady()) {
    try {
      await ready;
    } catch {
      await client.destroy();
      throw new Error('Discord gateway did not become ready in time.');
    }
  }

  if (client.user?.id !== applicationId) {
    await client.destroy();
    throw new Error('LINK_DISCORD_APPLICATION_ID does not match the Link bot token.');
  }
}

/** Replace the guild's Link commands, refusing any name Link does not own. */
export async function registerGuildCommands(guild: Guild): Promise<void> {
  assertCommandOwnership('link', linkCommands);
  await guild.commands.set(linkCommands);
}
