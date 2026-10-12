import { constants, publicEncrypt } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CfxForum,
  type CfxLinkConfig,
  CfxLinkError,
  cancelCfxLink,
  cfxConnection,
  completeCfxLink,
  grantLicenceException,
  staffUnlinkCfx,
  startCfxLink,
  unlinkCfxAccount,
  whitelistStateForIdentifiers,
} from '@xenon/fivem';
import { type Actor, systemActor } from '@xenon/permissions';

import { createActor, prisma, resetDatabase } from './harness';

/**
 * Website-first Cfx.re linking against a real database.
 *
 * forum.cfx.re is replaced by a double that behaves like Discourse's User API
 * key endpoint: it reads our public key and nonce from the authorize URL and
 * returns an RSA-encrypted payload. These tests prove our side of the protocol
 * (binding, single use, expiry, nonce, conflicts, revocation, persistence);
 * they do not prove that the real forum accepts our callback. See
 * docs/CFX_LINKING.md for the staging check against forum.cfx.re.
 */

const CONFIG: CfxLinkConfig = {
  forumUrl: 'https://forum.cfx.test',
  callbackUrl: 'https://xenon.test/api/v1/me/cfx/callback',
  applicationName: 'Xenon Roleplay',
  serverSecret: 'integration-server-secret-at-least-32-characters',
};

beforeEach(async () => {
  await resetDatabase();
});

/** What forum.cfx.re does after the player clicks Authorize. */
function approve(authorizeUrl: string, overrides: { nonce?: string; key?: string } = {}): string {
  const url = new URL(authorizeUrl);
  const publicKey = url.searchParams.get('public_key') ?? '';
  const body = JSON.stringify({
    key: overrides.key ?? 'user-api-key-0123456789abcdef',
    nonce: overrides.nonce ?? url.searchParams.get('nonce'),
    push: false,
    api: 4,
  });
  return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(body))
    .toString('base64')
    .replace(/(.{60})/g, '$1\n'); // Discourse's Base64.encode64 wraps lines.
}

function forum(
  account: { id: number; username: string } | Error = { id: 4815162, username: 'ravi_rp' },
) {
  const revoked: string[] = [];
  const port: CfxForum = {
    currentUser: vi.fn((key: string) => {
      if (account instanceof Error) return Promise.reject(account);
      expect(key).toBe('user-api-key-0123456789abcdef');
      return Promise.resolve(account);
    }),
    revoke: vi.fn((key: string) => {
      revoked.push(key);
      return Promise.resolve();
    }),
  };
  return { port, revoked };
}

async function begin(actor: Actor) {
  const started = await startCfxLink(prisma, actor, CONFIG);
  return { ...started, payload: approve(started.authorizeUrl) };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CfxLinkError);
  return (error as CfxLinkError).reason;
}

