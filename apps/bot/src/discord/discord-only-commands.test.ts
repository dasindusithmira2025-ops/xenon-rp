import { ApplicationCommandOptionType, ChannelType, MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { commandDefinitions } from './commands';
import {
  DISABLED_PLATFORM_RESPONSE,
  DISCORD_ONLY_COMMANDS,
  isPlatformDataCommand,
  respondPlatformUnavailable,
} from './discord-only-commands';

interface CommandOptionNode {
  readonly name: string;
  readonly type?: number;
  readonly required?: boolean;
  readonly options?: readonly CommandOptionNode[];
}

/** Discord rejects registration when a required option follows an optional sibling. */
function optionOrderViolations(node: CommandOptionNode, path: string): string[] {
  const children = node.options ?? [];
  const violations: string[] = [];
  let optionalSeen: string | null = null;
  for (const child of children) {
    const isParameter =
      child.type !== ApplicationCommandOptionType.Subcommand &&
      child.type !== ApplicationCommandOptionType.SubcommandGroup;
    if (isParameter && child.required !== true) optionalSeen ??= child.name;
    else if (isParameter && optionalSeen !== null)
      violations.push(`${path}: required '${child.name}' follows optional '${optionalSeen}'`);
    violations.push(...optionOrderViolations(child, `${path} ${child.name}`));
  }
  return violations;
}

describe('Discord-only command degradation', () => {
  it('identifies platform data commands for a clean integration-disabled response', async () => {
    for (const name of ['profile', 'application', 'review', 'link', 'queue', 'player'])
      expect(isPlatformDataCommand(name)).toBe(true);
    expect(DISABLED_PLATFORM_RESPONSE).toBe(
      'Xenon Platform integration is not enabled on this deployment.',
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    await respondPlatformUnavailable({ reply });
    expect(reply).toHaveBeenCalledWith({
      content: DISABLED_PLATFORM_RESPONSE,
      flags: MessageFlags.Ephemeral,
    });
  });

  it('keeps Discord-native setup and voice commands registered', () => {
    expect(DISCORD_ONLY_COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining(['status', 'announce', 'xenon', 'room']),
    );
  });
  it('registers the complete Xenon security and moderation command surface', () => {
    const names = DISCORD_ONLY_COMMANDS.map((command) => command.name);
    expect(names).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    const security = DISCORD_ONLY_COMMANDS.find((command) => command.name === 'security');
    expect(security?.options?.map((option) => option.name)).toEqual(
      expect.arrayContaining([
        'setup',
        'status',
        'scan',
        'raid',
        'raid-mode',
        'trust',
        'automod',
        'config',
        'lockdown',
        'unlock',
        'quarantine',
        'unquarantine',
      ]),
    );
    expect(security?.default_member_permissions).toBeNull();
    const configGroup = security?.options?.find((option) => option.name === 'config');
    const configCommands =
      configGroup !== undefined && 'options' in configGroup ? (configGroup.options ?? []) : [];
    expect(configCommands.map((option) => option.name)).toEqual(
      expect.arrayContaining(['channels', 'link-policy', 'raid-thresholds', 'spam', 'keyword']),
    );
  });

  it('registers /xenon setup adopt with optional text-channel bindings and no confirmation', () => {
    const xenon = DISCORD_ONLY_COMMANDS.find((command) => command.name === 'xenon');
    const setup = xenon?.options?.find((option) => option.name === 'setup');
    const adopt =
      setup !== undefined && 'options' in setup
        ? setup.options?.find((option) => option.name === 'adopt')
        : undefined;
    expect(adopt).toMatchObject({ description: 'Adopt existing server channels and roles' });
    const options = adopt !== undefined && 'options' in adopt ? (adopt.options ?? []) : [];
    expect(options.map((option) => option.name)).toEqual([
      'announcements',
      'logs',
      'review',
      'welcome',
      'rules',
    ]);
    for (const option of options) {
      expect(option).toMatchObject({
        type: ApplicationCommandOptionType.Channel,
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      });
      expect(option.required ?? false).toBe(false);
    }
  });

  it('orders required options before optional ones in every registered command', () => {
    const violations = [...DISCORD_ONLY_COMMANDS, ...commandDefinitions].flatMap((command) =>
      optionOrderViolations(command, `/${command.name}`),
    );
    expect(violations).toEqual([]);
  });
});
