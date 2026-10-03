import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Actor } from '@xenon/permissions';

const mocks = vi.hoisted(() => ({
  prisma: {
    applicationSubmission: { findUnique: vi.fn() },
    applicationTemplate: { findUnique: vi.fn() },
  },
  actorFromDiscord: vi.fn(),
  approveApplication: vi.fn(),
  claimApplication: vi.fn(),
  rejectApplication: vi.fn(),
  requestChanges: vi.fn(),
  requestInterview: vi.fn(),
  closeOwnTicket: vi.fn(),
  loadSupportSettings: vi.fn(),
  toSafeMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : 'Failed')),
  logger: { warn: vi.fn() },
}));

vi.mock('@xenon/applications', () => ({
  approveApplication: mocks.approveApplication,
  claimApplication: mocks.claimApplication,
  rejectApplication: mocks.rejectApplication,
  requestChanges: mocks.requestChanges,
  requestInterview: mocks.requestInterview,
}));
vi.mock('@xenon/core', () => ({ toSafeMessage: mocks.toSafeMessage }));
vi.mock('@xenon/database', () => ({ prisma: mocks.prisma }));
vi.mock('@xenon/domain', () => ({ closeOwnTicket: mocks.closeOwnTicket }));
vi.mock('@xenon/discord', async () => {
  const { EmbedBuilder } = await import('discord.js');
  return {
    loadSupportSettings: mocks.loadSupportSettings,
    XenonTicketPanel: vi.fn(),
    xenonEmbed: () => new EmbedBuilder(),
  };
});
vi.mock('../runtime', () => ({
  botEnv: { NEXT_PUBLIC_SITE_URL: 'https://xenon.example.test' },
  logger: mocks.logger,
}));
vi.mock('./actor', () => ({ actorFromDiscord: mocks.actorFromDiscord }));
vi.mock('./review-card', () => ({ postOrUpdateReviewCard: vi.fn() }));

import { handleButton, handleModal, handleStringSelect } from './interactions';

function makeActor(canRejectOrRequest = true): Actor {
  return {
    userId: 'xenon-staff-user',
    source: 'DISCORD',
    permissions: { has: vi.fn(() => canRejectOrRequest) },
  } as unknown as Actor;
}

function makeButton(customId: string) {
  const reply = vi.fn();
  const showModal = vi.fn((modal: { data: { custom_id?: string } }) => {
    shownModalId = modal.data.custom_id;
    return Promise.resolve();
  });
  const deferReply = vi.fn();
  const editReply = vi.fn();
  const interaction = {
    customId,
    user: { id: 'discord-staff-snowflake' },
    reply,
    showModal,
    deferReply,
    editReply,
    client: { isReady: () => true },
  } as unknown as ButtonInteraction;
  return { interaction, reply, showModal, deferReply, editReply };
}

let shownModalId: string | undefined;

function makeModal(customId: string) {
  const deferReply = vi.fn();
  const editReply = vi.fn();
  const interaction = {
    customId,
    user: { id: 'discord-staff-snowflake' },
    deferReply,
    editReply,
    fields: { getTextInputValue: (id: string) => (id === 'publicNote' ? 'Please add detail' : '') },
    client: { isReady: () => true },
  } as unknown as ModalSubmitInteraction;
  return { interaction, deferReply, editReply };
}

