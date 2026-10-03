import { isAbsolute, resolve } from 'node:path';

import { Client, GatewayIntentBits } from 'discord.js';

import type { PermissionKey } from '@xenon/core';
import { type Actor, systemActor } from '@xenon/permissions';

import { botEnv, hasRealDiscordCredentials } from '../runtime';

/**
 * Shared plumbing for the operator CLIs.
 *
 * Whoever runs these already holds the database URL and the bot token, which
 * is more authority than any Xenon role grants, so the CLI acts with the
 * provisioning capabilities and records itself as source CLI in the audit log.
 */

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function cliActor(): Actor {
  const permissions: PermissionKey[] = [
    'system.discord.bootstrap',
    'system.discord.bootstrap.destructive',
  ];
  return {
    ...systemActor,
    source: 'CLI',
    label: 'CLI operator',
    permissions: new Set(permissions),
  };
}

/**
 * Paths given on the command line are relative to where the operator typed
 * them, not to apps/bot where pnpm runs the script.
 */
export function operatorPath(path: string): string {
  // pnpm records the invoking directory here; it is not configuration.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const base = process.env.INIT_CWD ?? process.cwd();
  return isAbsolute(path) ? path : resolve(base, path);
}

export async function connectCli(): Promise<Client<true>> {
  if (!hasRealDiscordCredentials() || botEnv.DISCORD_BOT_TOKEN === undefined) {
    throw new Error(
      'Set DISCORD_MODE=enabled with the bot token, application ID and guild ID first.',
    );
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const ready = new Promise<Client<true>>((resolveReady) =>
    client.once('clientReady', resolveReady),
  );
  await client.login(botEnv.DISCORD_BOT_TOKEN);
  return ready;
}

export function guildId(): string {
  if (botEnv.DISCORD_GUILD_ID === undefined) throw new Error('DISCORD_GUILD_ID is not configured.');
  return botEnv.DISCORD_GUILD_ID;
}
