'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@xenon/database';
import {
  createAnnouncement,
  decideAppeal,
  deleteArticle,
  deleteDepartment,
  deleteRule,
  grantWhitelist,
  publishRuleSet,
  removeRole,
  revokeWhitelist,
  setRolePermissions,
  setSetting,
  setUserStatus,
  updateReport,
  updateTicket,
  upsertArticle,
  upsertDepartment,
  upsertFeatureFlag,
  upsertRule,
  upsertServer,
  assignRole as assignRoleService,
  replyToTicket,
} from '@xenon/domain';
import { requirePermission } from '@xenon/permissions';
import {
  announcementInput,
  appealDecisionInput,
  articleInput,
  assignRoleInput,
  cuid,
  departmentInput,
  featureFlagInput,
  publishRuleSetInput,
  reportUpdateInput,
  rolePermissionsInput,
  ruleInput,
  serverInput,
  ticketReplyInput,
  ticketUpdateInput,
  whitelistDecisionInput,
} from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { currentActor } from '~/server/context';

/**
 * Control centre actions.
 *
 * Note on the explicit `requirePermission` calls below: whitelist and account
 * status are deliberately unchecked inside their services, because
 * `approveApplication` calls them on behalf of a reviewer who holds
 * `applications.approve` but may not hold `players.whitelist`. A direct staff
 * action is a different context and does need the capability, so the check
 * belongs at this boundary.
 *
 * Every one is a transport: parse, resolve the actor, call the shared service.
 * Authorization, audit, notification and queued side effects belong to the
 * services, which is what keeps the website and the Discord bot honest about
 * behaving identically.
 */

// --- Players -----------------------------------------------------------------

export async function grantWhitelistAction(userId: string, reason: string): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(whitelistDecisionInput, { userId, reason });
    const actor = await currentActor();

    requirePermission(actor, 'players.whitelist');

    await grantWhitelist(prisma, actor, { userId: input.userId, reason: input.reason ?? null });
    revalidatePath('/control/players');
  });
}

export async function revokeWhitelistAction(userId: string, reason: string): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(whitelistDecisionInput, { userId, reason });
    const actor = await currentActor();

    requirePermission(actor, 'players.whitelist');

    await revokeWhitelist(prisma, actor, { userId: input.userId, reason: input.reason ?? null });
    revalidatePath('/control/players');
  });
}

export async function setUserStatusAction(
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED',
  reason: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, userId);
    const actor = await currentActor();

    requirePermission(actor, 'players.ban');

    await setUserStatus(prisma, actor, id, status, reason.length > 0 ? reason : null);
    revalidatePath('/control/players');
  });
}

// --- Roles -------------------------------------------------------------------

export async function assignRoleAction(userId: string, roleId: string): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(assignRoleInput, { userId, roleId });
    const actor = await currentActor();

    await assignRoleService(prisma, actor, { userId: input.userId, roleId: input.roleId });
    revalidatePath('/control/staff');
    revalidatePath('/control/players');
  });
}

export async function removeRoleAction(userId: string, roleId: string): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(assignRoleInput, { userId, roleId });
    const actor = await currentActor();

    await removeRole(prisma, actor, input.userId, input.roleId);
    revalidatePath('/control/staff');
    revalidatePath('/control/players');
  });
}

export async function setRolePermissionsAction(
  roleId: string,
  permissionKeys: readonly string[],
): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(rolePermissionsInput, { roleId, permissionKeys });
    const actor = await currentActor();

    await setRolePermissions(prisma, actor, input.roleId, input.permissionKeys);
    revalidatePath('/control/staff');
  });
}

// --- Tickets, reports, appeals ----------------------------------------------

export async function updateTicketAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(ticketUpdateInput, raw);
    const actor = await currentActor();

    await updateTicket(prisma, actor, {
      ticketId: input.ticketId,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId,
    });
    revalidatePath('/control/tickets');
  });
}

