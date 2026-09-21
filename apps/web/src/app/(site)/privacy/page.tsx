import { brand } from '@xenon/config';

import type { Metadata } from 'next';

import { LegalDocument } from '~/components/site/legal-document';

export const metadata: Metadata = {
  title: 'Privacy',
  description: `What data ${brand.name} stores about you, why, and how to have it removed.`,
  alternates: { canonical: '/privacy' },
};

/**
 * /privacy
 *
 * Written from what the code actually does, not from a template. Every claim
 * here is checkable against the schema: `Session.ipHash`, `LinkToken.codeHash`,
 * `AuditLog`, the `accounts` table holding provider tokens.
 *
 * The operator-specific parts - who the data controller is, and the contact
 * address for a deletion request - are marked, because inventing them would be
 * inventing a legal fact.
 */
export default function PrivacyPage(): React.ReactElement {
  return (
    <LegalDocument
      eyebrow="Privacy"
      title="What we store, and why"
      updated="This notice describes the platform as built. Operators must review it before launch."
      sections={[
        {
          heading: 'Who we are',
          body: [
            `${brand.name} is a community-run FiveM roleplay server. The community operators are the data controller for everything described here.`,
            'OPERATOR ACTION REQUIRED: replace this paragraph with the responsible person or entity, and a contact address for privacy requests, before the site goes live.',
          ],
        },
        {
          heading: 'What we collect',
          body: [
            'Your Discord account. When you sign in we store your Discord user ID, username, display name, avatar and - if you granted it - your email address. The Discord ID is the stable key; the rest is a copy that we refresh when you sign in.',
            'Your Xenon account. A public identifier such as XN-10082, a display name, and anything you choose to put on your profile: pronouns, timezone, a short bio.',
            'What you write. Applications, support tickets, reports, appeals and the characters you create. These are stored in full and are visible to the staff who handle them.',
            'Your game identifiers. When you link your FiveM account we store the identifiers the game server reports, such as your Steam and Rockstar licence IDs. These are how the server knows you are whitelisted.',
            'Technical records. A hashed form of your IP address and your browser user agent are recorded against sessions, submissions and reports. We store a hash rather than the address itself, and the hash is salted with a secret that is not in the database.',
          ],
        },
        {
          heading: 'What we do not do',
          body: [
            'We do not sell your data, and we do not share it with advertisers.',
            'We do not read your Discord messages. The bot uses interactions and does not request the message content intent.',
            'We do not store your Discord password. Sign-in happens on Discord and we never see it.',
          ],
        },
        {
          heading: 'Why we keep it',
          body: [
            'To run the whitelist. Applications, decisions and game identifiers exist so the server can tell who is allowed in.',
            'To answer you. Tickets, reports and appeals are kept so a conversation from March still makes sense in September.',
            'To be accountable. Every consequential staff action writes an audit entry naming who did it and when. That record is what makes an appeal possible.',
            'To stop abuse. Hashed addresses and rate limits exist to make automated abuse expensive. They are not used for profiling.',
          ],
        },
        {
          heading: 'How long we keep it',
          body: [
            'Account data is kept while your account exists.',
            'Applications, tickets, reports and appeals are kept while your account exists, because they are the history an appeal or a future application is judged against.',
            'Audit records are kept indefinitely. They are the accountability record for staff decisions and are deliberately not deletable from the interface.',
            'Link codes are deleted a week after they are used or expire. Only a hash is ever stored.',
            'Server status readings older than a week are deleted automatically.',
          ],
        },
        {
          heading: 'Who can see it',
          body: [
            'You can see everything about yourself in your portal.',
            'Staff can see what their role allows and nothing more. Access is capability-based: someone who can answer tickets cannot necessarily read applications, and reports filed against staff are behind a separate permission that most staff do not hold.',
            'Discord receives only what is needed to deliver a notification or reconcile a role. The content of your application is never posted publicly.',
            'The game server receives your identifiers and whether you are whitelisted. It does not receive your application answers.',
          ],
        },
        {
          heading: 'Your choices',
          body: [
            'You can edit your profile and unlink your game identifiers at any time from your portal.',
            'You can ask for your account to be deleted. Your profile, characters and linked identities are removed. Audit entries recording staff decisions are retained but no longer name you: the actor field is cleared and only the recorded display label at the time remains.',
            'You can withdraw an application you have not yet had decided.',
            'OPERATOR ACTION REQUIRED: add the address people should write to for a deletion request, and the timescale you commit to.',
          ],
        },
        {
          heading: 'Cookies',
          body: [
            'One cookie: your session. It is HTTP-only, SameSite protected, and marked Secure in production, which means JavaScript cannot read it and it is not sent on cross-site requests.',
            'There is no analytics cookie and no advertising cookie on this site.',
          ],
        },
        {
          heading: 'Changes',
          body: [
            'If this notice changes materially we will say so in the news section rather than quietly editing the page.',
          ],
        },
      ]}
    />
  );
}
