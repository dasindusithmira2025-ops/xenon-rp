/**
 * Paths scrubbed from every log record.
 *
 * The brief is explicit that no sensitive token may reach a log sink, and the
 * cheapest way to guarantee that is to redact centrally rather than to trust
 * every call site to pick its fields carefully.
 */
export const redactPaths = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'secret',
  'authorization',
  'cookie',
  'signature',
  'linkCode',
  'DATABASE_URL',
  'AUTH_SECRET',
  'DISCORD_BOT_TOKEN',
  'GUARDIAN_DISCORD_TOKEN',
  'LINK_DISCORD_TOKEN',
  'LINK_CORE_SECRET',
  'LINK_GATEWAY_SECRET',
  'AUTH_DISCORD_SECRET',
  'HASH_PEPPER',
  'REDIS_URL',
  'FIVEM_BRIDGE_SECRET',
  '*.signature',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
] as const;
