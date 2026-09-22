import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuildRolePort } from '@xenon/discord';
import type * as Jobs from '@xenon/jobs';

/**
 * What happens when the things Xenon does not control stop working.
 *
 * Every test here asserts the same property from a different direction:
 * PostgreSQL is the source of truth, and Discord, FXServer and Redis are
 * projections of it. A projection being unavailable may delay a coloured name
 * or a review card. It may never revert a decision a human made, and it may
 * never be the reason a committed approval is not honoured.
 *
 * The job queue is dead for this entire file. That is the point: every
 * assertion below is made in a world where nothing can be scheduled, so a code
 * path that quietly depends on the queue succeeding fails here.
 */

const queue = vi.hoisted(() => ({ enqueued: [] as string[] }));

vi.mock('@xenon/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof Jobs>();

  return {
    ...actual,
    // Rate limiting stays real: it is Redis too, and it already fails open.
    enqueue: () => {
      throw new Error('ECONNREFUSED 127.0.0.1:6389');
    },
    enqueueBestEffort: (name: string) => {
      queue.enqueued.push(name);
      // Exactly what the real function does when the queue is unreachable:
      // records the failure and reports it, without throwing.
      return Promise.resolve(false);
    },
  };
});

const { approveApplication, autosave, startApplication, submitApplication } =
  await import('@xenon/applications');
const { ConflictError } = await import('@xenon/core');
const { syncUserRoles } = await import('@xenon/discord');
const { assignRole } = await import('@xenon/domain');
const {
  issueLinkCode,
  NONCE_HEADER,
  redeemLinkCode,
  SIGNATURE_HEADER,
  signRequest,
  TIMESTAMP_HEADER,
  verifyRequest,
} = await import('@xenon/fivem');

const {
  actorFor,
  createActor,
  createTemplate,
  createUser,
  fillRequiredAnswers,
  prisma,
  resetDatabase,
} = await import('./harness');

beforeEach(async () => {
  queue.enqueued = [];
  await resetDatabase();
});

describe('Discord unavailable', () => {
  it('does not revert an approval when nothing can be enqueued', async () => {
    const template = await createTemplate({ grantsWhitelist: true });
    const { user: applicant, actor: applicantActor } = await createActor();
    const { actor: reviewer } = await createActor({ roleKeys: ['reviewer'] });

    const draft = await startApplication(prisma, applicantActor, template.slug);
    await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: 0,
      answers: await fillRequiredAnswers(prisma, draft.id),
    });
    await submitApplication(prisma, applicantActor, draft.id);

    await approveApplication(prisma, reviewer, { reference: draft.publicId });

    // The decision and everything it confers survived intact.
    const approved = await prisma.applicationSubmission.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(approved.status).toBe('APPROVED');

    const whitelist = await prisma.whitelist.findUnique({ where: { userId: applicant.id } });
    expect(whitelist?.state).toBe('APPROVED');

    // The audit trail records it, so the outage is visible afterwards rather
    // than being something that simply never happened.
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: draft.id, action: 'application.approved' },
    });
    expect(audit).not.toBeNull();

    // And the side effects were attempted, so the reconciliation sweep has
    // something to find. An approval that never tried to sync is a bug of a
    // different kind.
    expect(queue.enqueued).toContain('discord.role.sync');
    expect(queue.enqueued).toContain('fivem.whitelist.sync');
  });

  it('still notifies the applicant in Xenon when Discord cannot be reached', async () => {
    const template = await createTemplate();
    const { user: applicant, actor: applicantActor } = await createActor();
    const { actor: reviewer } = await createActor({ roleKeys: ['reviewer'] });

    const draft = await startApplication(prisma, applicantActor, template.slug);
    await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: 0,
      answers: await fillRequiredAnswers(prisma, draft.id),
    });
    await submitApplication(prisma, applicantActor, draft.id);
    await approveApplication(prisma, reviewer, { reference: draft.publicId });

    // The DM is a projection; the portal notification is the record. A player
    // with DMs closed, or a Discord outage, must not mean nobody was told.
    const notifications = await prisma.notification.findMany({ where: { userId: applicant.id } });
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('reports a missing guild member without failing the sync', async () => {
    const user = await createUser();

    const guild = await prisma.discordGuild.create({
      data: { guildId: '900000000000000001', name: 'Fixture guild', isPrimary: true },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'member' } });
    await prisma.discordRoleMapping.create({
      data: {
        guildId: guild.id,
        roleId: role.id,
        discordRoleId: '900000000000000002',
        syncToDiscord: true,
      },
    });

    const port: GuildRolePort = {
      // Left the guild, or never joined.
      memberRoles: () => Promise.resolve(null),
      addRole: () => Promise.reject(new Error('should not be called')),
      removeRole: () => Promise.reject(new Error('should not be called')),
      canManageRole: () =>
        Promise.resolve({ roleFound: true, hierarchyBlocked: false, manageRolesMissing: false }),
    };

    const outcome = await syncUserRoles(prisma, port, user.id);

    expect(outcome.memberMissing).toBe(true);
    expect(outcome.applied).toBe(false);
    expect(outcome.errors).toContain('Member is not in the guild');

    // The Xenon role is untouched: leaving the Discord does not take away what
    // the database says the account holds.
    expect(await prisma.userRole.count({ where: { userId: user.id } })).toBe(1);
  });

  it('records a hierarchy block as a setup problem instead of hammering the API', async () => {
    const user = await createUser();

    const guild = await prisma.discordGuild.create({
      data: { guildId: '900000000000000001', name: 'Fixture guild', isPrimary: true },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'member' } });
    const mapping = await prisma.discordRoleMapping.create({
      data: {
        guildId: guild.id,
        roleId: role.id,
        discordRoleId: '900000000000000002',
        syncToDiscord: true,
      },
    });

    const addRole = vi.fn(() => Promise.resolve());
    const port: GuildRolePort = {
      memberRoles: () => Promise.resolve([]),
      addRole,
      removeRole: () => Promise.resolve(),
      // The bot's own role sits below the role it is asked to grant.
      canManageRole: () =>
        Promise.resolve({ roleFound: true, hierarchyBlocked: true, manageRolesMissing: false }),
    };

    const outcome = await syncUserRoles(prisma, port, user.id);

    expect(outcome.blocked).toEqual(['900000000000000002']);
    expect(addRole).not.toHaveBeenCalled();

    const stored = await prisma.discordRoleMapping.findUniqueOrThrow({ where: { id: mapping.id } });
    expect(stored.hierarchyBlocked).toBe(true);
    expect(stored.lastError).toContain('below');
  });

  it('leaves community roles Xenon knows nothing about alone', async () => {
    const user = await createUser();

    const guild = await prisma.discordGuild.create({
      data: { guildId: '900000000000000001', name: 'Fixture guild', isPrimary: true },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'member' } });
    await prisma.discordRoleMapping.create({
      data: {
        guildId: guild.id,
        roleId: role.id,
        discordRoleId: '900000000000000002',
        syncToDiscord: true,
      },
    });

    const removeRole = vi.fn(() => Promise.resolve());
    const port: GuildRolePort = {
      // An unmapped colour role and a pingable event role.
      memberRoles: () => Promise.resolve(['900000000000000777', '900000000000000888']),
      addRole: () => Promise.resolve(),
      removeRole,
      canManageRole: () =>
        Promise.resolve({ roleFound: true, hierarchyBlocked: false, manageRolesMissing: false }),
    };

    await syncUserRoles(prisma, port, user.id);

    expect(removeRole).not.toHaveBeenCalled();
  });
});

