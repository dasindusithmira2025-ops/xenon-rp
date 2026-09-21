'use client';

import {
  Activity,
  Building2,
  FileCog,
  FileText,
  Flag,
  Gauge,
  Gavel,
  Image as ImageIcon,
  KeyRound,
  LifeBuoy,
  Link2,
  Menu,
  Newspaper,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { Avatar, cn } from '@xenon/ui';

import { XenonMark } from '~/components/brand/wordmark';

/**
 * Control centre navigation.
 *
 * Same design language as the public site, entirely different information
 * density. This is operational software: the sidebar is compact, grouped by
 * what staff actually do, and every entry is filtered by capability.
 *
 * The filtering is presentation only. Every page behind these links checks its
 * own capability server-side, and every mutation checks again in the service.
 * A hidden link is a courtesy, not a control.
 */

export interface ControlViewer {
  readonly displayName: string | null;
  readonly publicId: string;
  readonly avatarUrl: string | null;
  readonly permissions: readonly string[];
  readonly roleNames: readonly string[];
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  /** Shown when the actor holds any of these. Empty means always. */
  readonly permissions: readonly string[];
  readonly exact?: boolean;
}

interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const groups: readonly NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/control', label: 'Dashboard', icon: Gauge, permissions: [], exact: true }],
  },
  {
    label: 'Applications',
    items: [
      {
        href: '/control/applications',
        label: 'Review queue',
        icon: FileText,
        permissions: ['applications.view'],
        exact: true,
      },
      {
        href: '/control/applications/templates',
        label: 'Form builder',
        icon: FileCog,
        permissions: ['applications.manage_templates'],
      },
    ],
  },
  {
    label: 'Players',
    items: [
      { href: '/control/players', label: 'Players', icon: Users, permissions: ['players.view'] },
    ],
  },
  {
    label: 'Community',
    items: [
      {
        href: '/control/tickets',
        label: 'Tickets',
        icon: LifeBuoy,
        permissions: ['tickets.view'],
      },
      {
        href: '/control/reports',
        label: 'Reports',
        icon: ShieldAlert,
        permissions: ['reports.view', 'reports.staff.view'],
      },
      { href: '/control/appeals', label: 'Appeals', icon: Gavel, permissions: ['appeals.view'] },
    ],
  },
  {
    label: 'Organisation',
    items: [
      {
        href: '/control/departments',
        label: 'Departments',
        icon: Building2,
        permissions: ['departments.manage'],
      },
      {
        href: '/control/staff',
        label: 'Staff and roles',
        icon: KeyRound,
        permissions: ['staff.view'],
      },
    ],
  },
  {
    label: 'Content',
    items: [
      { href: '/control/news', label: 'News', icon: Newspaper, permissions: ['content.edit'] },
      {
        href: '/control/gallery',
        label: 'Gallery',
        icon: ImageIcon,
        permissions: ['content.edit'],
      },
      { href: '/control/rules', label: 'Rulebook', icon: ScrollText, permissions: ['rules.edit'] },
    ],
  },
  {
    label: 'Integrations',
    items: [
      {
        href: '/control/discord',
        label: 'Discord',
        icon: Link2,
        permissions: ['discord.manage'],
      },
      {
        href: '/control/fivem',
        label: 'Game servers',
        icon: Server,
        permissions: ['fivem.manage'],
      },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/control/audit', label: 'Audit log', icon: ScrollText, permissions: ['audit.view'] },
      { href: '/control/health', label: 'Health', icon: Activity, permissions: [] },
      {
        href: '/control/settings',
        label: 'Settings',
        icon: Settings,
        permissions: ['system.manage'],
      },
      {
        href: '/control/flags',
        label: 'Feature flags',
        icon: Flag,
        permissions: ['system.manage'],
      },
    ],
  },
];

function visible(item: NavItem, held: ReadonlySet<string>): boolean {
  return item.permissions.length === 0 || item.permissions.some((key) => held.has(key));
}

export function ControlShell({
  viewer,
  fixturesLoaded,
  children,
}: {
  viewer: ControlViewer;
  /** Renders the standing banner while seed-dev content is in the database. */
  fixturesLoaded: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const [menuState, setMenuState] = React.useState({ open: false, path: pathname });
  const menuOpen = menuState.open && menuState.path === pathname;

  const held = React.useMemo(() => new Set(viewer.permissions), [viewer.permissions]);

  const nav = (
    <nav aria-label="Control centre" className="flex flex-col gap-6">
      {groups.map((group) => {
        const items = group.items.filter((item) => visible(item, held));
        if (items.length === 0) return null;

        return (
          <div key={group.label} className="flex flex-col gap-1">
            <p className="x-eyebrow px-3 pb-1">{group.label}</p>
            {items.map((item) => {
              const active =
                item.exact === true
                  ? pathname === item.href
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-sm px-3 py-1.5 text-[0.8125rem] transition-colors duration-(--duration-fast)',
                    active
                      ? 'bg-elevated text-ink'
                      : 'text-ink-muted hover:bg-elevated/50 hover:text-ink-secondary',
                  )}
                >
                  <item.icon className="size-3.5 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <header className="sticky top-0 z-[40] flex items-center justify-between gap-3 border-b border-line bg-void/95 px-4 py-3 backdrop-blur-lg lg:hidden">
        <Link href="/control" className="inline-flex items-center gap-2">
          <XenonMark className="size-5" />
          <span className="font-mono text-[0.625rem] tracking-[0.2em] text-ink-secondary uppercase">
            Control
          </span>
        </Link>
        <button
          type="button"
          onClick={() => {
            setMenuState({ open: !menuOpen, path: pathname });
          }}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          className="rounded-sm p-2 text-ink"
        >
          {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
      </header>

      <aside
        className={cn(
          'border-line bg-black lg:block lg:w-60 lg:shrink-0 lg:border-r',
          menuOpen ? 'block border-b' : 'hidden',
        )}
      >
        <div className="flex flex-col gap-6 p-4 lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto lg:p-5">
          <Link href="/control" className="hidden items-center gap-2.5 lg:flex">
            <XenonMark className="size-5" />
            <span className="font-mono text-[0.625rem] tracking-[0.2em] text-ink-secondary uppercase">
              Control
            </span>
          </Link>

          {nav}

          <div className="mt-auto flex flex-col gap-2 border-t border-line pt-4">
            <Link
              href="/portal"
              className="flex items-center gap-2.5 rounded-sm px-3 py-1.5 text-[0.8125rem] text-ink-muted transition-colors hover:text-ink-secondary"
            >
              <Avatar src={viewer.avatarUrl} name={viewer.displayName} size={20} />
              <span className="min-w-0 truncate">{viewer.displayName ?? viewer.publicId}</span>
            </Link>
            <p className="px-3 font-mono text-[0.5625rem] tracking-[0.14em] text-ink-muted uppercase">
              {viewer.roleNames.join(' · ')}
            </p>
          </div>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1">
        {fixturesLoaded ? (
          <div
            role="status"
            className="border-b border-warning/30 bg-warning/10 px-5 py-2 text-center text-xs text-warning"
          >
            Development fixture content is loaded. Departments, rules, questions and news in this
            database are invented for development and must be replaced before launch.
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
