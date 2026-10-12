import {
  createCipheriv,
  createDecipheriv,
  createHash,
  constants,
  generateKeyPairSync,
  hkdfSync,
  privateDecrypt,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@xenon/core';
import { type Db, type GameIdentity, transaction } from '@xenon/database';
import { eventDiscordId, hashIp, recordAudit, refreshOnboardingStep } from '@xenon/domain';
import { emitIntegrationEvent, enforceRateLimit, enqueueDurable } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import { type Actor, requirePermission, requireUser } from '@xenon/permissions';

/**
 * Website-first Cfx.re account linking.
 *
 * Method: the Discourse "User API Keys" protocol that forum.cfx.re exposes
 * (https://meta.discourse.org/t/user-api-keys-specification/48536). It is the
 * same mechanism the FiveM client and txAdmin use for "Log in with Cfx.re".
 *
 *  1. We generate an ephemeral RSA key pair and a nonce per attempt, and send
 *     the browser to `{forum}/user-api-key/new` with our public key, the nonce,
 *     the `session_info` scope and our fixed callback URL.
 *  2. The player signs in to Cfx.re (if needed) and approves "Xenon".
 *  3. The forum redirects back with `payload` = RSA(public key, JSON{key,
 *     nonce, push, api}). Only our private key can read it.
 *  4. We check the nonce, call `{forum}/session/current.json` with the
 *     returned user API key, and take `current_user.id` - the numeric forum
 *     account id, which is exactly the value FXServer reports as `fivem:<id>`.
 *  5. The user API key is revoked immediately; it is never stored.
 *
 * Binding: the attempt row is owned by the signed-in Xenon user and the
 * callback must present the browser secret from an httpOnly cookie set when the
 * attempt started. A payload pasted into another session, replayed, stale or
 * belonging to another attempt is refused. The callback URL is fixed, so there
 * is no redirect target to tamper with.
 */

/** How long a player has to approve on forum.cfx.re. */
export const CFX_ATTEMPT_TTL_MS = 10 * 60_000;
const RSA_BITS = 2048;
const SCOPES = 'session_info';
const FIVEM_ID = /^[1-9]\d{0,11}$/;

/** Why an attempt ended without a link. Safe to put in a redirect query. */
export type CfxLinkFailure =
  'expired' | 'invalid' | 'mismatch' | 'conflict' | 'already-linked' | 'provider' | 'cancelled';

export class CfxLinkError extends ConflictError {
  constructor(
    readonly reason: CfxLinkFailure,
    message: string,
    safeMessage: string,
  ) {
    super(message, safeMessage);
  }
}

const SAFE: Record<CfxLinkFailure, string> = {
  expired: 'That Cfx.re authorization took too long. Start again from your account page.',
  invalid: 'That Cfx.re authorization could not be verified. Start again from your account page.',
  mismatch:
    'That Cfx.re authorization was started from a different browser or account. Start again here.',
  conflict:
    'That Cfx.re account is already linked to another Xenon account. Open a support ticket if it is yours.',
  'already-linked':
    'Your Xenon account is already linked to a different Cfx.re account. Unlink it first.',
  provider: 'Cfx.re could not be reached. Try again in a minute.',
  cancelled: 'Cfx.re authorization was cancelled.',
};

function fail(reason: CfxLinkFailure, detail: string): CfxLinkError {
  return new CfxLinkError(reason, `Cfx.re link refused: ${detail}`, SAFE[reason]);
}

function isUniqueViolation(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

/**
 * A suspended or banned player may not detach their identity: the link is the
 * anchor the connect gate refuses them by, and freeing it would let the same
 * Cfx.re account be verified by a fresh Xenon account.
 */
async function requireActiveForUnlink(db: Db, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (user?.status !== 'ACTIVE') {
    throw new ForbiddenError('identity unlink while sanctioned');
  }
}

/** The two forum calls the flow needs. A port so tests never touch the network. */
export interface CfxForum {
  /** The account the user API key belongs to. Throws on any provider failure. */
  currentUser(userApiKey: string): Promise<{ readonly id: number; readonly username: string }>;
  /** Revoke the key. Best effort: failures are logged by the caller, never fatal. */
  revoke(userApiKey: string): Promise<void>;
}

export interface CfxForumOptions {
  readonly baseUrl: string;
  /** Sent as User-Agent; forum.cfx.re answers `User ID was null` without one. */
  readonly userAgent: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The real forum.cfx.re client. */
export function httpCfxForum(options: CfxForumOptions): CfxForum {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const headers = (key: string) => ({
    accept: 'application/json',
    'user-agent': options.userAgent,
    'user-api-key': key,
  });

  return {
    async currentUser(key) {
      const response = await fetchImpl(`${base}/session/current.json`, {
        headers: headers(key),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`session/current.json answered ${String(response.status)}`);
      const body = (await response.json()) as {
        current_user?: { id?: unknown; username?: unknown };
      };
      const id = body.current_user?.id;
      const username = body.current_user?.username;
      if (typeof id !== 'number' || typeof username !== 'string') {
        throw new Error('session/current.json returned no current_user');
      }
      return { id, username };
    },
    async revoke(key) {
      await fetchImpl(`${base}/user-api-key/revoke`, {
        method: 'POST',
        headers: headers(key),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    },
  };
}

// --- Secrets -----------------------------------------------------------------

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameHash(value: string, expectedHash: string): boolean {
  const a = Buffer.from(sha256(value), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** AES-256-GCM key for private keys at rest, derived from the server secret. */
function keyFor(serverSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', serverSecret, 'xenon', 'cfx-link-private-key', 32));
}

function seal(plaintext: string, serverSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(serverSecret), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

function open(sealed: string, serverSecret: string): string {
  const [iv, tag, body] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (iv === undefined || tag === undefined || body === undefined) throw new Error('Bad seal');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(serverSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

// --- Flow --------------------------------------------------------------------

export interface CfxLinkConfig {
  /** `https://forum.cfx.re` in production. */
  readonly forumUrl: string;
  /** Absolute, fixed callback: `{site}/api/v1/me/cfx/callback`. */
  readonly callbackUrl: string;
  /** Shown on the forum consent screen and in the player's Cfx.re "Apps" tab. */
  readonly applicationName: string;
  /** Server-side secret used to seal the private key (the web tier's AUTH_SECRET). */
  readonly serverSecret: string;
}

export interface StartedCfxLink {
  /** Where to send the browser. */
  readonly authorizeUrl: string;
  /** Value for the httpOnly binding cookie: `<attemptId>.<browserSecret>`. */
  readonly cookie: string;
  readonly expiresAt: Date;
}

/** Begin a "Connect Cfx.re" attempt for the signed-in player. */
export async function startCfxLink(
  db: Db,
  actor: Actor,
  config: CfxLinkConfig,
  context: { ip?: string | null } = {},
): Promise<StartedCfxLink> {
  const userId = requireUser(actor);
  await enforceRateLimit('cfxLinkStart', userId);

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: RSA_BITS });
  const nonce = randomBytes(32).toString('hex');
  const browserSecret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CFX_ATTEMPT_TTL_MS);

  const attempt = await transaction(db, async (tx) => {
    // One live attempt per player: an older tab's callback can no longer land.
    await tx.cfxLinkAttempt.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date(), outcome: 'SUPERSEDED', privateKeyEnc: null },
    });
    return tx.cfxLinkAttempt.create({
      data: {
        userId,
        nonceHash: sha256(nonce),
        browserSecretHash: sha256(browserSecret),
        privateKeyEnc: seal(
          privateKey.export({ type: 'pkcs8', format: 'pem' }),
          config.serverSecret,
        ),
        expiresAt,
        createdIpHash: hashIp(context.ip),
      },
    });
  });

  const url = new URL('/user-api-key/new', config.forumUrl);
  url.searchParams.set('application_name', config.applicationName);
  url.searchParams.set('client_id', `xenonrp-${attempt.id}`);
  url.searchParams.set('scopes', SCOPES);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('auth_redirect', config.callbackUrl);
  url.searchParams.set('public_key', publicKey.export({ type: 'spki', format: 'pem' }));

  return { authorizeUrl: url.toString(), cookie: `${attempt.id}.${browserSecret}`, expiresAt };
}

/** Parse the binding cookie. Null when absent or malformed. */
function parseCookie(cookie: string | null | undefined): { id: string; secret: string } | null {
  if (!cookie) return null;
  const match = /^([a-z0-9]{10,40})\.([A-Za-z0-9_-]{40,60})$/.exec(cookie);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { id: match[1], secret: match[2] };
}

async function finish(db: Db, attemptId: string, outcome: string, cfxUserId?: string) {
  await db.cfxLinkAttempt.update({
    where: { id: attemptId },
    data: { outcome, privateKeyEnc: null, ...(cfxUserId === undefined ? {} : { cfxUserId }) },
  });
}

export interface CompletedCfxLink {
  readonly identity: GameIdentity;
  readonly username: string;
}

/**
 * Finish an attempt from the forum's redirect.
 *
 * `payload` is the raw `payload` query value; `null` means the player came
 * back without approving (treated as a cancellation).
 */
export async function completeCfxLink(
  db: Db,
  actor: Actor,
  input: { readonly cookie: string | null | undefined; readonly payload: string | null },
  config: CfxLinkConfig,
  forum: CfxForum,
): Promise<CompletedCfxLink> {
  const userId = requireUser(actor);
  const binding = parseCookie(input.cookie);
  if (binding === null) throw fail('mismatch', 'no binding cookie');

  const attempt = await db.cfxLinkAttempt.findUnique({ where: { id: binding.id } });
  // Same answer for "not yours" and "does not exist": nothing to probe.
  if (attempt?.userId !== userId || !sameHash(binding.secret, attempt.browserSecretHash)) {
    throw fail('mismatch', 'attempt not bound to this session');
  }

  // Claim before anything else: a replayed or concurrent callback finds it taken.
  const claimed = await db.cfxLinkAttempt.updateMany({
    where: { id: attempt.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count === 0) throw fail('invalid', 'attempt already used');

  if (attempt.expiresAt <= new Date()) {
    await finish(db, attempt.id, 'EXPIRED');
    throw fail('expired', 'attempt expired');
  }
  if (input.payload === null || input.payload.length === 0) {
    await finish(db, attempt.id, 'CANCELLED');
    throw fail('cancelled', 'no payload');
  }
  if (attempt.privateKeyEnc === null) throw fail('invalid', 'attempt has no key');

  let decoded: { key?: unknown; nonce?: unknown };
  try {
    const privateKey = open(attempt.privateKeyEnc, config.serverSecret);
    // Discourse encrypts with PKCS#1 v1.5 by default. The key pair is single
    // use and destroyed below, so there is no decryption oracle to query.
    const plaintext = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(input.payload, 'base64'),
    );
    decoded = JSON.parse(plaintext.toString('utf8')) as typeof decoded;
  } catch {
    await finish(db, attempt.id, 'INVALID_PAYLOAD');
    throw fail('invalid', 'payload did not decrypt');
  }

  if (typeof decoded.nonce !== 'string' || !sameHash(decoded.nonce, attempt.nonceHash)) {
    await finish(db, attempt.id, 'NONCE_MISMATCH');
    throw fail('invalid', 'nonce mismatch');
  }
  if (typeof decoded.key !== 'string' || decoded.key.length === 0) {
    await finish(db, attempt.id, 'INVALID_PAYLOAD');
    throw fail('invalid', 'payload had no key');
  }

  const userApiKey = decoded.key;
  let account: { id: number; username: string };
  try {
    account = await forum.currentUser(userApiKey);
  } catch {
    await finish(db, attempt.id, 'PROVIDER_ERROR');
    throw fail('provider', 'session/current.json failed');
  } finally {
    // The key only ever answers "who is this"; nothing keeps it.
    await forum.revoke(userApiKey).catch(() => undefined);
  }

  const cfxId = String(account.id);
  if (!FIVEM_ID.test(cfxId)) {
    await finish(db, attempt.id, 'PROVIDER_ERROR');
    throw fail('provider', 'forum returned a non-numeric id');
  }
  const username = account.username.slice(0, 60);

  let identity: GameIdentity;
  try {
    identity = await transaction(db, async (tx) => {
      const [existing, mine] = await Promise.all([
        tx.gameIdentity.findUnique({
          where: { kind_value: { kind: 'FIVEM', value: cfxId } },
          include: { user: { select: { status: true } } },
        }),
        tx.gameIdentity.findFirst({
          where: { userId, kind: 'FIVEM', unlinkedAt: null, NOT: { value: cfxId } },
        }),
      ]);
      if (existing !== null && existing.userId !== userId) {
        // Another account holds it, or held it and is sanctioned: moving a
        // banned player's Cfx.re account to a fresh Xenon account would be ban
        // evasion, so only a cleanly unlinked row from an ACTIVE account moves.
        if (existing.unlinkedAt === null || existing.user.status !== 'ACTIVE') {
          throw fail('conflict', 'Cfx.re account belongs to another user');
        }
      }
      if (mine !== null) throw fail('already-linked', 'user has a different Cfx.re account');

      const now = new Date();
      const fields = {
        userId,
        label: username,
        isPrimary: true,
        linkedVia: 'CFX' as const,
        verifiedAt: now,
        unlinkedAt: null,
      };
      let linked: GameIdentity;
      if (existing === null) {
        // A concurrent link of the same id loses on the unique index, not by
        // silently overwriting the winner.
        linked = await tx.gameIdentity
          .create({ data: { ...fields, kind: 'FIVEM', value: cfxId, linkedAt: now } })
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) throw fail('conflict', 'concurrent link');
            throw error;
          });
      } else {
        // Guarded so a row re-linked by its owner in the meantime is not taken.
        const updated = await tx.gameIdentity.updateMany({
          where: { id: existing.id, OR: [{ userId }, { unlinkedAt: { not: null } }] },
          data: {
            ...fields,
            linkedAt:
              existing.userId === userId && existing.unlinkedAt === null ? existing.linkedAt : now,
          },
        });
        if (updated.count === 0) throw fail('conflict', 'row changed concurrently');
        linked = await tx.gameIdentity.findUniqueOrThrow({ where: { id: existing.id } });
      }

      const owner = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { publicId: true, discordAccount: { select: { discordId: true } } },
      });
      await recordAudit(tx, actor, {
        action: 'game_identity.cfx_linked',
        entityType: 'user',
        entityId: userId,
        entityLabel: owner.publicId,
        after: { kind: 'FIVEM', cfxUserId: cfxId, cfxUsername: username, via: 'CFX' },
        metadata: { attemptId: attempt.id },
      });
      await emitIntegrationEvent(tx, {
        type: 'PLAYER_IDENTITY_LINKED',
        payload: {
          playerPublicId: owner.publicId,
          discordId: eventDiscordId(owner.discordAccount?.discordId),
          kinds: ['FIVEM'],
          via: 'CFX',
        },
        idempotencyKey: `cfx_link:${attempt.id}`,
        source: 'WEB',
      });
      // Game servers learn the new identifier with the next whitelist push.
      await enqueueDurable('fivem.whitelist.sync', { userId, reason: 'cfx.linked' }, { db: tx });
      await tx.cfxLinkAttempt.update({
        where: { id: attempt.id },
        data: { outcome: 'LINKED', cfxUserId: cfxId, privateKeyEnc: null },
      });
      return linked;
    });
  } catch (error) {
    await finish(db, attempt.id, error instanceof CfxLinkError ? 'CONFLICT' : 'ERROR', cfxId);
    throw error;
  }

  const notification = await createNotification(db, {
    userId,
    ...notificationCopy.accountLinked(`Cfx.re account ${username}`),
  });
  await dispatchPending([notification]);
  await refreshOnboardingStep(db, userId);

  return { identity, username };
}

/** Abandon the player's outstanding attempt (they pressed Cancel). */
export async function cancelCfxLink(db: Db, actor: Actor): Promise<void> {
  const userId = requireUser(actor);
  await db.cfxLinkAttempt.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date(), outcome: 'CANCELLED', privateKeyEnc: null },
  });
}

