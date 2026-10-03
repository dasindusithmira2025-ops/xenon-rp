// Model types, enums, the `Prisma` namespace and the PrismaClient class.
export * from '../generated/client/client';

// The configured singleton and the transaction-aware handle every service takes.
export { prisma, transaction, type Db } from './client';
export { DEV_DISCORD_FIXTURES, isDevFixtureDiscordId, seedDevFixtureUsers } from './dev-fixtures';
export { allocatePublicId } from './public-id';
export { seedBaseline } from './seed-baseline';
export { truncateAll } from './truncate';

// Type-level guard that core's domain unions still match the Prisma enums.
import './enum-parity';
