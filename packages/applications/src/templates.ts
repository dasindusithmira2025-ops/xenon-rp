import { ConflictError, NotFoundError } from '@xenon/core';
import type {
  ApplicationQuestion,
  ApplicationSection,
  ApplicationTemplate,
  Db,
} from '@xenon/database';
import { recordAudit, setting } from '@xenon/domain';
import { type Actor, requirePermission } from '@xenon/permissions';
import type { QuestionInput, TemplateInput } from '@xenon/validation';

import { checkEligibility, templateOpenState } from './eligibility';

/**
 * The form builder.
 *
 * Application types are rows, not React components. Adding a DOJ intake with
 * fourteen questions, three of them conditional, is an afternoon in /control
 * and no deploy at all - which is the difference between a platform staff can
 * run and one they have to file tickets against.
 */

export async function listTemplatesForStaff(db: Db) {
  return db.applicationTemplate.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      department: { select: { name: true, slug: true } },
      _count: { select: { submissions: true, sections: true } },
    },
  });
}

/** One template with its whole question tree, for the builder screen. */
export async function getTemplateTree(db: Db, slugOrId: string) {
  const template = await db.applicationTemplate.findFirst({
    where: { OR: [{ slug: slugOrId }, { id: slugOrId }] },
    include: {
      department: { select: { id: true, name: true } },
      sections: {
        orderBy: { sortOrder: 'asc' },
        include: {
          questions: {
            orderBy: { sortOrder: 'asc' },
            include: { options: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      },
    },
  });

  if (template === null) throw new NotFoundError('ApplicationTemplate', slugOrId);
  return template;
}

export async function upsertTemplate(
  db: Db,
  actor: Actor,
  input: TemplateInput,
  templateId?: string,
): Promise<ApplicationTemplate> {
  requirePermission(actor, 'applications.manage_templates');

  const data = {
    slug: input.slug,
    name: input.name,
    summary: input.summary ?? null,
    description: input.description ?? null,
    publicIdPrefix: input.publicIdPrefix,
    departmentId: input.departmentId ?? null,
    status: input.status,
    opensAt: input.opensAt ?? null,
    closesAt: input.closesAt ?? null,
    minimumAccountAgeDays: input.minimumAccountAgeDays,
    requiresGuildMember: input.requiresGuildMember,
    requiresFivemLink: input.requiresFivemLink,
    requiresRulesAccepted: input.requiresRulesAccepted,
    requiresCharacter: input.requiresCharacter,
    requiredRoleKeys: input.requiredRoleKeys,
    blockedRoleKeys: input.blockedRoleKeys,
    rejectionCooldownDays: input.rejectionCooldownDays,
    maxConcurrent: input.maxConcurrent,
    interviewRequired: input.interviewRequired,
    allowResubmission: input.allowResubmission,
    autoAssignReviewer: input.autoAssignReviewer,
    expiryDays: input.expiryDays,
    reviewChannelId: input.reviewChannelId ?? null,
    notifyRoleId: input.notifyRoleId ?? null,
    grantRoleKeys: input.grantRoleKeys,
    grantsWhitelist: input.grantsWhitelist,
    sortOrder: input.sortOrder,
  };

  // Publishing an empty form would show applicants a page with a submit button
  // and nothing above it.
  if (input.status === 'OPEN' && templateId !== undefined) {
    const questionCount = await db.applicationQuestion.count({
      where: { section: { templateId } },
    });
    if (questionCount === 0) {
      throw new ConflictError(
        'Template has no questions',
        'Add at least one question before opening this application.',
      );
    }
  }

  const template =
    templateId === undefined
      ? await db.applicationTemplate.create({ data })
      : await db.applicationTemplate.update({ where: { id: templateId }, data });

  await recordAudit(db, actor, {
    action: templateId === undefined ? 'template.created' : 'template.updated',
    entityType: 'application_template',
    entityId: template.id,
    entityLabel: template.slug,
    after: { name: template.name, status: template.status },
  });

  return template;
}

/**
 * Archive rather than delete once a template has submissions.
 *
 * Deleting would cascade away every application ever made through it, along
 * with the answers an appeal might later depend on.
 */
export async function archiveTemplate(
  db: Db,
  actor: Actor,
  templateId: string,
): Promise<ApplicationTemplate> {
  requirePermission(actor, 'applications.manage_templates');

  const template = await db.applicationTemplate.update({
    where: { id: templateId },
    data: { status: 'ARCHIVED', archivedAt: new Date() },
  });

  await recordAudit(db, actor, {
    action: 'template.archived',
    entityType: 'application_template',
    entityId: templateId,
    entityLabel: template.slug,
  });

  return template;
}

export async function deleteTemplate(db: Db, actor: Actor, templateId: string): Promise<void> {
  requirePermission(actor, 'applications.manage_templates');

  const submissions = await db.applicationSubmission.count({ where: { templateId } });
  if (submissions > 0) {
    throw new ConflictError(
      'Template has submissions',
      'This template has applications against it. Archive it instead of deleting.',
    );
  }

  const template = await db.applicationTemplate.findUnique({ where: { id: templateId } });
  if (template === null) throw new NotFoundError('ApplicationTemplate', templateId);

  await db.applicationTemplate.delete({ where: { id: templateId } });
  await recordAudit(db, actor, {
    action: 'template.deleted',
    entityType: 'application_template',
    entityId: templateId,
    entityLabel: template.slug,
  });
}

// --- Sections ----------------------------------------------------------------

export async function upsertSection(
  db: Db,
  actor: Actor,
  input: { templateId: string; title: string; description?: string | undefined; sortOrder: number },
  sectionId?: string,
): Promise<ApplicationSection> {
  requirePermission(actor, 'applications.manage_templates');

  const data = {
    templateId: input.templateId,
    title: input.title,
    description: input.description ?? null,
    sortOrder: input.sortOrder,
  };

  return sectionId === undefined
    ? db.applicationSection.create({ data })
    : db.applicationSection.update({ where: { id: sectionId }, data });
}

export async function deleteSection(db: Db, actor: Actor, sectionId: string): Promise<void> {
  requirePermission(actor, 'applications.manage_templates');
  await db.applicationSection.delete({ where: { id: sectionId } });
}

// --- Questions ---------------------------------------------------------------

/**
 * Create or update a question and its options.
 *
 * `key` is the stable identity that answers point at, so changing it on a
 * question that already has answers would orphan them. The builder UI keeps the
 * key read-only after creation, and this refuses it too - a rule enforced only
 * in the UI is not enforced.
 */
export async function upsertQuestion(
  db: Db,
  actor: Actor,
  input: QuestionInput,
  questionId?: string,
): Promise<ApplicationQuestion> {
  requirePermission(actor, 'applications.manage_templates');

  if (questionId !== undefined) {
    const existing = await db.applicationQuestion.findUnique({
      where: { id: questionId },
      select: { key: true, _count: { select: { answers: true } } },
    });
    if (existing !== null && existing.key !== input.key && existing._count.answers > 0) {
      throw new ConflictError(
        'Question key change with existing answers',
        'This question already has answers, so its key cannot change. Create a new question instead.',
      );
    }
  }

  const data = {
    sectionId: input.sectionId,
    key: input.key,
    type: input.type,
    label: input.label,
    helpText: input.helpText ?? null,
    placeholder: input.placeholder ?? null,
    required: input.required,
    sortOrder: input.sortOrder,
    minLength: input.minLength ?? null,
    maxLength: input.maxLength ?? null,
    minValue: input.minValue ?? null,
    maxValue: input.maxValue ?? null,
    pattern: input.pattern ?? null,
    staffOnly: input.staffOnly,
    visibleWhenQuestionKey: input.visibleWhenQuestionKey ?? null,
    visibleWhenOperator: input.visibleWhenOperator ?? null,
    visibleWhenValue: input.visibleWhenValue ?? null,
    maxFiles: input.maxFiles ?? null,
    maxFileSizeBytes: input.maxFileSizeBytes ?? null,
    allowedMimeTypes: input.allowedMimeTypes,
  };

  const question =
    questionId === undefined
      ? await db.applicationQuestion.create({ data })
      : await db.applicationQuestion.update({ where: { id: questionId }, data });

  // Options are replaced wholesale. They are pure configuration with no rows
  // pointing at them, so a diff would be complexity for nothing.
  await db.applicationQuestionOption.deleteMany({ where: { questionId: question.id } });
  if (input.options.length > 0) {
    await db.applicationQuestionOption.createMany({
      data: input.options.map((option, index) => ({
        questionId: question.id,
        value: option.value,
        label: option.label,
        helpText: option.helpText ?? null,
        sortOrder: index,
      })),
    });
  }

  await recordAudit(db, actor, {
    action: questionId === undefined ? 'question.created' : 'question.updated',
    entityType: 'application_question',
    entityId: question.id,
    entityLabel: question.key,
    after: { label: question.label, type: question.type, required: question.required },
  });

  return question;
}

export async function deleteQuestion(db: Db, actor: Actor, questionId: string): Promise<void> {
  requirePermission(actor, 'applications.manage_templates');

  const question = await db.applicationQuestion.findUnique({
    where: { id: questionId },
    select: { key: true, _count: { select: { answers: true } } },
  });
  if (question === null) throw new NotFoundError('ApplicationQuestion', questionId);

  if (question._count.answers > 0) {
    throw new ConflictError(
      'Question has answers',
      'Applicants have already answered this question. Hiding it with a condition keeps their answers intact.',
    );
  }

  await db.applicationQuestion.delete({ where: { id: questionId } });
  await recordAudit(db, actor, {
    action: 'question.deleted',
    entityType: 'application_question',
    entityId: questionId,
    entityLabel: question.key,
  });
}

/** Persist a drag-and-drop reorder. Positions are the array order. */
export async function reorderQuestions(
  db: Db,
  actor: Actor,
  orderedIds: readonly string[],
): Promise<void> {
  requirePermission(actor, 'applications.manage_templates');

  for (const [index, id] of orderedIds.entries()) {
    await db.applicationQuestion.update({ where: { id }, data: { sortOrder: index } });
  }
}

export async function reorderSections(
  db: Db,
  actor: Actor,
  orderedIds: readonly string[],
): Promise<void> {
  requirePermission(actor, 'applications.manage_templates');

  for (const [index, id] of orderedIds.entries()) {
    await db.applicationSection.update({ where: { id }, data: { sortOrder: index } });
  }
}

// --- Public listing ----------------------------------------------------------

export interface PublicTemplateCard {
  readonly slug: string;
  readonly name: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly departmentName: string | null;
  readonly open: boolean;
  readonly closedReason: string | null;
  readonly requiresFivemLink: boolean;
  readonly requiresGuildMember: boolean;
  readonly requiresRulesAccepted: boolean;
  readonly interviewRequired: boolean;
  readonly grantsWhitelist: boolean;
  readonly rejectionCooldownDays: number;
  readonly questionCount: number;
  readonly eligible: boolean | null;
  readonly unmetRequirements: readonly {
    label: string;
    action: string | null;
    href: string | null;
  }[];
}

/**
 * The cards on /applications.
 *
 * Archived and draft templates are excluded at the query, so an unpublished
 * intake is not merely hidden by a CSS class. Eligibility is only computed for
 * a signed-in visitor; for anonymous visitors the card shows requirements
 * without pretending to know whether they are met.
 */
export async function publicTemplates(
  db: Db,
  actor: Actor,
): Promise<readonly PublicTemplateCard[]> {
  const globallyOpen = (await setting(db, 'applications.globallyOpen')) !== 'false';

  const templates = await db.applicationTemplate.findMany({
    where: { status: { in: ['OPEN', 'CLOSED'] } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      department: { select: { name: true } },
      _count: { select: { sections: true } },
      sections: { select: { _count: { select: { questions: true } } } },
    },
  });

  const cards: PublicTemplateCard[] = [];

  for (const template of templates) {
    const openState = templateOpenState(template, globallyOpen);
    const eligibility =
      actor.userId === null
        ? null
        : await checkEligibility(db, template, actor.userId, { globallyOpen });

    cards.push({
      slug: template.slug,
      name: template.name,
      summary: template.summary,
      description: template.description,
      departmentName: template.department?.name ?? null,
      open: openState.open,
      closedReason: openState.reason,
      requiresFivemLink: template.requiresFivemLink,
      requiresGuildMember: template.requiresGuildMember,
      requiresRulesAccepted: template.requiresRulesAccepted,
      interviewRequired: template.interviewRequired,
      grantsWhitelist: template.grantsWhitelist,
      rejectionCooldownDays: template.rejectionCooldownDays,
      questionCount: template.sections.reduce(
        (total, section) => total + section._count.questions,
        0,
      ),
      eligible: eligibility === null ? null : eligibility.eligible,
      unmetRequirements:
        eligibility === null
          ? []
          : eligibility.requirements
              .filter((requirement) => !requirement.met)
              .map((requirement) => ({
                label: requirement.label,
                action: requirement.action,
                href: requirement.href,
              })),
    });
  }

  return cards;
}
