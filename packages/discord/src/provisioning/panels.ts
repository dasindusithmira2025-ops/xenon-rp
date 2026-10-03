import {
  ActionRowBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';

import { brand, siteMeta } from '@xenon/config';

import { xenonEmbed } from '../embeds';
import { xenonIds } from '../interaction-ids';

import { stableHash } from './hash';

import type { DesiredPanel, DesiredRole } from './types';

/**
 * Persistent panels.
 *
 * A panel is a message Xenon owns and edits in place: the welcome card, the
 * live city status, the role selector. Rendering is pure - data in, message
 * JSON out - so the plan can hash a panel to decide whether it needs an edit,
 * and the same bytes are posted whether the slash command, the Control Center
 * or the CLI triggered it.
 *
 * Copy is short on purpose. Discord is read on phones; a panel that needs
 * scrolling is a panel nobody reads.
 */

export interface PanelPayload {
  readonly embeds: APIEmbed[];
  readonly components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

export interface EmojiRef {
  readonly id: string;
  readonly name: string;
  readonly animated: boolean;
}

export interface PanelContext {
  readonly siteUrl: string;
  /** False in production when the site URL is localhost: link buttons are omitted. */
  readonly linksAllowed: boolean;
  readonly connectUrl: string | null;
  readonly rules: {
    readonly version: number | null;
    readonly retrievedAt: Date | null;
  };
  readonly applications: {
    readonly globallyOpen: boolean;
    readonly whitelistOpen: boolean;
    readonly open: readonly { readonly name: string; readonly slug: string }[];
  };
  readonly departments: readonly {
    readonly slug: string;
    readonly name: string;
    readonly tagline: string | null;
    readonly recruitmentState: 'OPEN' | 'CLOSED' | 'WAITLIST' | 'INVITE_ONLY';
  }[];
  readonly status: {
    readonly aggregate: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
    readonly totalPlayers: number | null;
    readonly totalCapacity: number | null;
    readonly queue: number | null;
    readonly nextRestartAt: string | null;
    readonly checkedAt: string | null;
    readonly servers: readonly {
      readonly name: string;
      readonly state: string;
      readonly players: number | null;
      readonly max: number | null;
    }[];
  };
  /** Custom emoji by logical key, when uploaded. */
  readonly emojis: ReadonlyMap<string, EmojiRef>;
  readonly selfRoles: readonly DesiredRole[];
}

export type AnnouncementType =
  | 'SERVER'
  | 'MAINTENANCE'
  | 'RESTART'
  | 'UPDATE'
  | 'PATCH_NOTES'
  | 'EVENT'
  | 'RECRUITMENT'
  | 'EMERGENCY'
  | 'COMMUNITY';

export interface XenonBasePanelInput {
  readonly title: string;
  readonly description: string;
  readonly tone?: 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  readonly footer?: string;
  readonly timestamp?: Date;
}

/** Shared visual foundation for Xenon panels and one-off system messages. */
export function XenonBasePanel(input: XenonBasePanelInput) {
  const embed = xenonEmbed(input.tone ?? 'brand')
    .setAuthor({ name: brand.wordmark })
    .setTitle(input.title)
    .setDescription(input.description)
    .setFooter({ text: input.footer ?? 'XenonRP • Official System' });
  if (input.timestamp !== undefined) embed.setTimestamp(input.timestamp);
  return embed;
}

export function XenonSuccessPanel(title: string, description: string) {
  return XenonBasePanel({ title, description, tone: 'success', footer: 'XenonRP • Success' });
}

export function XenonWarningPanel(title: string, description: string) {
  return XenonBasePanel({ title, description, tone: 'warning', footer: 'XenonRP • Notice' });
}

export function XenonErrorPanel(title: string, description: string) {
  return XenonBasePanel({ title, description, tone: 'danger', footer: 'XenonRP • System' });
}

export function XenonWelcomePanel(context: PanelContext): PanelPayload {
  const embed = XenonBasePanel({
    title: 'WELCOME TO XENON.',
    description: `One city. Thousands of stories. Your reputation starts here.\n\n**${siteMeta.tagline}**\nNeed help? Choose a category in #support.`,
  });
  embed.addFields(
    {
      name: 'SERVER OVERVIEW',
      value: 'Serious roleplay, player-led stories, businesses and city services.',
    },
    {
      name: 'BEFORE YOU START',
      value: [
        'Read the rules in #rules',
        'Connect your Xenon account',
        'Link FiveM and complete your whitelist',
        'Enter the city when approved',
      ].join('\n'),
    },
  );
  return {
    embeds: [embed.toJSON()],
    components: linkRow([
      ['WEBSITE', url(context, '/')],
      ['RULEBOOK', url(context, '/rules')],
      ['APPLY FOR WHITELIST', url(context, '/applications')],
      ['PLAYER PORTAL', url(context, '/portal')],
    ]),
  };
}

export function XenonRulesPanel(context: PanelContext): PanelPayload {
  const embed = XenonBasePanel({
    title: 'XENON OFFICIAL RULEBOOK',
    description:
      'All players are responsible for understanding and following the current XenonRP rules before entering the city. The website rulebook is canonical.',
    footer: 'XenonRP • Official Rulebook',
  });
  embed.addFields(
    {
      name: 'Version',
      value:
        context.rules.version === null ? 'Not yet published' : `v${String(context.rules.version)}`,
      inline: true,
    },
    {
      name: 'Last updated',
      value: timestamp(context.rules.retrievedAt, 'D') ?? '—',
      inline: true,
    },
  );
  return {
    embeds: [embed.toJSON()],
    components: linkRow([['READ FULL RULEBOOK', url(context, '/rules')]]),
  };
}

export function XenonRecruitmentPanel(
  context: PanelContext,
  departmentSlug?: string,
): PanelPayload {
  const departments =
    departmentSlug === undefined
      ? context.departments
      : context.departments.filter((department) => department.slug === departmentSlug);
  const hiring = departments.filter((department) => department.recruitmentState !== 'CLOSED');
  const embed = XenonBasePanel({
    title:
      departmentSlug === undefined
        ? 'XENON RECRUITMENT'
        : `${departments[0]?.name.toUpperCase() ?? 'DEPARTMENT'} · RECRUITMENT`,
    description:
      departments.length === 0
        ? 'No departments are published yet.'
        : departments
            .map(
              (department) =>
                `**${department.name}** · ${recruitmentLabel[department.recruitmentState]}`,
            )
            .join('\n'),
    tone: hiring.length > 0 ? 'brand' : 'neutral',
    footer: 'XenonRP • Recruitment',
  });
  return {
    embeds: [embed.toJSON()],
    components: linkRow([
      ['VIEW APPLICATIONS', hiring.length > 0 ? url(context, '/applications') : null],
      ...departments
        .slice(0, 4)
        .map(
          (department) =>
            [`ABOUT ${department.name}`, url(context, `/departments/${department.slug}`)] as const,
        ),
    ]),
  };
}

const supportCategories = [
  { value: 'GENERAL', label: 'General Support', description: 'General questions and assistance' },
  {
    value: 'TECHNICAL',
    label: 'Technical Support',
    description: 'Website, Discord or FiveM issues',
  },
  {
    value: 'CHARACTER',
    label: 'Character Issue',
    description: 'Problems related to your character',
  },
  {
    value: 'PLAYER_REPORT',
    label: 'Player Report',
    description: 'Report a player or rule violation',
  },
  { value: 'STAFF_REPORT', label: 'Staff Report', description: 'Report a Xenon staff member' },
  { value: 'WHITELIST', label: 'Whitelist Support', description: 'Whitelist or application help' },
  {
    value: 'BUSINESS',
    label: 'Business / Organization',
    description: 'Business, gang or organization help',
  },
  { value: 'DEVELOPER', label: 'Developer Issue', description: 'Staff and developer support only' },
] as const;

export function XenonSupportPanel(context: PanelContext): PanelPayload {
  const select = new StringSelectMenuBuilder()
    .setCustomId(xenonIds.supportCategory())
    .setPlaceholder('Select a support category')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      supportCategories.map(({ value, label, description }) => ({
        value,
        label,
        description,
      })),
    );
  return {
    embeds: [
      XenonBasePanel({
        title: 'XENON SUPPORT CENTER',
        description:
          'Choose the closest category below. Xenon keeps your ticket history in the player portal so staff can help with the full context.',
        footer: 'XenonRP • Support',
      }).toJSON(),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON(),
      ...linkRow([['XENON WEBSITE', url(context, '/')]]),
    ],
  };
}

export function XenonApplicationPanel(context: PanelContext): PanelPayload {
  const open = context.applications.globallyOpen ? context.applications.open.slice(0, 25) : [];
  const whitelistOpen = context.applications.globallyOpen && context.applications.whitelistOpen;
  const embed = XenonBasePanel({
    title: 'XENON APPLICATION CENTER',
    description:
      'Start your journey in Xenon. Applications are completed and tracked on the Xenon website.',
    tone: open.length > 0 ? 'brand' : 'neutral',
    footer: 'XenonRP • Applications',
  }).addFields(
    {
      name: 'AVAILABLE NOW',
      value:
        open.length > 0
          ? open.map((entry) => `• ${entry.name}`).join('\n')
          : 'No applications are open right now.',
    },
    {
      name: 'WHITELIST',
      value: whitelistOpen
        ? `${emojiText(context, 'emoji.xenon_verified', '✅')} Open`
        : `${emojiText(context, 'emoji.xenon_idle', '⚫')} Closed`,
      inline: true,
    },
  );
  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  if (open.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(xenonIds.applicationOpen())
      .setPlaceholder('Choose an open application')
      .addOptions(
        open.map((entry) => ({
          label: entry.name.slice(0, 100),
          value: entry.slug,
          description: 'Continue on the Xenon website',
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu).toJSON());
  }
  components.push(
    ...linkRow([
      ['VIEW APPLICATIONS', url(context, '/applications')],
      ['MY APPLICATIONS', url(context, '/portal/applications')],
    ]),
  );
  return { embeds: [embed.toJSON()], components };
}

export function XenonRolePanel(context: PanelContext): PanelPayload {
  const notify = context.selfRoles.filter((role) => role.tier === 'notification');
  const language = context.selfRoles.filter((role) => role.tier === 'language');
  const row = (roles: readonly DesiredRole[]) =>
    roles.length === 0
      ? []
      : [
          new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              roles.slice(0, 5).map((role) => {
                const button = new ButtonBuilder()
                  .setCustomId(xenonIds.roleToggle(role.key))
                  .setStyle(ButtonStyle.Secondary)
                  .setLabel(role.selfRoleLabel ?? role.name);
                if (role.selfRoleEmoji !== undefined) button.setEmoji(role.selfRoleEmoji);
                return button;
              }),
            )
            .toJSON(),
        ];
  return {
    embeds: [
      XenonBasePanel({
        title: 'CUSTOMIZE YOUR XENON EXPERIENCE',
        description:
          'Choose the notifications you want. These roles only control pings; they never grant access or staff permissions.',
        footer: 'XenonRP • Notifications',
      }).toJSON(),
    ],
    components: [...row(notify), ...row(language)],
  };
}

export function XenonStaffPanel(context: PanelContext): PanelPayload {
  return {
    embeds: [
      XenonBasePanel({
        title: 'XENON STAFF REVIEW',
        description:
          'Whitelist applications are reviewed through Xenon Control. Open an application card to approve, request changes, schedule an interview or reject.',
        footer: 'XenonRP • Staff',
      }).toJSON(),
    ],
    components: linkRow([['OPEN REVIEW QUEUE', url(context, '/control/applications')]]),
  };
}

export function XenonAnnouncementPanel(input: {
  readonly type: AnnouncementType;
  readonly title: string;
  readonly message: string;
  readonly readMoreUrl?: string | null;
  readonly effectiveAt?: Date | null;
  readonly timestamp?: Date;
}) {
  const labels: Record<AnnouncementType, string> = {
    SERVER: 'SERVER ANNOUNCEMENT',
    MAINTENANCE: 'SCHEDULED MAINTENANCE',
    RESTART: 'SERVER RESTART',
    UPDATE: 'CITY UPDATE',
    PATCH_NOTES: 'PATCH NOTES',
    EVENT: 'COMMUNITY EVENT',
    RECRUITMENT: 'RECRUITMENT',
    EMERGENCY: 'EMERGENCY NOTICE',
    COMMUNITY: 'COMMUNITY ANNOUNCEMENT',
  };
  const tone =
    input.type === 'EMERGENCY'
      ? 'danger'
      : input.type === 'MAINTENANCE' || input.type === 'RESTART'
        ? 'warning'
        : 'brand';
  const body =
    input.effectiveAt == null
      ? input.message
      : `${input.message}\n\n**Effective**\n<t:${String(Math.floor(input.effectiveAt.getTime() / 1000))}:R>`;
  const embed = XenonBasePanel({
    title: input.title,
    description: `**${labels[input.type]}**\n\n${body}`,
    tone,
    footer: 'XenonRP • Announcements',
    timestamp: input.timestamp ?? new Date(),
  });
  if (input.readMoreUrl !== undefined && input.readMoreUrl !== null)
    embed.setURL(input.readMoreUrl);
  return embed;
}

export function XenonTicketPanel(input: {
  readonly ticketId: string;
  readonly category: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly portalUrl: string | null;
  readonly closeCustomId?: string;
  readonly closed?: boolean;
  readonly canClose?: boolean;
}) {
  const embed = XenonBasePanel({
    title:
      input.closed === true ? 'XENON SUPPORT · TICKET CLOSED' : 'XENON SUPPORT · TICKET OPENED',
    description:
      input.closed === true
        ? 'This ticket is now closed. You can still review its history in the Xenon player portal.'
        : 'A staff member will assist you shortly. Add useful details and follow replies in the Xenon player portal.',
    tone: input.closed === true ? 'neutral' : 'brand',
    footer: 'XenonRP • Support',
    timestamp: input.createdAt,
  }).addFields(
    { name: 'Ticket', value: input.ticketId, inline: true },
    { name: 'Category', value: input.category, inline: true },
    { name: 'Created by', value: input.createdBy, inline: true },
  );
  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  const buttons: ButtonBuilder[] = [];
  if (input.portalUrl !== null)
    buttons.push(
      new ButtonBuilder()
        .setLabel('OPEN IN XENON')
        .setStyle(ButtonStyle.Link)
        .setURL(input.portalUrl),
    );
  if (input.closeCustomId !== undefined && input.closed !== true && input.canClose !== false)
    buttons.push(
      new ButtonBuilder()
        .setCustomId(input.closeCustomId)
        .setLabel('CLOSE TICKET')
        .setStyle(ButtonStyle.Secondary),
    );
  if (buttons.length > 0)
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons).toJSON());
  return { embeds: [embed.toJSON()], components };
}