describe('Connect Cfx.re', () => {
  it('builds a Discourse User API key request with only the session_info scope', async () => {
    const { actor } = await createActor();
    const { authorizeUrl } = await startCfxLink(prisma, actor, CONFIG);
    const url = new URL(authorizeUrl);

    expect(url.origin + url.pathname).toBe('https://forum.cfx.test/user-api-key/new');
    expect(url.searchParams.get('scopes')).toBe('session_info');
    expect(url.searchParams.get('auth_redirect')).toBe(CONFIG.callbackUrl);
    expect(url.searchParams.get('nonce')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('public_key')).toContain('BEGIN PUBLIC KEY');
    // The nonce is never stored in clear.
    const attempt = await prisma.cfxLinkAttempt.findFirstOrThrow();
    expect(JSON.stringify(attempt)).not.toContain(url.searchParams.get('nonce'));
  });

  it('links the verified account, revokes the key and stores no secret', async () => {
    const { user, actor } = await createActor();
    const { cookie, payload } = await begin(actor);
    const { port, revoked } = forum();

    const result = await completeCfxLink(prisma, actor, { cookie, payload }, CONFIG, port);

    expect(result.identity).toMatchObject({
      userId: user.id,
      kind: 'FIVEM',
      value: '4815162',
      label: 'ravi_rp',
      linkedVia: 'CFX',
    });
    expect(result.identity.verifiedAt).not.toBeNull();
    expect(revoked).toEqual(['user-api-key-0123456789abcdef']);

    const attempt = await prisma.cfxLinkAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({ outcome: 'LINKED', privateKeyEnc: null, cfxUserId: '4815162' });
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain('user-api-key');

    expect(await cfxConnection(prisma, user.id)).toMatchObject({
      linked: true,
      username: 'ravi_rp',
      verifiedOnWebsite: true,
    });
    const events = await prisma.outboxMessage.findMany({
      where: { kind: 'EVENT', name: 'PLAYER_IDENTITY_LINKED' },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.payload)).not.toContain('4815162');
    const onboarding = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(onboarding.onboardingStep).not.toBe('FIVEM_LINK');
  });

  it('refuses a replayed callback', async () => {
    const { actor } = await createActor();
    const { cookie, payload } = await begin(actor);
    await completeCfxLink(prisma, actor, { cookie, payload }, CONFIG, forum().port);

    expect(
      await reason(completeCfxLink(prisma, actor, { cookie, payload }, CONFIG, forum().port)),
    ).toBe('invalid');
  });

  it('refuses a payload whose nonce does not match the attempt', async () => {
    const { actor } = await createActor();
    const started = await startCfxLink(prisma, actor, CONFIG);
    const payload = approve(started.authorizeUrl, { nonce: 'f'.repeat(64) });
    const { port } = forum();

    expect(
      await reason(
        completeCfxLink(prisma, actor, { cookie: started.cookie, payload }, CONFIG, port),
      ),
    ).toBe('invalid');
    expect(port.currentUser).not.toHaveBeenCalled();
    expect(await prisma.gameIdentity.count()).toBe(0);
  });

  it('refuses a payload encrypted for a different attempt', async () => {
    const { actor } = await createActor();
    const first = await startCfxLink(prisma, actor, CONFIG);
    const second = await startCfxLink(prisma, actor, CONFIG);
    // The first attempt was superseded; its payload cannot land on the second.
    const payload = approve(first.authorizeUrl);
    expect(
      await reason(
        completeCfxLink(prisma, actor, { cookie: second.cookie, payload }, CONFIG, forum().port),
      ),
    ).toBe('invalid');
  });

  it('refuses an expired attempt', async () => {
    const { actor } = await createActor();
    const { cookie, payload } = await begin(actor);
    await prisma.cfxLinkAttempt.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } });

    expect(
      await reason(completeCfxLink(prisma, actor, { cookie, payload }, CONFIG, forum().port)),
    ).toBe('expired');
  });

  it('binds the callback to the session and browser that started it', async () => {
    const { actor } = await createActor();
    const { actor: other } = await createActor();
    const { cookie, payload } = await begin(actor);

    // Another signed-in account presenting the victim's cookie and payload.
    expect(
      await reason(completeCfxLink(prisma, other, { cookie, payload }, CONFIG, forum().port)),
    ).toBe('mismatch');
    // The right account without the browser cookie.
    expect(
      await reason(
        completeCfxLink(prisma, actor, { cookie: undefined, payload }, CONFIG, forum().port),
      ),
    ).toBe('mismatch');
    // A forged browser secret.
    const forged = `${cookie.split('.')[0] ?? ''}.${'A'.repeat(43)}`;
    expect(
      await reason(
        completeCfxLink(prisma, actor, { cookie: forged, payload }, CONFIG, forum().port),
      ),
    ).toBe('mismatch');
    // None of that spent the attempt: the genuine callback still succeeds.
    await completeCfxLink(prisma, actor, { cookie, payload }, CONFIG, forum().port);
  });

  it('refuses an unauthenticated caller', async () => {
    const { actor } = await createActor();
    const { cookie, payload } = await begin(actor);
    const anonymous: Actor = { ...systemActor, userId: null, source: 'WEB' };
    await expect(
      completeCfxLink(prisma, anonymous, { cookie, payload }, CONFIG, forum().port),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(startCfxLink(prisma, anonymous, CONFIG)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('records a cancellation when the player returns without approving', async () => {
    const { actor } = await createActor();
    const { cookie } = await startCfxLink(prisma, actor, CONFIG);
    expect(
      await reason(completeCfxLink(prisma, actor, { cookie, payload: null }, CONFIG, forum().port)),
    ).toBe('cancelled');
    expect(await prisma.cfxLinkAttempt.findFirstOrThrow()).toMatchObject({
      outcome: 'CANCELLED',
      privateKeyEnc: null,
    });
  });

  it('lets the player cancel an outstanding attempt', async () => {
    const { actor } = await createActor();
    const { cookie, payload } = await begin(actor);
    await cancelCfxLink(prisma, actor);
    expect(
      await reason(completeCfxLink(prisma, actor, { cookie, payload }, CONFIG, forum().port)),
    ).toBe('invalid');
  });

  it('survives a provider outage without linking, and still revokes the key', async () => {
    const { actor } = await createActor();
    const { cookie, payload } = await begin(actor);
    const { port, revoked } = forum(new Error('503 from forum'));

    expect(await reason(completeCfxLink(prisma, actor, { cookie, payload }, CONFIG, port))).toBe(
      'provider',
    );
    expect(revoked).toHaveLength(1);
    expect(await prisma.gameIdentity.count()).toBe(0);
    expect(await prisma.cfxLinkAttempt.findFirstOrThrow()).toMatchObject({
      outcome: 'PROVIDER_ERROR',
    });
  });

  it('refuses a Cfx.re account already linked to another Xenon account', async () => {
    const { actor: owner } = await createActor();
    const first = await begin(owner);
    await completeCfxLink(prisma, owner, first, CONFIG, forum().port);

    const { user, actor: claimant } = await createActor();
    const second = await begin(claimant);
    expect(await reason(completeCfxLink(prisma, claimant, second, CONFIG, forum().port))).toBe(
      'conflict',
    );
    expect(await prisma.gameIdentity.count({ where: { userId: user.id } })).toBe(0);
  });

  it('refuses linking a second, different Cfx.re account until the first is unlinked', async () => {
    const { user, actor } = await createActor();
    await completeCfxLink(prisma, actor, await begin(actor), CONFIG, forum().port);

    const other = forum({ id: 2342, username: 'alt_account' });
    expect(
      await reason(completeCfxLink(prisma, actor, await begin(actor), CONFIG, other.port)),
    ).toBe('already-linked');

    await unlinkCfxAccount(prisma, actor);
    await completeCfxLink(prisma, actor, await begin(actor), CONFIG, other.port);
    expect(await cfxConnection(prisma, user.id)).toMatchObject({ username: 'alt_account' });
    const audit = await prisma.auditLog.findMany({ where: { entityId: user.id } });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['game_identity.cfx_linked', 'game_identity.cfx_unlinked']),
    );
  });

  it('lets a Cfx.re account unlinked by one player be verified by another', async () => {
    const { actor: previous } = await createActor();
    await completeCfxLink(prisma, previous, await begin(previous), CONFIG, forum().port);
    await unlinkCfxAccount(prisma, previous);

    const { user, actor } = await createActor();
    await completeCfxLink(prisma, actor, await begin(actor), CONFIG, forum().port);
    expect(await cfxConnection(prisma, user.id)).toMatchObject({ linked: true });
  });

  it('does not grant connection access on its own: whitelist approval is still required', async () => {
    const { user, actor } = await createActor();
    await completeCfxLink(prisma, actor, await begin(actor), CONFIG, forum().port);

    const pending = await whitelistStateForIdentifiers(prisma, [
      { kind: 'FIVEM', value: '4815162' },
    ]);
    expect(pending.allowed).toBe(false);

    await prisma.user.update({ where: { id: user.id }, data: { whitelistState: 'APPROVED' } });
    const approved = await whitelistStateForIdentifiers(prisma, [
      { kind: 'FIVEM', value: '4815162' },
    ]);
    expect(approved.allowed).toBe(true);
  });

  it('rolls the link back when the database transaction fails', async () => {
    const { user, actor } = await createActor();
    const started = await begin(actor);
    // A broken outbox write inside the linking transaction.
    const failing = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.$transaction(async (tx) =>
              fn(
                new Proxy(tx, {
                  get(inner, name, innerReceiver) {
                    if (name === 'outboxMessage') {
                      return { createMany: () => Promise.reject(new Error('disk full')) };
                    }
                    return Reflect.get(inner, name, innerReceiver) as unknown;
                  },
                }),
              ),
            );
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await expect(completeCfxLink(failing, actor, started, CONFIG, forum().port)).rejects.toThrow(
      'disk full',
    );
    expect(await prisma.gameIdentity.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.cfxLinkAttempt.findFirstOrThrow()).toMatchObject({ outcome: 'ERROR' });
  });
});

