import { ApplicationCommandOptionType, ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { assertCommandOwnership, LINK_COMMAND_NAMES } from '@xenon/contracts';

import { GUARDIAN_COMMANDS } from './discord-only-commands';

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

describe('Guardian command registry', () => {
  it('owns exactly the Guardian command set and none of the Link commands', () => {
    expect(() => {
      assertCommandOwnership('guardian', GUARDIAN_COMMANDS);
    }).not.toThrow();
    const names = GUARDIAN_COMMANDS.map((command) => command.name);
    for (const name of LINK_COMMAND_NAMES) expect(names, name).not.toContain(name);
    expect(() => {
      assertCommandOwnership('link', GUARDIAN_COMMANDS);
    }).toThrow(/ownership violation/);
  });

  it('keeps Discord-native setup and voice commands registered', () => {
    expect(GUARDIAN_COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining(['announce', 'xenon', 'room']),
    );
  });

  it('exposes runtime status as a Manage Server /xenon status subcommand', () => {
    const xenon = GUARDIAN_COMMANDS.find((command) => command.name === 'xenon');
    const status = xenon?.options?.find((option) => option.name === 'status');
    expect(status?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(xenon?.default_member_permissions).toBe('32');
  });

  it('registers the complete Xenon security and moderation command surface', () => {
    const names = GUARDIAN_COMMANDS.map((command) => command.name);
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
    const security = GUARDIAN_COMMANDS.find((command) => command.name === 'security');
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
    const xenon = GUARDIAN_COMMANDS.find((command) => command.name === 'xenon');
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
    const violations = GUARDIAN_COMMANDS.flatMap((command) =>
      optionOrderViolations(command, `/${command.name}`),
    );
    expect(violations).toEqual([]);
  });
});
