import {
  banFromTxAdmin,
  type Identifier,
  isPlayerSource,
  isUnreachableStatus,
  newEventId,
  parseFailMode,
  parseIdentifiers,
  restartFromTxAdmin,
  UNAVAILABLE_MESSAGE,
  UNVERIFIED_MESSAGE,
} from './events';
import { type BridgeConfig, callXenon, readConfig, verifyFromXenon } from './xenon';

/**
 * xenon_bridge.
 *
 * Three jobs:
 *
 *  1. Gate connections on the whitelist Xenon holds, keyed on the `fivem:`
 *     (Cfx.re account) identifier the player verified on the Xenon website.
 *     There is no in-game linking step.
 *  2. Answer Xenon's signed requests for status, whitelist pushes and presence.
 *  3. Forward gameplay events (joins, drops, txAdmin restarts and bans) to
 *     Xenon, best-effort.
 *
 * It deliberately owns no state. The whitelist is not cached to a local file,
 * there is no local player table, and nothing here decides who may play -
 * Xenon is the source of truth and this resource is the part of it that runs
 * on the game server.
 *
 * Framework-agnostic on purpose. Nothing below knows or cares whether the
 * server runs QBCore, QBX, ESX or nothing at all; the adapter kind configured
 * in Xenon is for the framework-specific work an operator adds here, not for
 * anything the protocol needs.
 */

const config: BridgeConfig | null = readConfig();
const failMode = parseFailMode(GetConvar('xenon_fail_mode', 'open'));

/**
 * Identifiers FXServer reports for a connected player, normalised to Xenon's
 * shape. Always read server-side through the natives: an identifier a client
 * sends in an event payload proves nothing.
 */
function identifiersFor(source: number): Identifier[] {
  const raw: string[] = [];
  for (let index = 0; index < GetNumPlayerIdentifiers(String(source)); index += 1) {
    raw.push(GetPlayerIdentifier(String(source), index));
  }
  return parseIdentifiers(raw);
}

if (config === null) {
  console.error(
    '[xenon_bridge] Not configured. Set xenon_endpoint and xenon_secret in server.cfg. ' +
      'Connections are NOT being gated.',
  );
} else {
  console.log(`[xenon_bridge] Connected to ${config.endpoint} as "${config.slug}"`);
}

if (!failMode.recognised) {
  console.error(
    '[xenon_bridge] Unrecognised xenon_fail_mode; expected "open" or "closed". Failing CLOSED.',
  );
}
console.log(
  failMode.mode === 'open'
    ? '[xenon_bridge] Fail mode: OPEN - players are admitted without a check while Xenon is unreachable.'
    : '[xenon_bridge] Fail mode: CLOSED - players are refused while Xenon is unreachable.',
);

/**
 * Settle a connection when the whitelist could not be checked: admit in open
 * mode, refuse with a retry message in closed mode. Logged either way.
 */
function settleUnchecked(deferrals: Deferrals, name: string, why: string): void {
  if (failMode.mode === 'closed') {
    console.error(`[xenon_bridge] ${why}; refusing ${name} (fail mode closed).`);
    deferrals.done(UNAVAILABLE_MESSAGE);
    return;
  }
  console.error(`[xenon_bridge] ${why}; admitting ${name} without a whitelist check.`);
  deferrals.done();
}

// --- Connect gate ------------------------------------------------------------

on('playerConnecting', (name: string, _setReason: unknown, deferrals: Deferrals) => {
  // Read once, synchronously: `source` is a global FXServer reuses for the
  // next event, and everything below this line is asynchronous.
  const connecting = source;
  deferrals.defer();

  void (async (): Promise<void> => {
    if (config === null) {
      // Unconfigured means "not gating", not "refuse everybody". An operator
      // who has not finished setting the bridge up should still have a server.
      deferrals.done();
      return;
    }

    deferrals.update('Checking your Xenon whitelist...');

    const identifiers = identifiersFor(connecting);
    if (identifiers.length === 0) {
      deferrals.done('Could not read your game identifiers. Restart FiveM and try again.');
      return;
    }

    const response = await callXenon<{
      ok: boolean;
      allowed: boolean;
      publicId: string | null;
      reason: string | null;
    }>(config, '/api/bridge/whitelist', { identifiers });

    if (!response.ok || response.body === null) {
      if (!isUnreachableStatus(response.status)) {
        // Xenon answered and refused the request itself (signature, replay,
        // rate limit, malformed). That is not an outage, so it never opens
        // the gate regardless of the fail mode.
        console.error(
          `[xenon_bridge] Whitelist check refused by Xenon (status ${String(response.status)}); refusing ${name}.`,
        );
        deferrals.done(UNVERIFIED_MESSAGE);
        return;
      }
      /*
       * Xenon is unreachable.
       *
       * The default is to fail OPEN, and say so in the log: the alternative is
       * that a website outage empties the city, which is a far worse and far
       * more visible failure than a handful of unwhitelisted connections
       * during a few minutes of downtime. Whitelist state is re-checked on
       * every connection, so the gate closes again the moment Xenon returns.
       *
       * `set xenon_fail_mode "closed"` refuses instead. Make that choice
       * knowingly.
       */
      settleUnchecked(deferrals, name, `Xenon unreachable (status ${String(response.status)})`);
      return;
    }

    if (!response.body.allowed) {
      deferrals.done(
        response.body.reason ??
          'You are not whitelisted. Apply at the Xenon website and connect once you are approved.',
      );
      return;
    }

    deferrals.done();
  })().catch((error: unknown) => {
    console.error('[xenon_bridge] Connect check threw', error);
    settleUnchecked(deferrals, name, 'Connect check threw');
  });
});

// --- Event forwarding --------------------------------------------------------

