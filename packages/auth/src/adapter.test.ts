import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@xenon/database';

import { xenonAdapter } from './adapter';

import type { AdapterAccount } from 'next-auth/adapters';

describe('Xenon Auth.js adapter', () => {
  it('retains the provider identity pointer but never persists OAuth tokens', async () => {
    const accountUpsert = vi.fn(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({ ...create }),
    );
    const prisma = {
      discordAccount: {
        findUnique: vi.fn(() => Promise.resolve({ userId: 'xenon-user' })),
      },
      account: { upsert: accountUpsert },
    } as unknown as PrismaClient;
    const adapter = xenonAdapter(prisma);

    const linked = await adapter.linkAccount?.({
      userId: 'xenon-user',
      type: 'oauth',
      provider: 'discord',
      providerAccountId: '90000000000000000001',
      access_token: 'access-token-test-value',
      refresh_token: 'refresh-token-test-value',
      id_token: 'id-token-test-value',
      expires_at: 123,
      scope: 'identify' as const,
      token_type: 'bearer',
    } satisfies AdapterAccount);

    const create = accountUpsert.mock.calls[0]?.[0].create;
    expect(create).toMatchObject({
      userId: 'xenon-user',
      provider: 'discord',
      providerAccountId: '90000000000000000001',
      access_token: null,
      refresh_token: null,
      id_token: null,
      expires_at: null,
      scope: null,
      token_type: null,
    });
    expect(linked).toMatchObject({
      access_token: undefined,
      refresh_token: undefined,
      id_token: undefined,
      scope: undefined,
    });
  });

  it('refuses to link a Discord account to a different Xenon user', async () => {
    const prisma = {
      discordAccount: {
        findUnique: vi.fn(() => Promise.resolve({ userId: 'different-user' })),
      },
      account: { upsert: vi.fn() },
    } as unknown as PrismaClient;
    const adapter = xenonAdapter(prisma);

    await expect(
      adapter.linkAccount?.({
        userId: 'xenon-user',
        type: 'oauth',
        provider: 'discord',
        providerAccountId: '90000000000000000001',
      } satisfies AdapterAccount),
    ).rejects.toThrow(/ownership does not match/);
  });
});
