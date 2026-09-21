import { randomInt } from 'node:crypto';

import { ConflictError, NotFoundError } from '@xenon/core';
import { type Db, type GameIdentity, type LinkToken, transaction } from '@xenon/database';
import { hashIp, hashSecret, recordAudit, refreshOnboardingStep } from '@xenon/domain';
import { enforceRateLimit } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import { type Actor, requirePermission, requireUser, systemActor } from '@xenon/permissions';

import { type GameIdentifier } from './adapter';

/**
 * FiveM account linking.
 *
 * The player generates a code on the website and types it in game. The bridge
 * relays it with the connecting player's real identifiers, which is the only
 * way to prove that the person holding the Xenon session is the person sitting
 * at that FiveM client - a self-declared identifier would let anyone claim
 * anyone's licence.
 *
 * Properties the code must have, and where each one is enforced:
 *  - unguessable: 5 characters from a 31-symbol alphabet drawn with `randomInt`
 *  - short-lived: `expiresAt`, 10 minutes
 *  - single use: `consumedAt`, set inside the redeeming transaction
 *  - rate limited: `enforceRateLimit('linkCode')` per user
 *  - not readable from a database dump: only the SHA-256 is stored
 */

/**
 * Alphabet without the characters people misread aloud.
 *
 * These codes get typed from a screenshot and read out in voice chat, so 0/O,
 * 1/I/L and the rest are simply absent rather than being something support has
 * to guess at.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;
const TTL_MINUTES = 10;

export const LINK_CODE_PREFIX = 'XEN';

function generateCode(): string {
  let body = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // randomInt draws from the CSPRNG and is free of the modulo bias that
    // `Math.floor(Math.random() * n)` would introduce.
    body += ALPHABET.charAt(randomInt(0, ALPHABET.length));
  }
  return `${LINK_CODE_PREFIX}-${body}`;
}

export interface IssuedLinkCode {
  /** Shown to the player exactly once. Never persisted in plaintext. */
  readonly code: string;
  readonly expiresAt: Date;
  readonly hint: string;
}

