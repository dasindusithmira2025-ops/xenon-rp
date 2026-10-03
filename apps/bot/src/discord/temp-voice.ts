import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits as P,
  SlashCommandBuilder,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';

import { prisma } from '@xenon/database';
import { consumeRateLimit, rateLimits, redis } from '@xenon/jobs';

import { logger } from '../runtime';

/**
 * Temporary voice rooms.
 *
 * Join "➕ Create Room", get your own room, and it disappears when the last
 * person leaves. State is three small Redis keys per room rather than rows in
 * Postgres: a room lives for an evening, and nothing about it is worth keeping.
 *
 * Owners get control through `/room`, executed by the bot. They never receive
 * Manage Channels or Manage Permissions themselves, so a room can be renamed,
 * limited, locked or opened to a friend - and cannot be used to grant anything.
 */

const MAX_ROOMS = 25;
const ROOMS = 'tempvoice:rooms';
const ownerKey = (channelId: string) => `tempvoice:room:${channelId}`;
const roomOfKey = (userId: string) => `tempvoice:owner:${userId}`;

export const roomCommand = new SlashCommandBuilder()
  .setName('room')
  .setDescription('Control the temporary voice room you own')
  .addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Rename your room')
      .addStringOption((option) =>
        option.setName('name').setDescription('New name').setRequired(true).setMaxLength(32),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('limit')
      .setDescription('Limit how many people can join (0 = no limit)')
      .addIntegerOption((option) =>
        option
          .setName('size')
          .setDescription('0-25')
          .setMinValue(0)
          .setMaxValue(25)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('lock').setDescription('Only people already inside or permitted can join'),
  )
  .addSubcommand((sub) => sub.setName('unlock').setDescription('Anyone can join again'))
  .addSubcommand((sub) =>
    sub
      .setName('permit')
      .setDescription('Let someone join while locked')
      .addUserOption((option) => option.setName('member').setDescription('Who').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Disconnect someone and keep them out')
      .addUserOption((option) => option.setName('member').setDescription('Who').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('transfer')
      .setDescription('Give your room to someone inside it')
      .addUserOption((option) => option.setName('member').setDescription('Who').setRequired(true)),
  )
  .toJSON();

/** Printable, short, no mentions or markdown tricks. */
export function sanitiseRoomName(raw: string): string {
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\p{C}@#`*_~|<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return cleaned.length >= 2 ? cleaned : 'Room';
}

async function createRoomChannelId(guildId: string): Promise<string | null> {
  const entry = await prisma.discordManagedResource.findUnique({
    where: { guildId_logicalKey: { guildId, logicalKey: 'voice.create-room' } },
    select: { discordResourceId: true, managed: true },
  });
  return entry?.managed === true ? entry.discordResourceId : null;
}

async function deleteRoom(guild: Guild, channelId: string): Promise<void> {
  const owner = await redis().get(ownerKey(channelId));
  await guild.channels.delete(channelId, 'Temporary room empty').catch(() => undefined);
  await redis()
    .multi()
    .srem(ROOMS, channelId)
    .del(ownerKey(channelId))
    .del(owner === null ? 'tempvoice:none' : roomOfKey(owner))
    .exec();
}

async function openRoom(member: GuildMember, lobby: VoiceBasedChannel): Promise<void> {
  const existing = await redis().get(roomOfKey(member.id));
  if (existing !== null) {
    const room = await member.guild.channels.fetch(existing).catch(() => null);
    if (room?.isVoiceBased() === true) {
      await member.voice.setChannel(room, 'Back to own room');
      return;
    }
  }

  if ((await redis().scard(ROOMS)) >= MAX_ROOMS) {
    await member.voice.disconnect('Temporary room limit reached').catch(() => undefined);
    return;
  }
  const limit = await consumeRateLimit(rateLimits.discordTempRoom, member.id);
  if (!limit.allowed) {
    await member.voice.disconnect('Creating rooms too quickly').catch(() => undefined);
    return;
  }

  // The room copies the lobby category's policy and adds nothing but the
  // owner's ability to connect - no management permission ever reaches a member.
  const parent = lobby.parent;
  const room = await member.guild.channels.create({
    name: sanitiseRoomName(`${member.displayName}'s room`),
    type: ChannelType.GuildVoice,
    parent: parent?.id ?? null,
    permissionOverwrites: [
      ...(parent?.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield,
        deny: overwrite.deny.bitfield,
      })) ?? []),
      {
        id: member.id,
        type: OverwriteType.Member,
        allow: P.ViewChannel | P.Connect | P.Speak | P.Stream,
        deny: 0n,
      },
    ],
    reason: `Temporary room for ${member.user.username}`,
  });
  await redis()
    .multi()
    .sadd(ROOMS, room.id)
    .set(ownerKey(room.id), member.id)
    .set(roomOfKey(member.id), room.id)
    .exec();
  await member.voice.setChannel(room, 'Temporary room created').catch(async () => {
    await deleteRoom(member.guild, room.id);
  });
}

