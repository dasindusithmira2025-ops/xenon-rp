import {
  CORE_API_PREFIX,
  CORE_ERROR_STATUS,
  type CoreErrorCode,
  type CoreOperation,
  type CoreResponse,
  coreOperations,
  isRelayOperation,
  verifyServiceRequest,
} from '@xenon/contracts';
import { isDomainError, RateLimitError, toSafeMessage } from '@xenon/core';
import type { Logger } from '@xenon/logger';

import type { CoreHandlers } from './operations';
import type { RelayContext, RelayHandlers } from './relay';
import type { ReplayGuard } from './replay';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

/**
 * The Core API transport.
 *
 * Plain `node:http`: the surface is a dozen signed POST endpoints, and a
 * framework would add more attack surface than it removes code. Every request
 * to `/internal/v1/<operation>` passes, in order: method, body size, service
 * signature, replay guard, operation lookup, input schema, per-user rate
 * limit, the domain service, and the output schema. Nothing about a failure
 * beyond a code and the error's safe message ever leaves the process.
 */

export const MAX_BODY_BYTES = 64 * 1024;

export interface CoreServerDeps {
  /** `LINK_CORE_SECRET`: verifies requests signed by Xenon Link. */
  readonly secret: string;
  readonly handlers: CoreHandlers;
  /** The Link relay operations (`relay.pull`, `relay.complete`). */
  readonly relay: RelayHandlers;
  readonly replay: ReplayGuard;
  readonly logger: Logger;
  /** Readiness probe for `/readyz` (the database answers). */
  readonly ready: () => Promise<boolean>;
  /** Per-Discord-user budget. Throws `RateLimitError` when exhausted. */
  readonly rateLimit: (actorDiscordId: string) => Promise<void>;
  readonly now?: () => number;
}

class BodyTooLargeError extends Error {}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  response.end(json);
}

function failure(
  response: ServerResponse,
  status: number,
  code: CoreErrorCode,
  message: string,
  retryAfterSeconds?: number,
): void {
  const body: CoreResponse<never> = {
    ok: false,
    error: { code, message, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
  };
  send(response, status, body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyTooLargeError();

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const HTTP_TO_CODE: Readonly<Record<number, CoreErrorCode>> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION',
  429: 'RATE_LIMITED',
  502: 'INTEGRATION',
};

/** Map a thrown value to the contract's error shape. Unknown errors become INTERNAL. */
export function toCoreError(error: unknown): {
  code: CoreErrorCode;
  message: string;
  retryAfterSeconds?: number;
} {
  const code = isDomainError(error) ? (HTTP_TO_CODE[error.httpStatus] ?? 'INTERNAL') : 'INTERNAL';
  return {
    code,
    message: toSafeMessage(error),
    ...(error instanceof RateLimitError
      ? { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds)) }
      : {}),
  };
}

function isOperation(name: string): name is CoreOperation {
  return Object.hasOwn(coreOperations, name);
}

