import { prisma } from '@xenon/database';

import type { Metadata } from 'next';

import { CharacterManager } from '~/components/portal/character-manager';
import { PortalPage } from '~/components/portal/portal-page';
import { requireUserId } from '~/server/context';

export const metadata: Metadata = {
  title: 'Your characters',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/** Matches MAX_CHARACTERS_PER_USER in the character service. */
const CHARACTER_LIMIT = 5;

export default async function CharactersPage(): Promise<React.ReactElement> {
  const userId = await requireUserId();

  const characters = await prisma.character.findMany({
    where: { userId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });

  return (
    <PortalPage
      title="Characters"
      lead="The people you play in Xenon. Applications can be attached to a character, and staff see them alongside your history."
    >
      <CharacterManager
        limit={CHARACTER_LIMIT}
        characters={characters.map((character) => ({
          id: character.id,
          publicId: character.publicId,
          firstName: character.firstName,
          lastName: character.lastName,
          alias: character.alias,
          occupation: character.occupation,
          backstory: character.backstory,
          // Serialised for the client component; the input expects yyyy-mm-dd.
          dateOfBirth: character.dateOfBirth?.toISOString().slice(0, 10) ?? null,
          status: character.status,
          createdAt: character.createdAt.toISOString(),
        }))}
      />
    </PortalPage>
  );
}