describe('role authority', () => {
  it('refuses to let staff assign a role at or above their own rank', async () => {
    // Administrator holds staff.manage, so this is stopped by rank alone and
    // not by a missing capability - which is the guard under test.
    const { actor: administrator } = await createActor({ roleKeys: ['administrator'] });
    const target = await createUser();
    const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } });

    await expect(
      assignRole(prisma, administrator, { userId: target.id, roleId: owner.id }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(
      await prisma.userRole.findFirst({ where: { userId: target.id, roleId: owner.id } }),
    ).toBeNull();
  });

  it('refuses role management from staff without the staff.manage capability', async () => {
    const { actor: moderator } = await createActor({ roleKeys: ['moderator'] });
    const target = await createUser();
    const support = await prisma.role.findUniqueOrThrow({ where: { key: 'support' } });

    await expect(
      assignRole(prisma, moderator, { userId: target.id, roleId: support.id }),
    ).rejects.toThrow(/Missing required capability/);
  });

  it('refuses to let staff grant a capability they do not hold themselves', async () => {
    // Give Support the ability to manage staff, and nothing else new. It still
    // holds no content capability, and content_editor sits below it by
    // priority - so only the capability guard can stop this.
    const supportRole = await prisma.role.findUniqueOrThrow({ where: { key: 'support' } });
    const staffManage = await prisma.permission.findUniqueOrThrow({
      where: { key: 'staff.manage' },
    });
    await prisma.rolePermission.create({
      data: { roleId: supportRole.id, permissionId: staffManage.id },
    });

    const user = await createUser({ roleKeys: ['support'] });
    const support = await actorFor(user);
    expect(support.permissions.has('staff.manage')).toBe(true);
    expect(support.permissions.has('content.edit')).toBe(false);

    const target = await createUser();
    const contentEditor = await prisma.role.findUniqueOrThrow({ where: { key: 'content_editor' } });

    await expect(
      assignRole(prisma, support, { userId: target.id, roleId: contentEditor.id }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(
      await prisma.userRole.findFirst({ where: { userId: target.id, roleId: contentEditor.id } }),
    ).toBeNull();
  });
});

describe('FiveM link codes', () => {
  const identifiers = [
    { kind: 'LICENSE' as const, value: 'fixture-license-0001' },
    { kind: 'STEAM' as const, value: '110000100000001' },
  ];

  it('links an account when the code and the identifiers arrive together', async () => {
    const { user, actor } = await createActor();
    const issued = await issueLinkCode(prisma, actor);

    const result = await redeemLinkCode(prisma, {
      code: issued.code,
      identifiers,
      playerName: 'Fixture Player',
    });

    expect(result.userId).toBe(user.id);
    expect(result.identities).toHaveLength(2);

    const stored = await prisma.gameIdentity.findMany({ where: { userId: user.id } });
    expect(stored.map((row) => row.kind).sort()).toEqual(['LICENSE', 'STEAM']);
    expect(stored.find((row) => row.kind === 'LICENSE')?.isPrimary).toBe(true);
  });

  it('refuses a code that has already been redeemed', async () => {
    const { actor } = await createActor();
    const issued = await issueLinkCode(prisma, actor);

    await redeemLinkCode(prisma, { code: issued.code, identifiers });

    await expect(redeemLinkCode(prisma, { code: issued.code, identifiers })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses an expired code', async () => {
    const { actor } = await createActor();
    const issued = await issueLinkCode(prisma, actor);

    await prisma.linkToken.updateMany({
      where: { consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(redeemLinkCode(prisma, { code: issued.code, identifiers })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses an unknown code with the same message as a spent one', async () => {
    // Same user-facing text as expiry and reuse: distinguishing them would
    // turn this endpoint into an oracle for guessing live codes.
    await expect(redeemLinkCode(prisma, { code: 'XEN-ZZZZZ', identifiers })).rejects.toThrow(
      ConflictError,
    );
    await expect(redeemLinkCode(prisma, { code: 'XEN-YYYYY', identifiers })).rejects.toHaveProperty(
      'safeMessage',
      expect.stringContaining('not valid'),
    );
  });

  it('refuses to move an identifier that already belongs to another account', async () => {
    const { actor: first } = await createActor();
    const firstCode = await issueLinkCode(prisma, first);
    await redeemLinkCode(prisma, { code: firstCode.code, identifiers });

    const { actor: second } = await createActor();
    const secondCode = await issueLinkCode(prisma, second);

    await expect(
      redeemLinkCode(prisma, { code: secondCode.code, identifiers }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('issues one live code at a time, revoking the previous one', async () => {
    const { user, actor } = await createActor();

    const first = await issueLinkCode(prisma, actor);
    const second = await issueLinkCode(prisma, actor);
    expect(second.code).not.toBe(first.code);

    expect(
      await prisma.linkToken.count({
        where: { userId: user.id, consumedAt: null, revokedAt: null },
      }),
    ).toBe(1);

    await expect(redeemLinkCode(prisma, { code: first.code, identifiers })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('never stores the code itself', async () => {
    const { actor } = await createActor();
    const issued = await issueLinkCode(prisma, actor);

    const tokens = await prisma.linkToken.findMany();
    expect(tokens).toHaveLength(1);
    expect(JSON.stringify(tokens)).not.toContain(issued.code);

    // Nor does the audit entry that records the issue.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'link_token.issued' },
    });
    expect(JSON.stringify(audit)).not.toContain(issued.code);
  });
});

describe('bridge request signing', () => {
  const secret = 'fixture-bridge-secret-at-least-32-characters';
  const body = JSON.stringify({ identifiers: [{ kind: 'LICENSE', value: 'abc' }] });

  function headersOf(signed: ReturnType<typeof signRequest>) {
    return {
      signature: signed[SIGNATURE_HEADER],
      timestamp: signed[TIMESTAMP_HEADER],
      nonce: signed[NONCE_HEADER],
    };
  }

  it('accepts a request the bridge signed', () => {
    const signed = signRequest(secret, body);
    expect(verifyRequest(secret, body, headersOf(signed)).ok).toBe(true);
  });

  it('refuses a request whose body was altered in transit', () => {
    const signed = signRequest(secret, body);
    const tampered = JSON.stringify({ identifiers: [{ kind: 'LICENSE', value: 'someone-else' }] });

    expect(verifyRequest(secret, tampered, headersOf(signed)).ok).toBe(false);
  });

  it('refuses a request signed with the wrong secret', () => {
    const signed = signRequest('a-different-secret-entirely-abcdefgh', body);
    expect(verifyRequest(secret, body, headersOf(signed)).ok).toBe(false);
  });

  it('refuses a captured request once its timestamp has aged out', () => {
    const signed = signRequest(secret, body);
    const sixMinutesLater = Date.now() + 6 * 60_000;

    expect(verifyRequest(secret, body, headersOf(signed), sixMinutesLater)).toMatchObject({
      ok: false,
      reason: 'stale',
    });
  });

  it('refuses a request with no signature at all', () => {
    expect(
      verifyRequest(secret, body, { signature: null, timestamp: null, nonce: null }),
    ).toMatchObject({ ok: false, reason: 'missing' });
  });
});