/** Remove the player's verified Cfx.re link. The row is kept, marked unlinked, for audit. */
export async function unlinkCfxAccount(db: Db, actor: Actor): Promise<void> {
  const userId = requireUser(actor);
  await enforceRateLimit('cfxLinkStart', userId);
  await transaction(db, async (tx) => {
    await requireActiveForUnlink(tx, userId);
    const identity = await tx.gameIdentity.findFirst({
      where: { userId, kind: 'FIVEM', unlinkedAt: null },
    });
    if (identity === null) {
      throw new ConflictError('No Cfx.re link', 'There is no Cfx.re account linked to remove.');
    }
    await tx.gameIdentity.update({
      where: { id: identity.id },
      data: { unlinkedAt: new Date(), isPrimary: false },
    });
    await recordAudit(tx, actor, {
      action: 'game_identity.cfx_unlinked',
      entityType: 'user',
      entityId: userId,
      before: { kind: 'FIVEM', cfxUserId: identity.value, cfxUsername: identity.label },
    });
    await enqueueDurable('fivem.whitelist.sync', { userId, reason: 'cfx.unlinked' }, { db: tx });
  });
  await refreshOnboardingStep(db, userId);
}

export interface CfxConnection {
  readonly linked: boolean;
  readonly cfxUserId: string | null;
  readonly username: string | null;
  readonly linkedAt: Date | null;
  readonly verifiedAt: Date | null;
  /** True when the link came from the website authorization rather than older flows. */
  readonly verifiedOnWebsite: boolean;
}

