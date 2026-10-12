import { z } from 'zod';

import { lazyEnv, parseEnv } from './parse';
import {
  datastoreSchema,
  requireInProduction,
  runtimeSchema,
  securitySchema,
  siteSchema,
} from './schema';

/**
 * Configuration for the Xenon Core API, the internal service Xenon Link calls.
 *
 * Core owns the database and Redis credentials Link deliberately lacks, and
 * verifies Link's requests with `LINK_CORE_SECRET`. It holds no Discord token,
 * Auth.js secret or FiveM bridge secret: it never talks to Discord or FXServer
 * itself, it records outbox work for the worker.
 */

const coreApiSchema = requireInProduction(
  runtimeSchema
    .extend(datastoreSchema.shape)
    .extend(securitySchema.shape)
    .extend({
      NEXT_PUBLIC_SITE_URL: siteSchema.shape.NEXT_PUBLIC_SITE_URL,
      /** Verifies Link → Core API requests. */
      LINK_CORE_SECRET: z.string().min(32, 'must be at least 32 characters'),
      CORE_API_HOST: z.string().trim().min(1).default('127.0.0.1'),
      CORE_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3300),
    }),
);

export type CoreApiEnv = z.output<typeof coreApiSchema>;

export function parseCoreApiEnv(source: Record<string, string | undefined>): CoreApiEnv {
  return parseEnv('core-api', coreApiSchema, source);
}

export const coreApiEnv: CoreApiEnv = lazyEnv(() => parseCoreApiEnv(process.env));
