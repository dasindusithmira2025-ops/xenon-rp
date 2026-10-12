import type { AdoptionPlan, DesiredState } from '@xenon/discord/provisioning/pure';

const integrationLabels = {
  announcementChannel: 'Announcements',
  logChannel: 'Logs',
  reviewChannel: 'Review',
} as const;

/**
 * Shared by the platform and discord-only runtimes; must stay free of Prisma imports.
 * `explicit` (discord-only) lists operator-selected bindings, reported apart from automatic matches.
 */
export function adoptionReply(
  plan: AdoptionPlan & { readonly roleMappingsSkipped?: number },
  state: DesiredState,
  explicit?: readonly { readonly logicalKey: string; readonly label: string; readonly name: string }[],
): string {
  const matches = [...plan.adopted, ...plan.alreadyMapped];
  const integrationLines = Object.entries(integrationLabels).map(([key, label]) => {
    const mapping = matches.find((match) => match.integration === key);
    return `${label} → ${mapping === undefined ? 'not mapped' : `#${mapping.name}`}`;
  });
  const criticalKeys = new Set(
    state.channels
      .filter(
        (channel) =>
          channel.critical === true ||
          [
            'channel.welcome',
            'channel.rules',
            'channel.announcements',
            'channel.whitelist-review',
            'channel.bot-ops',
          ].includes(channel.key),
      )
      .map((channel) => channel.key),
  );
  const criticalRoleKeys = new Set(
    state.roles
      .filter((role) => role.tier === 'management' || role.tier === 'staff')
      .map((role) => role.key),
  );
  const attention = [
    ...plan.missing
      .filter((item) => criticalKeys.has(item.logicalKey) || criticalRoleKeys.has(item.logicalKey))
      .map((item) => `Missing ${resourceLabel(item.logicalKey, item.name)}`),
    ...plan.ambiguous
      .filter((item) => criticalKeys.has(item.logicalKey) || criticalRoleKeys.has(item.logicalKey))
      .map(
        (item) =>
          `Ambiguous ${resourceLabel(item.logicalKey, item.name)} (${String(item.matches)} matches)`,
      ),
  ].slice(0, 8);
  const announcementReady = matches.some((match) => match.integration === 'announcementChannel');
  const explicitKeys = new Set(explicit?.map((selection) => selection.logicalKey));
  const alreadyMapped = plan.alreadyMapped.filter((match) => !explicitKeys.has(match.logicalKey));

  return [
    'XENON EXISTING SERVER ADOPTED',
    '',
    ...(explicit === undefined || explicit.length === 0
      ? []
      : [
          'Explicitly mapped:',
          ...explicit.map((selection) => `${selection.label} → #${selection.name}`),
          '',
        ]),
    `${explicit === undefined ? 'Adopted' : 'Auto adopted'}: ${String(plan.adopted.length)}`,
    `Already mapped: ${String(alreadyMapped.length)}`,
    `Missing: ${String(plan.missing.length)}`,
    `Ambiguous: ${String(plan.ambiguous.length)}`,
    ...(plan.roleMappingsSkipped === undefined || plan.roleMappingsSkipped === 0
      ? []
      : [`Role mapping conflicts preserved: ${String(plan.roleMappingsSkipped)}`]),
    '',
    'Integrations:',
    ...integrationLines,
    ...(attention.length === 0 ? [] : ['', 'Critical resources needing attention:', ...attention]),
    ...(announcementReady ? ['', '/announce is ready.'] : []),
    '',
    'No Discord resources were created or modified.',
  ].join('\n');
}

function resourceLabel(logicalKey: string, name: string): string {
  return logicalKey.startsWith('role.') ? `@${name}` : `#${name}`;
}
