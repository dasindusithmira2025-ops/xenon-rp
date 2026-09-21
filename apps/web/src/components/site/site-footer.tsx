import Link from 'next/link';

import { brand } from '@xenon/config';
import { Separator } from '@xenon/ui';

import { Wordmark } from '~/components/brand/wordmark';

/**
 * Site footer.
 *
 * Social links are rendered only when the operator has configured them. A dead
 * icon row is worse than no icon row: it advertises channels that do not exist
 * and invites people to click into nothing.
 */

export interface SiteFooterProps {
  readonly discordInvite: string | null;
  readonly socials: readonly { label: string; href: string }[];
  readonly ruleVersion: number | null;
}

const columns = [
  {
    heading: 'The city',
    links: [
      { href: '/city', label: 'Life in Xenon' },
      { href: '/departments', label: 'Departments' },
      { href: '/gallery', label: 'Gallery' },
      { href: '/status', label: 'Server status' },
    ],
  },
  {
    heading: 'Join',
    links: [
      { href: '/applications', label: 'Applications' },
      { href: '/rules', label: 'Rulebook' },
      { href: '/community', label: 'Community' },
      { href: '/news', label: 'News' },
    ],
  },
  {
    heading: 'Help',
    links: [
      { href: '/support', label: 'Support' },
      { href: '/portal', label: 'Player portal' },
      { href: '/privacy', label: 'Privacy' },
      { href: '/terms', label: 'Terms' },
    ],
  },
] as const;

export function SiteFooter({
  discordInvite,
  socials,
  ruleVersion,
}: SiteFooterProps): React.ReactElement {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line bg-black">
      <div className="mx-auto max-w-wide px-5 py-14 lg:px-8 lg:py-20">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)] md:gap-8">
          <div className="flex flex-col gap-5">
            <Wordmark />
            <p className="max-w-xs text-sm leading-relaxed text-ink-muted">
              {brand.name} is a Sri Lankan FiveM roleplay city. Your actions create your reputation.
              Your story defines the city.
            </p>

            {discordInvite === null && socials.length === 0 ? null : (
              <div className="flex flex-wrap gap-2">
                {discordInvite === null ? null : (
                  <a
                    href={discordInvite}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[0.625rem] tracking-[0.14em] text-ink-secondary uppercase transition-colors hover:border-xenon/40 hover:text-xenon"
                  >
                    Discord
                  </a>
                )}
                {socials.map((social) => (
                  <a
                    key={social.href}
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[0.625rem] tracking-[0.14em] text-ink-secondary uppercase transition-colors hover:border-xenon/40 hover:text-xenon"
                  >
                    {social.label}
                  </a>
                ))}
              </div>
            )}
          </div>

          {columns.map((column) => (
            <nav key={column.heading} aria-label={column.heading} className="flex flex-col gap-3">
              <p className="x-eyebrow">{column.heading}</p>
              {column.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm text-ink-secondary transition-colors hover:text-xenon"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          ))}
        </div>

        <Separator className="my-10" />

        <div className="flex flex-col gap-4 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {brand.name}. Not affiliated with Rockstar Games or Take-Two Interactive.
          </p>
          <p className="font-mono tracking-[0.1em]">
            {ruleVersion === null ? 'RULEBOOK UNPUBLISHED' : `RULEBOOK V${String(ruleVersion)}`}
          </p>
        </div>
      </div>
    </footer>
  );
}
