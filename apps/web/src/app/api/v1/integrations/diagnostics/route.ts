import { ForbiddenError } from '@xenon/core';
import { prisma } from '@xenon/database';
import { requireUser } from '@xenon/permissions';

import { apiJson, runApi } from '~/server/api';
import { currentActor } from '~/server/context';

/**
 * GET /api/v1/integrations/diagnostics
 *
 * Operator view of the integration plane: service heartbeats, the outbox
 * backlog and recent integration events. Metadata only - payloads can carry
 * Discord ids and player references, so they are never returned here.
 */
const SERVICES = ['core-api', 'worker', 'link'] as const;
const LAST_ERROR_MAX = 300;

export async function GET(): Promise<Response> {
  return runApi(async () => {
    const actor = await currentActor();
    requireUser(actor);
    if (!actor.permissions.has('system.manage') && !actor.permissions.has('discord.manage')) {
      throw new ForbiddenError('system.manage | discord.manage', actor.userId);
    }

    const now = Date.now();
    const undispatched = { dispatchedAt: null } as const;

    const [heartbeats, pendingCount, oldestPending, backlog, events] = await Promise.all([
      prisma.serviceHeartbeat.findMany({
        where: { service: { in: [...SERVICES] } },
        select: { service: true, status: true, version: true, beatAt: true },
      }),
      prisma.outboxMessage.count({ where: undispatched }),
      prisma.outboxMessage.findFirst({
        where: undispatched,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.outboxMessage.findMany({
        where: undispatched,
        orderBy: [{ attempts: 'desc' }, { createdAt: 'asc' }],
        take: 20,
        select: { name: true, attempts: true, lastError: true, availableAt: true },
      }),
      prisma.outboxMessage.findMany({
        where: { kind: 'EVENT' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { name: true, createdAt: true, dispatchedAt: true },
      }),
    ]);

    const byService = new Map(heartbeats.map((beat) => [beat.service, beat]));

    return apiJson({
      checkedAt: new Date(now).toISOString(),
      heartbeats: SERVICES.map((service) => {
        const beat = byService.get(service);
        return beat === undefined
          ? { service, status: 'UNKNOWN', version: null, beatAt: null, ageSeconds: null }
          : {
              service,
              status: beat.status,
              version: beat.version,
              beatAt: beat.beatAt.toISOString(),
              ageSeconds: Math.max(0, Math.round((now - beat.beatAt.getTime()) / 1000)),
            };
      }),
      outbox: {
        pending: pendingCount,
        oldestPendingAgeSeconds:
          oldestPending === null
            ? null
            : Math.max(0, Math.round((now - oldestPending.createdAt.getTime()) / 1000)),
        backlog: backlog.map((row) => ({
          name: row.name,
          attempts: row.attempts,
          lastError: row.lastError === null ? null : row.lastError.slice(0, LAST_ERROR_MAX),
          availableAt: row.availableAt.toISOString(),
        })),
      },
      events: events.map((row) => ({
        type: row.name,
        createdAt: row.createdAt.toISOString(),
        dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
      })),
    });
  });
}