/** The player's Cfx.re connection, for their own account page. */
export async function cfxConnection(db: Db, userId: string): Promise<CfxConnection> {
  const identity = await db.gameIdentity.findFirst({
    where: { userId, kind: 'FIVEM', unlinkedAt: null },
    orderBy: { linkedAt: 'desc' },
  });
  return {
    linked: identity !== null,
    cfxUserId: identity?.value ?? null,
    username: identity?.label ?? null,
    linkedAt: identity?.linkedAt ?? null,
    verifiedAt: identity?.verifiedAt ?? null,
    verifiedOnWebsite: identity?.linkedVia === 'CFX',
  };
}

/** Delete finished attempts. Called by the maintenance sweep. */
export async function pruneCfxLinkAttempts(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await db.cfxLinkAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  // Unfinished attempts past their expiry lose their key immediately.
  await db.cfxLinkAttempt.updateMany({
    where: { expiresAt: { lt: new Date() }, privateKeyEnc: { not: null } },
    data: { privateKeyEnc: null, outcome: 'EXPIRED', consumedAt: new Date() },
  });
  return result.count;
}

/** When the player's outstanding attempt expires, or null when none is live. */
export async function pendingCfxLink(db: Db, userId: string): Promise<Date | null> {
  const attempt = await db.cfxLinkAttempt.findFirst({
    where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { expiresAt: true },
  });
  return attempt?.expiresAt ?? null;
}

