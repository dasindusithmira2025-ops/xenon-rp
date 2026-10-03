import { describe, expect, it } from 'vitest';

import { buildReviewActions, buildReviewEmbed } from './embeds';

describe('Discord application review presentation', () => {
  it('keeps unavailable guild membership visibly unknown on the review card', () => {
    const embed = buildReviewEmbed({
      publicId: 'XN-WL-1842',
      templateName: 'General Whitelist',
      status: 'SUBMITTED',
      applicant: {
        publicId: 'XN-10042',
        displayName: 'Fixture Player',
        discordId: 'test-discord-player',
        accountAgeDays: 25,
        guildMembershipState: 'UNAVAILABLE',
        whitelistState: 'NONE',
      },
      characterName: null,
      submittedAt: new Date('2026-09-23T00:00:00.000Z'),
      attempt: 1,
      assigneeName: null,
      decisionNote: null,
      lastAction: null,
      siteUrl: 'https://xenon.example.test',
      highlights: [],
    });

    const payload = embed.toJSON();
    expect(payload.author?.name).toBe('XENON STAFF REVIEW');
    expect(payload.title).toBe('GENERAL WHITELIST');
    expect(payload.description).toContain('XN-WL-1842');
    expect(payload.fields?.find((field) => field.name === 'Xenon ID')?.value).toBe('XN-10042');
    expect(payload.fields?.find((field) => field.name === 'Status')?.value).toBe('Awaiting review');
    expect(payload.fields?.find((field) => field.name === 'Account')?.value).toContain(
      'Guild: unknown',
    );
  });

  it('always provides a secure Control Center link and removes decision actions when terminal', () => {
    const active = buildReviewActions('XN-WL-1842', 'SUBMITTED', 'https://xenon.example.test');
    const terminal = buildReviewActions('XN-WL-1842', 'APPROVED', 'https://xenon.example.test');
    const activeRows = active.map((row) => row.toJSON());
    const terminalRows = terminal.map((row) => row.toJSON());

    expect(activeRows[0]?.components[0]).toMatchObject({
      label: 'OPEN APPLICATION',
      style: 5,
      url: 'https://xenon.example.test/control/applications/XN-WL-1842',
    });
    expect(activeRows[1]?.components).toHaveLength(5);
    expect(terminalRows).toHaveLength(1);
    expect(terminalRows[0]?.components).toHaveLength(1);
  });
});
