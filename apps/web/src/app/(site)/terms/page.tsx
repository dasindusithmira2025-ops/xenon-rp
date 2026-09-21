import { brand } from '@xenon/config';

import type { Metadata } from 'next';

import { LegalDocument } from '~/components/site/legal-document';

export const metadata: Metadata = {
  title: 'Terms',
  description: `The terms of using ${brand.name}: the website, the Discord and the city itself.`,
  alternates: { canonical: '/terms' },
};

export default function TermsPage(): React.ReactElement {
  return (
    <LegalDocument
      eyebrow="Terms"
      title="Using Xenon"
      updated="These terms cover this website, the Xenon Discord and the game server."
      sections={[
        {
          heading: 'What this is',
          body: [
            `${brand.name} is a community-run roleplay server for FiveM, a third-party modification for Grand Theft Auto V. It is not affiliated with, endorsed by, or connected to Rockstar Games, Take-Two Interactive or Cfx.re.`,
            'You need your own legitimate copy of Grand Theft Auto V to play. We do not provide the game.',
            'OPERATOR ACTION REQUIRED: name the responsible person or entity, and state which jurisdiction these terms are governed by, before launch.',
          ],
        },
        {
          heading: 'Your account',
          body: [
            'Your Xenon account is tied to one Discord account and to the game identifiers you link to it. One person, one account.',
            'You are responsible for what happens under your account. Sharing it, selling it, or letting somebody else play a whitelisted character is grounds for removal.',
            'Accounts created to get around a sanction are removed, along with the sanction being extended.',
          ],
        },
        {
          heading: 'The rules',
          body: [
            'The rulebook is part of these terms. It is published with a version number, and the version you accepted is recorded against your account.',
            'Rules change. When a new version is published you will be asked to read and accept it before you can apply for anything, and the previous version stays on record for anything that happened while it was in force.',
          ],
        },
        {
          heading: 'What you write',
          body: [
            'Applications, tickets, reports, appeals and character backstories stay yours. You give us permission to store them and to show them to the staff who need to handle them.',
            'Screenshots and clips you submit to the gallery may be shown publicly with credit. Tell us if you want something removed and we will remove it.',
            'Do not post anything you do not have the right to post.',
          ],
        },
        {
          heading: 'Whitelist and access',
          body: [
            'Whitelist access is granted at the discretion of the staff team and can be suspended or revoked.',
            'If your access is removed you will be told why, and you can appeal. Appeals are decided by someone other than whoever made the original call wherever that is possible.',
            'An application being rejected is not a permanent judgement. Most rejections come with a cooldown after which you are welcome to apply again.',
          ],
        },
        {
          heading: 'What gets you removed',
          body: [
            'Harassment, slurs, or hate of any kind, in or out of character.',
            'Cheating: menus, injectors, or anything that changes what the server believes is happening.',
            'Deliberately exploiting a bug rather than reporting it.',
            'Attempting to attack, overload or gain unauthorised access to the website, the Discord or the game server.',
            'Using someone else’s account, or selling yours.',
          ],
        },
        {
          heading: 'Availability',
          body: [
            'The server and the website are provided as they are. They go down sometimes, usually for a restart and occasionally because something broke.',
            'Characters, progress and in-game property are stored on the game server and can be lost. We take reasonable care and make no promise beyond that.',
            'There is no fee to play and no purchase confers a right to any particular level of service.',
          ],
        },
        {
          heading: 'Changes',
          body: [
            'These terms can change. Material changes will be announced in the news section.',
            'Continuing to use Xenon after a change means you accept it. If you do not, you can stop playing and ask for your account to be deleted.',
          ],
        },
      ]}
    />
  );
}