describe('Discord review interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shownModalId = undefined;
    mocks.prisma.applicationSubmission.findUnique.mockResolvedValue(null);
    mocks.prisma.applicationTemplate.findUnique.mockResolvedValue(null);
    mocks.actorFromDiscord.mockResolvedValue(makeActor());
    mocks.loadSupportSettings.mockResolvedValue({ dmNotifications: true, allowDiscordClose: true });
  });

  it('denies an unlinked or unauthorized reviewer before opening a sensitive modal', async () => {
    mocks.actorFromDiscord.mockResolvedValue(makeActor(false));
    const view = makeButton('app:reject:XN-WL-1842');

    await handleButton(view.interaction);

    expect(mocks.actorFromDiscord).toHaveBeenCalledWith('discord-staff-snowflake');
    expect(view.reply).toHaveBeenCalledWith({
      content: 'You do not have permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
    expect(view.showModal).not.toHaveBeenCalled();
  });

  it('routes an authorized approval through the shared Xenon service', async () => {
    const actor = makeActor();
    mocks.actorFromDiscord.mockResolvedValue(actor);
    const view = makeButton('app:approve:XN-WL-1842');

    await handleButton(view.interaction);

    expect(mocks.approveApplication).toHaveBeenCalledWith(mocks.prisma, actor, {
      reference: 'XN-WL-1842',
    });
    expect(view.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(view.editReply).toHaveBeenCalledWith(
      'Approved XN-WL-1842. The applicant has been notified, and role and whitelist ' +
        'synchronisation is queued.',
    );
  });

  it('opens the request-changes modal only after capability authorization', async () => {
    const view = makeButton('app:changes:XN-WL-1842');

    await handleButton(view.interaction);

    expect(view.showModal).toHaveBeenCalledTimes(1);
    expect(view.deferReply).not.toHaveBeenCalled();
    expect(shownModalId).toBe('app:changes:XN-WL-1842');
  });

  it('opens an interview instructions modal and does not transition on the initial click', async () => {
    const view = makeButton('app:interview:XN-WL-1842');

    await handleButton(view.interaction);

    expect(mocks.actorFromDiscord).toHaveBeenCalledWith('discord-staff-snowflake');
    expect(view.showModal).toHaveBeenCalledTimes(1);
    expect(shownModalId).toBe('app:interview:XN-WL-1842');
    expect(mocks.requestInterview).not.toHaveBeenCalled();
  });

  it('routes a reject modal to the shared application service with applicant-facing reason', async () => {
    const actor = makeActor();
    mocks.actorFromDiscord.mockResolvedValue(actor);
    const view = makeModal('app:reject:XN-WL-1842');

    await handleModal(view.interaction);

    expect(mocks.rejectApplication).toHaveBeenCalledWith(mocks.prisma, actor, {
      reference: 'XN-WL-1842',
      publicNote: 'Please add detail',
      staffNote: '',
    });
    expect(view.editReply).toHaveBeenCalledWith(
      'Rejected XN-WL-1842. The applicant has been told why.',
    );
  });

  it('routes interview instructions through the shared application service', async () => {
    const actor = makeActor();
    mocks.actorFromDiscord.mockResolvedValue(actor);
    const view = makeModal('app:interview:XN-WL-1842');

    await handleModal(view.interaction);

    expect(mocks.requestInterview).toHaveBeenCalledWith(mocks.prisma, actor, {
      reference: 'XN-WL-1842',
      publicNote: 'Please add detail',
      staffNote: null,
    });
    expect(view.editReply).toHaveBeenCalledWith('XN-WL-1842 moved to the interview stage.');
  });

  it('returns a clean stale-action message when another reviewer already changed the application', async () => {
    mocks.approveApplication.mockRejectedValue(new Error('APPLICATION_ALREADY_CHANGED'));
    const view = makeButton('app:approve:XN-WL-1842');

    await handleButton(view.interaction);

    expect(view.editReply).toHaveBeenCalledWith('APPLICATION_ALREADY_CHANGED');
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('Xenon support and application selections', () => {
  function makeSelect(customId: string, value: string) {
    const reply = vi.fn();
    const interaction = {
      customId,
      values: [value],
      user: { id: 'discord-user-snowflake' },
      reply,
    } as never;
    return { interaction, reply };
  }

  it('routes a support category to the canonical Xenon portal', async () => {
    const view = makeSelect('xn:support:category', 'TECHNICAL');

    await handleStringSelect(view.interaction);

    const response = view.reply.mock.calls[0]?.[0] as {
      components: { components: { url?: string }[] }[];
      flags: number;
    };
    expect(response.flags).toBe(MessageFlags.Ephemeral);
    expect(response.components[0]?.components[0]?.url).toBe(
      'https://xenon.example.test/support?category=TECHNICAL',
    );
  });

  it('denies developer support without Xenon capabilities', async () => {
    mocks.actorFromDiscord.mockResolvedValue(makeActor(false));
    const view = makeSelect('xn:support:category', 'DEVELOPER');

    await handleStringSelect(view.interaction);

    expect(view.reply).toHaveBeenCalledWith({
      content: 'Developer support is available to Xenon staff only.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does not link to an application that is no longer open', async () => {
    const view = makeSelect('xn:application:open', 'closed-application');

    await handleStringSelect(view.interaction);

    expect(view.reply).toHaveBeenCalledWith({
      content: 'That application is no longer open. Refresh the panel for current openings.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('acknowledges an unknown persistent selection without leaving Discord waiting', async () => {
    const view = makeSelect('xn:unknown:selection', 'value');

    await handleStringSelect(view.interaction);

    expect(view.reply).toHaveBeenCalledWith({
      content: 'This Xenon selection is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
  });
});
