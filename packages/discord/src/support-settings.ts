import { z } from 'zod';

import { ValidationError } from '@xenon/core';
import { transaction, type Db } from '@xenon/database';
import { recordAudit } from '@xenon/domain';
import { requirePermission, type Actor } from '@xenon/permissions';

export const supportSettingsInput = z.object({
  dmNotifications: z.boolean(),
  allowDiscordClose: z.boolean(),
});

export type SupportSettings = z.infer<typeof supportSettingsInput>;

export const defaultSupportSettings: SupportSettings = {
  dmNotifications: true,
  allowDiscordClose: true,
};

const supportKeys = {
  dmNotifications: 'discord.support.dmNotifications',
  allowDiscordClose: 'discord.support.allowDiscordClose',
} as const satisfies Record<keyof SupportSettings, string>;

export async function loadSupportSettings(db: Db): Promise<SupportSettings> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: Object.values(supportKeys) } },
    select: { key: true, value: true },
  });
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const dmNotifications: unknown = values[supportKeys.dmNotifications];
  const allowDiscordClose: unknown = values[supportKeys.allowDiscordClose];
  return {
    dmNotifications:
      typeof dmNotifications === 'boolean'
        ? dmNotifications
        : defaultSupportSettings.dmNotifications,
    allowDiscordClose:
      typeof allowDiscordClose === 'boolean'
        ? allowDiscordClose
        : defaultSupportSettings.allowDiscordClose,
  };
}

export async function saveSupportSettings(
  db: Db,
  actor: Actor,
  raw: unknown,
): Promise<SupportSettings> {
  requirePermission(actor, 'discord.manage');
  const parsed = supportSettingsInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError({ _form: ['Support settings are invalid.'] });
  const settings = parsed.data;
  await transaction(db, async (tx) => {
    for (const [field, key] of Object.entries(supportKeys)) {
      const value = settings[field as keyof SupportSettings];
      await tx.systemSetting.upsert({
        where: { key },
        create: {
          key,
          value,
          kind: 'BOOLEAN',
          category: 'discord',
          label: `Discord support ${field}`,
          updatedBy: actor.userId,
        },
        update: { value, updatedBy: actor.userId },
      });
    }
    await recordAudit(tx, actor, {
      action: 'SUPPORT_SETTINGS_CHANGED',
      entityType: 'discord_support_settings',
      entityId: 'discord.support',
      after: settings,
    });
  });
  return settings;
}
