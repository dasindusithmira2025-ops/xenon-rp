import {
  CORE_API_PREFIX,
  coreErrorSchema,
  coreOperations,
  signServiceRequest,
  type CoreErrorCode,
  type CoreInput,
  type CoreOperation,
  type CoreOutput,
} from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

/**
 * Typed client for the Xenon Core API.
 *
 * Link holds no datastore credential, so every read and decision is one of the
 * operations in `coreOperations`. Requests are signed as service `link`;
 * responses are validated against the operation's output schema so a Core/Link
 * version skew surfaces as a clear failure instead of a half-rendered reply.
 *
 * Request and response bodies are never logged: they carry Discord ids and
 * staff notes.
 */

export type CoreResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: CoreErrorCode;
        readonly message: string;
        readonly retryAfterSeconds?: number;
      };
    };

export const CORE_UNAVAILABLE_MESSAGE =
  'Xenon services are temporarily unavailable. Try again shortly.';

export const DEFAULT_CORE_TIMEOUT_MS = 5_000;

export interface CoreCallOptions {
  readonly timeoutMs?: number;
  /** Aborts the call (shutdown); the call resolves as unavailable without a warning. */
  readonly signal?: AbortSignal;
}

export type CoreCall = <TOp extends CoreOperation>(
  operation: TOp,
  input: CoreInput<TOp>,
  options?: CoreCallOptions,
) => Promise<CoreResult<CoreOutput<TOp>>>;

export interface CoreClientOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const unavailable = {
  ok: false,
  error: { code: 'INTEGRATION', message: CORE_UNAVAILABLE_MESSAGE },
} as const;

export function createCoreClient(options: CoreClientOptions): CoreCall {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  const callSignal = (callOptions: CoreCallOptions | undefined): AbortSignal => {
    const timeout = AbortSignal.timeout(
      callOptions?.timeoutMs ?? options.timeoutMs ?? DEFAULT_CORE_TIMEOUT_MS,
    );
    return callOptions?.signal ? AbortSignal.any([timeout, callOptions.signal]) : timeout;
  };

  return async (operation, input, callOptions) => {
    const path = `${CORE_API_PREFIX}/${operation}`;
    const body = JSON.stringify(input);
    const headers = signServiceRequest(options.secret, {
      service: 'link',
      method: 'POST',
      path,
      body,
    });

    let response: Response;
    let payload: unknown;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: callSignal(callOptions),
      });
      payload = await response.json();
    } catch (error) {
      // A caller-initiated abort (shutdown) is not an outage worth a warning.
      if (callOptions?.signal?.aborted !== true) {
        options.logger.warn(
          { operation, reason: error instanceof Error ? error.name : 'unknown' },
          'Core API unreachable',
        );
      }
      return unavailable;
    }

    if (typeof payload === 'object' && payload !== null && 'ok' in payload && payload.ok === true) {
      const data = coreOperations[operation].output.safeParse(
        'data' in payload ? payload.data : undefined,
      );
      if (data.success) return { ok: true, data: data.data as CoreOutput<typeof operation> };
      options.logger.error(
        { operation, status: response.status },
        'Core API response did not match the contract',
      );
      return { ok: false, error: { code: 'INTERNAL', message: CORE_UNAVAILABLE_MESSAGE } };
    }

    const failure = coreErrorSchema.safeParse(payload);
    if (failure.success) return { ok: false, error: failure.data.error };

    options.logger.warn({ operation, status: response.status }, 'Core API returned no envelope');
    return unavailable;
  };
}
