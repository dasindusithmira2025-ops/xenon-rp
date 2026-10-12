import { describe, expect, it } from 'vitest';

import { silentLogger } from '@xenon/logger';

import { createMemoryLinkRelayStore } from '../../../../packages/jobs/src/testing';
import { createRelayOperations } from '../../../core-api/src/relay';
import { GatewayError } from '../../../worker/src/gateway-client';
import { createRelayGatewayClient } from '../../../worker/src/gateway-relay-client';

import { createGatewayExecutor } from './execute';
import { startGatewayRelay } from './relay';

const SECRET = 'w'.repeat(40);

function wire(workerSecret: string) {
  const store = createMemoryLinkRelayStore();
  const relayOps = createRelayOperations({ store, logger: silentLogger });
  const roleCalls: unknown[] = [];
  const handlers = {
    'member.role': (input: unknown) => {
      roleCalls.push(input);
      return Promise.resolve({ changed: true });
    },
  } as never;
  const execute = createGatewayExecutor({ secret: SECRET, handlers, logger: silentLogger });
  const core = (async (
    operation: 'relay.pull' | 'relay.complete',
    input: never,
    options?: { signal?: AbortSignal },
  ) => {
    const data = await (
      relayOps.handlers[operation] as (
        value: never,
        context: { signal?: AbortSignal },
      ) => Promise<unknown>
    )(input, {
      signal: options?.signal,
    });
    return { ok: true, data };
  }) as never;
  const relay = startGatewayRelay({
    core,
    execute,
    isDiscordReady: () => true,
    logger: silentLogger,
  });
  const worker = createRelayGatewayClient({
    store,
    secret: workerSecret,
    timeoutMs: 4000,
    pollMs: 20,
  });
  return { store, relayOps, relay, worker, roleCalls };
}

async function waitForRelay(store: { presence(): Promise<{ state: string }> }): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await store.presence()).state === 'ready') return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Link relay did not announce presence');
}

describe('relay end to end (worker -> Redis -> Core -> Link executor)', () => {
  it('executes a signed request once and returns the operation result', async () => {
    const { store, relayOps, relay, worker, roleCalls } = wire(SECRET);
    await waitForRelay(store);
    const result = await worker('member.role', {
      discordUserId: '123456789012345678',
      roleId: '223456789012345678',
      action: 'add',
      reason: 'test',
    });
    expect(result).toEqual({ changed: true });
    expect(roleCalls).toHaveLength(1);
    await relay.stop();
    relayOps.close();
  }, 15_000);

  it('rejects a worker signature from the wrong secret without running the handler', async () => {
    const { store, relayOps, relay, worker, roleCalls } = wire('x'.repeat(40));
    await waitForRelay(store);
    await expect(
      worker('member.role', {
        discordUserId: '123456789012345678',
        roleId: '223456789012345678',
        action: 'add',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(roleCalls).toHaveLength(0);
    await relay.stop();
    relayOps.close();
  }, 15_000);
});
