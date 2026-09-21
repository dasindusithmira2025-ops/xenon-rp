import { ConflictError, NotFoundError } from '@xenon/core';
import { allocatePublicId, type Character, type Db } from '@xenon/database';
import { type Actor, requireOwnerOrPermission, requireUser } from '@xenon/permissions';
import type { CharacterInput } from '@xenon/validation';

import { recordAudit } from './audit';

/**
 * Characters.
 *
 * Only the fields the schema already models are written here. Server-specific
 * attributes - cash, inventory, licences - belong to the game server and are
 * read through the FiveM adapter when needed, not duplicated into this database
 * where they would immediately go stale.
 */

/** How many characters one account may hold. Configurable later if needed. */
const MAX_CHARACTERS_PER_USER = 5;

export async function createCharacter(
  db: Db,
  actor: Actor,
  userId: string,
  input: CharacterInput,
): Promise<Character> {
  requireOwnerOrPermission(actor, userId, 'players.manage');

  const active = await db.character.count({
    where: { userId, status: { in: ['DRAFT', 'ACTIVE'] } },
  });
  if (active >= MAX_CHARACTERS_PER_USER) {
    throw new ConflictError(
      `Character limit reached for ${userId}`,
      `You can hold ${String(MAX_CHARACTERS_PER_USER)} active characters. Retire one to make room.`,
    );
  }

  const publicId = await allocatePublicId(db, 'character');

  const character = await db.character.create({
    data: {
      publicId,
      userId,
      firstName: input.firstName,
      lastName: input.lastName,
      alias: input.alias ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      occupation: input.occupation ?? null,
      backstory: input.backstory ?? null,
      status: 'ACTIVE',
    },
  });

  await recordAudit(db, actor, {
    action: 'character.created',
    entityType: 'character',
    entityId: character.id,
    entityLabel: character.publicId,
    after: { name: `${character.firstName} ${character.lastName}` },
  });

  return character;
}

export async function updateCharacter(
  db: Db,
  actor: Actor,
  characterId: string,
  input: CharacterInput,
): Promise<Character> {
  const existing = await db.character.findUnique({ where: { id: characterId } });
  if (existing === null) throw new NotFoundError('Character', characterId);

  requireOwnerOrPermission(actor, existing.userId, 'players.manage');

  const character = await db.character.update({
    where: { id: characterId },
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      alias: input.alias ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      occupation: input.occupation ?? null,
      backstory: input.backstory ?? null,
    },
  });

  await recordAudit(db, actor, {
    action: 'character.updated',
    entityType: 'character',
    entityId: character.id,
    entityLabel: character.publicId,
    before: { name: `${existing.firstName} ${existing.lastName}` },
    after: { name: `${character.firstName} ${character.lastName}` },
  });

  return character;
}

/**
 * Retire a character.
 *
 * Retirement rather than deletion: submissions, tickets and audit entries all
 * reference the character, and a hole in that history is worse than a row
 * marked RETIRED.
 */
export async function retireCharacter(
  db: Db,
  actor: Actor,
  characterId: string,
  status: 'RETIRED' | 'DECEASED' = 'RETIRED',
): Promise<Character> {
  const existing = await db.character.findUnique({ where: { id: characterId } });
  if (existing === null) throw new NotFoundError('Character', characterId);

  requireOwnerOrPermission(actor, existing.userId, 'players.manage');

  const character = await db.character.update({
    where: { id: characterId },
    data: { status, retiredAt: new Date() },
  });

  await recordAudit(db, actor, {
    action: 'character.retired',
    entityType: 'character',
    entityId: characterId,
    entityLabel: character.publicId,
    before: { status: existing.status },
    after: { status },
  });

  return character;
}

/** A player's own characters, active first. */
export async function listCharacters(
  db: Db,
  actor: Actor,
  userId?: string,
): Promise<readonly Character[]> {
  const target = userId ?? requireUser(actor);
  requireOwnerOrPermission(actor, target, 'players.view');

  return db.character.findMany({
    where: { userId: target },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
}
