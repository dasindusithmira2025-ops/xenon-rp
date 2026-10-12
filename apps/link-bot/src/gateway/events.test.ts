import { describe, expect, it, vi } from 'vitest';

import type { DiscordMessageBody, IntegrationEvent } from '@xenon/contracts';
import { silentLogger } from '@xenon/logger';

import { createEventProjector, projectEvent } from './events';

const EVENTS = '500000000000000001';
const STAFF = '500000000000000002';
const DISCORD_ID = '300000000000000003';

function event<TType extends IntegrationEvent['type']>(
  type: TType,
  payload: Extract<IntegrationEvent, { type: TType }>['payload'],
  id = 'evt_1',
): IntegrationEvent {
  return {
    id,
    idempotencyKey: `key:${id}`,
    occurredAt: '2026-10-10T12:00:00.000Z',
    source: 'SYSTEM',
    type,
    version: 1,
    payload,
  } as IntegrationEvent;
}

const approved = (id = 'evt_1') =>
  event(
    'WHITELIST_APPROVED',
    { playerPublicId: 'XN-ABC123', discordId: DISCORD_ID, applicationPublicId: 'XN-WL-1' },
    id,
  );

function projector(
  channels: { events?: string; staff?: string } = { events: EVENTS, staff: STAFF },
) {
  const send = vi.fn((_channelId: string, _message: DiscordMessageBody) => Promise.resolve());
  const instance = createEventProjector({
    eventsChannelId: channels.events,
    staffLogChannelId: channels.staff,
    send,
    logger: silentLogger,
    capacity: 3,
  });
  return { send, instance };
}

describe('event projection', () => {
  it('posts a duplicate event id only once', async () => {
    const { send, instance } = projector();
    await expect(instance.deliver(approved())).resolves.toEqual({ accepted: true });
    await expect(instance.deliver(approved())).resolves.toEqual({ accepted: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(STAFF);
  });

  it('collapses concurrent deliveries of the same id', async () => {
    const { send, instance } = projector();
    await Promise.all([instance.deliver(approved()), instance.deliver(approved())]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed post instead of recording it as delivered', async () => {
    const { send, instance } = projector();
    send.mockRejectedValueOnce(new Error('Discord down'));
    await expect(instance.deliver(approved())).rejects.toThrow('Discord down');
    await instance.deliver(approved());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest ids beyond capacity', async () => {
    const { send, instance } = projector();
    for (const id of ['a', 'b', 'c', 'd']) await instance.deliver(approved(id));
    await instance.deliver(approved('a'));
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('routes public notices to the events channel', async () => {
    const { send, instance } = projector();
    await instance.deliver(
      event('SERVER_RESTART_SCHEDULED', {
        serverSlug: 'main',
        restartAt: '2026-10-10T12:30:00.000Z',
        secondsRemaining: 1800,
        origin: 'TXADMIN',
      }),
    );
    expect(send.mock.calls[0]?.[0]).toBe(EVENTS);
  });

  it('accepts without posting when the channel is not configured', async () => {
    const { send, instance } = projector({});
    await expect(instance.deliver(approved())).resolves.toEqual({ accepted: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts events Link does not project', async () => {
    const { send, instance } = projector();
    await expect(
      instance.deliver(
        event('PLAYER_CONNECTED', { serverSlug: 'main', playerPublicId: null, playerName: 'x' }),
      ),
    ).resolves.toEqual({ accepted: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('renders the Discord member as mention text and identity kinds without values', () => {
    const projection = projectEvent(
      event('PLAYER_IDENTITY_LINKED', {
        playerPublicId: 'XN-ABC123',
        discordId: DISCORD_ID,
        kinds: ['FIVEM'],
        via: 'CFX',
      }),
    );
    const rendered = JSON.stringify(projection);
    expect(projection?.audience).toBe('staff');
    expect(rendered).toContain(`<@${DISCORD_ID}>`);
    expect(rendered).toContain('fivem');
    expect(rendered).not.toMatch(/license:/i);
  });
});
