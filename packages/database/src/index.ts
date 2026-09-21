// Model types, enums, the `Prisma` namespace and the PrismaClient class.
export * from '../generated/client/client';

// The configured singleton and the transaction-aware handle every service takes.
export { prisma, transaction, type Db } from './client';
export { allocatePublicId } from './public-id';

// Type-level guard that core's domain unions still match the Prisma enums.
import './enum-parity';
