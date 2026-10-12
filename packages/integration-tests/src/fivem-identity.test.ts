import { beforeEach, describe, expect, it } from 'vitest';

import type { LinkSource } from '@xenon/database';
import { ADMISSION_MESSAGES, whitelistStateForIdentifiers } from '@xenon/fivem';

import { createActor, prisma, resetDatabase } from './harness';

/**
 * FiveM admission (`/api/bridge/whitelist`).
 *
 * The `fivem:` identifier - the Cfx.re account id FXServer authenticates - is
 * matched against the account the player verified on the website. Rockstar
 * licences count only when proven by the retired in-game flow or granted by
 * staff, and only staff exceptions survive `cfx-only` mode. Client-reported
 * Discord and Steam ids never admit anyone.
 */

const SNOWFLAKE = '123456789012345678';
const CFX_ID = '4815162';

beforeEach(async () => {
  await resetDatabase();
});

async function player(
  identities: readonly { kind: 'FIVEM' | 'LICENSE'; value: string; via: LinkSource }[],
  whitelist: 'APPROVED' | 'PENDING' = 'APPROVED',
) {
  const { user } = await createActor();
  await prisma.user.update({ where: { id: user.id }, data: { whitelistState: whitelist } });
  for (const identity of identities) {
    await prisma.gameIdentity.create({
      data: {
        userId: user.id,
        kind: identity.kind,
        value: identity.value,
        linkedVia: identity.via,
        verifiedAt: identity.via === 'CFX' ? new Date() : null,
      },
    });
  }
  return user;
}

describe('connect admission', () => {
  it('admits a whitelisted player by their website-verified Cfx.re account', async () => {
    const user = await player([{ kind: 'FIVEM', value: CFX_ID, via: 'CFX' }]);
    expect(
      await whitelistStateForIdentifiers(prisma, [
        { kind: 'FIVEM', value: CFX_ID },
        { kind: 'LICENSE', value: 'unrelated-licence' },
      ]),
    ).toEqual({ allowed: true, publicId: user.publicId, reason: null });
  });

  it('refuses a linked but unwhitelisted player, without claiming approval', async () => {
    const user = await player([{ kind: 'FIVEM', value: CFX_ID, via: 'CFX' }], 'PENDING');
    const state = await whitelistStateForIdentifiers(prisma, [{ kind: 'FIVEM', value: CFX_ID }]);
    expect(state).toMatchObject({ allowed: false, publicId: user.publicId });
    expect(state.reason).toBe(ADMISSION_MESSAGES.notWhitelisted);
  });

  it('refuses a banned or suspended player even when whitelisted', async () => {
    const user = await player([{ kind: 'FIVEM', value: CFX_ID, via: 'CFX' }]);
    for (const status of ['SUSPENDED', 'BANNED'] as const) {
      await prisma.user.update({ where: { id: user.id }, data: { status } });
      const state = await whitelistStateForIdentifiers(prisma, [{ kind: 'FIVEM', value: CFX_ID }]);
      expect(state).toMatchObject({ allowed: false, reason: ADMISSION_MESSAGES.suspended });
    }
  });

  it('tells a player with no Cfx.re identifier to sign in to Cfx.re in FiveM', async () => {
    await player([{ kind: 'FIVEM', value: CFX_ID, via: 'CFX' }]);
    expect(
      await whitelistStateForIdentifiers(prisma, [{ kind: 'STEAM', value: '110000100000009' }]),
    ).toEqual({ allowed: false, publicId: null, reason: ADMISSION_MESSAGES.noCfx });
  });

  it('tells an unlinked Cfx.re account to connect on the website', async () => {
    expect(await whitelistStateForIdentifiers(prisma, [{ kind: 'FIVEM', value: '999' }])).toEqual({
      allowed: false,
      publicId: null,
      reason: ADMISSION_MESSAGES.notLinked,
    });
  });

  it('ignores a malformed fivem identifier', async () => {
    await player([{ kind: 'FIVEM', value: CFX_ID, via: 'CFX' }]);
    const state = await whitelistStateForIdentifiers(prisma, [
      { kind: 'FIVEM', value: `${CFX_ID}x` },
    ]);
    expect(state.allowed).toBe(false);
  });

  it('never admits on Discord or Steam identifiers, even when they are linked', async () => {
    const { user } = await createActor();
    await prisma.user.update({ where: { id: user.id }, data: { whitelistState: 'APPROVED' } });
    await prisma.gameIdentity.createMany({
      data: [
        { userId: user.id, kind: 'DISCORD', value: SNOWFLAKE },
        { userId: user.id, kind: 'STEAM', value: '110000100000009' },
      ],
    });

    const state = await whitelistStateForIdentifiers(prisma, [
      { kind: 'DISCORD', value: SNOWFLAKE },
      { kind: 'STEAM', value: '110000100000009' },
    ]);
    expect(state).toMatchObject({ allowed: false, publicId: null });
  });

  it('refuses when identifiers resolve to two different accounts', async () => {
    await player([{ kind: 'LICENSE', value: 'licence-a', via: 'FIVEM' }]);
    await player([{ kind: 'FIVEM', value: CFX_ID, via: 'CFX' }]);
    expect(
      await whitelistStateForIdentifiers(prisma, [
        { kind: 'LICENSE', value: 'licence-a' },
        { kind: 'FIVEM', value: CFX_ID },
      ]),
    ).toEqual({ allowed: false, publicId: null, reason: ADMISSION_MESSAGES.conflict });
  });

  it('keeps legacy proven licences in cfx-or-legacy mode and drops them in cfx-only', async () => {
    const user = await player([{ kind: 'LICENSE', value: 'licence-legacy', via: 'FIVEM' }]);
    const identifiers = [{ kind: 'LICENSE' as const, value: 'licence-legacy' }];

    expect(await whitelistStateForIdentifiers(prisma, identifiers, 'cfx-or-legacy')).toMatchObject({
      allowed: true,
      publicId: user.publicId,
    });
    expect(await whitelistStateForIdentifiers(prisma, identifiers, 'cfx-only')).toMatchObject({
      allowed: false,
      reason: ADMISSION_MESSAGES.noCfx,
    });
  });

  it('honours a staff-granted licence exception in cfx-only mode', async () => {
    const user = await player([{ kind: 'LICENSE', value: 'licence-exception', via: 'STAFF' }]);
    expect(
      await whitelistStateForIdentifiers(
        prisma,
        [{ kind: 'LICENSE', value: 'licence-exception' }],
        'cfx-only',
      ),
    ).toEqual({ allowed: true, publicId: user.publicId, reason: null });
  });

  it('does not admit an unlinked identity', async () => {
    const user = await player([{ kind: 'FIVEM', value: CFX_ID, via: 'CFX' }]);
    await prisma.gameIdentity.updateMany({
      where: { userId: user.id },
      data: { unlinkedAt: new Date() },
    });
    const state = await whitelistStateForIdentifiers(prisma, [{ kind: 'FIVEM', value: CFX_ID }]);
    expect(state).toMatchObject({ allowed: false, reason: ADMISSION_MESSAGES.notLinked });
  });
});
