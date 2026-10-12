import { z } from 'zod';

import { EnvironmentValidationError, lazyEnv, parseEnv } from './parse';
import { discordSnowflake, optional, runtimeSchema } from './schema';

/**
 * Configuration for Xenon Link, the platform Discord application.
 *
 * Link holds its own Discord credentials, the secret it signs Core API calls
 * with and the secret the worker signs gateway calls with. It never receives
 * a database, Redis, Auth.js, storage or FiveM credential: every read and
 * decision goes through the Core API.
 */

const serviceSecret = z.string().min(32, 'must be at least 32 characters');

const linkSchema = runtimeSchema.extend({
  LINK_DISCORD_TOKEN: z.string().trim().min(1),
  LINK_DISCORD_APPLICATION_ID: discordSnowflake,
  DISCORD_GUILD_ID: discordSnowflake,
  NEXT_PUBLIC_SITE_URL: z.url(),
  CORE_API_URL: z.url({ protocol: /^https?$/ }),
  /** Signs Link → Core API requests. */
  LINK_CORE_SECRET: serviceSecret,
  /** Verifies worker → Link gateway requests. */
  LINK_GATEWAY_SECRET: serviceSecret,
  /**
   * `http`: Link listens on LINK_GATEWAY_HOST:PORT for the worker. `relay`:
   * Link opens no socket and pulls worker requests from the Core API.
   */
  LINK_GATEWAY_MODE: z.enum(['http', 'relay']).default('http'),
  /** http mode only. */
  LINK_GATEWAY_HOST: z.string().trim().min(1).default('127.0.0.1'),
  /** http mode only. */
  LINK_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8082),
  /** Public city notices (restarts, status changes). Unset: not posted. */
  LINK_EVENTS_CHANNEL_ID: optional(discordSnowflake),
  /** Staff log for whitelist, identity and moderation events. Unset: not posted. */
  LINK_STAFF_LOG_CHANNEL_ID: optional(discordSnowflake),
});

export type LinkEnv = z.output<typeof linkSchema>;

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/**
 * Guardian and Link are separate Discord applications. A process that sees
 * both credentials (a shared .env, a copy-pasted secret) must refuse to start
 * when they are the same bot: two runtimes on one token fight over the gateway
 * session and register each other's commands away.
 */
export function discordApplicationCollisions(
  source: Record<string, string | undefined>,
): readonly string[] {
  const issues: string[] = [];
  const guardianToken = present(source.GUARDIAN_DISCORD_TOKEN);
  const linkToken = present(source.LINK_DISCORD_TOKEN);
  if (guardianToken !== null && guardianToken === linkToken) {
    issues.push(
      'LINK_DISCORD_TOKEN: must differ from GUARDIAN_DISCORD_TOKEN; Guardian and Link are separate Discord applications',
    );
  }
  const guardianId = present(source.GUARDIAN_DISCORD_APPLICATION_ID);
  const linkId = present(source.LINK_DISCORD_APPLICATION_ID);
  if (guardianId !== null && guardianId === linkId) {
    issues.push(
      'LINK_DISCORD_APPLICATION_ID: must differ from GUARDIAN_DISCORD_APPLICATION_ID; Guardian and Link are separate Discord applications',
    );
  }
  return issues;
}

export function parseLinkEnv(source: Record<string, string | undefined>): LinkEnv {
  const collisions = discordApplicationCollisions(source);
  if (collisions.length > 0) throw new EnvironmentValidationError('link', collisions);
  return parseEnv('link', linkSchema, source);
}

export const linkEnv: LinkEnv = lazyEnv(() => parseLinkEnv(process.env));
