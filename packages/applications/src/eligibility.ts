import type { ApplicationTemplate, Db } from '@xenon/database';

/**
 * Who may start an application.
 *
 * Every requirement is evaluated against the database, never against something
 * the client sent, and the result is a list of reasons rather than a boolean -
 * the applications page shows exactly what is missing, so a player knows
 * whether to link FiveM or read the rules instead of just seeing a dead button.
 */

export interface EligibilityRequirement {
  readonly key: string;
  readonly label: string;
  readonly met: boolean;
  /** What the applicant should do about it, when unmet. */
  readonly action: string | null;
  readonly href: string | null;
}

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly requirements: readonly EligibilityRequirement[];
  /** Set when the template itself is not accepting, regardless of the user. */
  readonly closedReason: string | null;
  /** Set when a rejection cooldown is still running. */
  readonly availableAt: Date | null;
}

/** Whether the template's own window and status allow new submissions. */
export function templateOpenState(
  template: Pick<ApplicationTemplate, 'status' | 'opensAt' | 'closesAt'>,
  globallyOpen = true,
  now = new Date(),
): { open: boolean; reason: string | null } {
  if (!globallyOpen) {
    return { open: false, reason: 'Applications are paused across the community right now.' };
  }
  if (template.status === 'DRAFT') return { open: false, reason: 'Not yet published.' };
  if (template.status === 'ARCHIVED') return { open: false, reason: 'No longer offered.' };
  if (template.status === 'CLOSED') return { open: false, reason: 'Closed for now.' };
  if (template.opensAt !== null && template.opensAt > now) {
    return { open: false, reason: `Opens ${template.opensAt.toUTCString()}.` };
  }
  if (template.closesAt !== null && template.closesAt < now) {
    return { open: false, reason: 'Applications for this have closed.' };
  }
  return { open: true, reason: null };
}

/**
 * Evaluate a user against a template.
 *
 * Reads everything in one query rather than one per requirement: this runs for
 * every card on /applications, and nine templates should not mean sixty
 * queries.
 */
export async function checkEligibility(
  db: Db,
  template: ApplicationTemplate,
  userId: string | null,
  options: { globallyOpen?: boolean; now?: Date } = {},
): Promise<EligibilityResult> {
  const now = options.now ?? new Date();
  const openState = templateOpenState(template, options.globallyOpen ?? true, now);

  if (userId === null) {
    return {
      eligible: false,
      requirements: [
        {
          key: 'signed_in',
          label: 'Signed in with Discord',
          met: false,
          action: 'Sign in to apply',
          href: '/api/auth/signin',
        },
      ],
      closedReason: openState.reason,
      availableAt: null,
    };
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      createdAt: true,
      status: true,
      discordAccount: { select: { isGuildMember: true, guildJoinedAt: true } },
      gameIdentities: { where: { unlinkedAt: null }, select: { id: true }, take: 1 },
      characters: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
      ruleAcceptances: { select: { ruleSet: { select: { isCurrent: true } } } },
      roles: { select: { role: { select: { key: true } } } },
      submissions: {
        where: { templateId: template.id },
        select: { status: true, decidedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });

  if (user === null) {
    return { eligible: false, requirements: [], closedReason: openState.reason, availableAt: null };
  }

  const roleKeys = new Set(user.roles.map((assignment) => assignment.role.key));
  const requirements: EligibilityRequirement[] = [];

  // A sanctioned account is refused first and without detail; the appeal route
  // is the correct path, not a list of boxes to tick.
  if (user.status !== 'ACTIVE') {
    return {
      eligible: false,
      requirements: [
        {
          key: 'account_standing',
          label: 'Account in good standing',
          met: false,
          action: 'Appeal this decision',
          href: '/portal/appeals',
        },
      ],
      closedReason: openState.reason,
      availableAt: null,
    };
  }

  if (template.requiresGuildMember) {
    requirements.push({
      key: 'guild_member',
      label: 'Member of the Xenon Discord',
      met: user.discordAccount?.isGuildMember ?? false,
      action: 'Join the Discord',
      href: '/portal',
    });
  }

  if (template.minimumAccountAgeDays > 0) {
    const ageDays = (now.getTime() - user.createdAt.getTime()) / 86_400_000;
    requirements.push({
      key: 'account_age',
      label: `Account at least ${String(template.minimumAccountAgeDays)} days old`,
      met: ageDays >= template.minimumAccountAgeDays,
      action: 'Come back in a few days',
      href: null,
    });
  }

  if (template.requiresRulesAccepted) {
    requirements.push({
      key: 'rules',
      label: 'Current rules accepted',
      met: user.ruleAcceptances.some((acceptance) => acceptance.ruleSet.isCurrent),
      action: 'Read and accept the rules',
      href: '/rules',
    });
  }

  if (template.requiresFivemLink) {
    requirements.push({
      key: 'fivem',
      label: 'FiveM account linked',
      met: user.gameIdentities.length > 0,
      action: 'Link your game account',
      href: '/portal/account',
    });
  }

  if (template.requiresCharacter) {
    requirements.push({
      key: 'character',
      label: 'At least one character created',
      met: user.characters.length > 0,
      action: 'Create a character',
      href: '/portal/characters',
    });
  }

  for (const roleKey of template.requiredRoleKeys) {
    requirements.push({
      key: `role:${roleKey}`,
      label: `Holds the ${roleKey} role`,
      met: roleKeys.has(roleKey),
      action: null,
      href: null,
    });
  }

  for (const roleKey of template.blockedRoleKeys) {
    requirements.push({
      key: `not_role:${roleKey}`,
      label: `Not currently ${roleKey}`,
      met: !roleKeys.has(roleKey),
      action: null,
      href: null,
    });
  }

  // Concurrency: an in-flight submission blocks a second one, so the queue is
  // not filled with three copies of the same person's whitelist.
  const inFlight = user.submissions.filter(
    (submission) =>
      submission.status !== 'APPROVED' &&
      submission.status !== 'REJECTED' &&
      submission.status !== 'WITHDRAWN' &&
      submission.status !== 'EXPIRED' &&
      submission.status !== 'ARCHIVED',
  );
  requirements.push({
    key: 'concurrent',
    label:
      template.maxConcurrent === 1
        ? 'No application already in progress'
        : `Fewer than ${String(template.maxConcurrent)} applications in progress`,
    met: inFlight.length < template.maxConcurrent,
    action: 'Open your existing application',
    href: '/portal/applications',
  });

  // An approved application for the same template is not repeatable.
  const approved = user.submissions.some((submission) => submission.status === 'APPROVED');
  if (approved) {
    requirements.push({
      key: 'already_approved',
      label: 'Not already approved',
      met: false,
      action: 'You already hold this',
      href: '/portal',
    });
  }

  // Rejection cooldown.
  let availableAt: Date | null = null;
  if (template.rejectionCooldownDays > 0) {
    const lastRejection = user.submissions.find(
      (submission) => submission.status === 'REJECTED' && submission.decidedAt !== null,
    );
    if (lastRejection?.decidedAt != null) {
      const ready = new Date(
        lastRejection.decidedAt.getTime() + template.rejectionCooldownDays * 86_400_000,
      );
      if (ready > now) {
        availableAt = ready;
        requirements.push({
          key: 'cooldown',
          label: `Cooldown after a previous decision`,
          met: false,
          action: `You can apply again from ${ready.toDateString()}`,
          href: null,
        });
      }
    }
  }

  return {
    eligible: openState.open && requirements.every((requirement) => requirement.met),
    requirements,
    closedReason: openState.reason,
    availableAt,
  };
}
