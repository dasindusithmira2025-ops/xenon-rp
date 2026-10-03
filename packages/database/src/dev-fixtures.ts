import { transaction, type Db } from './client';
import { allocatePublicId } from './public-id';

/**
 * Development-only identity keys. These are deliberately not Discord
 * snowflakes, so a real OAuth profile can never have the same ID.
 */
export const DEV_DISCORD_FIXTURES = {
  player: {
    discordId: 'xenon-dev-fixture-player',
    username: 'dev_player',
    displayName: 'Dev Player',
    roleKeys: ['member'],
    legacyDiscordId: '900000000000000001',
  },
  staff: {
    discordId: 'xenon-dev-fixture-staff',
    username: 'dev_staff',
    displayName: 'Dev Staff',
    roleKeys: ['member', 'owner'],
    legacyDiscordId: '900000000000000002',
  },
} as const;

const devFixtureDiscordIds = new Set<string>(
  Object.values(DEV_DISCORD_FIXTURES).map((fixture) => fixture.discordId),
);

/** Exact allowlist used by the local development sign-in route. */
export function isDevFixtureDiscordId(discordId: string): boolean {
  return devFixtureDiscordIds.has(discordId);
}

/**
 * Create the local fixture users or migrate the two historical numeric IDs.
 *
 * The legacy migration is intentionally strict: the Discord profile fields
 * and Xenon display name must still match the original seed data, and there
 * must be no Auth.js Discord account row. Anything else needs an operator to
 * inspect it rather than a seed script claiming the identity.
 */
export async function seedDevFixtureUsers(db: Db): Promise<number> {
  for (const fixture of Object.values(DEV_DISCORD_FIXTURES)) {
    await transaction(db, async (tx) => {
      const [current, legacy] = await Promise.all([
        tx.discordAccount.findUnique({
          where: { discordId: fixture.discordId },
          select: { userId: true, username: true },
        }),
        tx.discordAccount.findUnique({
          where: { discordId: fixture.legacyDiscordId },
          select: { discordId: true, userId: true, username: true, globalName: true },
        }),
      ]);

      if (current !== null && legacy !== null) {
        throw new Error(
          `Both current and legacy Discord fixture identities exist for ${fixture.displayName}; inspect them before seeding.`,
        );
      }

      let userId: string;
      if (current !== null) {
        if (current.username !== fixture.username) {
          throw new Error(
            `Discord fixture key ${fixture.discordId} belongs to unexpected profile ${current.username}; refusing to change it.`,
          );
        }
        userId = current.userId;
      } else if (legacy !== null) {
        const owner = await tx.user.findUnique({
          where: { id: legacy.userId },
          select: { publicId: true, displayName: true, deletedAt: true },
        });
        const isOriginalFixture =
          owner !== null &&
          owner.deletedAt === null &&
          /^XN-\d+$/.test(owner.publicId) &&
          owner.displayName === fixture.displayName &&
          legacy.username === fixture.username &&
          legacy.globalName === fixture.displayName;

        if (!isOriginalFixture) {
          throw new Error(
            `Legacy Discord ID ${fixture.legacyDiscordId} is not clearly owned by the original ${fixture.displayName} development fixture; refusing to detach it.`,
          );
        }

        const authAccount = await tx.account.findUnique({
          where: {
            provider_providerAccountId: {
              provider: 'discord',
              providerAccountId: fixture.legacyDiscordId,
            },
          },
          select: { userId: true },
        });
        if (authAccount !== null) {
          throw new Error(
            `Legacy Discord ID ${fixture.legacyDiscordId} has an Auth.js provider link; refusing to reassign it automatically.`,
          );
        }

        // Keep the same Xenon user and all of its domain data. Only replace
        // the seed's colliding key and revoke sessions for this verified
        // fixture-only user, so a stale fixture login cannot turn the next
        // OAuth sign-in into an account-link attempt.
        await tx.discordAccount.update({
          where: { discordId: fixture.legacyDiscordId },
          data: { discordId: fixture.discordId },
        });
        await tx.session.deleteMany({ where: { userId: legacy.userId } });

        userId = legacy.userId;
      } else {
        const user = await tx.user.create({
          data: {
            publicId: await allocatePublicId(tx, 'user'),
            displayName: fixture.displayName,
            onboardingStep: 'DISCORD_CONNECTED',
            discordAccount: {
              create: {
                discordId: fixture.discordId,
                username: fixture.username,
                globalName: fixture.displayName,
                isGuildMember: true,
                guildMembershipState: 'MEMBER',
                guildJoinedAt: new Date(),
              },
            },
          },
        });
        userId = user.id;
      }

      for (const key of fixture.roleKeys) {
        const role = await tx.role.findUnique({ where: { key } });
        if (role === null) continue;
        await tx.userRole.upsert({
          where: { userId_roleId: { userId, roleId: role.id } },
          create: { userId, roleId: role.id },
          update: {},
        });
      }
    });
  }

  return Object.keys(DEV_DISCORD_FIXTURES).length;
}