const LICENCE = /^[0-9a-f]{40}$/;

/**
 * Staff exception for a player whose FiveM client cannot report a Cfx.re
 * identifier: bind their Rockstar licence (as shown in txAdmin or the server
 * console, without the `license:` prefix) to their Xenon account. Requires
 * `players.manage`, a reason, and is audited. It admits in both admission
 * modes, so it is deliberately not self-service.
 */
export async function grantLicenceException(
  db: Db,
  actor: Actor,
  input: { readonly userPublicId: string; readonly licence: string; readonly reason: string },
): Promise<GameIdentity> {
  requirePermission(actor, 'players.manage');
  const licence = input.licence
    .trim()
    .toLowerCase()
    .replace(/^license:/, '');
  if (!LICENCE.test(licence)) {
    throw new ValidationError({ licence: ['Expected a 40-character Rockstar licence.'] });
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new ValidationError({ reason: ['Explain why the exception is needed.'] });
  }

  return transaction(db, async (tx) => {
    const user = await tx.user.findUnique({
      where: { publicId: input.userPublicId },
      select: { id: true, publicId: true },
    });
    if (user === null) throw new NotFoundError('User', input.userPublicId);

    const existing = await tx.gameIdentity.findUnique({
      where: { kind_value: { kind: 'LICENSE', value: licence } },
    });
    if (existing !== null && existing.userId !== user.id && existing.unlinkedAt === null) {
      throw new ConflictError(
        'Licence linked to another account',
        'That licence is already linked to another Xenon account.',
      );
    }

    const fields = { userId: user.id, linkedVia: 'STAFF' as const, unlinkedAt: null };
    let identity: GameIdentity;
    if (existing === null) {
      identity = await tx.gameIdentity
        .create({ data: { ...fields, kind: 'LICENSE', value: licence } })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new ConflictError('Licence linked concurrently', 'Try again in a moment.');
          }
          throw error;
        });
    } else {
      const updated = await tx.gameIdentity.updateMany({
        where: { id: existing.id, OR: [{ userId: user.id }, { unlinkedAt: { not: null } }] },
        data: { ...fields, linkedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ConflictError('Licence changed concurrently', 'Try again in a moment.');
      }
      identity = await tx.gameIdentity.findUniqueOrThrow({ where: { id: existing.id } });
    }
    await recordAudit(tx, actor, {
      action: 'game_identity.licence_exception',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.publicId,
      after: { kind: 'LICENSE', via: 'STAFF', reason },
    });
    await enqueueDurable(
      'fivem.whitelist.sync',
      { userId: user.id, reason: 'licence.exception' },
      { db: tx },
    );
    return identity;
  });
}

