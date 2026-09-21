import { z } from 'zod';

/** Discord IDs are snowflakes: decimal strings, currently 17-20 digits. */
export const discordSnowflake = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a Discord snowflake (17-20 digits)');

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info');

/** A secret long enough to be worth calling a secret. */
const secret = (min = 32) => z.string().min(min, `must be at least ${min} characters`);

export const runtimeSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
});

export const datastoreSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

/**
 * Values used to derive non-reversible hashes of client addresses.
 *
 * Optional outside production with a documented development default, because a
 * fresh clone must boot; required in production because a predictable pepper
 * makes the stored hash of an IPv4 address trivially reversible.
 */
export const securitySchema = z.object({
  HASH_PEPPER: z.string().min(16).optional(),
});

export const authSchema = z.object({
  AUTH_SECRET: secret(32),
  AUTH_DISCORD_ID: discordSnowflake,
  AUTH_DISCORD_SECRET: z.string().min(1),
  /** Auth.js needs the canonical origin to build callback URLs behind proxies. */
  AUTH_URL: z.url().optional(),
  AUTH_TRUST_HOST: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Opens a development-only sign-in route used by the E2E suite.
   *
   * Parsed here but never trusted on its own: `hasDevLogin()` additionally
   * requires a non-production NODE_ENV, so setting this in a production
   * environment does nothing rather than opening an authentication bypass.
   */
  AUTH_DEV_LOGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const discordSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: discordSnowflake,
  DISCORD_GUILD_ID: discordSnowflake,
});

/**
 * Object storage. Optional outside production so a fresh clone runs against the
 * local filesystem driver; required in production so uploads never silently
 * land somewhere ephemeral.
 */
export const storageSchema = z.object({
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY: z.string().min(1).optional(),
  R2_SECRET_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  /** Public base URL that fronts the bucket, used to build asset URLs. */
  R2_PUBLIC_URL: z.url().optional(),
});

export const integrationsSchema = z.object({
  TURNSTILE_SECRET: z.string().min(1).optional(),
  SENTRY_DSN: z.url().optional(),
});

export const fivemSchema = z.object({
  /** Shared secret used to sign requests between Xenon and the FiveM bridge. */
  FIVEM_BRIDGE_SECRET: secret(32).optional(),
  /** Base URL of the FXServer HTTP endpoint used for status and whitelist sync. */
  FIVEM_SERVER_URL: z.url().optional(),
});

export const siteSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
});

/**
 * Integrations that may be stubbed in development but must be fully configured
 * in production. Enforced here rather than at the call site so there is exactly
 * one place that decides what "production ready" means.
 */
const productionRequired = [
  ['R2_ACCOUNT_ID', 'object storage'],
  ['R2_ACCESS_KEY', 'object storage'],
  ['R2_SECRET_KEY', 'object storage'],
  ['R2_BUCKET', 'object storage'],
  ['R2_PUBLIC_URL', 'object storage'],
  ['TURNSTILE_SECRET', 'abuse protection'],
  ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'abuse protection'],
  ['FIVEM_BRIDGE_SECRET', 'FiveM bridge'],
  ['HASH_PEPPER', 'address hashing'],
] as const satisfies readonly (readonly [string, string])[];

/**
 * Wrap a schema so that production refuses to start with a stubbed integration.
 *
 * The set of keys to enforce is taken from the schema's own shape, captured
 * here at construction time. Reading it from the parsed value instead would
 * silently do nothing: Zod omits absent optional keys from its output, so
 * `'R2_BUCKET' in value` is false in exactly the case the guard exists to
 * catch, and production would boot with storage unconfigured.
 *
 * Each runtime therefore only has to answer for the integrations it actually
 * declares - the bot is not asked about Turnstile, and the web tier is not
 * asked about variables it never reads.
 */
export function requireInProduction<TShape extends z.ZodRawShape>(schema: z.ZodObject<TShape>) {
  const declared = new Set(Object.keys(schema.shape));

  return schema.superRefine((value, ctx) => {
    const record = value as Record<string, unknown> & { NODE_ENV?: string };
    if (record.NODE_ENV !== 'production') return;

    for (const [key, subsystem] of productionRequired) {
      if (!declared.has(key)) continue;
      if (record[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `is required in production (${subsystem} would otherwise run unconfigured)`,
        });
      }
    }
  });
}
