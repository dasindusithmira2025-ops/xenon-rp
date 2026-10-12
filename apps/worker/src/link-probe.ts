import type { Db, ServiceStatus } from '@xenon/database';
import { recordHeartbeat } from '@xenon/domain';
import type { LinkRelayStore } from '@xenon/jobs';

/**
 * Xenon Link holds no database credential, so it cannot write its own
 * heartbeat row. The worker probes Link and records the result as the `link`
 * heartbeat the health page reads: `/healthz` over HTTP, or the presence key
 * Core writes on every relay pull.
 */

export interface LinkProbeResult {
  readonly status: ServiceStatus;
  readonly detail: Record<string, string | number | boolean>;
}

const PROBE_TIMEOUT_MS = 5_000;

export async function probeLink(
  gatewayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkProbeResult> {
  const url = new URL('/healthz', gatewayUrl);
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body: unknown = await response.json().catch(() => null);
    const reported =
      typeof body === 'object' &&
      body !== null &&
      'status' in body &&
      typeof body.status === 'string'
        ? body.status
        : 'unreadable';
    return {
      status: response.status === 200 && reported === 'ok' ? 'HEALTHY' : 'DEGRADED',
      detail: { httpStatus: response.status, reported },
    };
  } catch {
    return { status: 'UNHEALTHY', detail: { reachable: false } };
  }
}

/** Relay transport: Link's liveness is the presence Core records on each pull. */
export async function probeLinkRelay(store: LinkRelayStore): Promise<LinkProbeResult> {
  try {
    const { state, pending } = await store.presence();
    if (state === 'ready') return { status: 'HEALTHY', detail: { transport: 'relay', pending } };
    if (state === 'unready') {
      return {
        status: 'DEGRADED',
        detail: { transport: 'relay', reported: 'degraded', pending },
      };
    }
    return { status: 'UNHEALTHY', detail: { transport: 'relay', reachable: false, pending } };
  } catch {
    return { status: 'UNHEALTHY', detail: { transport: 'relay', reachable: false } };
  }
}

export async function recordLinkHeartbeat(
  db: Db,
  probe: () => Promise<LinkProbeResult>,
): Promise<LinkProbeResult> {
  const result = await probe();
  await recordHeartbeat(db, 'link', result.status, result.detail);
  return result;
}
