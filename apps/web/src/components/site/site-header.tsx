'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { Avatar, Button, cn, StatusDot } from '@xenon/ui';

import { Wordmark } from '~/components/brand/wordmark';

/**
 * Global navigation.
 *
 * Transparent over the hero and solid once the page has moved, so the homepage
 * opens on uninterrupted photography but the bar never becomes unreadable over
 * a light frame of video.
 *
 * The mobile navigation is a separate composition rather than the desktop links
 * stacked: at 375px a row of five links wraps into an unreadable block, and the
 * list of five places worth going is exactly the kind of thing that should be
 * set large.
 */

export interface HeaderViewer {
  readonly displayName: string | null;
  readonly publicId: string | null;
  readonly avatarUrl: string | null;
  readonly isStaff: boolean;
}

export interface SiteHeaderProps {
  readonly viewer: HeaderViewer | null;
  readonly serverState: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
  readonly playerCount: number | null;
  readonly discordInvite: string | null;
}

const links = [
  { href: '/city', label: 'City' },
  { href: '/departments', label: 'Departments' },
  { href: '/rules', label: 'Rules' },
  { href: '/community', label: 'Community' },
  { href: '/applications', label: 'Applications' },
] as const;

const stateLabel: Record<SiteHeaderProps['serverState'], string> = {
  ONLINE: 'City online',
  OFFLINE: 'City offline',
  DEGRADED: 'Partial service',
  UNKNOWN: 'Status unavailable',
};

const dotState = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded',
  UNKNOWN: 'unknown',
} as const;

export function SiteHeader({
  viewer,
  serverState,
  playerCount,
  discordInvite,
}: SiteHeaderProps): React.ReactElement {
  const pathname = usePathname();
  const [scrolled, setScrolled] = React.useState(false);

  /*
   * The overlay's open state is stored with the route it was opened on, so a
   * navigation closes it by derivation rather than by an effect that calls
   * setState and cascades a second render.
   */
  const [menu, setMenu] = React.useState({ open: false, path: pathname });
  const menuOpen = menu.open && menu.path === pathname;

  React.useEffect(() => {
    const onScroll = (): void => {
      setScrolled(window.scrollY > 24);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  React.useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  return (
    <>
      <header
        className={cn(
          'fixed inset-x-0 top-0 z-[40] transition-colors duration-(--duration-base) ease-standard',
          scrolled || menuOpen
            ? 'border-b border-line bg-void/85 backdrop-blur-xl'
            : 'border-b border-transparent bg-transparent',
        )}
      >
        <div className="mx-auto flex h-(--header-height) max-w-wide items-center justify-between gap-6 px-5 lg:px-8">
          <Link href="/" className="shrink-0" aria-label="XenonRP home">
            <Wordmark />
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
            {links.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative px-3.5 py-2 font-mono text-[0.6875rem] tracking-[0.18em] uppercase transition-colors duration-(--duration-fast)',
                    active ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary',
                  )}
                >
                  {link.label}
                  {active ? (
                    <span className="absolute inset-x-3.5 -bottom-px h-px bg-xenon" />
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2.5">
            <Link
              href="/status"
              className="hidden items-center gap-2 rounded-pill border border-line-strong bg-surface/80 px-3 py-1.5 transition-colors hover:border-chrome-500 md:inline-flex"
            >
              <StatusDot state={dotState[serverState]} />
              <span className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-secondary uppercase">
                {/* Never a fabricated number: the count appears only when a
                    live reading actually supplied one. */}
                {serverState === 'ONLINE' && playerCount !== null
                  ? `${String(playerCount)} in city`
                  : stateLabel[serverState]}
              </span>
            </Link>

            {discordInvite === null ? null : (
              <Button variant="outline" size="sm" asChild className="hidden sm:inline-flex">
                <a href={discordInvite} target="_blank" rel="noopener noreferrer">
                  Discord
                </a>
              </Button>
            )}

            {viewer === null ? (
              <Button variant="accent" size="sm" asChild className="hidden sm:inline-flex">
                <Link href="/signin">Sign in</Link>
              </Button>
            ) : (
              <Link
                href="/portal"
                className="hidden items-center gap-2 rounded-pill border border-line-strong py-1 pr-3 pl-1 transition-colors hover:border-chrome-500 sm:inline-flex"
              >
                <Avatar src={viewer.avatarUrl} name={viewer.displayName} size={26} />
                <span className="max-w-28 truncate text-xs font-medium text-ink-secondary">
                  {viewer.displayName ?? viewer.publicId ?? 'Portal'}
                </span>
              </Link>
            )}

            <button
              type="button"
              onClick={() => {
                setMenu({ open: !menuOpen, path: pathname });
              }}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              className="rounded-sm p-2 text-ink transition-colors hover:bg-elevated lg:hidden"
            >
              {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>
      </header>

      {menuOpen ? (
        <MobileNavigation
          viewer={viewer}
          discordInvite={discordInvite}
          serverState={serverState}
          playerCount={playerCount}
        />
      ) : null}
    </>
  );
}

function MobileNavigation({
  viewer,
  discordInvite,
  serverState,
  playerCount,
}: Omit<SiteHeaderProps, 'viewer'> & { viewer: HeaderViewer | null }): React.ReactElement {
  return (
    <div
      id="mobile-navigation"
      className="fixed inset-0 top-(--header-height) z-[39] flex animate-fade-in flex-col overflow-y-auto bg-void lg:hidden"
    >
      <nav aria-label="Primary mobile" className="flex flex-col px-5 pt-6">
        {links.map((link, index) => (
          <Link
            key={link.href}
            href={link.href}
            className="group flex items-baseline justify-between border-b border-line py-5"
          >
            <span className="font-display text-[2rem] leading-none font-extrabold tracking-tight text-ink transition-colors group-hover:text-xenon">
              {link.label.toUpperCase()}
            </span>
            <span className="font-mono text-[0.625rem] text-ink-muted">
              {String(index + 1).padStart(2, '0')}
            </span>
          </Link>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3 p-5 pb-10">
        <Link
          href="/status"
          className="flex items-center gap-2.5 rounded-md border border-line-strong bg-surface px-4 py-3"
        >
          <StatusDot state={dotState[serverState]} />
          <span className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-secondary uppercase">
            {serverState === 'ONLINE' && playerCount !== null
              ? `${String(playerCount)} in city`
              : stateLabel[serverState]}
          </span>
        </Link>

        {viewer === null ? (
          <Button variant="accent" size="lg" asChild>
            <Link href="/signin">Sign in with Discord</Link>
          </Button>
        ) : (
          <Button variant="accent" size="lg" asChild>
            <Link href="/portal">Open your portal</Link>
          </Button>
        )}

        {discordInvite === null ? null : (
          <Button variant="outline" size="lg" asChild>
            <a href={discordInvite} target="_blank" rel="noopener noreferrer">
              Join the Discord
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
