import { describe, expect, it } from 'vitest';

import { parseXenonId, xenonIds } from '../interaction-ids';
import { defaultWelcomeSettings, welcomeNeedsMembersIntent } from '../welcome-settings';

import {
  XenonAnnouncementPanel,
  XenonApplicationPanel,
  XenonErrorPanel,
  XenonRulesPanel,
  XenonServerStatusPanel,
  XenonSupportPanel,
  XenonSuccessPanel,
  XenonTicketPanel,
  XenonWarningPanel,
  XenonWelcomePanel,
  type PanelContext,
} from './panels';

const context: PanelContext = {
  siteUrl: 'https://xenon.example',
  linksAllowed: true,
  connectUrl: 'fivem://connect/city.example:30120',
  rules: { version: 4, retrievedAt: new Date('2026-10-01T10:00:00Z') },
  applications: {
    globallyOpen: true,
    whitelistOpen: true,
    open: [{ name: 'General Whitelist', slug: 'general-whitelist' }],
  },
  departments: [
    { slug: 'lspd', name: 'LSPD', tagline: null, recruitmentState: 'OPEN' },
    { slug: 'ems', name: 'EMS', tagline: null, recruitmentState: 'CLOSED' },
  ],
  status: {
    aggregate: 'UNKNOWN',
    totalPlayers: null,
    totalCapacity: null,
    queue: null,
    nextRestartAt: null,
    checkedAt: null,
    servers: [],
  },
  emojis: new Map(),
  selfRoles: [],
};

describe('Xenon text-first panel system', () => {
  it('requests GuildMembers only when an enabled welcome feature needs member joins', () => {
    expect(welcomeNeedsMembersIntent(defaultWelcomeSettings)).toBe(false);
    expect(welcomeNeedsMembersIntent({ ...defaultWelcomeSettings, enabled: true })).toBe(false);
    expect(
      welcomeNeedsMembersIntent({ ...defaultWelcomeSettings, enabled: true, dmEnabled: true }),
    ).toBe(true);
  });

  it('renders branded welcome and rules panels without image dependencies', () => {
    const welcome = XenonWelcomePanel(context);
    const rules = XenonRulesPanel(context);

    expect(welcome.embeds[0]?.title).toBe('WELCOME TO XENON.');
    expect(welcome.embeds[0]?.image).toBeUndefined();
    expect(welcome.embeds[0]?.thumbnail).toBeUndefined();
    expect(
      welcome.components[0]?.components.map((button) => 'label' in button && button.label),
    ).toEqual(['WEBSITE', 'RULEBOOK', 'APPLY FOR WHITELIST', 'PLAYER PORTAL']);
    expect(rules.embeds[0]?.fields?.find((field) => field.name === 'Version')?.value).toBe('v4');
  });

  it('renders support categories as a select menu and only configured applications', () => {
    const support = XenonSupportPanel(context);
    const applications = XenonApplicationPanel(context);
    const select = support.components[0]?.components[0];

    expect(support.embeds[0]?.title).toBe('XENON SUPPORT CENTER');
    expect(select?.type).toBe(3);
    expect(select && 'options' in select ? select.options : []).toHaveLength(8);
    expect(applications.embeds[0]?.description).toContain('tracked on the Xenon website');
    expect(applications.components[0]?.components[0]).toMatchObject({
      custom_id: 'xn:application:open',
    });
  });

  it('uses custom emoji when present and a Unicode fallback when absent', () => {
    const panel = XenonServerStatusPanel(context);
    expect(panel.embeds[0]?.title).toBe('XENON CITY STATUS');
    expect(panel.embeds[0]?.description).toContain('⚫ **STATUS UNAVAILABLE**');
    expect(panel.embeds[0]?.description).not.toContain('0 citizens');

    const live = XenonServerStatusPanel({
      ...context,
      status: {
        ...context.status,
        aggregate: 'ONLINE',
        totalPlayers: 0,
        totalCapacity: 128,
        queue: 0,
        checkedAt: '2026-10-03T09:00:00.000Z',
      },
    });
    expect(live.embeds[0]?.fields?.find((field) => field.name === 'Queue')?.value).toBe('0');
  });

  it('builds semantic notices and a private ticket panel with stable component ids', () => {
    expect(XenonSuccessPanel('Done', 'Saved').data.color).toBe(0x2afd23);
    expect(XenonWarningPanel('Review', 'Check this').data.color).toBe(0xffb020);
    expect(XenonErrorPanel('Failed', 'Try again').data.color).toBe(0xff4d4d);

    const announcement = XenonAnnouncementPanel({
      type: 'EMERGENCY',
      title: 'City access paused',
      message: 'We are investigating an outage.',
    });
    expect(announcement.data.color).toBe(0xff4d4d);

    const ticket = XenonTicketPanel({
      ticketId: 'XN-TK-1042',
      category: 'technical',
      createdBy: 'You',
      createdAt: new Date('2026-10-03T09:00:00Z'),
      portalUrl: 'https://xenon.example/portal/tickets/XN-TK-1042',
      closeCustomId: xenonIds.ticketClose('XN-TK-1042'),
    });
    expect(ticket.embeds[0]?.title).toContain('TICKET OPENED');
    expect(parseXenonId('xn:ticket:close:XN-TK-1042')).toEqual({
      namespace: 'ticket',
      action: 'close',
      argument: 'XN-TK-1042',
    });
  });
});
