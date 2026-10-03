import { z } from 'zod';

import { ValidationError } from '@xenon/core';
import { Prisma, transaction, type Db } from '@xenon/database';
import { recordAudit } from '@xenon/domain';
import { requirePermission, type Actor } from '@xenon/permissions';

const snowflake = z
  .string()
  .regex(/^\d{17,20}$/)
  .nullable();

export const welcomeSettingsInput = z.object({
  enabled: z.boolean(),
  channelId: snowflake,
  publicEnabled: z.boolean(),
  dmEnabled: z.boolean(),
  initialRoleKey: z.enum(['role.citizen']).nullable(),
  deleteAfterSeconds: z.number().int().min(0).max(604_800),
  personalized: z.boolean(),
});

export type WelcomeSettings = z.infer<typeof welcomeSettingsInput>;

export const defaultWelcomeSettings: WelcomeSettings = {
  enabled: false,
  channelId: null,
  publicEnabled: false,
  dmEnabled: false,
  initialRoleKey: null,
  deleteAfterSeconds: 0,
  personalized: false,
};

const settingKeys = {
  enabled: 'discord.welcome.enabled',
  channelId: 'discord.welcome.channelId',
  publicEnabled: 'discord.welcome.publicEnabled',
  dmEnabled: 'discord.welcome.dmEnabled',
  initialRoleKey: 'discord.welcome.initialRoleKey',
  deleteAfterSeconds: 'discord.welcome.deleteAfterSeconds',
  personalized: 'discord.welcome.personalized',
} as const satisfies Record<keyof WelcomeSettings, string>;

function valueOf(row: { value: unknown } | null): unknown {
  if (row === null) return undefined;
  if (typeof row.value === 'string') {
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return row.value;
    }
  }
  return row.value;
}

/** Read join behavior without enabling a privileged Gateway intent by default. */
export async function loadWelcomeSettings(db: Db): Promise<WelcomeSettings> {
  const entries = await Promise.all(
    Object.entries(settingKeys).map(async ([field, key]) => {
      const row = await db.systemSetting.findUnique({ where: { key }, select: { value: true } });
      return [field, valueOf(row)] as const;
    }),
  );
  const candidate = Object.fromEntries(entries);
  const parsed = welcomeSettingsInput.safeParse({
    ...defaultWelcomeSettings,
    ...candidate,
  });
  return parsed.success ? parsed.data : defaultWelcomeSettings;
}

/** Save join behavior under Xenon's Discord capability and leave an audit trail. */
export async function saveWelcomeSettings(
  db: Db,
  actor: Actor,
  raw: unknown,
): Promise<WelcomeSettings> {
  requirePermission(actor, 'discord.manage');
  const parsed = welcomeSettingsInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError({ _form: ['Welcome settings are invalid.'] });
  const settings = parsed.data;

  if (settings.publicEnabled && settings.channelId === null) {
    throw new ValidationError({
      channelId: ['Choose a welcome channel before enabling public welcomes.'],
    });
  }

  await transaction(db, async (tx) => {
    for (const [field, key] of Object.entries(settingKeys)) {
      const value = settings[field as keyof WelcomeSettings];
      const storedValue = value ?? Prisma.JsonNull;
      await tx.systemSetting.upsert({
        where: { key },
        create: {
          key,
          value: storedValue,
          kind:
            value === null
              ? 'JSON'
              : typeof value === 'boolean'
                ? 'BOOLEAN'
                : typeof value === 'number'
                  ? 'NUMBER'
                  : 'STRING',
          category: 'discord',
          label: `Discord welcome ${field}`,
          updatedBy: actor.userId,
        },
        update: { value: storedValue, updatedBy: actor.userId },
      });
    }
    await recordAudit(tx, actor, {
      action: 'WELCOME_CONFIG_CHANGED',
      entityType: 'discord_welcome_settings',
      entityId: 'discord.welcome',
      after: settings,
    });
  });
  return settings;
}

export function welcomeNeedsMembersIntent(settings: WelcomeSettings): boolean {
  return (
    settings.enabled &&
    (settings.publicEnabled || settings.dmEnabled || settings.initialRoleKey !== null)
  );
}
