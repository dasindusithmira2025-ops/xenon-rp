import { MessageFlags, type Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '@xenon/logger';

import { AUTHORIZE_TIMEOUT_MS, handleComponent, parseReviewId } from './interactions';

import type { CoreCall } from './core-client';

const ACTOR = '300000000000000003';

function fakeButton(customId: string) {
  const interaction = {
    customId,
    user: { id: ACTOR },
    deferred: false,
    replied: false,
    isButton: () => true,
    isModalSubmit: () => false,
    message: { edit: vi.fn(() => Promise.resolve()) },
    reply: vi.fn((_reply: unknown) => Promise.resolve()),
    showModal: vi.fn((_modal: unknown) => Promise.resolve()),
    deferReply: vi.fn(() => {
      interaction.deferred = true;
      return Promise.resolve();
    }),
    editReply: vi.fn((_reply: unknown) => Promise.resolve()),
  };
  return interaction;
}

function fakeModal(customId: string, fields: Record<string, string>) {
  return {
    ...fakeButton(customId),
    isButton: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: (name: string) => fields[name] ?? '' },
  };
}

async function route(interaction: object, core: CoreCall) {
  await handleComponent(interaction as Interaction, { core, logger: silentLogger });
}

function coreReturning(...results: unknown[]) {
  const core = vi.fn();
  for (const result of results) core.mockResolvedValueOnce(result);
  return core;
}

describe('review custom ids', () => {
  it('parses app:<action>:<reference> and rejects anything else', () => {
    expect(parseReviewId('app:approve:XN-WL-1842')).toEqual({
      action: 'approve',
      reference: 'XN-WL-1842',
    });
    for (const bad of [
      'app:approve',
      'xn:ticket:close:T-1',
      'app:approve:XN-1:extra',
      'app:Approve!:XN-1',
      'app:approve:XN 1',
      'app:approve:',
    ]) {
      expect(parseReviewId(bad), bad).toBeNull();
    }
  });
});

describe('review buttons', () => {
  it('authorizes before opening a modal, within the interaction window', async () => {
    const core = coreReturning({ ok: true, data: { allowed: true } });
    const button = fakeButton('app:reject:XN-WL-1');
    await route(button, core);
    expect(core).toHaveBeenCalledWith(
      'applications.authorize',
      { actorDiscordId: ACTOR, action: 'reject' },
      { timeoutMs: AUTHORIZE_TIMEOUT_MS },
    );
    expect(AUTHORIZE_TIMEOUT_MS).toBeLessThan(3_000);
    expect(button.showModal).toHaveBeenCalledTimes(1);
    expect(button.reply).not.toHaveBeenCalled();
  });

  it('refuses the modal when Core denies or is unavailable', async () => {
    const denied = fakeButton('app:changes:XN-WL-1');
    await route(denied, coreReturning({ ok: true, data: { allowed: false } }));
    expect(denied.showModal).not.toHaveBeenCalled();
    expect(denied.reply).toHaveBeenCalledWith({
      content: 'You do not have permission to do that.',
      flags: MessageFlags.Ephemeral,
    });

    const down = fakeButton('app:interview:XN-WL-1');
    await route(
      down,
      coreReturning({
        ok: false,
        error: { code: 'INTEGRATION', message: 'Xenon services are temporarily unavailable.' },
      }),
    );
    expect(down.showModal).not.toHaveBeenCalled();
    expect(down.reply).toHaveBeenCalledWith({
      content: 'Xenon services are temporarily unavailable.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('decides approve through Core and then refreshes the card', async () => {
    const core = coreReturning(
      { ok: true, data: { reference: 'XN-WL-1', status: 'APPROVED', statusLabel: 'Approved' } },
      { ok: true, data: { queued: true } },
    );
    const button = fakeButton('app:approve:XN-WL-1');
    await route(button, core);
    expect(core.mock.calls).toEqual([
      ['applications.decide', { actorDiscordId: ACTOR, reference: 'XN-WL-1', action: 'approve' }],
      ['applications.refreshCard', { actorDiscordId: ACTOR, reference: 'XN-WL-1' }],
    ]);
    expect(String(button.editReply.mock.calls[0]?.[0])).toContain('Approved XN-WL-1');
  });

  it('shows Core’s safe message when a decision fails and skips the refresh', async () => {
    const core = coreReturning({
      ok: false,
      error: { code: 'CONFLICT', message: 'Someone else already decided this.' },
    });
    const button = fakeButton('app:claim:XN-WL-1');
    await route(button, core);
    expect(button.editReply).toHaveBeenCalledWith('Someone else already decided this.');
    expect(core).toHaveBeenCalledTimes(1);
  });

  it('submits modal notes as a decision', async () => {
    const core = coreReturning(
      { ok: true, data: { reference: 'XN-WL-1', status: 'REJECTED', statusLabel: 'Rejected' } },
      { ok: true, data: { queued: true } },
    );
    const modal = fakeModal('app:reject:XN-WL-1', {
      publicNote: 'Backstory too short.',
      staffNote: 'n/a',
    });
    await route(modal, core);
    expect(core).toHaveBeenNthCalledWith(1, 'applications.decide', {
      actorDiscordId: ACTOR,
      reference: 'XN-WL-1',
      action: 'reject',
      publicNote: 'Backstory too short.',
      staffNote: 'n/a',
    });
  });
});

describe('ticket and unknown components', () => {
  it('closes the actor’s own ticket and clears the panel buttons', async () => {
    const core = coreReturning({ ok: true, data: { publicId: 'T-1001' } });
    const button = fakeButton('xn:ticket:close:T-1001');
    await route(button, core);
    expect(core).toHaveBeenCalledWith('tickets.closeOwn', {
      actorDiscordId: ACTOR,
      ticketPublicId: 'T-1001',
    });
    expect(button.message.edit).toHaveBeenCalledWith({ components: [] });
    expect(button.editReply).toHaveBeenCalledWith('Ticket T-1001 is closed.');
  });

  it('ignores components Link does not own', async () => {
    const core = vi.fn();
    for (const customId of [
      'xn:role:toggle:vip',
      'xn:setup:apply:run1',
      'guardian:panel',
      'xn:ticket:close',
    ]) {
      const button = fakeButton(customId);
      await route(button, core);
      expect(button.reply, customId).not.toHaveBeenCalled();
      expect(button.deferReply, customId).not.toHaveBeenCalled();
    }
    expect(core).not.toHaveBeenCalled();
  });
});
