import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  DISABLED_PLATFORM_RESPONSE,
  DISCORD_ONLY_COMMANDS,
  isPlatformDataCommand,
  respondPlatformUnavailable,
} from './discord-only-commands';

describe('Discord-only command degradation', () => {
  it('identifies platform data commands for a clean integration-disabled response', async () => {
    for (const name of ['profile', 'application', 'review', 'link', 'queue', 'player'])
      expect(isPlatformDataCommand(name)).toBe(true);
    expect(DISABLED_PLATFORM_RESPONSE).toBe('Xenon Platform integration is not enabled on this deployment.');
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
});
