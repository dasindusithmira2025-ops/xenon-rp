import { ArrowUpRight, BookOpen, LifeBuoy, ShieldAlert } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { allSettings } from '@xenon/domain';
import { Button, Panel } from '@xenon/ui';

import type { Metadata } from 'next';

import { PageHeader, Section } from '~/components/site/section';
import { SupportForms } from '~/components/support/support-forms';
import { currentActor } from '~/server/context';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'Get help with your XenonRP account, report a rule break, or appeal a decision. Every ticket is answered by a person.',
  alternates: { canonical: '/support' },
};

export const dynamic = 'force-dynamic';

const routes = [
  {
    icon: LifeBuoy,
    title: 'Something is wrong with my account',
    body: 'Whitelist, applications, linking, or anything that stops you playing. Open a ticket.',
  },
  {
    icon: ShieldAlert,
    title: 'Someone broke the rules',
    body: 'File a report with as much detail as you can. Reports about staff go to a separate team.',
  },
  {
    icon: BookOpen,
    title: 'I want to understand a rule',
    body: 'The rulebook is searchable by shorthand and every rule has its own link.',
  },
] as const;

export default async function SupportPage(): Promise<React.ReactElement> {
  const [actor, settings] = await Promise.all([currentActor(), allSettings(prisma)]);

  const invite = settings['community.discordInvite'];
  const discordInvite = invite !== undefined && invite.length > 0 ? invite : null;

  const openTickets =
    actor.userId === null
      ? 0
      : await prisma.ticket.count({
          where: { authorId: actor.userId, status: { notIn: ['CLOSED', 'RESOLVED'] } },
        });

  return (
    <>
      <PageHeader
        eyebrow="Support"
        title={
          <>
            Talk to
            <br />a person
          </>
        }
        lead="Every ticket, report and appeal is read by a member of staff. Nothing here is answered by a bot."
      />

      <Section width="wide" size="sm">
        <div className="grid gap-4 md:grid-cols-3">
          {routes.map((route) => (
            <Panel key={route.title} tone="flat" pad="lg" className="flex flex-col gap-3">
              <route.icon className="size-5 text-xenon" aria-hidden />
              <h2 className="font-display text-base font-bold text-ink">{route.title}</h2>
              <p className="text-sm leading-relaxed text-ink-muted">{route.body}</p>
            </Panel>
          ))}
        </div>
      </Section>

      <Section width="content" size="sm">
        <div className="grid gap-10 lg:grid-cols-[1.6fr_1fr] lg:gap-14">
          <div>
            {actor.userId === null ? (
              <Panel tone="raised" pad="xl" edgeLight className="flex flex-col items-start gap-5">
                <h2 className="font-display text-title font-bold text-ink">
                  Sign in to open a ticket
                </h2>
                <p className="max-w-lg leading-relaxed text-ink-secondary">
                  Tickets are attached to your Xenon account so staff can see your history and you
                  can follow the reply in your portal. Signing in takes one click with Discord.
                </p>
                <Button variant="accent" size="lg" asChild>
                  <Link href="/signin?callbackUrl=/support">Sign in with Discord</Link>
                </Button>
              </Panel>
            ) : (
              <SupportForms />
            )}
          </div>

          <aside className="flex flex-col gap-4 lg:sticky lg:top-28 lg:self-start">
            {actor.userId !== null && openTickets > 0 ? (
              <Panel tone="accent" pad="lg">
                <p className="font-medium text-ink">
                  You have {openTickets} open ticket{openTickets === 1 ? '' : 's'}
                </p>
                <Button variant="outline" asChild className="mt-4 w-full">
                  <Link href="/portal/tickets">View your tickets</Link>
                </Button>
              </Panel>
            ) : null}

            <Panel tone="flat" pad="lg">
              <p className="x-eyebrow">Before you write</p>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-ink-secondary">
                <li>Check the rulebook - most questions are answered there.</li>
                <li>Include your Xenon ID if you have one.</li>
                <li>Times in UTC, or say which timezone you mean.</li>
                <li>Clips and screenshots make a report far quicker to action.</li>
              </ul>
              <Button variant="ghost" asChild className="mt-5 w-full">
                <Link href="/rules">Open the rulebook</Link>
              </Button>
            </Panel>

            {discordInvite === null ? null : (
              <Panel tone="flat" pad="lg">
                <p className="x-eyebrow">Community</p>
                <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
                  General questions are often answered fastest in the Discord.
                </p>
                <Button variant="outline" asChild className="mt-5 w-full">
                  <a href={discordInvite} target="_blank" rel="noopener noreferrer">
                    Open Discord <ArrowUpRight />
                  </a>
                </Button>
              </Panel>
            )}
          </aside>
        </div>
      </Section>
    </>
  );
}
