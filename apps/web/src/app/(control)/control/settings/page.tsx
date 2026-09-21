import { prisma } from '@xenon/database';
import { allSettings, settingDefinitions } from '@xenon/domain';
import { Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { SettingsForm } from '~/components/control/settings-form';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Settings' };

/**
 * /control/system/settings
 *
 * Everything an owner might want to change at 2am without a deploy. Secrets
 * are deliberately absent: a credential in a database row is a credential in
 * every backup and every export, so those stay in the environment.
 */
export default async function SettingsPage(): Promise<React.ReactElement> {
  await requireCapability('system.manage');
  const values = await allSettings(prisma);

  const grouped = new Map<
    string,
    { key: string; label: string; description: string; value: string }[]
  >();
  for (const [key, definition] of Object.entries(settingDefinitions)) {
    const list = grouped.get(definition.category) ?? [];
    list.push({
      key,
      label: definition.label,
      description: definition.description,
      value: values[key] ?? definition.fallback,
    });
    grouped.set(definition.category, list);
  }

  return (
    <ControlPage
      title="Settings"
      lead="Operator-tunable values. Changes take effect on the next page load across the site."
    >
      <SettingsForm
        groups={[...grouped.entries()].map(([category, items]) => ({ category, items }))}
      />

      <Panel tone="ghost" pad="lg">
        <p className="x-eyebrow">Not here on purpose</p>
        <ul className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
          <li>
            <strong className="text-ink-secondary">Secrets</strong> - the bot token, the OAuth
            secret, the R2 keys and the FiveM bridge secret are environment variables. A credential
            in a database row is a credential in every backup.
          </li>
          <li>
            <strong className="text-ink-secondary">Discord role IDs</strong> - mapped in
            Integrations → Discord, so changing a mapping never needs a redeploy.
          </li>
          <li>
            <strong className="text-ink-secondary">Game server addresses</strong> - configured in
            Integrations → Game servers, where the adapter is chosen too.
          </li>
        </ul>
      </Panel>
    </ControlPage>
  );
}
