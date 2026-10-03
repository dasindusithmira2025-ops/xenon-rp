'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import {
  Avatar,
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  StatusDot,
  VisuallyHidden,
} from '@xenon/ui';
import { AnimatedCounter, motion, useReducedMotion } from '@xenon/ui/motion';

import { Wordmark } from '~/components/brand/wordmark';

/**
 * Global navigation.
 *
 * Transparent over the hero and solid once the page has moved, so the homepage
 * opens on uninterrupted photography but the bar never becomes unreadable over
 * a light frame of video.
 *
 * The active-route marker is a single underline that travels between links
 * rather than four that blink on and off. That is the header's one piece of
 * choreography and it does real work: the line moving from Rules to Community
 * is a statement about where you just came from.
 *
 * The mobile navigation is a separate composition rather than the desktop links
 * stacked: at 375px a row of five links wraps into an unreadable block, and the
 * list of five places worth going is exactly the kind of thing that should be
 * set large. It is a Radix dialog, which means focus trapping, scroll locking
 * and escape-to-close are handled by the library that already ships them rather
 * than by three effects here that would each get an edge case wrong.
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
  const reduced = useReducedMotion();
  const [scrolled, setScrolled] = React.useState(false);

  /*
   * The overlay's open state is stored with the route it was opened on, so a
   * navigation closes it by derivation rather than by an effect that calls
   * setState and cascades a second render.
   */
  const [menu, setMenu] = React.useState({ open: false, path: pathname });
  const menuOpen = menu.open && menu.path === pathname;

  React.useEffect(() => {
    /*
     * A passive listener that sets state only on the frame the threshold is
     * actually crossed.
     *
     * The naive version calls `setScrolled` on every scroll event - hundreds of
     * times during a single flick - and relies on React bailing out of an
     * identical value. React does bail, but only after scheduling work, and
     * scheduling work from the scroll handler is precisely what makes a page
     * feel like it is dragging.
     */
    let current = false;

    const onScroll = (): void => {
      const next = window.scrollY > 24;
      if (next === current) return;
      current = next;
      setScrolled(next);
    };

    /*
     * The opening read happens in a frame callback rather than in the effect
     * body. Not a lint dance: a page restored from the back-forward cache, or
     * reloaded halfway down, already has a scroll position, and the header has
     * to catch up to it. Doing that synchronously in the effect is a cascading
     * render; doing it in the next frame is the same correction one frame later
     * and is genuinely what "subscribe to an external system" looks like.
     */
    const frame = requestAnimationFrame(onScroll);

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const liveLabel =
    serverState === 'ONLINE' && playerCount !== null ? null : stateLabel[serverState];

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-40',
        'transition-[background-color,border-color,backdrop-filter] duration-(--duration-base) ease-standard',
        scrolled || menuOpen
          ? 'border-b border-line bg-void/85 backdrop-blur-xl'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-(--header-height) max-w-wide items-center justify-between gap-6 px-5 lg:px-8">
        <Link
          href="/"
          // The logo's entire interaction: a hairline of brightness on hover.
          // Anything more - a spin, a bounce, a scale - turns the one fixed
          // point on the page into a toy.
          className="shrink-0 opacity-90 transition-opacity duration-(--duration-fast) hover:opacity-100"
          aria-label="XenonRP home"
        >
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
                  'group relative px-3.5 py-2 font-mono text-[0.6875rem] tracking-[0.18em] uppercase',
                  'transition-colors duration-(--duration-fast)',
                  active ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary',
                )}
              >
                {link.label}

                {/* Hover: a line drawing itself from the left under an inactive
                    link. Scale rather than width, so it costs nothing. */}
                {active ? null : (
                  <span className="absolute inset-x-3.5 bottom-1 h-px origin-left scale-x-0 bg-chrome-500 transition-transform duration-(--duration-fast) ease-standard group-hover:scale-x-100" />
                )}

                {/* Active: the one travelling underline. */}
                {active ? (
                  <motion.span
                    layoutId={reduced === true ? undefined : 'site-nav-underline'}
                    className="absolute inset-x-3.5 bottom-1 h-px bg-xenon"
                    transition={{ duration: 0.34, ease: [0.32, 0.72, 0, 1] }}
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2.5">
          <Link
            href="/status"
            className="hidden items-center gap-2 rounded-pill border border-line-strong bg-surface/80 px-3 py-1.5 transition-colors duration-(--duration-fast) hover:border-chrome-500 md:inline-flex"
          >
            <StatusDot state={dotState[serverState]} />
            <span className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-secondary uppercase">
              {/* Never a fabricated number: the count appears only when a live
                  reading actually supplied one, and animates only between two
                  real readings. */}
              {liveLabel ?? (
                <>
                  <AnimatedCounter value={playerCount ?? 0} countOnReveal={false} /> in city
                </>
              )}
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
              className="hidden items-center gap-2 rounded-pill border border-line-strong py-1 pr-3 pl-1 transition-colors duration-(--duration-fast) hover:border-chrome-500 sm:inline-flex"
            >
              <Avatar src={viewer.avatarUrl} name={viewer.displayName} size={26} />
              <span className="max-w-28 truncate text-xs font-medium text-ink-secondary">
                {viewer.displayName ?? viewer.publicId ?? 'Portal'}
              </span>
            </Link>
          )}

          <Dialog
            open={menuOpen}
            onOpenChange={(open) => {
              setMenu({ open, path: pathname });
            }}
          >
            <DialogTrigger asChild>
              <button
                type="button"
                aria-label="Open menu"
                className="rounded-sm p-2 text-ink transition-colors duration-(--duration-fast) hover:bg-elevated lg:hidden"
              >
                <Menu className="size-5" />
              </button>
            </DialogTrigger>

            <MobileNavigation
              viewer={viewer}
              discordInvite={discordInvite}
              serverState={serverState}
              playerCount={playerCount}
            />
          </Dialog>
        </div>
      </div>
    </header>
  );
}