/** Issue a one-time link code for the signed-in user. */
export async function issueLinkCode(
  db: Db,
  actor: Actor,
  context: { ip?: string | null } = {},
): Promise<IssuedLinkCode> {
  const userId = requireUser(actor);
  await enforceRateLimit('linkCode', userId);

  // Outstanding codes are revoked so a player cannot accumulate live codes by
  // reloading the page, and so the UI only ever shows one.
  await db.linkToken.updateMany({
    where: { userId, consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000);

  await db.linkToken.create({
    data: {
      userId,
      codeHash: hashSecret(code),
      hint: code.slice(-2),
      expiresAt,
      createdIpHash: hashIp(context.ip),
    },
  });

  await recordAudit(db, actor, {
    action: 'link_token.issued',
    entityType: 'user',
    entityId: userId,
    entityLabel: actor.publicId,
    // The code itself is never written to the audit log; the hint is enough to
    // correlate an issue with a redemption.
    after: { hint: code.slice(-2), expiresAt: expiresAt.toISOString() },
  });

  return { code, expiresAt, hint: code.slice(-2) };
}

export interface RedeemResult {
  readonly userId: string;
  readonly publicId: string;
  readonly displayName: string | null;
  readonly identities: readonly GameIdentity[];
  readonly whitelisted: boolean;
}

/**
 * Redeem a code with the identifiers the game server observed.
 *
 * The whole exchange is one transaction. Without that, two simultaneous
 * redemptions of the same code could both pass the "not yet consumed" check and
 * both link - handing one player's account to whoever typed the code second.
 */
export async function redeemLinkCode(
  db: Db,
  input: {
    code: string;
    identifiers: readonly GameIdentifier[];
    playerName?: string | undefined;
  },
): Promise<RedeemResult> {
  await enforceRateLimit('bridgeRedeem', hashSecret(input.code).slice(0, 16));

  const codeHash = hashSecret(input.code.trim().toUpperCase());

  const token = await db.linkToken.findUnique({
    where: { codeHash },
    include: { user: { select: { id: true, publicId: true, displayName: true } } },
  });

  // Every failure below produces the same user-facing message. Distinguishing
  // "expired" from "wrong" would let someone probe for valid codes.
  const rejected = (detail: string): ConflictError =>
    new ConflictError(
      `Link code rejected: ${detail}`,
      'That code is not valid. Generate a new one from your Xenon portal.',
    );

  if (token === null) throw rejected('unknown');
  if (token.consumedAt !== null) throw rejected('already used');
  if (token.revokedAt !== null) throw rejected('revoked');
  if (token.expiresAt <= new Date()) throw rejected('expired');

  const primary = input.identifiers[0];
  if (primary === undefined) throw rejected('no identifiers supplied');

  const identities = await transaction(db, async (tx) => {
    // Re-read inside the transaction and consume atomically: `updateMany` with
    // the consumed guard in the WHERE clause is what makes a double redemption
    // impossible rather than merely unlikely.
    const claimed = await tx.linkToken.updateMany({
      where: { id: token.id, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: {
        consumedAt: new Date(),
        consumedBy: `${primary.kind.toLowerCase()}:${primary.value}`,
      },
    });
    if (claimed.count === 0) throw rejected('consumed concurrently');

    const created: GameIdentity[] = [];

    for (const [index, identifier] of input.identifiers.entries()) {
      const existing = await tx.gameIdentity.findUnique({
        where: { kind_value: { kind: identifier.kind, value: identifier.value } },
      });

      // An identifier already bound to a different account is a genuine
      // conflict - one Steam account cannot be two players - and is refused
      // rather than silently stolen.
      if (existing !== null && existing.userId !== token.userId) {
        throw new ConflictError(
          `Identifier ${identifier.kind}:${identifier.value} belongs to another account`,
          'One of your game identifiers is already linked to a different Xenon account. Open a support ticket.',
        );
      }

      created.push(
        await tx.gameIdentity.upsert({
          where: { kind_value: { kind: identifier.kind, value: identifier.value } },
          create: {
            userId: token.userId,
            kind: identifier.kind,
            value: identifier.value,
            label: input.playerName ?? null,
            isPrimary: index === 0,
            linkedVia: 'FIVEM',
          },
          update: {
            label: input.playerName ?? null,
            unlinkedAt: null,
            lastSeenAt: new Date(),
          },
        }),
      );
    }

    return created;
  });

  const label = input.playerName ?? `${primary.kind.toLowerCase()}:${primary.value.slice(0, 8)}`;

  // Audited as a FIVEM-sourced system action: nobody was signed in on the web
  // when this happened, and recording the player as the actor would be a lie.
  await recordAudit(
    db,
    { ...systemActor, source: 'FIVEM' },
    {
      action: 'game_identity.linked',
      entityType: 'user',
      entityId: token.userId,
      entityLabel: token.user.publicId,
      after: { identifiers: input.identifiers.map((id) => id.kind), playerName: input.playerName },
    },
  );

  const copy = notificationCopy.accountLinked(label);
  const notification = await createNotification(db, { userId: token.userId, ...copy });
  await dispatchPending([notification]);

  await refreshOnboardingStep(db, token.userId);

  const user = await db.user.findUniqueOrThrow({
    where: { id: token.userId },
    select: { publicId: true, displayName: true, whitelistState: true },
  });

  return {
    userId: token.userId,
    publicId: user.publicId,
    displayName: user.displayName,
    identities,
    whitelisted: user.whitelistState === 'APPROVED',
  };
}

/** Unlink an identity. The row is kept, marked unlinked, for audit. */
export async function unlinkIdentity(
  db: Db,
  actor: Actor,
  identityId: string,
): Promise<GameIdentity> {
  const identity = await db.gameIdentity.findUnique({ where: { id: identityId } });
  if (identity === null) throw new NotFoundError('GameIdentity', identityId);

  if (identity.userId !== actor.userId) {
    requirePermission(actor, 'players.manage');
  }

  const updated = await db.gameIdentity.update({
    where: { id: identityId },
    data: { unlinkedAt: new Date(), isPrimary: false },
  });

  await recordAudit(db, actor, {
    action: 'game_identity.unlinked',
    entityType: 'user',
    entityId: identity.userId,
    before: { kind: identity.kind },
  });

  await refreshOnboardingStep(db, identity.userId);
  return updated;
}

/** The user's live link code, if one is outstanding. Hint only, never the code. */
export async function activeLinkToken(db: Db, userId: string): Promise<LinkToken | null> {
  return db.linkToken.findFirst({
    where: { userId, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
}

/** Delete spent and expired tokens. Called by the maintenance sweep. */
export async function pruneLinkTokens(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await db.linkToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }] },
  });
  return result.count;
}
