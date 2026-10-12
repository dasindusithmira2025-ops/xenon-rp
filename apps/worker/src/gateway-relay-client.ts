import {
  GATEWAY_BODY_LIMIT_BYTES,
  type GatewayOperation,
  LINK_GATEWAY_PREFIX,
  SERVICE_NONCE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SERVICE_TIMESTAMP_HEADER,
  signServiceRequest,
} from '@xenon/contracts';
import type { LinkRelayRead, LinkRelayStore } from '@xenon/jobs';

import {
  DEFAULT_GATEWAY_TIMEOUT_MS,
  type GatewayCall,
  GatewayError,
  readGatewayResponse,
} from './gateway-client';

/**
 * Gateway client for the relay transport: Link cannot be reached, so each
 * request is signed exactly as for HTTP, parked in Redis, and answered by Link
 * through the Core API. Errors match HTTP mode (`readGatewayResponse`), so job
 * retry classification does not care which transport carried the call.
 *
 * A request is claimed at most once. On timeout the worker abandons it: one
 * nobody has claimed can never run, one that was claimed has an unknown
 * outcome (the same as an HTTP timeout), and one that finished a moment ago is
 * used rather than thrown away.
 */

export const RELAY_RESULT_POLL_MS = 100;

export interface RelayGatewayClientOptions {
  readonly store: LinkRelayStore;
  readonly secret: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRelayGatewayClient(options: RelayGatewayClientOptions): GatewayCall {
  const { store, secret } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? RELAY_RESULT_POLL_MS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => performance.now());

  /** Best-effort delete; a failure only leaves a TTL-bounded key behind. */
  const discard = (id: string): void => {
    void store.abandon(id).catch(() => undefined);
  };

  return async (operation, input) => {
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body, 'utf8') > GATEWAY_BODY_LIMIT_BYTES) {
      throw new GatewayError('VALIDATION', 'Request body too large.', false);
    }

    const headers = signServiceRequest(secret, {
      service: 'worker',
      method: 'POST',
      path: `${LINK_GATEWAY_PREFIX}/${operation}`,
      body,
    });
    const id = headers[SERVICE_NONCE_HEADER];

    const start = now();
    let outcome;
    try {
      outcome = await store.enqueue(
        {
          id,
          operation,
          body,
          timestamp: headers[SERVICE_TIMESTAMP_HEADER],
          signature: headers[SERVICE_SIGNATURE_HEADER],
        },
        timeoutMs,
      );
    } catch (error) {
      // The shared Redis client queues commands while disconnected, so this
      // enqueue may still run later; the abandon queues behind it.
      discard(id);
      throw new GatewayError('NETWORK', `Xenon Link relay unavailable (${operation})`, true, error);
    }
    switch (outcome) {
      case 'queued':
        break;
      case 'offline':
        throw new GatewayError('NETWORK', 'Xenon Link is not connected to the relay', true);
      case 'not_ready':
        throw new GatewayError('DISCORD_UNAVAILABLE', 'The Discord gateway is not ready.', true);
      case 'full':
        throw new GatewayError('NETWORK', 'Xenon Link relay queue is full', true);
      case 'duplicate':
        throw new GatewayError('PROTOCOL', 'Relay request id collision', true);
    }

    while (now() - start < timeoutMs) {
      await sleep(pollMs);
      let read: LinkRelayRead;
      try {
        read = await store.read(id);
      } catch {
        continue; // transient Redis trouble: keep polling until the deadline
      }
      if (read.state === 'done') {
        discard(id);
        return parseResponse(operation, read.response);
      }
      if (read.state === 'expired' || read.state === 'missing') {
        discard(id);
        throw new GatewayError('NETWORK', 'Xenon Link did not take the request in time', true);
      }
    }

    let last: LinkRelayRead;
    try {
      last = await store.abandon(id);
    } catch {
      last = { state: 'missing' };
    }
    if (last.state === 'done') return parseResponse(operation, last.response);
    throw new GatewayError(
      'NETWORK',
      last.state === 'pending'
        ? `Xenon Link did not take ${operation} in time`
        : `Xenon Link did not answer ${operation} in time`,
      true,
    );
  };
}

function parseResponse<TOp extends GatewayOperation>(operation: TOp, raw: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new GatewayError('PROTOCOL', `Unreadable ${operation} response from Link`, true);
  }
  return readGatewayResponse(operation, payload);
}
