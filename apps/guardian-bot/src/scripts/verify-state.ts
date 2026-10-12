import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { defaultRuntimeStorePath, JsonDiscordRuntimeStore } from '../discord/runtime-store';

/**
 * Read-only compatibility check of a Guardian runtime store.
 *
 *   node --import tsx src/scripts/verify-state.ts [path/to/discord-runtime.json]
 *
 * Loads a COPY of the file through the same store class and validation the
 * running bot uses, for every guild in it, and prints counts only (never
 * ticket contents, user IDs or message text). Exit 0: every guild loads;
 * exit 1: a validation error that would stop the bot reading its own state.
 */

const source = resolve(process.argv[2] ?? defaultRuntimeStorePath());
if (!existsSync(source)) {
  console.error(`No runtime store at ${source}`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'guardian-verify-'));
const copy = join(scratch, 'discord-runtime.json');
copyFileSync(source, copy);

try {
  const document = JSON.parse(readFileSync(copy, 'utf8')) as {
    version?: unknown;
    guilds?: Record<string, unknown>;
  };
  const guildIds = Object.keys(document.guilds ?? {});
  process.stdout.write(`store version=${String(document.version)} guilds=${guildIds.length}\n`);

  const store = new JsonDiscordRuntimeStore(copy);
  let failed = false;
  for (const guildId of guildIds) {
    try {
      const state = await store.getGuild(guildId);
      const tickets = Object.values(state.tickets);
      process.stdout.write(
        `OK guild=${guildId} tickets=${tickets.length} open=${tickets.filter((t) => t.status === 'OPEN').length} ` +
          `ticketSequence=${state.ticketSequence} ticketConfig=${state.ticketConfig === null ? 'none' : 'set'} ` +
          `rooms=${Object.keys(state.rooms).length} registryEntries=${state.entries.length} ` +
          `securityKeys=${Object.keys(state.security).length}\n`,
      );
    } catch (error) {
      failed = true;
      console.error(
        `FAIL guild=${guildId}: ${error instanceof Error ? error.message.slice(0, 200) : 'unreadable'}`,
      );
    }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
