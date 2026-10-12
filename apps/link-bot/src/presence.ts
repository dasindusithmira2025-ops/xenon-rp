import { ActivityType, type Client } from 'discord.js';

import type { CoreOutput } from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

import type { CoreCall } from './core-client';

export const PRESENCE_INTERVAL_MS = 60_000;

/** The activity line for a status board, e.g. `42/64 in the city`. */
export function presenceText(board: CoreOutput<'status.board'>): string {
  if (board.aggregate === 'OFFLINE' || board.servers.length === 0) return 'City offline';
  let players = 0;
  let capacity = 0;
  let known = false;
  for (const server of board.servers) {
    if (server.playerCount === null) continue;
    known = true;
    players += server.playerCount;
    capacity += server.maxPlayers ?? 0;
  }
  if (!known) return 'the city';
  return capacity > 0
    ? `${String(players)}/${String(capacity)} in the city`
    : `${String(players)} in the city`;
}

/**
 * Keep the bot's activity in step with the city. Core failures keep the last
 * presence: a stale count for a minute beats flapping to "offline" whenever
 * Core restarts.
 */
export function startPresence(client: Client, core: CoreCall, logger: Logger): () => void {
  let last: string | null = null;

  const update = async () => {
    if (!client.isReady()) return;
    const result = await core('status.board', {});
    if (!result.ok) {
      logger.debug({ code: result.error.code }, 'Presence update skipped');
      return;
    }
    const text = presenceText(result.data);
    if (text === last) return;
    client.user.setActivity(text, { type: ActivityType.Watching });
    last = text;
  };

  const run = () => {
    update().catch((error: unknown) => {
      logger.debug({ err: error }, 'Presence update failed');
    });
  };
  run();
  const timer = setInterval(run, PRESENCE_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
