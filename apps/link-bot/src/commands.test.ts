import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { assertCommandOwnership, GUARDIAN_COMMAND_NAMES } from '@xenon/contracts';
import { silentLogger } from '@xenon/logger';

import { handleCommand, linkCommands } from './commands';
import { CORE_UNAVAILABLE_MESSAGE, createCoreClient, type CoreCall } from './core-client';

const ACTOR = '300000000000000003';
const SITE = 'https://xenonrp.test';

function fakeInteraction(
  commandName: string,
  strings: Record<string, string> = {},
  users: Record<string, { id: string }> = {},
) {
  const interaction = {
    commandName,
    user: { id: ACTOR },
    deferred: false,
    replied: false,
    options: {
      getString: (name: string) => strings[name] ?? null,
      getUser: (name: string) => users[name] ?? null,
    },
    deferReply: vi.fn(() => {
      interaction.deferred = true;
      return Promise.resolve();
    }),
    editReply: vi.fn((_reply: unknown) => Promise.resolve()),
    reply: vi.fn((_reply: unknown) => Promise.resolve()),
  };
  return interaction;
}

async function run(interaction: ReturnType<typeof fakeInteraction>, core: CoreCall) {
  await handleCommand(interaction as unknown as ChatInputCommandInteraction, {
    core,
    siteUrl: SITE,
    logger: silentLogger,
  });
}

function lastReply(interaction: ReturnType<typeof fakeInteraction>): Record<string, unknown> {
  return interaction.editReply.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('link command registry', () => {
  it('registers exactly the commands Link owns', () => {
    expect(() => {
      assertCommandOwnership('link', linkCommands);
    }).not.toThrow();
    const names = linkCommands.map((command) => command.name);
    for (const guardian of GUARDIAN_COMMAND_NAMES) expect(names).not.toContain(guardian);
  });
});

describe('link commands', () => {
  it('answers /link without an account with Core’s safe message', async () => {
    const core = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Sign in to Xenon with Discord first.' },
    });
    const interaction = fakeInteraction('link');
    await run(interaction, core);

    expect(core).toHaveBeenCalledWith('link.status', { actorDiscordId: ACTOR });
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(lastReply(interaction)).toEqual({
      content: 'Sign in to Xenon with Discord first.',
      allowedMentions: { parse: [] },
    });
  });

  it('sends an unlinked player to the website instead of issuing a code', async () => {
    const core = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        hasAccount: true,
        linked: false,
        cfxUsername: null,
        linkedAt: null,
        verifiedOnWebsite: false,
      },
    });
    const interaction = fakeInteraction('link');
    await run(interaction, core);
    const content = String(lastReply(interaction).content);
    expect(content).toContain('/portal/account#fivem');
    expect(content).toContain('Connect Cfx.re');
    expect(content).not.toMatch(/XEN-|in game chat/);
  });

  it('shows the verified Cfx.re account for a linked player', async () => {
    const core = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        hasAccount: true,
        linked: true,
        cfxUsername: 'ravi_rp',
        linkedAt: '2026-10-10T12:10:00.000Z',
        verifiedOnWebsite: true,
      },
    });
    const interaction = fakeInteraction('link');
    await run(interaction, core);
    const content = String(lastReply(interaction).content);
    expect(content).toContain('**ravi_rp**');
    expect(content).toContain('Verified through Cfx.re');
  });

  it('answers with the INTEGRATION message when Core is unreachable', async () => {
    const core = createCoreClient({
      baseUrl: 'http://core.invalid',
      secret: 'c'.repeat(40),
      logger: silentLogger,
      fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });
    for (const command of ['whitelist', 'status', 'queue', 'sync']) {
      const interaction = fakeInteraction(command);
      await run(interaction, core);
      expect(lastReply(interaction).content, command).toBe(CORE_UNAVAILABLE_MESSAGE);
    }
  });

  it('defers /status publicly and every other command ephemerally', async () => {
    const core = vi.fn().mockResolvedValue({
      ok: true,
      data: { aggregate: 'ONLINE', checkedAt: null, connectUrl: null, servers: [] },
    });
    const status = fakeInteraction('status');
    await run(status, core);
    expect(status.deferReply).toHaveBeenCalledWith({});
    expect(lastReply(status).embeds).toHaveLength(1);
  });

  it('shows a self profile miss as a sign-in prompt and others as no account', async () => {
    const core = vi.fn().mockResolvedValue({ ok: true, data: null });
    const self = fakeInteraction('profile');
    await run(self, core);
    expect(String(lastReply(self).content)).toContain(`Sign in at ${SITE}`);

    const other = fakeInteraction('profile', {}, { member: { id: '300000000000000004' } });
    await run(other, core);
    expect(core).toHaveBeenLastCalledWith('players.profile', {
      actorDiscordId: ACTOR,
      targetDiscordId: '300000000000000004',
    });
    expect(lastReply(other).content).toBe('That member has no Xenon account.');
  });

  it('never leaks an unexpected error', async () => {
    const core = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const interaction = fakeInteraction('queue');
    await run(interaction, core);
    expect(lastReply(interaction).content).toBe('Something went wrong. Try again shortly.');
  });
});