export async function staffReplyAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(ticketReplyInput, raw);
    const actor = await currentActor();

    await replyToTicket(prisma, actor, input);
    revalidatePath('/control/tickets');
  });
}

export async function updateReportAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(reportUpdateInput, raw);
    const actor = await currentActor();

    await updateReport(prisma, actor, {
      reportId: input.reportId,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId,
      outcome: input.outcome,
    });
    revalidatePath('/control/reports');
  });
}

export async function decideAppealAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(appealDecisionInput, raw);
    const actor = await currentActor();

    await decideAppeal(prisma, actor, input);
    revalidatePath('/control/appeals');
  });
}

// --- Content -----------------------------------------------------------------

export async function upsertArticleAction(
  raw: unknown,
  articleId?: string,
): Promise<ActionResult<{ slug: string }>> {
  return runAction(async () => {
    const input = parseInput(articleInput, raw);
    const actor = await currentActor();

    const article = await upsertArticle(prisma, actor, input, articleId);
    revalidatePath('/control/news');
    revalidatePath('/news');
    revalidatePath(`/news/${article.slug}`);
    return { slug: article.slug };
  });
}

export async function deleteArticleAction(articleId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, articleId);
    const actor = await currentActor();

    await deleteArticle(prisma, actor, id);
    revalidatePath('/control/news');
    revalidatePath('/news');
  });
}

export async function createAnnouncementAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(announcementInput, raw);
    const actor = await currentActor();

    await createAnnouncement(prisma, actor, input);
    revalidatePath('/control/news');
    revalidatePath('/news');
  });
}

// --- Departments -------------------------------------------------------------

export async function upsertDepartmentAction(
  raw: unknown,
  departmentId?: string,
): Promise<ActionResult<{ slug: string }>> {
  return runAction(async () => {
    const input = parseInput(departmentInput, raw);
    const actor = await currentActor();

    const department = await upsertDepartment(prisma, actor, input, departmentId);
    revalidatePath('/control/departments');
    revalidatePath('/departments');
    return { slug: department.slug };
  });
}

export async function deleteDepartmentAction(departmentId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, departmentId);
    const actor = await currentActor();

    await deleteDepartment(prisma, actor, id);
    revalidatePath('/control/departments');
    revalidatePath('/departments');
  });
}

// --- Rules -------------------------------------------------------------------

export async function upsertRuleAction(raw: unknown, ruleId?: string): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(ruleInput, raw);
    const actor = await currentActor();

    await upsertRule(prisma, actor, input, ruleId);
    revalidatePath('/control/rules');
    revalidatePath('/rules');
  });
}

export async function deleteRuleAction(ruleId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, ruleId);
    const actor = await currentActor();

    await deleteRule(prisma, actor, id);
    revalidatePath('/control/rules');
    revalidatePath('/rules');
  });
}

export async function publishRuleSetAction(
  note: string,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const input = parseInput(publishRuleSetInput, { note });
    const actor = await currentActor();

    const ruleSet = await publishRuleSet(prisma, actor, input.note ?? null);
    revalidatePath('/control/rules');
    revalidatePath('/rules');
    revalidatePath('/portal');
    return { version: ruleSet.version };
  });
}

// --- Integrations and system -------------------------------------------------

export async function upsertServerAction(raw: unknown, serverId?: string): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(serverInput, raw);
    const actor = await currentActor();

    await upsertServer(prisma, actor, input, serverId);
    revalidatePath('/control/fivem');
    revalidatePath('/status');
  });
}

export async function setSettingAction(key: string, value: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await currentActor();
    await setSetting(prisma, actor, key, value);

    revalidatePath('/control/settings');
    // Settings drive the public chrome, so the whole site is invalidated.
    revalidatePath('/', 'layout');
  });
}

export async function upsertFeatureFlagAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(featureFlagInput, raw);
    const actor = await currentActor();

    await upsertFeatureFlag(prisma, actor, input);
    revalidatePath('/control/flags');
  });
}
