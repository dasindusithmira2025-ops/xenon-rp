import '@xenon/config/load-env';

import { prisma } from '../src/client';
import { seedBaseline } from '../src/seed-baseline';

/**
 * Baseline seed.
 *
 * Idempotent and safe to run against production on every deploy. The work
 * itself lives in `src/seed-baseline.ts` so the integration suite runs the
 * same code; this file is only the command-line wrapper around it.
 *
 * Nothing here invents community content. Departments, rule text, application
 * questions, Discord role IDs and server addresses are all configured from
 * /control by staff, because guessing them would put fiction in the database
 * that somebody later has to find and delete.
 *
 * Development fixtures live in `seed-dev.ts` and are never run automatically.
 */
async function main(): Promise<void> {
  const { permissions, roles } = await seedBaseline(prisma);

  // eslint-disable-next-line no-console -- a seed script's output is its result
  console.log(
    `Seeded ${String(permissions)} capabilities and ${String(roles)} roles.\n` +
      'Next: assign the Owner role to your account once you have signed in with Discord.\n' +
      '  pnpm --filter @xenon/database exec tsx prisma/grant-owner.ts <discord-user-id>',
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
