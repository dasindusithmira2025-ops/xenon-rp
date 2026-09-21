import '@xenon/config/load-env';

import { prisma } from '../src/client';
import { seedBaseline } from '../src/seed-baseline';
import { truncateAll } from '../src/truncate';

/**
 * Empty a test database and rebuild the baseline.
 *
 * Deliberately not `prisma migrate reset`: this leaves the schema and the
 * migration history alone and only removes rows, which is both faster and a
 * great deal harder to point at something that matters. `truncateAll` refuses
 * to run when NODE_ENV says production.
 */
async function main(): Promise<void> {
  const tables = await truncateAll(prisma);
  const { permissions, roles } = await seedBaseline(prisma);

  // eslint-disable-next-line no-console -- a CLI script's output is its result
  console.log(
    `Emptied ${String(tables)} tables, reseeded ${String(permissions)} capabilities and ${String(roles)} roles.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
