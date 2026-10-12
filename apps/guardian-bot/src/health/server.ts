import { createServer, type Server } from 'node:http';

import type { Client } from 'discord.js';
import type { AddressInfo } from 'node:net';

/**
 * Guardian's health endpoint.
 *
 * Guardian has no database, so it cannot write a heartbeat row; operators and
 * the container runtime probe this endpoint instead. The body carries only
 * non-secret runtime facts and the server binds to loopback by default.
 */

export interface GuardianHealth {
  readonly service: 'guardian';
  readonly status: 'ok' | 'degraded';
  readonly gateway: 'READY' | 'CONNECTING';
  readonly guildId: string;
  readonly latencyMs: number | null;
  readonly uptimeSeconds: number;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Healthy only when the gateway is ready and the configured guild is resolved. */
export function guardianHealth(
  client: Pick<Client, 'isReady' | 'guilds' | 'ws'>,
  guildId: string,
): GuardianHealth {
  const ready = client.isReady();
  const ok = ready && client.guilds.cache.has(guildId);
  return {
    service: 'guardian',
    status: ok ? 'ok' : 'degraded',
    gateway: ready ? 'READY' : 'CONNECTING',
    guildId,
    latencyMs: ready && client.ws.ping >= 0 ? client.ws.ping : null,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function startHealthServer(options: {
  readonly host: string;
  readonly port: number;
  readonly probe: () => GuardianHealth;
}): Promise<HealthServer> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?', 1)[0];
    if (request.method !== 'GET' || path !== '/healthz') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const health = options.probe();
    response.writeHead(health.status === 'ok' ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(health));
  });

  return new Promise<HealthServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error === undefined) resolveClose();
              else rejectClose(error);
            });
          }),
      });
    });
  });
}
