import { Copy } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { allSettings, statusBoard } from '@xenon/domain';
import { Badge, Button, EmptyState, Panel, StatusDot } from '@xenon/ui';

import type { Metadata } from 'next';

import { PageHeader, Section } from '~/components/site/section';
import { CopyConnect } from '~/components/status/copy-connect';

export const metadata: Metadata = {
  title: 'Server status',
  description: 'Live status for the XenonRP city: players online, queue and the next restart.',
  alternates: { canonical: '/status' },
};

/**
 * /status
 *
 * Reads the cached status board, which the poller refreshes independently. No
 * browser talks to FXServer: that keeps the game server's address private and
 * turns a thousand concurrent visitors into one probe.
 *
 * Every figure is a real reading or the word "unavailable". This is the page
 * people open when something is wrong, so a comforting fiction here would be
 * worse than useless.
 */
export const dynamic = 'force-dynamic';

const stateTone = {
  ONLINE: 'success',
  OFFLINE: 'danger',
  DEGRADED: 'warning',
  UNKNOWN: 'neutral',
} as const;

const stateDot = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded',
  UNKNOWN: 'unknown',
} as const;

const stateHeadline = {
  ONLINE: 'The city is online',
  OFFLINE: 'The city is offline',
  DEGRADED: 'Partial service',
  UNKNOWN: 'Status unavailable',
} as const;

const stateBlurb = {
  ONLINE: 'Everything is answering normally.',
  OFFLINE: 'The server is not responding. It is usually back within a few minutes.',
  DEGRADED: 'Some servers are reachable and others are not.',
  UNKNOWN:
    'We have no recent reading from the status poller. That means our monitoring is down, not necessarily the city.',
} as const;

export default async function StatusPage(): Promise<React.ReactElement> {
  const [board, settings] = await Promise.all([statusBoard(prisma), allSettings(prisma)]);

  const configuredConnect = settings['community.connectUrl'];
  const connectUrl =
    configuredConnect !== undefined && configuredConnect.length > 0
      ? configuredConnect
      : (board.servers.find((server) => server.connectUrl !== null)?.connectUrl ?? null);

  return (
    <>
      <PageHeader
        eyebrow="Status"
        title={stateHeadline[board.aggregate]}
        lead={stateBlurb[board.aggregate]}
      >
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-2.5 rounded-pill border border-line-strong bg-surface px-3.5 py-2">
            <StatusDot state={stateDot[board.aggregate]} />
            <span className="font-mono text-[0.625rem] tracking-[0.16em] text-ink-secondary uppercase">
              {board.aggregate.toLowerCase()}
            </span>
          </span>

          {board.checkedAt === null ? (
            <span className="font-mono text-[0.625rem] tracking-[0.16em] text-ink-muted uppercase">
              Never checked
            </span>
          ) : (
            <span className="font-mono text-[0.625rem] tracking-[0.16em] text-ink-muted uppercase">
              Checked{' '}
              {new Date(board.checkedAt).toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'UTC',
              })}{' '}
              UTC
            </span>
          )}
        </div>
      </PageHeader>

      <Section width="wide">
        {board.servers.length === 0 ? (
          <EmptyState
            title="No game server is configured"
            description="Servers are added from the control centre under Integrations. Until one exists there is nothing to report."
            action={
              <Button variant="outline" asChild>
                <Link href="/support">Contact staff</Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-6">
            {board.servers.map((server) => (
              <Panel
                key={server.slug}
                tone="raised"
                pad="none"
                edgeLight
                className="overflow-hidden"
              >
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line p-6 lg:p-8">
                  <div className="flex items-center gap-3">
                    <StatusDot state={stateDot[server.state]} />
                    <h2 className="font-display text-title font-bold text-ink">{server.name}</h2>
                  </div>
                  <Badge tone={stateTone[server.state]}>{server.state.toLowerCase()}</Badge>
                </div>

                <dl className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
                  <Figure
                    label="Players"
                    value={server.playerCount === null ? null : String(server.playerCount)}
                    hint={
                      server.maxPlayers === null
                        ? 'capacity unknown'
                        : `of ${String(server.maxPlayers)}`
                    }
                  />
                  <Figure
                    label="Queue"
                    value={server.queueLength === null ? null : String(server.queueLength)}
                    hint={server.queueLength === 0 ? 'no wait' : 'waiting to connect'}
                  />
                  <Figure
                    label="Next restart"
                    value={
                      server.nextRestartAt === null
                        ? null
                        : new Date(server.nextRestartAt).toLocaleTimeString('en-GB', {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'UTC',
                          })
                    }
                    hint={server.nextRestartAt === null ? 'not scheduled' : 'UTC'}
                  />
                  <Figure
                    label="Response"
                    value={server.latencyMs === null ? null : `${String(server.latencyMs)}ms`}
                    hint={
                      server.updatedAt === null
                        ? 'never measured'
                        : `at ${new Date(server.updatedAt).toLocaleTimeString('en-GB', {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'UTC',
                          })} UTC`
                    }
                  />
                </dl>

                {server.error === null ? null : (
                  <p className="border-t border-line bg-danger/5 px-6 py-4 font-mono text-xs text-danger lg:px-8">
                    {server.error}
                  </p>
                )}
              </Panel>
            ))}
          </div>
        )}

        {connectUrl === null ? null : (
          <Panel tone="flat" pad="lg" className="mt-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="x-eyebrow flex items-center gap-2">
                  <Copy className="size-3" aria-hidden /> Connect
                </p>
                <p className="mt-2 truncate font-mono text-sm text-ink">{connectUrl}</p>
              </div>
              <CopyConnect value={connectUrl} />
            </div>
          </Panel>
        )}
      </Section>
    </>
  );
}

/**
 * One reading.
 *
 * `null` renders an em dash and the reason, never a zero. "0 players" and "we
 * could not read the player count" are different facts and the page must not
 * conflate them.
 */
function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 bg-elevated p-6 lg:p-8">
      <dt className="x-eyebrow">{label}</dt>
      <dd
        className={
          value === null
            ? 'font-display text-3xl leading-none font-black text-ink-muted'
            : 'x-tabular font-display text-3xl leading-none font-black text-ink'
        }
      >
        {value ?? '—'}
      </dd>
      <p className="text-xs text-ink-muted">{value === null ? 'unavailable' : hint}</p>
    </div>
  );
}