/**
 * Staff removal of a player's Cfx.re link (`players.manage`, with a reason).
 * The recovery path when a link is disputed - for example a player reports
 * that someone else linked their Cfx.re account - so the rightful owner can
 * verify it again. Audited; the row is kept, marked unlinked.
 */
export async function staffUnlinkCfx(
  db: Db,
  actor: Actor,
  input: { readonly userPublicId: string; readonly reason: string },
): Promise<void> {
  requirePermission(actor, 'players.manage');
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new ValidationError({ reason: ['Explain why the link is being removed.'] });
  }
  const userId = await transaction(db, async (tx) => {
    const user = await tx.user.findUnique({
      where: { publicId: input.userPublicId },
      select: { id: true, publicId: true },
    });
    if (user === null) throw new NotFoundError('User', input.userPublicId);
    const identity = await tx.gameIdentity.findFirst({
      where: { userId: user.id, kind: 'FIVEM', unlinkedAt: null },
    });
    if (identity === null) {
      throw new ConflictError('No Cfx.re link', 'That player has no Cfx.re account linked.');
    }
    await tx.gameIdentity.update({
      where: { id: identity.id },
      data: { unlinkedAt: new Date(), isPrimary: false },
    });
    await recordAudit(tx, actor, {
      action: 'game_identity.cfx_unlinked_by_staff',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.publicId,
      before: { kind: 'FIVEM', cfxUserId: identity.value, cfxUsername: identity.label },
      after: { reason },
    });
    await enqueueDurable(
      'fivem.whitelist.sync',
      { userId: user.id, reason: 'cfx.unlinked_by_staff' },
      { db: tx },
    );
    return user.id;
  });
  await refreshOnboardingStep(db, userId);
}
