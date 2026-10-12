import { z } from 'zod';

import { EnvironmentValidationError, lazyEnv, parseEnv } from './parse';
import {
  datastoreSchema,
  discordSnowflake,
  fivemSchema,
  optional,
  requireInProduction,
  runtimeSchema,
  securitySchema,
  siteSchema,
} from './schema';

/**
 * Configuration for the Xenon worker: the job consumer, outbox relay, sweeps
 * and status polling.
 *
 * The worker owns the database and the queue but no Discord token. Every
 * Discord effect is a signed request to Xenon Link's gateway. With
 * `LINK_GATEWAY_MODE=http` the worker POSTs to `LINK_GATEWAY_URL`; with
 * `relay` it queues the request in Redis and Link pulls it through the Core
 * API (Link need not be reachable). Both sign with `LINK_GATEWAY_SECRET`.
 * FXServer is reached with the FiveM bridge secret.
 */

const workerSchema = requireInProduction(
  runtimeSchema
    .extend(datastoreSchema.shape)
    .extend(securitySchema.shape)
    .extend({
      NEXT_PUBLIC_SITE_URL: siteSchema.shape.NEXT_PUBLIC_SITE_URL,
      /** The one guild the worker reconciles; must match the primary guild row. */
      DISCORD_GUILD_ID: discordSnowflake,
      /** How Discord effects reach Link: direct HTTP, or the Core-API relay. */
      LINK_GATEWAY_MODE: z.enum(['http', 'relay']).default('http'),
      /** Required only when LINK_GATEWAY_MODE=http. */
      LINK_GATEWAY_URL: optional(z.url({ protocol: /^https?$/ })),
      /** Signs worker → Link gateway requests (both transports). */
      LINK_GATEWAY_SECRET: z.string().min(32, 'must be at least 32 characters'),
      FIVEM_BRIDGE_SECRET: fivemSchema.shape.FIVEM_BRIDGE_SECRET,
      WORKER_HEALTH_HOST: z.string().trim().min(1).default('127.0.0.1'),
      WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8083),
    }),
).superRefine((value, ctx) => {
  if (value.LINK_GATEWAY_MODE === 'http' && value.LINK_GATEWAY_URL === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['LINK_GATEWAY_URL'],
      message: 'is required when LINK_GATEWAY_MODE=http',
    });
  }
});

export type WorkerEnv = z.output<typeof workerSchema>;

export function parseWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  return parseEnv('worker', workerSchema, source);
}

export type LinkGatewayTarget =
  | { readonly mode: 'http'; readonly url: string }
  | { readonly mode: 'relay' };

/** How the worker reaches Link. Throws only if the env was not produced by `parseWorkerEnv`. */
export function linkGatewayTarget(env: WorkerEnv): LinkGatewayTarget {
  if (env.LINK_GATEWAY_MODE === 'relay') return { mode: 'relay' };
  if (env.LINK_GATEWAY_URL === undefined) {
    throw new EnvironmentValidationError('worker', [
      'LINK_GATEWAY_URL: is required when LINK_GATEWAY_MODE=http',
    ]);
  }
  return { mode: 'http', url: env.LINK_GATEWAY_URL };
}

export const workerEnv: WorkerEnv = lazyEnv(() => parseWorkerEnv(process.env));
