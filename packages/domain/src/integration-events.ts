import { NotFoundError } from '@xenon/core';
import type { Db } from '@xenon/database';

/**
 * Shared helpers for the integration events domain services emit.
 *
 * Events identify a player by Xenon id and, when there is one, the Discord
 * snowflake. Game identifiers never appear in an event: consumers that need
 * them ask Core, which applies its own authorization.
 */

const SNOWFLAKE = /^\d{17,20}$/;

/** A Discord id fit for an event payload, or null for fixtures and unlinked accounts. */
export function eventDiscordId(discordId: string | null | undefined): string | null {
  return discordId !== null && discordId !== undefined && SNOWFLAKE.test(discordId)
    ? discordId
    : null;
}

export interface EventSubject {
  readonly playerPublicId: string;
  readonly discordId: string | null;
}

/** The player an event is about, read through the caller's transaction. */
export async function eventSubject(db: Db, userId: string): Promise<EventSubject> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { publicId: true, discordAccount: { select: { discordId: true } } },
  });
  if (user === null) throw new NotFoundError('User', userId);
  return {
    playerPublicId: user.publicId,
    discordId: eventDiscordId(user.discordAccount?.discordId),
  };
}

/** Event text fields are bounded by the contract; clip rather than fail the decision. */
export function eventText(value: string | null | undefined, max: number, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return (trimmed.length > 0 ? trimmed : fallback).slice(0, max);
}
