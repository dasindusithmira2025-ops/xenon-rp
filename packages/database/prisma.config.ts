import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer reads `.env` implicitly and no longer accepts `url` inside
// the schema, so the connection string is wired up here instead.
import '@xenon/config/load-env';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
