import type { Db } from '@xenon/database';
import { type Actor, anonymousActor, resolveActor } from '@xenon/permissions';

/**
 * Discord user to `Actor`.
 *
 * Xenon Link reports which Discord user triggered an interaction; Core turns
 * that into a Xenon account through the stored snowflake and takes every
 * capability from the database - never from the Discord roles the clicker
 * happens to hold. Somebody given the staff colour in Discord by mistake gains
 * nothing here.
 *
 * The source is DISCORD so the audit log distinguishes an approval clicked on
 * an embed from one clicked on the website.
 */
export async function actorFromDiscord(db: Db, discordUserId: string): Promise<Actor> {
  const account = await db.discordAccount.findUnique({
    where: { discordId: discordUserId },
    select: { userId: true },
  });

  if (account === null) return anonymousActor('DISCORD');

  const actor = await resolveActor(db, { userId: account.userId, source: 'DISCORD' });
  return actor ?? anonymousActor('DISCORD');
}
