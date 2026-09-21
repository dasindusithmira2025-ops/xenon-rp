'use server';

import { revalidatePath } from 'next/cache';

import {
  archiveTemplate,
  deleteQuestion,
  deleteSection,
  deleteTemplate,
  reorderQuestions,
  reorderSections,
  upsertQuestion,
  upsertSection,
  upsertTemplate,
} from '@xenon/applications';
import { prisma } from '@xenon/database';
import { cuid, questionInput, reorderInput, sectionInput, templateInput } from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { currentActor } from '~/server/context';

/**
 * Form builder actions.
 *
 * Application types are rows. Adding a department intake with fourteen
 * questions, three of them conditional, happens entirely through these and
 * never through a deploy.
 */

function refresh(slug?: string): void {
  revalidatePath('/control/applications/templates');
  if (slug !== undefined) revalidatePath(`/control/applications/templates/${slug}`);
  revalidatePath('/applications');
}

export async function saveTemplateAction(
  raw: unknown,
  templateId?: string,
): Promise<ActionResult<{ slug: string }>> {
  return runAction(async () => {
    const input = parseInput(templateInput, raw);
    const actor = await currentActor();

    const template = await upsertTemplate(prisma, actor, input, templateId);
    refresh(template.slug);
    return { slug: template.slug };
  });
}

export async function archiveTemplateAction(templateId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, templateId);
    const actor = await currentActor();

    await archiveTemplate(prisma, actor, id);
    refresh();
  });
}

export async function deleteTemplateAction(templateId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, templateId);
    const actor = await currentActor();

    // Refuses when submissions exist; archiving is the correct move there.
    await deleteTemplate(prisma, actor, id);
    refresh();
  });
}

export async function saveSectionAction(
  raw: unknown,
  sectionId?: string,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const input = parseInput(sectionInput, raw);
    const actor = await currentActor();

    const section = await upsertSection(prisma, actor, input, sectionId);
    refresh();
    return { id: section.id };
  });
}

export async function deleteSectionAction(sectionId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, sectionId);
    const actor = await currentActor();

    await deleteSection(prisma, actor, id);
    refresh();
  });
}

export async function saveQuestionAction(
  raw: unknown,
  questionId?: string,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const input = parseInput(questionInput, raw);
    const actor = await currentActor();

    const question = await upsertQuestion(prisma, actor, input, questionId);
    refresh();
    return { id: question.id };
  });
}

export async function deleteQuestionAction(questionId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, questionId);
    const actor = await currentActor();

    // Refuses when answers exist. Hiding it behind a condition keeps the
    // applicants' answers intact, which deleting would not.
    await deleteQuestion(prisma, actor, id);
    refresh();
  });
}

export async function reorderQuestionsAction(orderedIds: readonly string[]): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(reorderInput, { ids: orderedIds });
    const actor = await currentActor();

    await reorderQuestions(prisma, actor, input.ids);
    refresh();
  });
}

export async function reorderSectionsAction(orderedIds: readonly string[]): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(reorderInput, { ids: orderedIds });
    const actor = await currentActor();

    await reorderSections(prisma, actor, input.ids);
    refresh();
  });
}