/**
 * The mobile menu.
 *
 * Full-bleed and set large, with the links arriving in sequence. The stagger is
 * short - roughly 45ms a link, five links, so the last one lands 180ms after
 * the first - which is enough to read as a deck being dealt and not enough to
 * make anyone wait to tap the thing they opened the menu for.
 *
 * It covers the header rather than sitting below it and carries its own close
 * button. A panel that leaves the real header exposed looks tidier in a mockup
 * and is broken in practice: a modal dialog makes everything outside it inert,
 * so the hamburger the menu was opened with would be visible, obviously
 * clickable, and dead.
 */
function MobileNavigation({
  viewer,
  discordInvite,
  serverState,
  playerCount,
}: Omit<SiteHeaderProps, 'viewer'> & { viewer: HeaderViewer | null }): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <DialogContent
      layout="sheet"
      showClose={false}
      className={cn(
        'inset-0 max-w-none gap-0 rounded-none border-0 bg-void p-0',
        'lg:hidden',
        // The sheet's horizontal slide is wrong for something that fills the
        // screen; this one rises.
        'data-[state=open]:animate-slide-up data-[state=closed]:animate-fade-out',
      )}
    >
      <VisuallyHidden>
        <DialogTitle>Site navigation</DialogTitle>
      </VisuallyHidden>

      <div className="flex h-(--header-height) shrink-0 items-center justify-between gap-6 px-5">
        <DialogClose asChild>
          <Link href="/" aria-label="XenonRP home">
            <Wordmark />
          </Link>
        </DialogClose>
        <DialogClose asChild>
          <button
            type="button"
            aria-label="Close menu"
            className="rounded-sm p-2 text-ink transition-colors duration-(--duration-fast) hover:bg-elevated"
          >
            <X className="size-5" />
          </button>
        </DialogClose>
      </div>

      <nav aria-label="Primary mobile" className="flex flex-col px-5 pt-2">
        {links.map((link, index) => (
          <motion.div
            key={link.href}
            initial={reduced === true ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.05 + index * 0.045, ease: [0.16, 1, 0.3, 1] }}
          >
            <DialogClose asChild>
              <Link
                href={link.href}
                className="group flex items-baseline justify-between border-b border-line py-5"
              >
                <span className="font-display text-[2rem] leading-none font-extrabold tracking-tight text-ink transition-colors duration-(--duration-fast) group-hover:text-xenon">
                  {link.label.toUpperCase()}
                </span>
                {/*
                  Hidden from assistive technology. The index is typographic
                  furniture, and without this the link announces as "Rules 03" -
                  which is both noise to listen to and, because the accessible
                  name no longer matches the visible label, a link that cannot
                  be reached by voice control.
                */}
                <span aria-hidden className="font-mono text-[0.625rem] text-ink-muted">
                  {String(index + 1).padStart(2, '0')}
                </span>
              </Link>
            </DialogClose>
          </motion.div>
        ))}
      </nav>

      <motion.div
        className="mt-auto flex flex-col gap-3 p-5 pb-10"
        initial={reduced === true ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        <DialogClose asChild>
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
        </DialogClose>

        <Button variant="accent" size="lg" asChild>
          <Link href={viewer === null ? '/signin' : '/portal'}>
            {viewer === null ? 'Sign in with Discord' : 'Open your portal'}
          </Link>
        </Button>

        {discordInvite === null ? null : (
          <Button variant="outline" size="lg" asChild>
            <a href={discordInvite} target="_blank" rel="noopener noreferrer">
              Join the Discord
            </a>
          </Button>
        )}
      </motion.div>
    </DialogContent>
  );
}
