import { brand } from '@xenon/config';
import type { DiscordMessageBody, IntegrationEvent } from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

/**
 * Projects integration events into Discord.
 *
 * Events describe decisions already committed in Core; Link only announces
 * them. Public city notices go to `LINK_EVENTS_CHANNEL_ID`, staff-facing
 * records to `LINK_STAFF_LOG_CHANNEL_ID`. An unconfigured channel makes the
 * event a logged no-op rather than a failure, so the relay does not retry
 * something that can never succeed.
 *
 * Payloads carry Xenon ids and Discord snowflakes only. Game identifiers never
 * reach this module, and nothing here would echo one if it did: only named
 * payload fields are rendered.
 */

export const EVENT_DEDUPE_CAPACITY = 10_000;

export interface EventProjectorOptions {
  readonly eventsChannelId: string | undefined;
  readonly staffLogChannelId: string | undefined;
  readonly send: (channelId: string, message: DiscordMessageBody) => Promise<unknown>;
  readonly logger: Logger;
  readonly capacity?: number;
}

interface Projection {
  readonly audience: 'public' | 'staff';
  readonly message: DiscordMessageBody;
}

type Embed = Record<string, unknown>;

function embed(colour: number, title: string, fields: readonly (readonly [string, string])[]) {
  return {
    color: colour,
    title,
    fields: fields
      .filter(([, value]) => value.length > 0)
      .map(([name, value]) => ({ name, value: value.slice(0, 1024), inline: value.length < 40 })),
    footer: { text: brand.wordmark },
  } satisfies Embed;
}

function timestamp(iso: string): string {
  return `<t:${String(Math.floor(new Date(iso).getTime() / 1000))}:R>`;
}

/** Mention text only: every send suppresses mention parsing, so nobody is pinged. */
function member(discordId: string | null): string {
  return discordId === null ? 'not linked' : `<@${discordId}>`;
}

function staff(title: string, colour: number, fields: readonly (readonly [string, string])[]) {
  return {
    audience: 'staff',
    message: { embeds: [embed(colour, title, fields)] },
  } as const satisfies Projection;
}

/** The Discord projection of an event, or null when Link shows nothing for it. */
export function projectEvent(event: IntegrationEvent): Projection | null {
  const { state } = brand;
  switch (event.type) {
    case 'SERVER_RESTART_SCHEDULED':
      return {
        audience: 'public',
        message: {
          embeds: [
            embed(state.warningInt, 'City restart scheduled', [
              ['Server', event.payload.serverSlug],
              ['Restart', timestamp(event.payload.restartAt)],
            ]),
          ],
        },
      };
    case 'SERVER_STATUS_CHANGED': {
      const { payload } = event;
      const players =
        payload.playerCount === null
          ? ''
          : `${String(payload.playerCount)}${payload.maxPlayers === null ? '' : ` / ${String(payload.maxPlayers)}`}`;
      return {
        audience: 'public',
        message: {
          embeds: [
            embed(
              payload.online ? state.successInt : state.dangerInt,
              `${payload.serverName} is ${payload.online ? 'online' : 'offline'}`,
              [['Players', payload.online ? players : '']],
            ),
          ],
        },
      };
    }
    case 'WHITELIST_SUBMITTED':
      return staff('Whitelist application submitted', state.infoInt, [
        ['Player', event.payload.playerPublicId],
        ['Discord', member(event.payload.discordId)],
        ['Application', event.payload.applicationPublicId],
        ['Form', event.payload.templateName],
      ]);
    case 'WHITELIST_APPROVED':
      return staff('Whitelist approved', state.successInt, [
        ['Player', event.payload.playerPublicId],
        ['Discord', member(event.payload.discordId)],
        ['Application', event.payload.applicationPublicId ?? 'granted directly'],
      ]);
    case 'WHITELIST_REJECTED':
      return staff('Whitelist rejected', state.dangerInt, [
        ['Player', event.payload.playerPublicId],
        ['Discord', member(event.payload.discordId)],
        ['Application', event.payload.applicationPublicId],
      ]);
    case 'WHITELIST_REVOKED':
      return staff(`Whitelist ${event.payload.state.toLowerCase()}`, state.dangerInt, [
        ['Player', event.payload.playerPublicId],
        ['Discord', member(event.payload.discordId)],
      ]);
    case 'PLAYER_IDENTITY_LINKED':
      return staff('Game identity linked', state.infoInt, [
        ['Player', event.payload.playerPublicId],
        ['Discord', member(event.payload.discordId)],
        ['Via', event.payload.via.toLowerCase()],
        ['Kinds', event.payload.kinds.map((kind) => kind.toLowerCase()).join(', ')],
      ]);
    case 'PLAYER_SUSPENDED':
      return staff('Player suspended', state.warningInt, [
        ['Player', event.payload.playerPublicId],
        ['Discord', member(event.payload.discordId)],
        ['Until', event.payload.until === null ? 'indefinitely' : timestamp(event.payload.until)],
        ['Reason', event.payload.reason],
      ]);
    case 'PLAYER_BANNED':
      return staff(
        event.payload.scope === 'FIVEM' ? 'Player banned from the city' : 'Player banned',
        state.dangerInt,
        [
          ['Player', event.payload.playerPublicId ?? 'unknown'],
          ['Discord', member(event.payload.discordId)],
          [
            'Expires',
            event.payload.expiresAt === null ? 'never' : timestamp(event.payload.expiresAt),
          ],
          ['Case', event.payload.caseId ?? ''],
          ['Reason', event.payload.reason],
        ],
      );
    case 'ROLE_SYNC_FAILED':
      return staff('Role sync failed', state.dangerInt, [
        ['Player', event.payload.playerPublicId],
        ['Discord', member(event.payload.discordId)],
        ['Errors', event.payload.errors.join('\n')],
      ]);
    case 'PLAYER_CONNECTED':
    case 'PLAYER_DISCONNECTED':
    case 'ROLE_SYNC_REQUESTED':
      return null;
  }
}

export function createEventProjector(options: EventProjectorOptions) {
  const capacity = options.capacity ?? EVENT_DEDUPE_CAPACITY;
  const delivered = new Set<string>();
  const inFlight = new Map<string, Promise<{ accepted: boolean }>>();

  async function project(event: IntegrationEvent): Promise<{ accepted: boolean }> {
    const projection = projectEvent(event);
    const channelId =
      projection?.audience === 'public' ? options.eventsChannelId : options.staffLogChannelId;
    if (projection === null) {
      options.logger.debug({ eventId: event.id, type: event.type }, 'Event has no projection');
    } else if (channelId === undefined) {
      options.logger.debug(
        { eventId: event.id, type: event.type, audience: projection.audience },
        'Event channel not configured; skipping',
      );
    } else {
      await options.send(channelId, projection.message);
    }

    // Recorded only after a successful post, so a failed post is retried by the relay.
    delivered.add(event.id);
    if (delivered.size > capacity) {
      const oldest = delivered.values().next().value;
      if (oldest !== undefined) delivered.delete(oldest);
    }
    return { accepted: true };
  }

  return {
    async deliver(event: IntegrationEvent): Promise<{ accepted: boolean }> {
      if (delivered.has(event.id)) return { accepted: true };
      const pending = inFlight.get(event.id);
      if (pending !== undefined) return pending;

      const run = project(event).finally(() => inFlight.delete(event.id));
      inFlight.set(event.id, run);
      return run;
    },
  };
}
