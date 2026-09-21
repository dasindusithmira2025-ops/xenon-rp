// Model types, enums, the `Prisma` namespace and the PrismaClient class.
export * from '../generated/client/client';

// The configured singleton and the transaction-aware handle every service takes.
export { prisma, type Db } from './client';
