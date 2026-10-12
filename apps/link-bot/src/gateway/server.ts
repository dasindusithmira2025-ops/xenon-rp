import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  GATEWAY_BODY_LIMIT_BYTES,
  LINK_GATEWAY_PREFIX,
  type NonceCache,
  type GatewayErrorCode,
  type GatewayResponse,
} from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

import { createGatewayExecutor } from './execute';

import type { GatewayHandlers } from './operations';

/**
 * The Link gateway: the only door from the worker into Discord.
 *
 * `GET /healthz` is unauthenticated and carries no secret. Every other request
 * is `POST /gateway/v1/<operation>`, signed by the worker with
 * `LINK_GATEWAY_SECRET`, and is checked in this order:
 *
 *   size limit → signature (service, method, exact path, body) → replay →
 *   operation → JSON → schema → handler.
 *
 * Authentication runs before the operation lookup so an unauthenticated
 * caller cannot even learn which operations exist. The nonce is recorded only
 * after the signature passes, so garbage requests cannot fill the replay cache.
 */

export interface GatewayServerOptions {
  readonly secret: string;
  readonly guildId: string;
  readonly handlers: GatewayHandlers;
  readonly isDiscordReady: () => boolean;
  readonly logger: Logger;
  readonly nonces?: NonceCache;
  readonly now?: () => number;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  response.end(json);
}

function fail(
  response: ServerResponse,
  status: number,
  code: GatewayErrorCode,
  message: string,
  retryable = false,
  discordCode?: number,
): void {
  const body: GatewayResponse<never> = {
    ok: false,
    error: { code, message, retryable, ...(discordCode === undefined ? {} : { discordCode }) },
  };
  send(response, status, body);
}

class BodyTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (declared > GATEWAY_BODY_LIMIT_BYTES) throw new BodyTooLarge();

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > GATEWAY_BODY_LIMIT_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  const execute = createGatewayExecutor({
    secret: options.secret,
    handlers: options.handlers,
    logger: options.logger,
    nonces: options.nonces,
    now: options.now,
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '/';

    if (path === '/healthz') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      const ready = options.isDiscordReady();
      send(response, ready ? 200 : 503, {
        service: 'link',
        status: ready ? 'ok' : 'degraded',
        gateway: ready ? 'READY' : 'CONNECTING',
        guildId: options.guildId,
      });
      return;
    }

    if (!path.startsWith(`${LINK_GATEWAY_PREFIX}/`)) {
      fail(response, 404, 'VALIDATION', 'Not found.');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      fail(response, 405, 'VALIDATION', 'Method not allowed.');
      return;
    }

    let raw: string;
    try {
      raw = await readBody(request);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        fail(response, 413, 'VALIDATION', 'Request body too large.');
        request.resume();
        return;
      }
      throw error;
    }

    const operation = path.slice(LINK_GATEWAY_PREFIX.length + 1);
    const { status, response: body } = await execute({
      operation,
      body: raw,
      header: (name) => {
        const value = request.headers[name];
        return Array.isArray(value) ? undefined : value;
      },
    });
    send(response, status, body);
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.logger.error({ err: error }, 'Gateway request crashed');
      if (!response.headersSent)
        fail(response, 500, 'DISCORD_UNAVAILABLE', 'Internal error.', true);
      else response.destroy();
    });
  });
}
