import type { Db, FeatureFlag, Prisma, SystemSetting } from '@xenon/database';
import { cacheDelete, cached } from '@xenon/jobs';
import { type Actor, requirePermission } from '@xenon/permissions';

import { recordAudit } from './audit';
import { hashSecret } from './hashing';

/**
 * Operator-tunable settings and feature flags.
 *
 * Anything an owner might want to change at 2am without a deploy lives here:
 * the Discord invite, the community's social links, whether applications are
 * accepting at all. Secrets are still environment variables - a credential in a
 * database row is a credential in every backup and every audit export.
 */

const SETTINGS_CACHE_KEY = 'settings:all';
const FLAGS_CACHE_KEY = 'flags:all';
const CACHE_TTL = 60;

/**
 * Settings the platform reads by name, with their defaults.
 *
 * Declared here so the admin screen can render the full list before anyone has
 * saved anything, and so a missing row is a documented default rather than an
 * `undefined` two layers down.
 */
export const settingDefinitions = {
  'community.discordInvite': {
    label: 'Discord invite URL',
    category: 'community',
    description: 'Shown on every Discord call to action. Leave blank to hide those buttons.',
    fallback: '',
  },
  'community.connectUrl': {
    label: 'FiveM connect link',
    category: 'community',
    description: 'cfx.re join link shown on the status page.',
    fallback: '',
  },
  'community.youtube': {
    label: 'YouTube channel URL',
    category: 'community',
    description: 'Optional. Rendered in the footer when set.',
    fallback: '',
  },
  'community.tiktok': {
    label: 'TikTok profile URL',
    category: 'community',
    description: 'Optional. Rendered in the footer when set.',
    fallback: '',
  },
  'community.instagram': {
    label: 'Instagram profile URL',
    category: 'community',
    description: 'Optional. Rendered in the footer when set.',
    fallback: '',
  },
  'applications.globallyOpen': {
    label: 'Applications open',
    category: 'applications',
    description: 'Master switch. Turning this off closes every template at once.',
    fallback: 'true',
  },
  'site.maintenanceMessage': {
    label: 'Site banner message',
    category: 'site',
    description: 'Shown as a banner across the public site while non-empty.',
    fallback: '',
  },
  'site.heroVideoUrl': {
    label: 'Homepage hero video URL',
    category: 'site',
    description: 'MP4 or WebM served from your CDN. Leave blank to use the poster image only.',
    fallback: '',
  },
  'site.heroPosterUrl': {
    label: 'Homepage hero poster image',
    category: 'site',
    description: 'Shown first and behind the video. Always set this.',
    fallback: '',
  },
} as const satisfies Record<
  string,
  { label: string; category: string; description: string; fallback: string }
>;

export type SettingKey = keyof typeof settingDefinitions;

/** Every setting as a flat map, with declared defaults filled in. */
export async function allSettings(db: Db): Promise<Record<string, string>> {
  return cached(SETTINGS_CACHE_KEY, CACHE_TTL, async () => {
    const rows = await db.systemSetting.findMany({ where: { isSecret: false } });

    const values: Record<string, string> = {};
    for (const [key, definition] of Object.entries(settingDefinitions)) {
      values[key] = definition.fallback;
    }
    for (const row of rows) {
      values[row.key] = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
    }
    return values;
  });
}

/** One setting, with its declared default. */
export async function setting(db: Db, key: SettingKey): Promise<string> {
  const values = await allSettings(db);
  return values[key] ?? settingDefinitions[key].fallback;
}

export async function setSetting(
  db: Db,
  actor: Actor,
  key: string,
  value: string,
): Promise<SystemSetting> {
  requirePermission(actor, 'system.manage');

  const definition = key in settingDefinitions ? settingDefinitions[key as SettingKey] : undefined;

  const row = await db.systemSetting.upsert({
    where: { key },
    create: {
      key,
      value,
      kind: 'STRING',
      category: definition?.category ?? 'general',
      label: definition?.label ?? key,
      description: definition?.description ?? null,
      updatedBy: actor.userId,
    },
    update: { value, updatedBy: actor.userId },
  });

  await recordAudit(db, actor, {
    action: 'setting.updated',
    entityType: 'setting',
    entityId: key,
    entityLabel: key,
    // Values are hashed rather than logged. Most settings are harmless, but the
    // audit log must not become the place a mistyped credential is preserved.
    after: { valueHash: hashSecret(value).slice(0, 16), length: value.length },
  });

  await cacheDelete(SETTINGS_CACHE_KEY);
  return row;
}

// --- Feature flags -----------------------------------------------------------

export async function allFeatureFlags(db: Db): Promise<readonly FeatureFlag[]> {
  return cached(FLAGS_CACHE_KEY, CACHE_TTL, () =>
    db.featureFlag.findMany({ orderBy: { key: 'asc' } }),
  );
}

/**
 * Evaluate a flag for one actor.
 *
 * Rollout is deterministic per user, not random per call: a user who sees a
 * feature on one page must see it on the next, and a bug report that says "it
 * appears sometimes" is unactionable.
 */
export async function isFeatureEnabled(
  db: Db,
  key: string,
  context: { userId?: string | null; roleKeys?: ReadonlySet<string> } = {},
): Promise<boolean> {
  const flags = await allFeatureFlags(db);
  const flag = flags.find((candidate) => candidate.key === key);
  if (flag === undefined) return false;

  if (context.roleKeys !== undefined) {
    for (const roleKey of flag.forceForRoleKeys) {
      if (context.roleKeys.has(roleKey)) return true;
    }
  }

  if (!flag.enabled) return false;
  if (flag.rollout >= 100) return true;
  if (flag.rollout <= 0) return false;
  if (!context.userId) return false;

  let hash = 0;
  const seed = `${key}:${context.userId}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % 100 < flag.rollout;
}

export async function upsertFeatureFlag(
  db: Db,
  actor: Actor,
  input: {
    key: string;
    description?: string | undefined;
    enabled: boolean;
    rollout: number;
    forceForRoleKeys: readonly string[];
  },
): Promise<FeatureFlag> {
  requirePermission(actor, 'system.manage');

  const data: Prisma.FeatureFlagUncheckedCreateInput = {
    key: input.key,
    description: input.description ?? null,
    enabled: input.enabled,
    rollout: input.rollout,
    forceForRoleKeys: [...input.forceForRoleKeys],
    updatedBy: actor.userId,
  };

  const flag = await db.featureFlag.upsert({
    where: { key: input.key },
    create: data,
    update: data,
  });

  await recordAudit(db, actor, {
    action: 'feature_flag.updated',
    entityType: 'feature_flag',
    entityId: flag.key,
    entityLabel: flag.key,
    after: { enabled: flag.enabled, rollout: flag.rollout },
  });

  await cacheDelete(FLAGS_CACHE_KEY);
  return flag;
}
