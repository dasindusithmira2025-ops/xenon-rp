import Link from 'next/link';

import { prisma } from '@xenon/database';
import { searchUsers } from '@xenon/domain';
import { Avatar, Badge, EmptyState, TBody, TD, TH, THead, Table, TableShell, TR } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { PlayerFilters } from '~/components/control/player-filters';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Players' };

const PAGE_SIZE = 30;

const whitelistTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  APPROVED: 'success',
  PENDING: 'warning',
  SUSPENDED: 'warning',
  REVOKED: 'danger',
  NONE: 'neutral',
};

const statusTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ACTIVE: 'neutral',
  SUSPENDED: 'warning',
  BANNED: 'danger',
  DEACTIVATED: 'neutral',
};

/**
 * /control/players
 *
 * The directory. Search accepts anything staff actually have to hand: an XN
 * identifier, a display name, a Discord username or a raw snowflake.
 */
export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  await requireCapability('players.view');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const page = Math.max(1, Number(single('page') ?? '1'));
  const whitelist = single('whitelist');
  const status = single('status');

  const { items, total } = await searchUsers(prisma, {
    ...(single('q') === undefined ? {} : { search: single('q') }),
    ...(whitelist === undefined
      ? {}
      : { whitelistState: whitelist as 'APPROVED' | 'NONE' | 'PENDING' | 'SUSPENDED' | 'REVOKED' }),
    ...(status === undefined
      ? {}
      : { status: status as 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED' }),
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  return (
    <ControlPage title="Players" lead={`${String(total)} account${total === 1 ? '' : 's'}.`}>
      <PlayerFilters />

      {items.length === 0 ? (
        <EmptyState title="No players match" description="Try a different search or filter." />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <TH width="9rem">Xenon ID</TH>
              <TH>Player</TH>
              <TH width="12rem">Discord</TH>
              <TH width="9rem">Whitelist</TH>
              <TH width="9rem">Account</TH>
              <TH width="10rem">Roles</TH>
              <TH width="5rem" align="right">
                Chars
              </TH>
            </THead>
            <TBody>
              {items.map((user) => (
                <TR key={user.id}>
                  <TD>
                    <Link
                      href={`/control/players/${user.publicId}`}
                      className="font-mono text-xs text-xenon hover:underline"
                    >
                      {user.publicId}
                    </Link>
                  </TD>
                  <TD>
                    <Link
                      href={`/control/players/${user.publicId}`}
                      className="flex items-center gap-2.5 hover:text-ink"
                    >
                      <Avatar src={user.avatarUrl} name={user.displayName} size={24} />
                      <span className="truncate">{user.displayName ?? '—'}</span>
                    </Link>
                  </TD>
                  <TD>
                    {user.discordAccount === null ? (
                      <span className="text-warning">not linked</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="truncate">{user.discordAccount.username}</span>
                        <span
                          className={
                            user.discordAccount.guildMembershipState === 'MEMBER'
                              ? 'shrink-0 text-ink-muted'
                              : 'shrink-0 text-warning'
                          }
                        >
                          ({membershipLabel(user.discordAccount.guildMembershipState)})
                        </span>
                      </span>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={whitelistTone[user.whitelistState] ?? 'neutral'}>
                      {user.whitelistState.toLowerCase()}
                    </Badge>
                  </TD>
                  <TD>
                    <Badge tone={statusTone[user.status] ?? 'neutral'}>
                      {user.status.toLowerCase()}
                    </Badge>
                  </TD>
                  <TD>
                    <span className="truncate text-xs">
                      {user.roles.length === 0
                        ? '—'
                        : user.roles.map((assignment) => assignment.role.name).join(', ')}
                    </span>
                  </TD>
                  <TD align="right" className="x-tabular">
                    {user._count.characters}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableShell>
      )}

      {total > PAGE_SIZE ? (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-4 text-xs">
          <p className="x-tabular text-ink-muted">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE)} of {total}
          </p>
          <div className="flex gap-2">
            {page > 1 ? <PageLink params={params} page={page - 1} label="Previous" /> : null}
            {page * PAGE_SIZE < total ? (
              <PageLink params={params} page={page + 1} label="Next" />
            ) : null}
          </div>
        </nav>
      ) : null}
    </ControlPage>
  );
}

function membershipLabel(state: string): string {
  switch (state) {
    case 'MEMBER':
      return 'member';
    case 'PENDING_SCREENING':
      return 'screening pending';
    case 'NOT_MEMBER':
      return 'not joined';
    case 'MISCONFIGURED':
      return 'setup issue';
    case 'UNAVAILABLE':
      return 'unknown';
    default:
      return 'not checked';
  }
}

function PageLink({
  params,
  page,
  label,
}: {
  params: Record<string, string | string[] | undefined>;
  page: number;
  label: string;
}): React.ReactElement {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 0 && key !== 'page') query.set(key, value);
  }
  query.set('page', String(page));

  return (
    <Link
      href={`/control/players?${query.toString()}`}
      className="rounded-sm border border-line-strong px-3 py-1.5 text-ink-secondary transition-colors hover:bg-elevated"
    >
      {label}
    </Link>
  );
}