function emojiText(context: PanelContext, key: string, fallback: string): string {
  const emoji = context.emojis.get(key);
  return emoji === undefined
    ? fallback
    : `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

function url(context: PanelContext, path: string): string | null {
  if (!context.linksAllowed) return null;
  return new URL(path, context.siteUrl).toString();
}

function linkRow(
  links: readonly (readonly [label: string, href: string | null])[],
): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const buttons = links
    .filter(
      (link): link is readonly [string, string] => link[1] !== null && /^https?:\/\//.test(link[1]),
    )
    .slice(0, 5)
    .map(([label, href]) =>
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(href),
    );
  return buttons.length === 0
    ? []
    : [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons).toJSON()];
}

function timestamp(value: Date | string | null, style: 'R' | 'D' | 'f' = 'R'): string | null {
  if (value === null) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime())
    ? null
    : `<t:${String(Math.floor(date.getTime() / 1000))}:${style}>`;
}

const recruitmentLabel = {
  OPEN: 'Recruiting',
  WAITLIST: 'Waitlist',
  INVITE_ONLY: 'Invite only',
  CLOSED: 'Closed',
} as const;

export function renderPanel(panel: DesiredPanel, context: PanelContext): PanelPayload {
  switch (panel.kind) {
    case 'welcome':
      return XenonWelcomePanel(context);

    case 'support':
      return XenonSupportPanel(context);

    case 'rules':
      return XenonRulesPanel(context);

    case 'how-to-join': {
      const steps = [
        ['Discord', 'You are here.'],
        ['Xenon account', 'Sign in on the website with this Discord account.'],
        ['Rules', 'Read and accept the current rulebook.'],
        ['FiveM', 'Link your game account from the player portal.'],
        ['Whitelist', 'Apply. Staff review every application.'],
        ['Enter the city', 'Approved? Connect and start your story.'],
      ] as const;
      return {
        embeds: [
          xenonEmbed()
            .setTitle('HOW TO JOIN')
            .setDescription(
              steps
                .map(([title, body], index) => `**${String(index + 1)} · ${title}**\n${body}`)
                .join('\n\n'),
            )
            .toJSON(),
        ],
        components: linkRow([
          ['Sign in', url(context, '/signin')],
          ['Rules', url(context, '/rules')],
          ['Link FiveM', url(context, '/portal/account')],
          ['Apply', url(context, '/applications')],
        ]),
      };
    }

    case 'city-status':
      return XenonServerStatusPanel(context);

    case 'choose-roles':
      return XenonRolePanel(context);

    case 'applications':
      return XenonApplicationPanel(context);

    case 'staff':
      return XenonStaffPanel(context);

    case 'departments': {
      const embed = xenonEmbed().setTitle('CITY SERVICES');
      embed.setDescription(
        context.departments.length === 0
          ? 'Departments are being prepared.'
          : context.departments
              .map(
                (department) =>
                  `**${department.name}** · ${recruitmentLabel[department.recruitmentState]}${department.tagline === null ? '' : `\n${department.tagline}`}`,
              )
              .join('\n\n'),
      );
      return {
        embeds: [embed.toJSON()],
        components: linkRow(
          context.departments
            .slice(0, 5)
            .map(
              (department) =>
                [department.name, url(context, `/departments/${department.slug}`)] as const,
            ),
        ),
      };
    }

    case 'department-recruitment': {
      return XenonRecruitmentPanel(context, panel.departmentSlug);
    }
  }
}

/**
 * The live city card. Never shows a number it does not have: an unknown player
 * count is "unavailable", never zero.
 */
export function XenonServerStatusPanel(context: PanelContext): PanelPayload {
  const { status } = context;
  const tone =
    status.aggregate === 'ONLINE'
      ? 'success'
      : status.aggregate === 'DEGRADED'
        ? 'warning'
        : status.aggregate === 'OFFLINE'
          ? 'danger'
          : 'neutral';
  const dot = {
    ONLINE: emojiText(context, 'emoji.xenon_online', '🟢'),
    DEGRADED: emojiText(context, 'emoji.xenon_degraded', '🟠'),
    OFFLINE: emojiText(context, 'emoji.xenon_offline', '🔴'),
    UNKNOWN: emojiText(context, 'emoji.xenon_idle', '⚫'),
  }[status.aggregate];
  const label = {
    ONLINE: 'ONLINE',
    DEGRADED: 'DEGRADED',
    OFFLINE: 'OFFLINE',
    UNKNOWN: 'STATUS UNAVAILABLE',
  }[status.aggregate];

  const players =
    status.totalPlayers === null
      ? null
      : `**${String(status.totalPlayers)}**${status.totalCapacity === null ? '' : ` / ${String(status.totalCapacity)}`} citizens`;

  const embed = xenonEmbed(tone)
    .setTitle('XENON CITY STATUS')
    .setFooter({ text: 'XenonRP • City Status' })
    .setDescription(
      [
        `${dot} **${label}**`,
        players ?? (status.aggregate === 'UNKNOWN' ? 'Player count unavailable' : null),
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );

  if (status.queue !== null)
    embed.addFields({ name: 'Queue', value: String(status.queue), inline: true });
  const restart = timestamp(status.nextRestartAt);
  if (restart !== null) embed.addFields({ name: 'Next restart', value: restart, inline: true });
  if (status.servers.length > 1) {
    embed.addFields({
      name: 'Servers',
      value: status.servers
        .map(
          (server) =>
            `${server.name} · ${server.state.toLowerCase()}${server.players === null ? '' : ` · ${String(server.players)}${server.max === null ? '' : `/${String(server.max)}`}`}`,
        )
        .join('\n'),
    });
  }
  embed.addFields({
    name: 'Last updated',
    value: timestamp(status.checkedAt) ?? 'never',
    inline: true,
  });

  return {
    embeds: [embed.toJSON()],
    components: linkRow([
      [
        'Connect',
        status.aggregate === 'ONLINE' || status.aggregate === 'DEGRADED'
          ? context.connectUrl
          : null,
      ],
      ['Website', url(context, '/')],
      ['Player portal', url(context, '/portal')],
      ['Status', url(context, '/status')],
    ]),
  };
}

/** Content hash of a rendered panel, the plan's "does this need an edit". */
export function panelHash(payload: PanelPayload): string {
  return stableHash(payload);
}

/** Bot presence lines, real data only. Rotated slowly by the bot. */
export function presenceLines(
  context: Pick<PanelContext, 'status' | 'applications' | 'siteUrl'>,
): string[] {
  const lines: string[] = [brand.name];
  const { status } = context;
  if (status.aggregate === 'ONLINE' && status.totalPlayers !== null) {
    lines.push(
      `City Online • ${String(status.totalPlayers)}${status.totalCapacity === null ? '' : `/${String(status.totalCapacity)}`}`,
    );
  } else if (status.aggregate === 'OFFLINE') {
    lines.push('City offline');
  }
  if (context.applications.globallyOpen && context.applications.whitelistOpen)
    lines.push('Applications Open');
  try {
    const host = new URL(context.siteUrl).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') lines.push(host);
  } catch {
    // An invalid site URL simply contributes no line.
  }
  return lines;
}