export async function handleVoiceState(before: VoiceState, after: VoiceState): Promise<void> {
  if (
    after.channelId !== null &&
    after.channelId !== before.channelId &&
    after.member !== null &&
    !after.member.user.bot
  ) {
    const lobby = await createRoomChannelId(after.guild.id);
    if (lobby !== null && after.channelId === lobby && after.channel !== null) {
      await openRoom(after.member, after.channel);
    }
  }

  if (
    before.channelId !== null &&
    before.channelId !== after.channelId &&
    before.channel !== null
  ) {
    const isRoom = (await redis().sismember(ROOMS, before.channelId)) === 1;
    if (isRoom && before.channel.members.size === 0)
      await deleteRoom(before.guild, before.channelId);
  }
}

/** On start: remove rooms that emptied or vanished while the bot was offline. */
export async function sweepRooms(client: Client): Promise<void> {
  const rooms = await redis().smembers(ROOMS);
  for (const channelId of rooms) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isVoiceBased()) {
      await redis().multi().srem(ROOMS, channelId).del(ownerKey(channelId)).exec();
      continue;
    }
    if (channel.members.size === 0) await deleteRoom(channel.guild, channelId);
  }
}

export async function handleRoomCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (guild === null) return;

  const member = await guild.members.fetch(interaction.user.id);
  const channelId = member.voice.channelId;
  if (channelId === null || (await redis().get(ownerKey(channelId))) !== member.id) {
    await reply('Join the temporary room you own first.');
    return;
  }
  const room = member.voice.channel;
  if (room === null) return;

  const sub = interaction.options.getSubcommand(true);
  if (sub === 'rename' || sub === 'limit') {
    const limit = await consumeRateLimit(rateLimits.discordRoomEdit, member.id);
    if (!limit.allowed) {
      await reply('Discord only allows a few room edits every ten minutes. Try again shortly.');
      return;
    }
  }

  try {
    switch (sub) {
      case 'rename':
        await room.setName(
          sanitiseRoomName(interaction.options.getString('name', true)),
          'Room owner rename',
        );
        await reply('Renamed.');
        return;
      case 'limit':
        await room.setUserLimit(interaction.options.getInteger('size', true), 'Room owner limit');
        await reply('Limit updated.');
        return;
      case 'lock':
        await room.permissionOverwrites.edit(
          guild.id,
          { Connect: false },
          { reason: 'Room owner lock' },
        );
        await reply('Locked. Use `/room permit` to let someone in.');
        return;
      case 'unlock':
        await room.permissionOverwrites.edit(
          guild.id,
          { Connect: true },
          { reason: 'Room owner unlock' },
        );
        await reply('Unlocked.');
        return;
      case 'permit': {
        const target = interaction.options.getUser('member', true);
        await room.permissionOverwrites.edit(
          target.id,
          { ViewChannel: true, Connect: true },
          { reason: 'Room owner permit' },
        );
        await reply(`${target.username} can join.`);
        return;
      }
      case 'remove': {
        const target = interaction.options.getUser('member', true);
        if (target.id === member.id) {
          await reply('You cannot remove yourself; leave the room instead.');
          return;
        }
        await room.permissionOverwrites.edit(
          target.id,
          { Connect: false },
          { reason: 'Room owner remove' },
        );
        const inside = room.members.get(target.id);
        if (inside !== undefined) await inside.voice.disconnect('Removed by room owner');
        await reply(`${target.username} was removed.`);
        return;
      }
      case 'transfer': {
        const target = interaction.options.getUser('member', true);
        if (!room.members.has(target.id) || target.bot) {
          await reply('They need to be in the room.');
          return;
        }
        if ((await redis().get(roomOfKey(target.id))) !== null) {
          await reply('They already own a room.');
          return;
        }
        await redis()
          .multi()
          .set(ownerKey(room.id), target.id)
          .del(roomOfKey(member.id))
          .set(roomOfKey(target.id), room.id)
          .exec();
        await room.permissionOverwrites.edit(target.id, {
          ViewChannel: true,
          Connect: true,
          Speak: true,
          Stream: true,
        });
        await reply(`${target.username} owns the room now.`);
        return;
      }
      default:
        await reply('Unknown room command.');
    }
  } catch (error) {
    logger.warn({ err: error, sub }, 'Room command failed');
    await reply('That did not work. Check that Xenon still manages this room.');
  }
}