/**
 * Forward one gameplay event to Xenon. Best-effort: a failure is logged and
 * dropped, never retried in a loop and never allowed to touch gameplay. The
 * event id makes a duplicate delivery harmless on Xenon's side.
 *
 * Every handler below uses `on` (server-local), never `onNet`, so a client
 * cannot raise these events directly.
 */
function forward(event: { type: string } & Record<string, unknown>): void {
  if (config === null) return;

  void callXenon<{ ok?: boolean; error?: string }>(config, '/api/bridge/events', {
    ...event,
    eventId: newEventId(),
    serverSlug: config.slug,
  }).then((response) => {
    if (!response.ok) {
      console.warn(
        `[xenon_bridge] ${event.type} not recorded by Xenon (status ${String(response.status)})`,
      );
    }
  });
}

on('playerJoining', () => {
  const player = source;
  const identifiers = identifiersFor(player);
  if (identifiers.length === 0) return;

  forward({
    type: 'PLAYER_CONNECTED',
    identifiers,
    playerName: GetPlayerName(String(player)).trim().slice(0, 64),
  });
});

on('playerDropped', (reason: string) => {
  // Read now: once this handler returns the player's identifiers are gone.
  const player = source;
  const identifiers = identifiersFor(player);
  if (identifiers.length === 0) return;

  forward({
    type: 'PLAYER_DISCONNECTED',
    identifiers,
    playerName: GetPlayerName(String(player)).trim().slice(0, 64),
    reason: typeof reason === 'string' ? reason.trim().slice(0, 200) : '',
  });
});

/*
 * txAdmin raises these server-side. A player `source` means a client got the
 * event to fire (another resource registering it as a net event would allow
 * that), so it is ignored rather than trusted.
 *
 * The ban's identifiers come from txAdmin's own server-side payload. Xenon only
 * records the ban as a FiveM-scope moderation case; txAdmin keeps enforcing it
 * in its own playerConnecting handler, and nothing here overrides that.
 */
on('txAdmin:events:scheduledRestart', (payload: unknown) => {
  if (isPlayerSource(source)) {
    console.warn('[xenon_bridge] Ignored txAdmin restart event raised by a player');
    return;
  }
  const event = restartFromTxAdmin(payload);
  if (event !== null) forward({ ...event });
});

on('txAdmin:events:playerBanned', (payload: unknown) => {
  if (isPlayerSource(source)) {
    console.warn('[xenon_bridge] Ignored txAdmin ban event raised by a player');
    return;
  }
  const event = banFromTxAdmin(payload, Math.floor(Date.now() / 1000));
  if (event === null) {
    console.warn('[xenon_bridge] txAdmin ban event carried no usable identifiers; not forwarded');
    return;
  }
  forward({ ...event });
});

// --- Inbound endpoints -------------------------------------------------------

/**
 * Xenon calls these. Every one is HMAC-verified before it is acted on: an
 * unauthenticated caller must not be able to read who is connected or flip
 * somebody's whitelist.
 *
 * The whitelist push is accepted and acknowledged without being stored,
 * because this resource holds no whitelist - it asks Xenon on every connect.
 * Acknowledging keeps Xenon's sync state accurate, which is what the health
 * page reads.
 */
setHttpHandler((request: HttpRequest, response: HttpResponse) => {
  const finish = (status: number, body: unknown): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.send(JSON.stringify(body));
  };

  if (config === null) {
    finish(503, { ok: false, error: 'Bridge is not configured' });
    return;
  }

  if (request.method !== 'POST') {
    finish(405, { ok: false, error: 'Method not allowed' });
    return;
  }

  request.setDataHandler((raw: string) => {
    if (!verifyFromXenon(config, raw, request.headers)) {
      finish(401, { ok: false, error: 'Unauthorised' });
      return;
    }

    const path = request.path.split('?')[0] ?? '';

    switch (path) {
      case '/xenon/status': {
        const players = getPlayers();
        finish(200, {
          ok: true,
          players: players.length,
          maxPlayers: Number.parseInt(GetConvar('sv_maxclients', '48'), 10),
          queue: 0,
        });
        return;
      }

      case '/xenon/whitelist': {
        // Acknowledged, not stored. See the note above.
        finish(200, { ok: true });
        return;
      }

      case '/xenon/presence': {
        const body = JSON.parse(raw) as { identifiers?: string[] };
        const wanted = new Set((body.identifiers ?? []).map((value) => value.toLowerCase()));

        const online = getPlayers().some((player) =>
          identifiersFor(Number(player)).some((identifier) =>
            wanted.has(`${identifier.kind.toLowerCase()}:${identifier.value}`),
          ),
        );

        finish(200, { ok: true, online });
        return;
      }

      default:
        finish(404, { ok: false, error: 'Unknown endpoint' });
    }
  });
});

// --- Presence push -----------------------------------------------------------

/**
 * Push status to Xenon every minute.
 *
 * Xenon also polls, and polling is primary because a crashed server cannot
 * report that it has crashed. This exists for servers behind NAT that Xenon
 * cannot reach but which can reach out.
 */
if (config !== null) {
  setInterval(() => {
    void callXenon(config, '/api/bridge/presence', {
      slug: config.slug,
      players: getPlayers().length,
      maxPlayers: Number.parseInt(GetConvar('sv_maxclients', '48'), 10),
    }).catch(() => undefined);
  }, 60_000);
}

/** Exported for other resources: a synchronous whitelist question is not one
 *  this bridge can answer, so it is deliberately absent. Ask Xenon instead. */
export function isWhitelisted(): never {
  throw new Error(
    'xenon_bridge does not cache whitelist state. Gate on playerConnecting, which asks Xenon.',
  );
}
