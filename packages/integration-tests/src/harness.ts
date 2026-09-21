import {
  type ApplicationTemplate,
  type Db,
  type Prisma,
  prisma,
  seedBaseline,
  type User,
} from '@xenon/database';
import { ensureUserFromDiscord } from '@xenon/domain';
import { type Actor, resolveActor, systemActor } from '@xenon/permissions';

/**
 * Fixtures for the integration suite.
 *
 * The rule here is that fixtures are built through the same functions the
 * product uses - `ensureUserFromDiscord`, `seedBaseline`, `resolveActor` -
 * rather than by inserting rows directly. A test that hand-builds an actor
 * with the permissions it wants proves nothing about whether those permissions
 * are the ones the role actually grants.
 *
 * Every Discord snowflake below is fictional and starts `9000...`, which is
 * outside the range Discord issues, so fixture data can never collide with a
 * real account.
 */

export { prisma, systemActor };

/** Fictional snowflakes, allocated in order so they are stable within a test. */
let snowflakeCounter = 0;
function nextSnowflake(): string {
  snowflakeCounter += 1;
  return `9000000000000${String(snowflakeCounter).padStart(5, '0')}`;
}

/**
 * Empty every table and rebuild the baseline.
 *
 * Truncate rather than delete-in-order: the schema has enough cycles
 * (submissions reference users, users reference submissions through assignee)
 * that a hand-maintained delete order is a thing that breaks every time
 * somebody adds a relation. Table names are read from the catalogue so the list
 * cannot go stale either.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;

  if (tables.length > 0) {
    const list = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }

  snowflakeCounter = 0;
  await seedBaseline(prisma);
}

export interface TestUserOptions {
  readonly displayName?: string;
  readonly roleKeys?: readonly string[];
  /** Discord guild membership, which several templates require. */
  readonly guildMember?: boolean;
  readonly acceptCurrentRules?: boolean;
}

/** Create an account the way a Discord sign-in would, then add what the test needs. */
export async function createUser(options: TestUserOptions = {}): Promise<User> {
  const discordId = nextSnowflake();
  const username = options.displayName ?? `fixture-${discordId.slice(-4)}`;

  const user = await ensureUserFromDiscord(prisma, {
    discordId,
    username,
    globalName: options.displayName ?? username,
  });

  if (options.guildMember ?? true) {
    await prisma.discordAccount.update({
      where: { userId: user.id },
      data: { isGuildMember: true, guildJoinedAt: new Date() },
    });
  }

  for (const key of options.roleKeys ?? []) {
    await prisma.userRole.create({
      data: { user: { connect: { id: user.id } }, role: { connect: { key } } },
    });
  }

  if (options.acceptCurrentRules ?? false) {
    await acceptCurrentRules(user.id);
  }

  return user;
}

/** Publish a minimal current ruleset and record this user's acceptance of it. */
export async function acceptCurrentRules(userId: string): Promise<void> {
  const ruleSet =
    (await prisma.ruleSet.findFirst({ where: { isCurrent: true } })) ??
    (await prisma.ruleSet.create({
      data: {
        version: 1,
        note: 'Development fixture. Not XenonRP rule text.',
        isCurrent: true,
      },
    }));

  await prisma.ruleAcceptance.upsert({
    where: { userId_ruleSetId: { userId, ruleSetId: ruleSet.id } },
    create: { userId, ruleSetId: ruleSet.id },
    update: {},
  });
}

/** Resolve an actor through the real resolver, so capabilities come from roles. */
export async function actorFor(user: User, source: Actor['source'] = 'WEB'): Promise<Actor> {
  const actor = await resolveActor(prisma, { userId: user.id, source });
  if (actor === null) throw new Error(`No actor resolved for ${user.publicId}`);
  return actor;
}

/** A user holding a role, and the actor for them. The common two-line setup. */
export async function createActor(
  options: TestUserOptions = {},
): Promise<{ user: User; actor: Actor }> {
  const user = await createUser(options);
  return { user, actor: await actorFor(user) };
}

export interface TestTemplateOptions {
  readonly slug?: string;
  readonly name?: string;
  readonly status?: 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED';
  readonly grantsWhitelist?: boolean;
  readonly grantRoleKeys?: readonly string[];
  readonly interviewRequired?: boolean;
  readonly requiresGuildMember?: boolean;
  readonly requiresRulesAccepted?: boolean;
  readonly expiryDays?: number;
  readonly rejectionCooldownDays?: number;
  readonly questions?: readonly Partial<Prisma.ApplicationQuestionCreateWithoutSectionInput>[];
}

/**
 * An open application template with one section.
 *
 * Requirements default to off, because a test about the review workflow should
 * not fail on rule acceptance. The eligibility tests turn them back on
 * explicitly, which is also what makes those tests readable.
 */
export async function createTemplate(
  options: TestTemplateOptions = {},
): Promise<ApplicationTemplate> {
  const slug = options.slug ?? 'fixture-whitelist';

  const questions = options.questions ?? [
    {
      key: 'about_you',
      type: 'LONG_TEXT',
      label: 'Tell us about you',
      required: true,
      minLength: 10,
    },
    { key: 'timezone', type: 'SHORT_TEXT', label: 'Your timezone', required: true },
  ];

  return prisma.applicationTemplate.create({
    data: {
      slug,
      name: options.name ?? 'Fixture whitelist',
      publicIdPrefix: 'WL',
      status: options.status ?? 'OPEN',
      requiresGuildMember: options.requiresGuildMember ?? false,
      requiresRulesAccepted: options.requiresRulesAccepted ?? false,
      grantsWhitelist: options.grantsWhitelist ?? false,
      grantRoleKeys: [...(options.grantRoleKeys ?? [])],
      interviewRequired: options.interviewRequired ?? false,
      expiryDays: options.expiryDays ?? 0,
      rejectionCooldownDays: options.rejectionCooldownDays ?? 0,
      sections: {
        create: [
          {
            title: 'About you',
            sortOrder: 0,
            questions: {
              create: questions.map((question, index) => ({
                key: `q${String(index)}`,
                type: 'SHORT_TEXT',
                label: 'Question',
                sortOrder: index,
                ...question,
              })),
            },
          },
        ],
      },
    },
  });
}

/** Answer every required question with something that passes validation. */
export async function fillRequiredAnswers(
  db: Db,
  submissionId: string,
): Promise<{ questionKey: string; textValue: string }[]> {
  const submission = await db.applicationSubmission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { templateId: true },
  });

  const questions = await db.applicationQuestion.findMany({
    where: { section: { templateId: submission.templateId }, required: true, staffOnly: false },
    select: { key: true, minLength: true },
  });

  return questions.map((question) => ({
    questionKey: question.key,
    textValue: 'Fixture answer. '.repeat(Math.max(1, Math.ceil((question.minLength ?? 1) / 15))),
  }));
}

/** Every audit action recorded, oldest first. Used to assert the trail exists. */
export async function auditActions(entityId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityId },
    orderBy: { createdAt: 'asc' },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}

/** Every application event type recorded for a submission, oldest first. */
export async function eventTypes(submissionId: string): Promise<string[]> {
  const rows = await prisma.applicationEvent.findMany({
    where: { submissionId },
    orderBy: { createdAt: 'asc' },
    select: { type: true },
  });
  return rows.map((row) => row.type);
}
