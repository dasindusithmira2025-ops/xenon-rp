import { IntegrationError } from '@xenon/core';
import type { GameIdentityKind, GameServerAdapterKind } from '@xenon/database';

/**
 * The game-server boundary.
 *
 * Xenon does not know or care which framework the city runs. Standalone,
 * QBCore, QBX and ESX all differ in how they store a player, but they agree on
 * the three things the platform actually needs: who is connected, whether an
 * identifier is allowed in, and whether the server is up. Those three are this
 * interface; everything framework-specific is an implementation of it.
 *
 * Without this boundary, "we migrated from ESX to QBX" would be a rewrite of
 * the whitelist, the linking flow and the status page rather than one new file.
 */

export interface GameIdentifier {
  readonly kind: GameIdentityKind;
  readonly value: string;
}

export interface ServerStatusReading {
  readonly online: boolean;
  readonly playerCount: number | null;
  readonly maxPlayers: number | null;
  readonly queueLength: number | null;
  readonly latencyMs: number | null;
  readonly error: string | null;
}

export interface WhitelistPush {
  readonly identifiers: readonly GameIdentifier[];
  readonly allowed: boolean;
  readonly reason: string | null;
  /** Xenon's public identifier, so server-side logs are traceable back here. */
  readonly publicId: string;
}

export interface GameServerAdapter {
  readonly kind: GameServerAdapterKind;
  /** Probe the server. Must never throw: an outage is a reading, not an error. */
  status(): Promise<ServerStatusReading>;
  /** Push one player's whitelist state. Throws on failure so the job retries. */
  pushWhitelist(push: WhitelistPush): Promise<void>;
  /** Ask the server who is currently connected under a given identifier. */
  isOnline(identifiers: readonly GameIdentifier[]): Promise<boolean>;
}

/** FXServer reports identifiers as `steam:110000112345678`. Split that apart. */
export function parseIdentifier(raw: string): GameIdentifier | null {
  const index = raw.indexOf(':');
  if (index <= 0) return null;

  const prefix = raw.slice(0, index).toUpperCase();
  const value = raw.slice(index + 1);
  if (value.length === 0) return null;

  const kinds: Record<string, GameIdentityKind> = {
    LICENSE: 'LICENSE',
    LICENSE2: 'LICENSE2',
    STEAM: 'STEAM',
    DISCORD: 'DISCORD',
    FIVEM: 'FIVEM',
    XBL: 'XBL',
    LIVE: 'LIVE',
  };

  const kind = kinds[prefix];
  return kind === undefined ? null : { kind, value };
}

/** Render back into the `kind:value` form FXServer uses. */
export function formatIdentifier(identifier: GameIdentifier): string {
  return `${identifier.kind.toLowerCase()}:${identifier.value}`;
}

/**
 * Development adapter.
 *
 * Reports a server that is up and empty, and accepts every whitelist push. It
 * exists so the whole approval-to-whitelist flow can be exercised end to end
 * with no FXServer anywhere - which is what makes the integration testable.
 *
 * It never invents a player count. `playerCount: 0` here means "the mock has
 * nobody connected", and the status page labels a mock server as such.
 */
export class MockGameServerAdapter implements GameServerAdapter {
  readonly kind = 'MOCK' as const;

  /** Whitelist pushes seen so far. Assertions in tests read this. */
  readonly pushes: WhitelistPush[] = [];

  constructor(private readonly options: { failNext?: boolean } = {}) {}

  status(): Promise<ServerStatusReading> {
    return Promise.resolve({
      online: true,
      playerCount: 0,
      maxPlayers: 64,
      queueLength: 0,
      latencyMs: 1,
      error: null,
    });
  }

  pushWhitelist(push: WhitelistPush): Promise<void> {
    if (this.options.failNext === true) {
      return Promise.reject(
        new IntegrationError('fivem', 'Mock adapter configured to fail', { retryable: true }),
      );
    }
    this.pushes.push(push);
    return Promise.resolve();
  }

  isOnline(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
