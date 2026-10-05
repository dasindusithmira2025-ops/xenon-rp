import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const xenon = new SlashCommandBuilder()
  .setName('xenon')
  .setDescription('Manage Xenon Discord server features')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((group) =>
    group
      .setName('setup')
      .setDescription('Plan and manage the Xenon Discord server')
      .addSubcommand((sub) => sub.setName('plan').setDescription('Preview Discord changes'))
      .addSubcommand((sub) =>
        sub
          .setName('apply')
          .setDescription('Apply a reviewed server plan')
          .addStringOption((option) =>
            option
              .setName('confirm')
              .setDescription('Type PROVISION XENON to confirm')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show managed resources'))
      .addSubcommand((sub) =>
        sub
          .setName('repair')
          .setDescription('Repair drifted Discord resources')
          .addStringOption((option) =>
            option
              .setName('confirm')
              .setDescription('Type PROVISION XENON to confirm')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('validate').setDescription('Validate permissions and hierarchy'))
      .addSubcommand((sub) => sub.setName('permissions').setDescription('Show server permission audit'))
      .addSubcommand((sub) => sub.setName('assets').setDescription('Show emoji and sticker assets'))
      .addSubcommand((sub) => sub.setName('adopt').setDescription('Adopt existing server channels and roles')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('panel')
      .setDescription('Manage persistent Discord panels')
      .addSubcommand((sub) => sub.setName('setup').setDescription('Create missing panels'))
      .addSubcommand((sub) => sub.setName('refresh').setDescription('Refresh existing panels'))
      .addSubcommand((sub) => sub.setName('status').setDescription('Show panel messages'))
      .addSubcommand((sub) => sub.setName('repair').setDescription('Repair panel drift')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('automod')
      .setDescription('Configure Discord AutoMod')
      .addSubcommand((sub) => sub.setName('status').setDescription('Show AutoMod configuration'))
      .addSubcommand((sub) => sub.setName('enable').setDescription('Enable Xenon AutoMod rules'))
      .addSubcommand((sub) => sub.setName('disable').setDescription('Disable Xenon AutoMod rules')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('welcome')
      .setDescription('Configure Discord join messages')
      .addSubcommand((sub) => sub.setName('enable').setDescription('Enable welcome messages'))
      .addSubcommand((sub) => sub.setName('disable').setDescription('Disable welcome messages'))
      .addSubcommand((sub) => sub.setName('dm-enable').setDescription('Send new members a welcome DM'))
      .addSubcommand((sub) => sub.setName('dm-disable').setDescription('Stop sending welcome DMs')),
  )
  .toJSON();

const room = new SlashCommandBuilder()
  .setName('room')
  .setDescription('Control the temporary voice room you own')
  .addSubcommand((sub) =>
    sub.setName('rename').setDescription('Rename your room').addStringOption((option) =>
      option.setName('name').setDescription('New name').setRequired(true).setMaxLength(32),
    ),
  )
  .addSubcommand((sub) =>
    sub.setName('limit').setDescription('Set room capacity').addIntegerOption((option) =>
      option.setName('size').setDescription('0-25').setMinValue(0).setMaxValue(25).setRequired(true),
    ),
  )
  .addSubcommand((sub) => sub.setName('lock').setDescription('Lock your room'))
  .addSubcommand((sub) => sub.setName('unlock').setDescription('Unlock your room'))
  .addSubcommand((sub) =>
    sub.setName('permit').setDescription('Allow someone into a locked room').addUserOption((option) =>
      option.setName('member').setDescription('Who').setRequired(true),
    ),
  )
  .addSubcommand((sub) =>
    sub.setName('remove').setDescription('Disconnect someone from your room').addUserOption((option) =>
      option.setName('member').setDescription('Who').setRequired(true),
    ),
  )
  .addSubcommand((sub) =>
    sub.setName('transfer').setDescription('Transfer your room to someone inside').addUserOption((option) =>
      option.setName('member').setDescription('Who').setRequired(true),
    ),
  )
  .toJSON();

export const DISABLED_PLATFORM_RESPONSE =
  'Xenon Platform integration is not enabled on this deployment.';

export function respondPlatformUnavailable(interaction: {
  readonly reply: (payload: { readonly content: string; readonly flags: MessageFlags.Ephemeral }) => Promise<unknown>;
}): Promise<unknown> {
  return interaction.reply({ content: DISABLED_PLATFORM_RESPONSE, flags: MessageFlags.Ephemeral });
}

export const DISCORD_ONLY_COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Show Discord bot and guild status').toJSON(),
  new SlashCommandBuilder().setName('profile').setDescription('Show your Xenon platform profile').addUserOption((option) =>
    option.setName('member').setDescription('Whose profile to show').setRequired(false),
  ).toJSON(),
  new SlashCommandBuilder().setName('application').setDescription('Show a Xenon platform application').addStringOption((option) =>
    option.setName('reference').setDescription('Application reference').setRequired(false),
  ).toJSON(),
  new SlashCommandBuilder().setName('review').setDescription('Review a platform application').addStringOption((option) =>
    option.setName('reference').setDescription('Application reference').setRequired(true),
  ).toJSON(),
  new SlashCommandBuilder().setName('link').setDescription('Link your FiveM identity').addStringOption((option) =>
    option.setName('code').setDescription('Link code').setRequired(true),
  ).toJSON(),
  new SlashCommandBuilder().setName('queue').setDescription('Show the platform application queue').toJSON(),
  new SlashCommandBuilder().setName('player').setDescription('Look up a platform player').addStringOption((option) =>
    option.setName('reference').setDescription('Player reference').setRequired(true),
  ).toJSON(),
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post an announcement to Xenon announcements')
    .addStringOption((option) => option.setName('title').setDescription('Announcement title').setRequired(true).setMaxLength(100))
    .addStringOption((option) => option.setName('message').setDescription('Announcement message').setRequired(true).setMaxLength(3500))
    .toJSON(),
  xenon,
  room,
];

export function isPlatformDataCommand(name: string): boolean {
  return ['profile', 'application', 'review', 'link', 'queue', 'player'].includes(name);
}
