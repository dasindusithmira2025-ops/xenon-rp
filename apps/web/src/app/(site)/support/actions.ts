'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { prisma } from '@xenon/database';
import { createAppeal, createReport, createTicket } from '@xenon/domain';
import { appealInput, reportInput, ticketInput } from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { requireSignedIn } from '~/server/context';

/**
 * Support intake actions.
 *
 * All three follow the same shape: parse, resolve the actor, call the shared
 * service, return the public identifier. Rate limiting, audit and notification
 * all live in the service, so the Discord bot creating a ticket behaves
 * identically to the website creating one.
 */

/** The client address, for the hashed record the services keep. */
async function clientIp(): Promise<string | null> {
  const store = await headers();
  return store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? store.get('x-real-ip');
}

export async function createTicketAction(
  raw: unknown,
): Promise<ActionResult<{ publicId: string }>> {
  return runAction(async () => {
    const input = parseInput(ticketInput, raw);
    const actor = await requireSignedIn();

    const ticket = await createTicket(prisma, actor, input, { ip: await clientIp() });
    revalidatePath('/portal/tickets');
    return { publicId: ticket.publicId };
  });
}

export async function createReportAction(
  raw: unknown,
): Promise<ActionResult<{ publicId: string }>> {
  return runAction(async () => {
    const input = parseInput(reportInput, raw);
    const actor = await requireSignedIn();

    const report = await createReport(prisma, actor, input, { ip: await clientIp() });
    revalidatePath('/portal/tickets');
    return { publicId: report.publicId };
  });
}

export async function createAppealAction(
  raw: unknown,
): Promise<ActionResult<{ publicId: string }>> {
  return runAction(async () => {
    const input = parseInput(appealInput, raw);
    // Deliberately not gated on account standing: an appeal process a banned
    // player cannot reach is not an appeal process.
    const actor = await requireSignedIn();

    const appeal = await createAppeal(prisma, actor, input, { ip: await clientIp() });
    revalidatePath('/portal/appeals');
    return { publicId: appeal.publicId };
  });
}
