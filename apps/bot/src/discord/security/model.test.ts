import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECURITY_CONFIG,
  EMPTY_SECURITY_STATE,
  checkLink,
  correlateAuditEntry,
  evaluateNuke,
  evaluateRaid,
  evaluateSpam,
  isAuthorized,
  maySetTrust,
  scanRolePermissions,
  validateSecurityState,
  type JoinSignal,
  type MessageSignal,
  type NukeSignal,
  type SecurityConfig,
} from './model';

const config: SecurityConfig = DEFAULT_SECURITY_CONFIG;

describe('security detection policies', () => {
  it('expires old joins from the raid window and does not raid on account age alone', () => {
    const events: JoinSignal[] = Array.from({ length: 6 }, (_, index) => ({
      userId: String(10000000000000000 + index),
      at: 0,
      accountAgeMs: 8 * 24 * 60 * 60 * 1_000,
      bot: false,
    }));
    expect(evaluateRaid(events, 31_000, config).level).toBe('NORMAL');
    expect(evaluateRaid(events, 5_000, config).level).toBe('WARNING');
    expect(evaluateRaid(events.slice(0, 1), 1_000, config).level).toBe('NORMAL');
  });

  it('requires threshold counts before new-account clustering raises raid severity', () => {
    const events: JoinSignal[] = Array.from({ length: 9 }, (_, index) => ({
      userId: String(10000000000000000 + index),
      at: 2_000,
      accountAgeMs: 100,
      bot: false,
    }));
    expect(evaluateRaid(events, 3_000, config).level).toBe('CRITICAL');
    const mixed = events.map((entry, index) => ({
      ...entry,
      accountAgeMs: index < 3 ? 100 : 30 * 86_400_000,
    }));
    expect(evaluateRaid(mixed, 3_000, config).level).toBe('RAID');
  });

  it('uses actor-and-action windows, with no exemption for a merely administrative Discord account', () => {
    const candidate: NukeSignal = {
      actorId: '10000000000000001',
      action: 'CHANNEL_DELETE',
      targetId: '20000000000000001',
      at: 10_000,
    };
    const earlier: NukeSignal[] = [0, 1].map((value) => ({
      ...candidate,
      targetId: String(20000000000000000 + value),
      at: value * 1_000,
    }));
    expect(evaluateNuke([...earlier, candidate], candidate, false, 10_000)).toMatchObject({
      severity: 'CRITICAL',
      count: 3,
    });
    expect(evaluateNuke([...earlier, candidate], candidate, true, 10_000).rule).toBe(
      'TRUSTED_ACTOR_EXEMPT',
    );
    expect(evaluateNuke(earlier.slice(0, 1), candidate, false, 40_000).severity).toBe('INFO');
  });

  it('correlates audit events only by exact action and target within the time bound', () => {
    const entries = [
      {
        action: 12,
        targetId: '20000000000000002',
        executorId: '30000000000000001',
        createdTimestamp: 5_000,
      },
      {
        action: 13,
        targetId: '20000000000000001',
        executorId: '30000000000000002',
        createdTimestamp: 5_000,
      },
      {
        action: 12,
        targetId: '20000000000000001',
        executorId: '30000000000000003',
        createdTimestamp: 20_000,
      },
    ];
    expect(correlateAuditEntry(entries, 12, '20000000000000001', 4_999)).toBeNull();
    expect(correlateAuditEntry(entries, 12, '20000000000000001', 20_000)?.executorId).toBe(
      '30000000000000003',
    );
    expect(correlateAuditEntry(entries, 12, '20000000000000001', 40_000)).toBeNull();
  });

  it('detects repeated messages and rate thresholds without punishing a single ordinary message', () => {
    const candidate: MessageSignal = {
      userId: '10000000000000001',
      channelId: '20000000000000001',
      content: 'Hello there',
      at: 10_000,
      mentionCount: 0,
      linkCount: 0,
      inviteCount: 0,
      emojiCount: 0,
    };
    expect(evaluateSpam([], candidate, config, false).severity).toBe('NONE');
    const history = [0, 1].map((index) => ({
      ...candidate,
      at: index * 1_000,
      content: 'hello   there',
    }));
    expect(evaluateSpam(history, candidate, config, false)).toMatchObject({
      severity: 'DELETE',
      reasons: ['repeated identical message'],
    });
  });

  it('counts a join exactly 10 seconds old and drops it one millisecond later', () => {
    const events: JoinSignal[] = Array.from({ length: 5 }, (_, index) => ({
      userId: String(10000000000000000 + index),
      at: 0,
      accountAgeMs: 30 * 86_400_000,
      bot: false,
    }));
    expect(evaluateRaid(events, 10_000, config)).toMatchObject({ joins10s: 5, level: 'WARNING' });
    expect(evaluateRaid(events, 10_001, config)).toMatchObject({ joins10s: 0, level: 'NORMAL' });
  });

  it('escalates a burst of fresh accounts but keeps an old-account trickle NORMAL', () => {
    const old: JoinSignal[] = Array.from({ length: 4 }, (_, index) => ({
      userId: String(10000000000000000 + index),
      at: index * 1_000,
      accountAgeMs: 400 * 86_400_000,
      bot: false,
    }));
    expect(evaluateRaid(old, 4_000, config).level).toBe('NORMAL');
    const fresh: JoinSignal[] = Array.from({ length: 9 }, (_, index) => ({
      userId: String(10000000000000000 + index),
      at: index * 500,
      accountAgeMs: 1_000,
      bot: false,
    }));
    expect(['RAID', 'CRITICAL']).toContain(evaluateRaid(fresh, 4_500, config).level);
  });

  describe('spam similarity and invites', () => {
    const base: MessageSignal = {
      userId: '10000000000000001',
      channelId: '20000000000000001',
      content: '',
      at: 10_000,
      mentionCount: 0,
      linkCount: 0,
      inviteCount: 0,
      emojiCount: 0,
    };

    it('counts near-duplicates toward the duplicate limit with a distinct reason', () => {
      const history = [
        { ...base, at: 0, content: 'buy cheap gold now at example-shop dot com' },
        { ...base, at: 1_000, content: 'buy cheap gold now at example-shop dot com!' },
      ];
      const candidate = { ...base, content: 'buy cheap gold now at example-shop dot com!!' };
      expect(evaluateSpam(history, candidate, config, false)).toMatchObject({
        severity: 'DELETE',
        reasons: ['near-duplicate message'],
      });
    });

    it('does not treat short or unrelated messages as near-duplicates', () => {
      const history = [
        { ...base, at: 0, content: 'hello there' },
        { ...base, at: 1_000, content: 'hello there!' },
      ];
      expect(
        evaluateSpam(history, { ...base, content: 'hello there!!' }, config, false).severity,
      ).not.toBe('DELETE');
      const different = [
        { ...base, at: 0, content: 'the quick brown fox jumps over the lazy dog' },
        { ...base, at: 1_000, content: 'pack my box with five dozen liquor jugs' },
      ];
      expect(
        evaluateSpam(
          different,
          { ...base, content: 'sphinx of black quartz judge my vow' },
          config,
          false,
        ).severity,
      ).toBe('NONE');
    });

    it('flags a second invite within 30 seconds but not after the window', () => {
      const first = { ...base, at: 0, content: 'join discord.gg/abc', inviteCount: 1 };
      const second = { ...base, at: 30_000, content: 'also discord.gg/xyz', inviteCount: 1 };
      expect(evaluateSpam([first], second, config, false)).toMatchObject({
        severity: 'DELETE',
        reasons: ['repeated invites'],
      });
      expect(evaluateSpam([first], { ...second, at: 30_001 }, config, false).reasons).not.toContain(
        'repeated invites',
      );
      expect(
        evaluateSpam([first], { ...second, inviteCount: 0 }, config, false).reasons,
      ).not.toContain('repeated invites');
    });
  });

  describe('security state persistence', () => {
    const response = {
      level: 'RAID',
      since: '2026-01-01T00:00:00.000Z',
      lastEscalationAt: '2026-01-01T00:01:00.000Z',
      incidentId: 'XEN-SEC-ABC',
      slowmode: [{ channelId: '20000000000000001', before: 0, applied: 30 }],
    };

    it('loads state written before raid response and recovery settings existed', () => {
      const old = JSON.parse(JSON.stringify(EMPTY_SECURITY_STATE)) as Record<string, unknown>;
      delete old.raidResponse;
      const oldConfig = old.config as Record<string, unknown>;
      delete oldConfig.raidRecoveryMinutes;
      delete oldConfig.raidSlowmodeSeconds;
      const parsed = validateSecurityState(old, true);
      expect(parsed.raidResponse).toBeNull();
      expect(parsed.config.raidRecoveryMinutes).toBe(10);
      expect(parsed.config.raidSlowmodeSeconds).toBe(30);
    });

    it('round-trips raid response and incident resolution, rejecting out-of-range settings', () => {
      const state = JSON.parse(JSON.stringify(EMPTY_SECURITY_STATE)) as Record<string, unknown>;
      state.raidResponse = response;
      state.incidents = [
        {
          id: 'XEN-SEC-1',
          severity: 'LOW',
          title: 'x',
          source: 'Test',
          rule: 'R',
          createdAt: '2026-01-01T00:00:00.000Z',
          actorId: null,
          targetId: null,
          evidence: [],
          automatic: true,
          actionTaken: [],
          auditCorrelation: 'UNAVAILABLE',
          status: 'RESOLVED',
          resolvedAt: '2026-01-02T00:00:00.000Z',
          resolvedBy: '10000000000000001',
          resolution: 'false positive',
        },
      ];
      const parsed = validateSecurityState(state, true);
      expect(parsed.raidResponse).toEqual(response);
      expect(parsed.incidents[0]?.resolution).toBe('false positive');
      for (const bad of [
        { raidRecoveryMinutes: 0 },
        { raidRecoveryMinutes: 1_441 },
        { raidSlowmodeSeconds: 21_601 },
        { raidSlowmodeSeconds: 1.5 },
      ]) {
        const broken = { ...state, config: { ...(state.config as object), ...bad } };
        expect(() => validateSecurityState(broken, true)).toThrow();
        const lenient = validateSecurityState(broken, false).config;
        expect([lenient.raidRecoveryMinutes, lenient.raidSlowmodeSeconds]).toEqual([10, 30]);
      }
    });
  });

  it('applies deterministic link policy and trusted-domain precedence', () => {
    const policy: SecurityConfig = {
      ...config,
      links: {
        ...config.links,
        action: 'BLOCK',
        trustedDomains: ['xenonrp.com'],
        blockedDomains: ['bad.example'],
        blockInvites: true,
      },
    };
    expect(checkLink('https://xenonrp.com/rules', policy).action).toBe('ALLOW');
    expect(checkLink('https://a.bad.example/path', policy)).toMatchObject({
      action: 'BLOCK',
      reason: 'domain is configured as blocked',
    });
    expect(checkLink('https://discord.gg/raid', policy).action).toBe('BLOCK');
    expect(checkLink('https://safe.example', policy).action).toBe('BLOCK');
  });

  it('requires both Discord permission and internal trust for privileged commands', () => {
    expect(isAuthorized('SECURITY_ADMIN', 'TRUSTED_STAFF', false, true)).toBe(true);
    expect(isAuthorized(undefined, 'NORMAL_STAFF', false, true)).toBe(false);
    expect(isAuthorized('SECURITY_ADMIN', 'TRUSTED_STAFF', false, false)).toBe(false);
    expect(isAuthorized(undefined, 'SECURITY_ADMIN', true, true)).toBe(true);
    expect(maySetTrust(false, 'SECURITY_ADMIN', 'SECURITY_ADMIN', 'TRUSTED_STAFF')).toBe(false);
    expect(maySetTrust(true, undefined, 'SECURITY_ADMIN', undefined)).toBe(true);
  });

  it('reports dangerous permissions and role hierarchy without changing permissions', () => {
    const findings = scanRolePermissions(
      [
        {
          id: '10000000000000001',
          name: '@everyone',
          permissions: new Set(['ManageRoles']),
          managed: true,
          position: 0,
        },
        {
          id: '10000000000000002',
          name: 'Old Admin',
          permissions: new Set(['Administrator']),
          managed: false,
          position: 2,
        },
      ],
      '10000000000000001',
      new Set(['10000000000000001', '10000000000000003']),
      3,
      true,
    );
    expect(findings.map((finding) => finding.code)).toContain('DANGEROUS_EVERYONE_PERMISSION');
    expect(findings.map((finding) => finding.code)).toContain('UNEXPECTED_DANGEROUS_ROLE');
    expect(findings.map((finding) => finding.code)).toContain('MISSING_VIEW_AUDIT_LOG');
  });

  it('validates the default account-age ratio and reserves AutoMod keyword capacity', () => {
    expect(
      validateSecurityState(EMPTY_SECURITY_STATE, true).config.raidThresholds.newAccountRatio,
    ).toBe(0.6);
    const keywords = Array.from({ length: 99 }, (_, index) => `keyword ${String(index)}`);
    const invalid = {
      ...EMPTY_SECURITY_STATE,
      config: { ...DEFAULT_SECURITY_CONFIG, prohibitedKeywords: keywords },
    };
    expect(() => validateSecurityState(invalid, true)).toThrow('Invalid prohibited keyword list.');
  });
});

describe('enforcement mode configuration', () => {
  const { enforcementMode: _omitted, ...legacyConfig } = DEFAULT_SECURITY_CONFIG;

  it('defaults to OBSERVE and migrates configs saved before the field existed', () => {
    expect(DEFAULT_SECURITY_CONFIG.enforcementMode).toBe('OBSERVE');
    for (const strict of [true, false])
      expect(validateSecurityState({ config: legacyConfig }, strict).config.enforcementMode).toBe(
        'OBSERVE',
      );
  });

  it('keeps an explicitly saved mode and never upgrades invalid values to ENFORCE', () => {
    for (const mode of ['OBSERVE', 'ALERT', 'ENFORCE'] as const)
      expect(
        validateSecurityState({ config: { ...legacyConfig, enforcementMode: mode } }, true).config
          .enforcementMode,
      ).toBe(mode);
    for (const invalid of ['enforce', 'ON', 1, null, true]) {
      const raw = { config: { ...legacyConfig, enforcementMode: invalid } };
      expect(validateSecurityState(raw, false).config.enforcementMode).toBe('OBSERVE');
      expect(() => validateSecurityState(raw, true)).toThrow();
    }
  });
});
