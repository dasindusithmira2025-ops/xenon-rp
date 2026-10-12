import {
  GATEWAY_BODY_LIMIT_BYTES,
  LINK_GATEWAY_PREFIX,
  NonceCache,
  gatewayOperations,
  verifyServiceRequest,
  type GatewayErrorCode,
  type GatewayOperation,
  type GatewayResponse,
  type HeaderReader,
} from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

import { toGatewayFailure, type GatewayHandlers } from './operations';

/**
 * Transport-independent gateway execution: the verify → replay → operation →
 * JSON → schema → handler pipeline shared by the HTTP server and the relay
 * poller. Whatever carried the request, a worker-signed envelope is checked
 * with the same code and runs through the same `GatewayHandlers`, whose
 * allow-list policy is the enforcement point.
 *
 * Order matters: authentication runs before the operation lookup so an
 * unauthenticated caller cannot learn which operations exist, and the nonce is
 * recorded only after the signature passes so garbage cannot fill the replay
 * cache. Bodies and signatures are never logged.
 */

export interface GatewayExecutionRequest {
  readonly operation: string;
  readonly body: string;
  readonly header: HeaderReader;
}

export interface GatewayExecution {
  /** The HTTP status the server transport answers with; the relay ignores it. */
  readonly status: number;
  readonly response: GatewayResponse<unknown>;
}

/** Never rejects: every failure is an execution with an error response. */
export type GatewayExecutor = (request: GatewayExecutionRequest) => Promise<GatewayExecution>;

export interface GatewayExecutorOptions {
  readonly secret: string;
  readonly handlers: GatewayHandlers;
  readonly logger: Logger;
  readonly nonces?: NonceCache;
  readonly now?: () => number;
}

const STATUS: Readonly<Record<GatewayErrorCode, number>> = {
  DISCORD_UNAVAILABLE: 503,
  DISCORD_ERROR: 422,
  FORBIDDEN_TARGET: 403,
  VALIDATION: 422,
  UNAUTHENTICATED: 401,
};

function isOperation(name: string): name is GatewayOperation {
  return Object.hasOwn(gatewayOperations, name);
}

function failed(
  status: number,
  code: GatewayErrorCode,
  message: string,
  retryable = false,
  discordCode?: number,
): GatewayExecution {
  return {
    status,
    response: {
      ok: false,
      error: { code, message, retryable, ...(discordCode === undefined ? {} : { discordCode }) },
    },
  };
}

export function createGatewayExecutor(options: GatewayExecutorOptions): GatewayExecutor {
  const nonces = options.nonces ?? new NonceCache();
  const now = options.now ?? Date.now;

  async function run(request: GatewayExecutionRequest): Promise<GatewayExecution> {
    if (Buffer.byteLength(request.body, 'utf8') > GATEWAY_BODY_LIMIT_BYTES) {
      return failed(413, 'VALIDATION', 'Request body too large.');
    }

    const path = `${LINK_GATEWAY_PREFIX}/${request.operation}`;
    const verification = verifyServiceRequest(
      options.secret,
      { service: 'worker', method: 'POST', path },
      request.body,
      request.header,
      now(),
    );
    if (!verification.ok) {
      options.logger.warn({ path, reason: verification.reason }, 'Rejected gateway request');
      return failed(401, 'UNAUTHENTICATED', 'Unauthenticated.');
    }
    if (!nonces.remember(verification.nonce, now())) {
      options.logger.warn({ path }, 'Rejected replayed gateway request');
      return failed(409, 'UNAUTHENTICATED', 'Replayed request.');
    }

    const operation = request.operation;
    if (!isOperation(operation)) return failed(404, 'VALIDATION', 'Unknown operation.');

    let json: unknown;
    try {
      json = JSON.parse(request.body);
    } catch {
      return failed(400, 'VALIDATION', 'Body must be JSON.');
    }
    const input = gatewayOperations[operation].input.safeParse(json);
    if (!input.success) {
      return failed(
        422,
        'VALIDATION',
        input.error.issues[0]?.message.slice(0, 200) ?? 'Invalid input.',
      );
    }

    try {
      const handler = options.handlers[operation] as (input: unknown) => Promise<unknown>;
      const data = await handler(input.data);
      return { status: 200, response: { ok: true, data } };
    } catch (error) {
      const failure = toGatewayFailure(error);
      const log = failure.code === 'DISCORD_UNAVAILABLE' ? 'warn' : 'info';
      // Discord REST errors may include requestBody (including private DM text,
      // embeds or attachments). Log only explicitly safe metadata.
      options.logger[log](
        {
          operation,
          code: failure.code,
          discordCode: failure.discordCode,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          ...(error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number'
            ? { httpStatus: error.status }
            : {}),
        },
        'Gateway operation failed',
      );
      return failed(
        STATUS[failure.code],
        failure.code,
        failure.message,
        failure.retryable,
        failure.discordCode,
      );
    }
  }

  return async (request) => {
    try {
      return await run(request);
    } catch (error) {
      // Never serialize raw exceptions; dependency errors can carry request
      // payloads even when thrown outside the handler catch.
      options.logger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Gateway request crashed',
      );
      return failed(500, 'DISCORD_UNAVAILABLE', 'Internal error.', true);
    }
  };
}
