import { z } from 'zod';

import { lazyEnv, parseEnv } from './parse';
import { discordSnowflake, optional, runtimeSchema } from './schema';

/**
 * Configuration for Xenon Guardian, the security and community Discord app.
 *
 * Guardian is deliberately isolated: it holds its own bot token and nothing
 * else. Database, Redis, Auth.js, FiveM and Link/Core secrets are neither
 * accepted nor required, so a Guardian host cannot leak platform credentials
 * and keeps protecting the server when every platform service is down.
 *
 * Production and info logging are literal requirements, as they were for the
 * former discord-only runtime: Guardian only ever runs as a production service.
 */
const guardianSchema = runtimeSchema
  .extend({
    NODE_ENV: z.literal('production'),
    LOG_LEVEL: z.literal('info'),
    GUARDIAN_DISCORD_TOKEN: z.string().trim().min(1),
    GUARDIAN_DISCORD_APPLICATION_ID: discordSnowflake,
    DISCORD_GUILD_ID: discordSnowflake,
    DISCORD_INVITE_URL: z.url(),
    /** Optional: only used for the ticket panel's website button. */
    NEXT_PUBLIC_SITE_URL: optional(z.url()),
    GUARDIAN_HEALTH_HOST: z.string().trim().min(1).default('127.0.0.1'),
    GUARDIAN_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
    // Read only for the token-collision guard below; never part of the output.
    LINK_DISCORD_TOKEN: optional(z.string().trim()),
    LINK_DISCORD_APPLICATION_ID: optional(z.string().trim()),
  })
  .superRefine((env, context) => {
    // Guardian and Link are separate Discord applications. Running both
    // processes with one token would put two gateways (and two command
    // registries) on the same account.
    if (
      env.LINK_DISCORD_TOKEN !== undefined &&
      env.LINK_DISCORD_TOKEN === env.GUARDIAN_DISCORD_TOKEN
    )
      context.addIssue({
        code: 'custom',
        path: ['GUARDIAN_DISCORD_TOKEN'],
        message:
          'must differ from LINK_DISCORD_TOKEN (Guardian and Link are separate applications)',
      });
    if (
      env.LINK_DISCORD_APPLICATION_ID !== undefined &&
      env.LINK_DISCORD_APPLICATION_ID === env.GUARDIAN_DISCORD_APPLICATION_ID
    )
      context.addIssue({
        code: 'custom',
        path: ['GUARDIAN_DISCORD_APPLICATION_ID'],
        message:
          'must differ from LINK_DISCORD_APPLICATION_ID (Guardian and Link are separate applications)',
      });
  })
  .transform(({ LINK_DISCORD_TOKEN: _token, LINK_DISCORD_APPLICATION_ID: _id, ...env }) => env);

export type GuardianEnv = z.output<typeof guardianSchema>;

export function parseGuardianEnv(source: Record<string, string | undefined>): GuardianEnv {
  return parseEnv('guardian', guardianSchema, source);
}

export const guardianEnv: GuardianEnv = lazyEnv(() => parseGuardianEnv(process.env));
