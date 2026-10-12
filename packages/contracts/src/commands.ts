/**
 * Slash-command ownership.
 *
 * Guardian and Link are separate Discord applications, so Discord would let
 * both register `/status` — and members would see two `/status` entries that
 * do different things. Every top-level command name therefore belongs to
 * exactly one application, and each application's registry is checked against
 * this list in its tests and at startup.
 */

export const GUARDIAN_COMMAND_NAMES = [
  'xenon',
  'room',
  'announce',
  'security',
  'warn',
  'warnings',
  'timeout',
  'untimeout',
  'kick',
  'ban',
  'unban',
  'softban',
  'purge',
  'case',
  'cases',
] as const;

export const LINK_COMMAND_NAMES = [
  'link',
  'profile',
  'whitelist',
  'application',
  'status',
  'player',
  'review',
  'sync',
  'queue',
] as const;

export type DiscordApplicationName = 'guardian' | 'link';

const OWNED: Readonly<Record<DiscordApplicationName, readonly string[]>> = {
  guardian: GUARDIAN_COMMAND_NAMES,
  link: LINK_COMMAND_NAMES,
};

/**
 * Throw unless `registered` is exactly the set of names `application` owns.
 * Called before commands are pushed to Discord, so a collision is a failed
 * deploy rather than a confusing member experience.
 */
export function assertCommandOwnership(
  application: DiscordApplicationName,
  registered: readonly { readonly name: string }[],
): void {
  const owned = new Set(OWNED[application]);
  const names = registered.map((command) => command.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const foreign = names.filter((name) => !owned.has(name));
  const missing = [...owned].filter((name) => !names.includes(name));
  if (duplicates.length > 0 || foreign.length > 0 || missing.length > 0) {
    throw new Error(
      `Command ownership violation for ${application}: ` +
        JSON.stringify({ duplicates, foreign, missing }),
    );
  }
}
