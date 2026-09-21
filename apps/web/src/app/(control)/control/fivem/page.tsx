import { hasFivemBridge, serverEnv } from '@xenon/config/server';
import { prisma } from '@xenon/database';
import { statusBoard, unsyncedWhitelists } from '@xenon/domain';
import { Badge, Panel } from '@xenon/ui';

import { ControlPage, MetricTile } from '~/components/control/control-page';
import { ServerConfig } from '~/components/control/server-config';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Game servers' };

/**
 * /control/integrations/fivem
 *
 * Game servers, their adapter, and how whitelist synchronisation is going.
 *
 * The adapter choice is the important field. Xenon does not know or care which
 * framework the city runs - the bridge translates - so picking QBCore here does
 * not change Xenon's behaviour, it tells the bridge what to do locally.
 */
export default async function FivemPage(): Promise<React.ReactElement> {
  await requireCapability('fivem.manage');

  const [servers, board, unsynced, failed] = await Promise.all([
    prisma.server.findMany({ orderBy: { sortOrder: 'asc' } }),
    statusBoard(prisma),
    unsyncedWhitelists(prisma),
    prisma.whitelist.count({ where: { syncFailedAt: { not: null } } }),
  ]);

  const bridgeConfigured = hasFivemBridge();

  return (
    <ControlPage
      title="Game servers"
      lead="Xenon is the source of truth. Whitelist state is pushed to these servers and retried until it lands."
      actions={
        <Badge tone={bridgeConfigured ? 'success' : 'warning'}>
          {bridgeConfigured ? 'Bridge configured' : 'Bridge not configured'}
        </Badge>
      }
    >
      {bridgeConfigured ? null : (
        <Panel tone="ghost" pad="md" className="border-warning/30 bg-warning/5">
          <p className="text-xs leading-relaxed text-warning">
            FIVEM_BRIDGE_SECRET and FIVEM_SERVER_URL are not both set, so every server falls back to
            the mock adapter. The whole approval-to-whitelist path still works end to end - nothing
            actually reaches a game server. Production refuses to start without the secret.
          </p>
        </Panel>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricTile
          label="Servers"
          value={servers.length}
          hint={`${String(servers.filter((server) => server.adapter !== 'MOCK').length)} real`}
        />
        <MetricTile
          label="Never synced"
          value={unsynced}
          hint="whitelist changes not yet pushed"
          tone={unsynced > 0 ? 'warn' : 'neutral'}
        />
        <MetricTile
          label="Failed pushes"
          value={failed}
          hint="retried by the worker"
          tone={failed > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <ServerConfig
        servers={servers.map((server) => ({
          id: server.id,
          slug: server.slug,
          name: server.name,
          adapter: server.adapter,
          connectUrl: server.connectUrl,
          endpointUrl: server.endpointUrl,
          maxPlayers: server.maxPlayers,
          restartCron: server.restartCron,
          timezone: server.timezone,
          isPublic: server.isPublic,
          sortOrder: server.sortOrder,
          state: board.servers.find((view) => view.slug === server.slug)?.state ?? 'UNKNOWN',
        }))}
      />

      <Panel tone="ghost" pad="lg">
        <p className="x-eyebrow">The bridge</p>
        <ul className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
          <li>
            Install <code className="font-mono text-ink-secondary">fivem/xenon_bridge</code> as a
            resource and set the same FIVEM_BRIDGE_SECRET on both sides. Every request between the
            two is HMAC-signed with a timestamp and a nonce.
          </li>
          <li>
            Endpoint currently configured in the environment:{' '}
            <code className="font-mono text-ink-secondary">
              {serverEnv.FIVEM_SERVER_URL ?? 'not set'}
            </code>
            . Per-server endpoints below override it.
          </li>
          <li>
            Restart schedules use the minute and hour fields only, for example{' '}
            <code className="font-mono text-ink-secondary">0 4,10,16,22 * * *</code>.
          </li>
        </ul>
      </Panel>
    </ControlPage>
  );
}
