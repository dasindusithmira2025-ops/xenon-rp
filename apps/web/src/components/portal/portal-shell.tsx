'use client';

import {
  Bell,
  FileText,
  Gavel,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  UserRound,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { Avatar, Badge, cn } from '@xenon/ui';

import { XenonMark } from '~/components/brand/wordmark';

/**
 * Player portal navigation.
 *
 * Deliberately not an admin sidebar. The portal is the player's account - it
 * should read like a game profile, so the identity block is the largest thing
 * on it and the navigation is a short, legible list rather than a dense tree.
 *
 * On mobile the navigation becomes a bottom bar: the portal is the one part of
 * the site people open on a phone while waiting for something, and a hamburger
 * for six destinations is a tap nobody should have to make.
 */

export interface PortalViewer {
  readonly publicId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly whitelistState: string;
  readonly unreadNotifications: number;
  readonly isStaff: boolean;
}

const links = [
  { href: '/portal', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/portal/applications', label: 'Applications', icon: FileText, exact: false },
  { href: '/portal/characters', label: 'Characters', icon: Users, exact: false },
  { href: '/portal/tickets', label: 'Support', icon: LifeBuoy, exact: false },
  { href: '/portal/appeals', label: 'Appeals', icon: Gavel, exact: false },
  { href: '/portal/account', label: 'Account', icon: UserRound, exact: false },
] as const;

const whitelistTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  APPROVED: 'success',
  PENDING: 'warning',
  SUSPENDED: 'warning',
  REVOKED: 'danger',
  NONE: 'neutral',
};

const whitelistLabel: Record<string, string> = {
  APPROVED: 'Whitelisted',
  PENDING: 'Pending',
  SUSPENDED: 'Suspended',
  REVOKED: 'Revoked',
  NONE: 'Not whitelisted',
};

function isActive(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function PortalShell({
  viewer,
  signOut,
  children,
}: {
  viewer: PortalViewer;
  signOut: () => Promise<void>;
  children: React.ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const tone = whitelistTone[viewer.whitelistState] ?? 'neutral';
  const label = whitelistLabel[viewer.whitelistState] ?? viewer.whitelistState;

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="border-b border-line bg-black lg:w-72 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex flex-col gap-8 p-5 lg:sticky lg:top-0 lg:h-dvh lg:p-7">
          <Link href="/" className="inline-flex items-center gap-2.5" aria-label="XenonRP home">
            <XenonMark className="size-6" />
            <span className="font-display text-sm font-extrabold tracking-[0.18em] text-ink">
              XENON
            </span>
          </Link>

          <div className="flex items-center gap-4 lg:flex-col lg:items-start lg:gap-4">
            <Avatar src={viewer.avatarUrl} name={viewer.displayName} size={56} />
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="truncate font-display text-lg leading-tight font-bold text-ink">
                {viewer.displayName ?? 'Xenon player'}
              </p>
              <p className="font-mono text-[0.6875rem] tracking-[0.16em] text-ink-muted">
                {viewer.publicId}
              </p>
              <Badge tone={tone} className="mt-1 self-start">
                {label}
              </Badge>
            </div>
          </div>

          <nav
            aria-label="Portal"
            className="hidden flex-1 flex-col gap-1 border-t border-line pt-6 lg:flex"
          >
            {links.map((link) => {
              const active = isActive(pathname, link.href, link.exact);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors duration-(--duration-fast)',
                    active
                      ? 'bg-elevated text-ink'
                      : 'text-ink-muted hover:bg-elevated/60 hover:text-ink-secondary',
                  )}
                >
                  <link.icon className="size-4 shrink-0" aria-hidden />
                  {link.label}
                </Link>
              );
            })}

            <Link
              href="/portal/notifications"
              aria-current={isActive(pathname, '/portal/notifications', false) ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                isActive(pathname, '/portal/notifications', false)
                  ? 'bg-elevated text-ink'
                  : 'text-ink-muted hover:bg-elevated/60 hover:text-ink-secondary',
              )}
            >
              <Bell className="size-4 shrink-0" aria-hidden />
              Notifications
              {viewer.unreadNotifications > 0 ? (
                <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-pill bg-xenon px-1.5 py-0.5 text-[0.625rem] font-bold text-ink-inverse">
                  {viewer.unreadNotifications > 99 ? '99+' : viewer.unreadNotifications}
                </span>
              ) : null}
            </Link>
          </nav>

          <div className="hidden flex-col gap-1 border-t border-line pt-5 lg:flex">
            {viewer.isStaff ? (
              <Link
                href="/control"
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-ink-muted transition-colors hover:bg-elevated/60 hover:text-xenon"
              >
                <LayoutDashboard className="size-4 shrink-0" aria-hidden />
                Control centre
              </Link>
            ) : null}
            <form action={signOut}>
              <button
                type="submit"
                className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm text-ink-muted transition-colors hover:bg-elevated/60 hover:text-danger"
              >
                <LogOut className="size-4 shrink-0" aria-hidden />
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1 pb-20 lg:pb-0">
        {children}
      </main>

      {/* Bottom bar on small screens. Five destinations, thumb-reachable. */}
      <nav
        aria-label="Portal mobile"
        className="fixed inset-x-0 bottom-0 z-[40] grid grid-cols-5 border-t border-line bg-void/95 backdrop-blur-lg lg:hidden"
      >
        {[
          ...links.slice(0, 4),
          { href: '/portal/notifications', label: 'Alerts', icon: Bell, exact: false },
        ].map((link) => {
          const active = isActive(pathname, link.href, link.exact);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex flex-col items-center gap-1 py-3 text-[0.625rem] tracking-wide transition-colors',
                active ? 'text-xenon' : 'text-ink-muted',
              )}
            >
              <link.icon className="size-4.5" aria-hidden />
              {link.label}
              {link.href === '/portal/notifications' && viewer.unreadNotifications > 0 ? (
                <span className="absolute top-2 right-[calc(50%-1.25rem)] size-1.5 rounded-full bg-xenon" />
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
