import type { DesiredState, RegistryEntry } from './types';

export interface AdoptionChannel {
  readonly id: string;
  readonly name: string;
  readonly kind: 'category' | 'text' | 'announcement' | 'forum' | 'voice';
}

export interface AdoptionRole {
  readonly id: string;
  readonly name: string;
  readonly managed: boolean;
}

export interface AdoptionMatch {
  readonly logicalKey: string;
  readonly resourceType: 'CHANNEL' | 'CATEGORY' | 'ROLE';
  readonly discordId: string;
  readonly name: string;
  readonly integration?: 'reviewChannel' | 'announcementChannel' | 'logChannel';
  readonly xenonRoleKey?: string;
}

export interface AdoptionPlan {
  readonly adopted: readonly AdoptionMatch[];
  readonly alreadyMapped: readonly AdoptionMatch[];
  readonly missing: readonly { readonly logicalKey: string; readonly name: string }[];
  readonly ambiguous: readonly {
    readonly logicalKey: string;
    readonly name: string;
    readonly matches: number;
  }[];
}

/** Exact normalized matching for explicit adoption; never guesses by similarity. */
export function planResourceAdoption(
  state: DesiredState,
  registry: readonly RegistryEntry[],
  channels: readonly AdoptionChannel[],
  roles: readonly AdoptionRole[],
): AdoptionPlan {
  const adopted: AdoptionMatch[] = [];
  const alreadyMapped: AdoptionMatch[] = [];
  const missing: { logicalKey: string; name: string }[] = [];
  const ambiguous: { logicalKey: string; name: string; matches: number }[] = [];
  const registered = new Map(registry.map((entry) => [entry.logicalKey, entry]));
  const claimedRoleIds = new Set(
    registry
      .filter(
        (entry): entry is RegistryEntry & { readonly discordId: string } =>
          entry.resourceType === 'ROLE' && entry.discordId !== null,
      )
      .map((entry) => entry.discordId),
  );
  const claimedChannelIds = new Set(
    registry
      .filter(
        (entry): entry is RegistryEntry & { readonly discordId: string } =>
          (entry.resourceType === 'CHANNEL' || entry.resourceType === 'CATEGORY') &&
          entry.discordId !== null,
      )
      .map((entry) => entry.discordId),
  );
  const selectedRoleIds = new Set<string>();
  const selectedChannelIds = new Set<string>();
  const byIdRole = new Map(roles.map((role) => [role.id, role]));
  const byIdChannel = new Map(channels.map((channel) => [channel.id, channel]));

  for (const role of state.roles) {
    const entry = registered.get(role.key);
    if (entry !== undefined) {
      const current = entry.discordId === null ? undefined : byIdRole.get(entry.discordId);
      if (entry.resourceType === 'ROLE' && current !== undefined) {
        alreadyMapped.push({
          logicalKey: role.key,
          resourceType: 'ROLE',
          discordId: current.id,
          name: current.name,
          ...(role.xenonRoleKey === undefined ? {} : { xenonRoleKey: role.xenonRoleKey }),
        });
      } else {
        missing.push({ logicalKey: role.key, name: role.name });
      }
      continue;
    }

    const matches = roles.filter(
      (candidate) =>
        !candidate.managed &&
        !claimedRoleIds.has(candidate.id) &&
        !selectedRoleIds.has(candidate.id) &&
        normalizeName(candidate.name) === normalizeName(role.name),
    );
    if (matches.length > 1) {
      ambiguous.push({ logicalKey: role.key, name: role.name, matches: matches.length });
    } else if (matches.length === 0) {
      missing.push({ logicalKey: role.key, name: role.name });
    } else {
      const match = matches[0];
      if (match === undefined) continue;
      selectedRoleIds.add(match.id);
      adopted.push({
        logicalKey: role.key,
        resourceType: 'ROLE',
        discordId: match.id,
        name: match.name,
        ...(role.xenonRoleKey === undefined ? {} : { xenonRoleKey: role.xenonRoleKey }),
      });
    }
  }

  for (const channel of state.channels) {
    const resourceType = channel.kind === 'category' ? 'CATEGORY' : 'CHANNEL';
    const entry = registered.get(channel.key);
    if (entry !== undefined) {
      const current = entry.discordId === null ? undefined : byIdChannel.get(entry.discordId);
      if (
        entry.resourceType === resourceType &&
        current !== undefined &&
        channelKindCompatible(channel.effectiveKind, current.kind)
      ) {
        alreadyMapped.push({
          logicalKey: channel.key,
          resourceType,
          discordId: current.id,
          name: current.name,
          ...(channel.integration === undefined ? {} : { integration: channel.integration }),
        });
      } else {
        missing.push({ logicalKey: channel.key, name: channel.name });
      }
      continue;
    }

    const matches = channels.filter(
      (candidate) =>
        !claimedChannelIds.has(candidate.id) &&
        !selectedChannelIds.has(candidate.id) &&
        channelKindCompatible(channel.effectiveKind, candidate.kind) &&
        normalizeName(candidate.name) === normalizeName(channel.name),
    );
    if (matches.length > 1) {
      ambiguous.push({ logicalKey: channel.key, name: channel.name, matches: matches.length });
    } else if (matches.length === 0) {
      missing.push({ logicalKey: channel.key, name: channel.name });
    } else {
      const match = matches[0];
      if (match === undefined) continue;
      selectedChannelIds.add(match.id);
      adopted.push({
        logicalKey: channel.key,
        resourceType,
        discordId: match.id,
        name: match.name,
        ...(channel.integration === undefined ? {} : { integration: channel.integration }),
      });
    }
  }

  return { adopted, alreadyMapped, missing, ambiguous };
}

function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

function channelKindCompatible(
  expected: 'category' | 'text' | 'announcement' | 'forum' | 'voice',
  actual: AdoptionChannel['kind'],
): boolean {
  if (expected === 'category') return actual === 'category';
  if (expected === 'text' || expected === 'announcement') {
    return actual === 'text' || actual === 'announcement';
  }
  return expected === actual;
}
