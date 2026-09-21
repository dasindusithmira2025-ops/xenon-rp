import { prisma } from '@xenon/database';
import { anonymousActor, resolveActor } from '@xenon/permissions';
/**
 * Discord user to `Actor`.
 *
 * The bot's authorization story in one function. A Discord user is resolved to
 * a Xenon account through the stored snowflake, and capabilities come from the
 * database - never from which Discord roles the clicker happens to hold.
 *
 * That distinction is the whole point of the architecture. Somebody who is
 * given the staff colour in Discord by mistake gains nothing here, because the
 * button handler asks Postgres what they may do.
 *
 * The source is recorded as DISCORD so the audit log distinguishes an approval
 * clicked on an embed from one clicked on the website.
 */
export async function actorFromDiscord(discordUserId) {
  const account = await prisma.discordAccount.findUnique({
    where: { discordId: discordUserId },
    select: { userId: true },
  });
  if (account === null) return anonymousActor('DISCORD');
  const actor = await resolveActor(prisma, { userId: account.userId, source: 'DISCORD' });
  return actor ?? anonymousActor('DISCORD');
}
/** True when this Discord user has a Xenon account at all. */
export async function hasLinkedAccount(discordUserId) {
  const account = await prisma.discordAccount.findUnique({
    where: { discordId: discordUserId },
    select: { id: true },
  });
  return account !== null;
}
//# sourceMappingURL=actor.js.map
