import { prisma } from '@xenon/database';
import { healthReport, unsyncedWhitelists } from '@xenon/domain';
import { queueDepth } from '@xenon/jobs';
import { storageStatus } from '@xenon/storage';
import { Badge, Panel, StatusDot } from '@xenon/ui';

import { ControlPage, MetricTile } from '~/components/control/control-page';
import { requireStaff } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Health' };

const tone = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  UNHEALTHY: 'danger',
  UNKNOWN: 'neutral',
} as const;

/**
 * Health status as a live indicator.
 *
 * Only `HEALTHY` gets the expanding ring, which is the point: on a page that is
 * mostly green, the one row that has stopped pulsing is the one worth reading.
 * A degraded or failing dependency is deliberately inert - a flashing red on a
 * status board is how people learn to ignore status boards.
 */
const dot = {
  HEALTHY: 'online',
  DEGRADED: 'degraded',
  UNHEALTHY: 'offline',
  UNKNOWN: 'unknown',
} as const;

/**
 * /control/system/health
 *
 * Every dependency, checked independently and bounded, so one unreachable
 * service cannot make the health page itself hang - which is exactly when it
 * is most needed.
 *
 * The bot is not probed. The web tier cannot reach its gateway connection and
 * trying would couple two deployments; it writes a heartbeat row instead, and
 * a stale heartbeat is the signal.
 */
export default async function HealthPage(): Promise<React.ReactElement> {
  // Any staff capability is enough: knowing whether the platform is up is not
  // privileged among staff, and no secret is rendered here. It is still
  // checked on the page rather than left to the layout - queue depths and
  // sync backlogs are not for players.
  await requireStaff();

  const [report, queue, storage, unsynced] = await Promise.all([
    healthReport(prisma),
    queueDepth().catch(() => null),
    Promise.resolve(storageStatus()),
    unsyncedWhitelists(prisma),
  ]);

  return (
    <ControlPage
      title="System health"
      lead={`Checked ${new Date(report.checkedAt).toLocaleTimeString('en-GB')}.`}
      actions={<Badge tone={tone[report.status]}>{report.status.toLowerCase()}</Badge>}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Queued jobs"
          value={queue?.waiting ?? '—'}
          hint={queue === null ? 'queue unreachable' : `${String(queue.active)} running`}
          tone={queue !== null && queue.waiting > 200 ? 'warn' : 'neutral'}
        />
        <MetricTile
          label="Failed jobs"
          value={queue?.failed ?? '—'}
          hint="retained for 14 days"
          tone={queue !== null && queue.failed > 0 ? 'warn' : 'neutral'}
        />
        <MetricTile
          label="Whitelist out of sync"
          value={unsynced}
          hint="never pushed to a game server"
          tone={unsynced > 0 ? 'warn' : 'neutral'}
        />
        <MetricTile
          label="Media storage"
          value={storage.driver}
          hint={storage.configured ? 'Cloudflare R2' : 'local filesystem (development)'}
          tone={storage.configured ? 'neutral' : 'warn'}
        />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="x-eyebrow">Dependencies</h2>
        <Panel tone="flat" pad="none" className="divide-y divide-line">
          {report.checks.map((check) => (
            <div key={check.name} className="flex flex-wrap items-center gap-4 p-4">
              <StatusDot state={dot[check.status]} />
              <span className="w-20 shrink-0 text-sm text-ink capitalize">{check.name}</span>
              <span className="min-w-0 flex-1 text-xs text-ink-muted">{check.detail}</span>
              {check.latencyMs === null ? null : (
                <span className="x-tabular font-mono text-[0.625rem] text-ink-muted">
                  {check.latencyMs}ms
                </span>
              )}
              <Badge tone={tone[check.status]}>{check.status.toLowerCase()}</Badge>
            </div>
          ))}
        </Panel>
      </section>

      <Panel tone="ghost" pad="lg">
        <p className="x-eyebrow">How to read this</p>
        <ul className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
          <li>
            <strong className="text-ink-secondary">Unknown</strong> means not configured yet, not
            broken. A fresh install has no game server and no Discord guild.
          </li>
          <li>
            <strong className="text-ink-secondary">bot</strong> and{' '}
            <strong className="text-ink-secondary">worker</strong> report by heartbeat. If they read
            unhealthy, the process is not running - start it with{' '}
            <code className="font-mono">pnpm --filter @xenon/bot dev</code>.
          </li>
          <li>
            Failed jobs are Discord or FXServer refusing something. The canonical state in Postgres
            is already correct; these are the side effects still owed.
          </li>
        </ul>
      </Panel>
    </ControlPage>
  );
}