describe('staff licence exception', () => {
  const LICENCE = 'a'.repeat(40);

  it('is refused to players without players.manage', async () => {
    const { user } = await createActor();
    const { actor } = await createActor();
    await expect(
      grantLicenceException(prisma, actor, {
        userPublicId: user.publicId,
        licence: LICENCE,
        reason: 'FiveM client cannot sign in to Cfx.re',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await prisma.gameIdentity.count()).toBe(0);
  });

  it('lets staff admit a whitelisted player by licence, audited, even in cfx-only mode', async () => {
    const { user } = await createActor();
    await prisma.user.update({ where: { id: user.id }, data: { whitelistState: 'APPROVED' } });
    const { actor: staff } = await createActor({ roleKeys: ['moderator'] });

    await grantLicenceException(prisma, staff, {
      userPublicId: user.publicId,
      licence: `license:${LICENCE}`,
      reason: 'FiveM client cannot sign in to Cfx.re',
    });

    expect(
      await whitelistStateForIdentifiers(prisma, [{ kind: 'LICENSE', value: LICENCE }], 'cfx-only'),
    ).toMatchObject({ allowed: true, publicId: user.publicId });
    expect(
      await prisma.auditLog.count({ where: { action: 'game_identity.licence_exception' } }),
    ).toBe(1);
  });
});

describe('sanctions and races', () => {
  it('stops a banned player freeing their Cfx.re account for a new Xenon account', async () => {
    const { user, actor } = await createActor();
    await completeCfxLink(prisma, actor, await begin(actor), CONFIG, forum().port);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'BANNED' } });

    await expect(unlinkCfxAccount(prisma, actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Even if the row had been unlinked earlier, a sanctioned owner keeps it.
    await prisma.gameIdentity.updateMany({ data: { unlinkedAt: new Date() } });
    const { actor: fresh } = await createActor();
    expect(
      await reason(completeCfxLink(prisma, fresh, await begin(fresh), CONFIG, forum().port)),
    ).toBe('conflict');
  });

  it('lets exactly one of two simultaneous links of the same Cfx.re account win', async () => {
    const { actor: first } = await createActor();
    const { actor: second } = await createActor();
    const [a, b] = await Promise.all([begin(first), begin(second)]);

    const results = await Promise.allSettled([
      completeCfxLink(prisma, first, a, CONFIG, forum().port),
      completeCfxLink(prisma, second, b, CONFIG, forum().port),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected!.reason).toBeInstanceOf(CfxLinkError);
    expect(await prisma.gameIdentity.count({ where: { kind: 'FIVEM', unlinkedAt: null } })).toBe(1);
    const linkedAudits = await prisma.auditLog.count({
      where: { action: 'game_identity.cfx_linked' },
    });
    expect(linkedAudits).toBe(1);
  });
});

describe('staff Cfx.re unlink', () => {
  it('lets staff free a disputed link for the rightful owner, and refuses players', async () => {
    const { user: squatter, actor } = await createActor();
    await completeCfxLink(prisma, actor, await begin(actor), CONFIG, forum().port);

    const { actor: player } = await createActor();
    await expect(
      staffUnlinkCfx(prisma, player, {
        userPublicId: squatter.publicId,
        reason: 'Owner disputes this link',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const { actor: staff } = await createActor({ roleKeys: ['moderator'] });
    await staffUnlinkCfx(prisma, staff, {
      userPublicId: squatter.publicId,
      reason: 'Owner disputes this link',
    });

    const { user: owner, actor: ownerActor } = await createActor();
    await completeCfxLink(prisma, ownerActor, await begin(ownerActor), CONFIG, forum().port);
    expect(await cfxConnection(prisma, owner.id)).toMatchObject({ linked: true });
    expect(
      await prisma.auditLog.count({ where: { action: 'game_identity.cfx_unlinked_by_staff' } }),
    ).toBe(1);
  });
});
