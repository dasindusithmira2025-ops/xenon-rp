import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const expectedApplicationId = '1550168431163084921';
const expectedGuildId = '1371209014372991137';

function readLocalEnv(path) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return {};
  }

  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

const env = {
  ...readLocalEnv(resolve(process.cwd(), '.env')),
  ...process.env,
};
const applicationId = env.AUTH_DISCORD_ID ?? '';
const botApplicationId = env.DISCORD_APPLICATION_ID ?? '';
const guildId = env.DISCORD_GUILD_ID ?? '';
const inviteUrl = env.DISCORD_INVITE_URL ?? '';
const siteUrl = env.NEXT_PUBLIC_SITE_URL ?? '';
const authUrl = env.AUTH_URL || siteUrl;
let callbackUrl = 'invalid';
let validOrigins = false;

try {
  const siteOrigin = new URL(siteUrl).origin;
  const auth = new URL(authUrl);
  callbackUrl = new URL('/api/auth/callback/discord', auth.origin).toString();
  validOrigins =
    siteOrigin === auth.origin &&
    ['/', '/api/auth'].includes(auth.pathname) &&
    env.AUTH_URL === 'http://localhost:3200';
} catch {
  // Print a safe status only; never include an exception that could echo input.
}

const checks = [
  ['Discord mode', env.DISCORD_MODE ?? 'disabled'],
  ['Application ID', applicationId || 'missing'],
  ['Guild ID', guildId || 'missing'],
  ['Discord invite', inviteUrl || 'missing'],
  ['OAuth secret', env.AUTH_DISCORD_SECRET?.trim() ? 'configured' : 'missing'],
  ['Bot token', env.DISCORD_BOT_TOKEN?.trim() ? 'configured' : 'missing'],
  ['Auth URL', env.AUTH_URL || 'missing'],
  ['Site URL', siteUrl || 'missing'],
  ['OAuth callback', callbackUrl],
  [
    'Application IDs match the client application',
    applicationId === expectedApplicationId && botApplicationId === expectedApplicationId
      ? 'YES'
      : 'NO',
  ],
  [
    'Application IDs match each other',
    applicationId !== '' && applicationId === botApplicationId ? 'YES' : 'NO',
  ],
  ['Guild ID matches the configured client guild', guildId === expectedGuildId ? 'YES' : 'NO'],
  ['Auth and site origins match', validOrigins ? 'YES' : 'NO'],
];

for (const [label, value] of checks) console.log(`${label}: ${value}`);

if (
  env.DISCORD_MODE !== 'enabled' ||
  applicationId !== expectedApplicationId ||
  botApplicationId !== expectedApplicationId ||
  guildId !== expectedGuildId ||
  inviteUrl !== 'https://discord.gg/ybev9tk87f' ||
  !env.AUTH_DISCORD_SECRET?.trim() ||
  !env.DISCORD_BOT_TOKEN?.trim() ||
  !validOrigins ||
  callbackUrl !== 'http://localhost:3200/api/auth/callback/discord'
) {
  process.exitCode = 1;
}
