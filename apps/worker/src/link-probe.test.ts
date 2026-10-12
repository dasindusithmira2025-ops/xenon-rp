import { describe, expect, it, vi } from 'vitest';

import type { LinkRelayPresence, LinkRelayStore } from '@xenon/jobs';

import { probeLinkRelay } from './link-probe';

function storeWith(presence: () => Promise<LinkRelayPresence>): LinkRelayStore {
  return { presence } as unknown as LinkRelayStore;
}

describe('probeLinkRelay', () => {
  it('is healthy while Link reports ready', async () => {
    const result = await probeLinkRelay(
      storeWith(() => Promise.resolve({ state: 'ready', pending: 2 })),
    );
    expect(result).toEqual({ status: 'HEALTHY', detail: { transport: 'relay', pending: 2 } });
  });

  it('is degraded while Link is connected but Discord is not ready', async () => {
    const result = await probeLinkRelay(
      storeWith(() => Promise.resolve({ state: 'unready', pending: 0 })),
    );
    expect(result).toEqual({
      status: 'DEGRADED',
      detail: { transport: 'relay', reported: 'degraded', pending: 0 },
    });
  });

  it('is unhealthy when Link has not pulled recently', async () => {
    const result = await probeLinkRelay(
      storeWith(() => Promise.resolve({ state: 'absent', pending: 1 })),
    );
    expect(result).toEqual({
      status: 'UNHEALTHY',
      detail: { transport: 'relay', reachable: false, pending: 1 },
    });
  });

  it('is unhealthy when the store fails', async () => {
    const presence = vi.fn().mockRejectedValue(new Error('redis down'));
    const result = await probeLinkRelay(storeWith(presence));
    expect(result).toEqual({
      status: 'UNHEALTHY',
      detail: { transport: 'relay', reachable: false },
    });
  });
});