export function createCoreRequestListener(deps: CoreServerDeps): RequestListener {
  const now = deps.now ?? Date.now;

  async function handleOperation(
    request: IncomingMessage,
    response: ServerResponse,
    rawPath: string,
    name: string,
  ): Promise<void> {
    const started = now();
    // Aborts when the caller goes away before the reply is written, so a
    // long-poll stops claiming work for a client that can no longer receive it.
    const aborted = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) aborted.abort();
    });
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      failure(response, 405, 'VALIDATION', 'Method not allowed');
      return;
    }

    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        failure(response, 413, 'VALIDATION', 'Request body too large');
        return;
      }
      throw error;
    }

    const verification = verifyServiceRequest(
      deps.secret,
      { service: 'link', method: 'POST', path: rawPath },
      body,
      (header) => {
        const value = request.headers[header];
        return Array.isArray(value) ? value[0] : value;
      },
      now(),
    );
    if (!verification.ok) {
      deps.logger.warn({ op: name, reason: verification.reason }, 'Rejected unsigned Core request');
      failure(response, 401, 'UNAUTHENTICATED', 'Unauthenticated');
      return;
    }
    if (!(await deps.replay.claim(verification.nonce))) {
      deps.logger.warn({ op: name }, 'Rejected replayed Core request');
      failure(response, 409, 'UNAUTHENTICATED', 'Replayed request');
      return;
    }

    if (!isOperation(name)) {
      failure(response, 404, 'NOT_FOUND', 'Unknown operation');
      return;
    }
    const operation = coreOperations[name];

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      failure(response, 422, 'VALIDATION', 'Body is not valid JSON');
      return;
    }
    const input = operation.input.safeParse(json);
    if (!input.success) {
      const issue = input.error.issues[0];
      const where =
        issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
      failure(response, 422, 'VALIDATION', `${where}${issue?.message ?? 'Invalid input'}`);
      return;
    }

    const actorDiscordId =
      'actorDiscordId' in input.data && typeof input.data.actorDiscordId === 'string'
        ? input.data.actorDiscordId
        : null;

    try {
      if (actorDiscordId !== null) await deps.rateLimit(actorDiscordId);
      const result = isRelayOperation(name)
        ? await (deps.relay[name] as (value: unknown, context: RelayContext) => Promise<unknown>)(
            input.data,
            { signal: aborted.signal },
          )
        : await (deps.handlers[name] as (value: unknown) => Promise<unknown>)(input.data);
      const output = operation.output.safeParse(result);
      if (!output.success) {
        deps.logger.error(
          { op: name, actorDiscordId, issue: output.error.issues[0]?.path.join('.') },
          'Core operation produced output outside its contract',
        );
        failure(response, 500, 'INTERNAL', toSafeMessage(null));
        return;
      }
      if (isRelayOperation(name)) {
        // Link long-polls: an info line every 20 s would drown the log.
        const data: unknown = output.data;
        const count =
          typeof data === 'object' && data !== null && 'requests' in data && Array.isArray(data.requests)
            ? data.requests.length
            : undefined;
        deps.logger.debug({ op: name, ms: now() - started, count }, 'Core op');
      } else {
        deps.logger.info({ op: name, actorDiscordId, outcome: 'ok', ms: now() - started }, 'Core op');
      }
      send(response, 200, { ok: true, data: output.data });
    } catch (error) {
      const mapped = toCoreError(error);
      const log = { op: name, actorDiscordId, outcome: mapped.code, ms: now() - started };
      if (mapped.code === 'INTERNAL') deps.logger.error({ ...log, err: error }, 'Core op failed');
      else deps.logger.info(log, 'Core op refused');
      failure(
        response,
        CORE_ERROR_STATUS[mapped.code],
        mapped.code,
        mapped.message,
        mapped.retryAfterSeconds,
      );
    }
  }

  return (request, response) => {
    const rawPath = request.url ?? '/';
    const pathname = rawPath.split('?')[0] ?? '/';

    const run = async (): Promise<void> => {
      if (pathname === '/healthz' && request.method === 'GET') {
        send(response, 200, { service: 'core-api', status: 'ok' });
        return;
      }
      if (pathname === '/readyz' && request.method === 'GET') {
        const ready = await deps.ready().catch(() => false);
        send(response, ready ? 200 : 503, {
          service: 'core-api',
          status: ready ? 'ok' : 'degraded',
          database: ready ? 'reachable' : 'unreachable',
        });
        return;
      }
      if (pathname.startsWith(`${CORE_API_PREFIX}/`)) {
        await handleOperation(
          request,
          response,
          rawPath,
          pathname.slice(CORE_API_PREFIX.length + 1),
        );
        return;
      }
      failure(response, 404, 'NOT_FOUND', 'Not found');
    };

    void run().catch((error: unknown) => {
      deps.logger.error({ err: error, path: pathname }, 'Core request failed');
      if (!response.headersSent) failure(response, 500, 'INTERNAL', toSafeMessage(null));
      else response.destroy();
    });
  };
}
