import { describe, expect, it } from 'vitest';

import { buildDesiredState } from './blueprint';
import { parseFeatures } from './config';
import { renderPanel } from './panels';

describe('Discord-only panel rendering', () => {
  it('omits all website buttons when no site URL is configured', () => {
    const state = buildDesiredState({
      features: parseFeatures({}),
      guildFeatures: [],
      departments: [],
      organizations: [],
      assets: [],
    });
    const context = {
      discordOnly: true,
      siteUrl: '',
      linksAllowed: false,
      connectUrl: null,
      rules: { version: null, retrievedAt: null },
      applications: { globallyOpen: false, whitelistOpen: false, open: [] },
      departments: [],
      status: {
        aggregate: 'UNKNOWN' as const,
        totalPlayers: null,
        totalCapacity: null,
        queue: null,
        nextRestartAt: null,
        checkedAt: null,
        servers: [],
      },
      emojis: new Map(),
      selfRoles: state.roles.filter((role) => role.selfAssignable),
    };
    const panels = state.panels.filter((panel) =>
      ['welcome', 'support', 'rules', 'how-to-join', 'applications', 'staff'].includes(panel.kind),
    );

    for (const panel of panels) {
      const payload = renderPanel(panel, context);
      expect(JSON.stringify(payload.components)).not.toMatch(/https?:\/\//);
    }
    const support = panels.find((panel) => panel.kind === 'support');
    expect(support).toBeDefined();
    expect(renderPanel(support!, context).components).toEqual([]);
  });
});
