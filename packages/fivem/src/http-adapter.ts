import { IntegrationError } from '@xenon/core';
import type { GameServerAdapterKind } from '@xenon/database';

import {
  formatIdentifier,
  type GameIdentifier,
  type GameServerAdapter,
  type ServerStatusReading,
  type WhitelistPush,
} from './adapter';
import { signRequest } from './signing';

/**
 * HTTP adapter for a real FXServer running `xenon_bridge`.
 *
 * Speaks to the resource's HTTP handler, which is the same regardless of
 * framework: the bridge translates between this protocol and whatever QBCore,
 * QBX or ESX wants locally. The `kind` is carried through so the server can
 * pick its local strategy, but Xenon's side of the wire never varies.
 */
export class HttpGameServerAdapter implements GameServerAdapter {
  constructor(
    readonly kind: GameServerAdapterKind,
    private readonly endpointUrl: string,
    private readonly secret: string,
    /** Bounded so a hung game server cannot hold a worker open. */
    private readonly timeoutMs = 5_000,
  ) {}

  private async call<T>(path: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const signed = signRequest(this.secret, body);

    const response = await fetch(new URL(path, this.endpointUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new IntegrationError(
        'fivem',
        `${path} returned ${String(response.status)}`,
        // 4xx means the bridge rejected the request as malformed or
        // unauthorised; retrying an identical request will fail identically.
        { retryable: response.status >= 500 },
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Probe the server.
   *
   * Never throws. A status probe that raises would turn "the city is down" into
   * "the status page is down", and the status page is exactly what people open
   * when the city is down.
   */
  async status(): Promise<ServerStatusReading> {
    const started = Date.now();
    try {
      const reading = await this.call<{
        players?: number;
        maxPlayers?: number;
        queue?: number;
      }>('/xenon/status', {});

      return {
        online: true,
        playerCount: typeof reading.players === 'number' ? reading.players : null,
        maxPlayers: typeof reading.maxPlayers === 'number' ? reading.maxPlayers : null,
        queueLength: typeof reading.queue === 'number' ? reading.queue : null,
        latencyMs: Date.now() - started,
        error: null,
      };
    } catch (error) {
      return {
        online: false,
        playerCount: null,
        maxPlayers: null,
        queueLength: null,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async pushWhitelist(push: WhitelistPush): Promise<void> {
    await this.call('/xenon/whitelist', {
      identifiers: push.identifiers.map(formatIdentifier),
      allowed: push.allowed,
      reason: push.reason,
      publicId: push.publicId,
    });
  }

  async isOnline(identifiers: readonly GameIdentifier[]): Promise<boolean> {
    try {
      const reply = await this.call<{ online?: boolean }>('/xenon/presence', {
        identifiers: identifiers.map(formatIdentifier),
      });
      return reply.online === true;
    } catch {
      // Presence is a convenience for staff screens; an unreachable server means
      // "we cannot tell", and the honest answer there is "not shown as online".
      return false;
    }
  }
}
