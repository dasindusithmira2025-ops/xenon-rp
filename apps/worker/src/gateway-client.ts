import {
  type GatewayErrorCode,
  type GatewayInput,
  type GatewayOperation,
  type GatewayOutput,
  gatewayErrorSchema,
  gatewayOperations,
  LINK_GATEWAY_PREFIX,
  signServiceRequest,
} from '@xenon/contracts';
import { IntegrationError } from '@xenon/core';

/**
 * Client for Xenon Link's gateway: the only way the worker reaches Discord.
 *
 * Requests are signed as service `worker`. Failures are translated into the
 * two shapes the job code already understands:
 *
 *  - `DiscordRequestError` carries Discord's numeric `code`, so the existing
 *    classification (50013 missing permission, 10011 unknown role, 10007
 *    unknown member, 50007 DMs closed) keeps working unchanged;
 *  - `GatewayError` (an `IntegrationError`) for everything else. Link being
 *    unreachable, not ready or rate limited is retryable; a refused target or
 *    a request Link considers malformed is not.
 */

export type GatewayCall = <TOp extends GatewayOperation>(
  operation: TOp,
  input: GatewayInput<TOp>,
) => Promise<GatewayOutput<TOp>>;

/** Discord refused the call. `code` is Discord's JSON error code. */
export class DiscordRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DiscordRequestError';
  }
}

/** The gateway could not, or would not, perform the call. */
export class GatewayError extends IntegrationError {
  constructor(
    readonly gatewayCode: GatewayErrorCode | 'NETWORK' | 'PROTOCOL',
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super('link-gateway', message, { retryable, cause });
  }
}

export interface GatewayClientOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export const DEFAULT_GATEWAY_TIMEOUT_MS = 15_000;

export function createGatewayClient(options: GatewayClientOptions): GatewayCall {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;

  return async (operation, input) => {
    const path = `${LINK_GATEWAY_PREFIX}/${operation}`;
    const body = JSON.stringify(input);
    const headers = signServiceRequest(options.secret, {
      service: 'worker',
      method: 'POST',
      path,
      body,
    });

    let payload: unknown;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      payload = await response.json();
    } catch (error) {
      throw new GatewayError(
        'NETWORK',
        `Xenon Link gateway unreachable (${operation})`,
        true,
        error,
      );
    }

    return readGatewayResponse(operation, payload);
  };
}

/**
 * Map a `GatewayResponse` body to the operation's output, or throw the error
 * the job code understands. Shared by the HTTP and relay transports so both
 * classify Link's answers identically.
 */
export function readGatewayResponse<TOp extends GatewayOperation>(
  operation: TOp,
  payload: unknown,
): GatewayOutput<TOp> {
  // Link answers with a GatewayResponse body whatever the HTTP status.
  if (typeof payload === 'object' && payload !== null && 'ok' in payload && payload.ok === true) {
    const output = gatewayOperations[operation].output.safeParse(
      'data' in payload ? payload.data : undefined,
    );
    if (!output.success) {
      throw new GatewayError('PROTOCOL', `Unexpected ${operation} response from Link`, true);
    }
    return output.data as GatewayOutput<TOp>;
  }

  const parsed = gatewayErrorSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GatewayError('PROTOCOL', `Unreadable ${operation} response from Link`, true);
  }

  const { code, message, retryable, discordCode } = parsed.data.error;
  switch (code) {
    case 'DISCORD_ERROR':
      throw new DiscordRequestError(discordCode ?? 0, message, retryable);
    case 'DISCORD_UNAVAILABLE':
      throw new GatewayError(code, message, true);
    // A secret or clock problem is fixed by an operator; the job keeps its
    // retries so the work still lands once it is.
    case 'UNAUTHENTICATED':
      throw new GatewayError(code, message, true);
    case 'FORBIDDEN_TARGET':
    case 'VALIDATION':
      throw new GatewayError(code, message, false);
  }
}

/** True for an error that will not succeed on retry. */
export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof DiscordRequestError) return !error.retryable;
  if (error instanceof IntegrationError) return !error.retryable;
  return false;
}
