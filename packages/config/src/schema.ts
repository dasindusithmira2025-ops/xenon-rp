import { z } from 'zod';

/** Discord IDs are snowflakes: decimal strings, currently 17-20 digits. */
export const discordSnowflake = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a Discord snowflake (17-20 digits)');

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info');

/** A secret long enough to be worth calling a secret. */
const secret = (min = 32) => z.string().min(min, `must be at least ${min} characters`);

/**
 * An optional variable, where an empty string means "not set".
 *
 * `.env.example` ships every optional key present but blank, which is the right
 * documentation shape - an operator fills in the line rather than remembering
 * the name. Without this, `R2_BUCKET=` would be an empty string that fails a
 * `.min(1)` check, and a fresh clone would refuse to boot on variables it is
 * explicitly allowed to omit.
 *
 * It also keeps the production guard honest: `requireInProduction` tests for
 * `undefined`, so a blank line in a production environment is correctly read as
 * missing rather than as a satisfied requirement.
 */
export function optional<TSchema extends z.ZodType>(schema: TSchema) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    schema.optional(),
  );
}

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
  HASH_PEPPER: optional(z.string().min(16)),
});

export const authSchema = z.object({
  AUTH_SECRET: secret(32),
  AUTH_DISCORD_ID: optional(discordSnowflake),
  AUTH_DISCORD_SECRET: optional(z.string().min(1)),
  /** Auth.js needs the canonical origin to build callback URLs behind proxies. */
  AUTH_URL: optional(
    z.url().refine((value) => {
      const url = parseUrl(value);
      if (url === null) return false;
      return (
        (url.pathname === '/' || url.pathname === '/api/auth') &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    }, 'must be an origin or end in /api/auth without query or fragment'),
  ),
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
  DISCORD_BOT_TOKEN: optional(z.string().min(1)),
  DISCORD_APPLICATION_ID: optional(discordSnowflake),
  DISCORD_GUILD_ID: optional(discordSnowflake),
});

/** Public community invite used when no Control Center invite setting exists. */
export const discordInviteUrl = optional(z.url());

export const discordMode = z.enum(['enabled', 'disabled']).default('disabled');

/**
 * Validate the shared Discord mode against only the credentials a process owns.
 * Development can explicitly run with Discord disabled; production must have
 * the complete real integration and may never silently fall back to a mock.
 */
export function validateDiscordMode<TShape extends z.ZodRawShape>(schema: z.ZodObject<TShape>) {
  const declared = new Set(Object.keys(schema.shape));

  return schema.superRefine((value, ctx) => {
    const record = value as Record<string, unknown> & {
      NODE_ENV?: string;
      DISCORD_MODE?: 'enabled' | 'disabled';
    };
    const mode = record.DISCORD_MODE ?? 'disabled';
    const productionRuntime = record.NODE_ENV === 'production' && !isBuildPhase();

    if (productionRuntime && mode !== 'enabled') {
      ctx.addIssue({
        code: 'custom',
        path: ['DISCORD_MODE'],
        message: 'must be enabled in production; Discord cannot silently run disabled',
      });
    }

    if (productionRuntime && declared.has('AUTH_URL') && record.AUTH_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_URL'],
        message: 'is required in production so OAuth callbacks use the validated public origin',
      });
    }

    if (mode === 'enabled') {
      for (const key of [
        'AUTH_DISCORD_ID',
        'AUTH_DISCORD_SECRET',
        'DISCORD_APPLICATION_ID',
        'DISCORD_BOT_TOKEN',
        'DISCORD_GUILD_ID',
      ]) {
        if (declared.has(key) && record[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when DISCORD_MODE=enabled',
          });
        }
      }
    }

    if (
      typeof record.AUTH_DISCORD_ID === 'string' &&
      typeof record.DISCORD_APPLICATION_ID === 'string' &&
      record.AUTH_DISCORD_ID !== record.DISCORD_APPLICATION_ID
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DISCORD_APPLICATION_ID'],
        message: 'must match AUTH_DISCORD_ID; OAuth and bot must use the same application',
      });
    }

    const authOrigin =
      typeof record.AUTH_URL === 'string' ? parseUrl(record.AUTH_URL)?.origin : null;
    const siteOrigin =
      typeof record.NEXT_PUBLIC_SITE_URL === 'string'
        ? parseUrl(record.NEXT_PUBLIC_SITE_URL)?.origin
        : null;
    if (
      authOrigin !== undefined &&
      authOrigin !== null &&
      siteOrigin !== undefined &&
      siteOrigin !== null &&
      authOrigin !== siteOrigin
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_URL'],
        message: 'must use the same public origin as NEXT_PUBLIC_SITE_URL',
      });
    }
  });
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Object storage. Optional outside production so a fresh clone runs against the
 * local filesystem driver; required in production so uploads never silently
 * land somewhere ephemeral.
 */
export const storageSchema = z.object({
  R2_ACCOUNT_ID: optional(z.string().min(1)),
  R2_ACCESS_KEY: optional(z.string().min(1)),
  R2_SECRET_KEY: optional(z.string().min(1)),
  R2_BUCKET: optional(z.string().min(1)),
  /** Public base URL that fronts the bucket, used to build asset URLs. */
  R2_PUBLIC_URL: optional(z.url()),
});

export const integrationsSchema = z.object({
  TURNSTILE_SECRET: optional(z.string().min(1)),
  SENTRY_DSN: optional(z.url()),
});

export const fivemSchema = z.object({
  /** Shared secret used to sign requests between Xenon and the FiveM bridge. */
  FIVEM_BRIDGE_SECRET: optional(secret(32)),
  /** Base URL of the FXServer HTTP endpoint used for status and whitelist sync. */
  FIVEM_SERVER_URL: optional(z.url()),
});

export const siteSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optional(z.string().min(1)),
});

/**
 * True while Next.js is compiling rather than serving.
 *
 * Next sets NEXT_PHASE for the duration of `next build`. Read through a lookup
 * that tolerates the variable being absent, because this module is also
 * imported by the bot and by CLI scripts where Next is not involved at all.
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

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

    // `next build` runs with NODE_ENV=production but is not a production
    // server: it renders pages to discover their shape, in CI, deliberately
    // without real credentials. Enforcing runtime integrations there would make
    // the build itself require the secrets it exists to avoid baking in.
    //
    // This does not weaken the guard. The same schema is parsed again when the
    // server process actually starts, and it fails there, loudly, before
    // serving a single request.
    if (isBuildPhase()) return;

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
