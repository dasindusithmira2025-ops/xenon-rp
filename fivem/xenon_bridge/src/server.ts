import { type BridgeConfig, callXenon, readConfig, verifyFromXenon } from './xenon';

/**
 * xenon_bridge.
 *
 * Three jobs:
 *
 *  1. Gate connections on the whitelist Xenon holds.
 *  2. Let a player redeem a link code with `/link`.
 *  3. Answer Xenon's signed requests for status, whitelist pushes and presence.
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

/** Identifiers FXServer reports, as `kind:value`, normalised to Xenon's shape. */
function identifiersFor(source: number): { kind: string; value: string }[] {
  const known = new Set(['license', 'license2', 'steam', 'discord', 'fivem', 'xbl', 'live']);
  const output: { kind: string; value: string }[] = [];

  for (let index = 0; index < GetNumPlayerIdentifiers(String(source)); index += 1) {
    const raw = GetPlayerIdentifier(String(source), index);
    const separator = raw.indexOf(':');
    if (separator <= 0) continue;

    const prefix = raw.slice(0, separator).toLowerCase();
    if (!known.has(prefix)) continue;

    output.push({ kind: prefix.toUpperCase(), value: raw.slice(separator + 1) });
  }

  return output;
}

if (config === null) {
  console.error(
    '[xenon_bridge] Not configured. Set xenon_endpoint and xenon_secret in server.cfg. ' +
      'Connections are NOT being gated.',
  );
} else {
  console.log(`[xenon_bridge] Connected to ${config.endpoint} as "${config.slug}"`);
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
      /*
       * Xenon is unreachable.
       *
       * Fail OPEN, and say so in the log. This is a deliberate choice and the
       * reasoning matters: the alternative is that a website outage empties
       * the city, which is a far worse and far more visible failure than a
       * handful of unwhitelisted connections during a few minutes of
       * downtime. Whitelist state is re-checked on every connection, so the
       * gate closes again the moment Xenon returns.
       *
       * Operators who would rather fail closed can change `done()` below to
       * `done('...')`. Make that choice knowingly.
       */
      console.error(
        `[xenon_bridge] Xenon unreachable (status ${String(response.status)}); ` +
          `admitting ${name} without a whitelist check.`,
      );
      deferrals.done();
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
    deferrals.done();
  });
});

// --- /link -------------------------------------------------------------------

RegisterCommand(
  'link',
  (source: number, args: string[]) => {
    const reply = (message: string): void => {
      if (source === 0) console.log(`[xenon_bridge] ${message}`);
      else emitNet('chat:addMessage', source, { args: ['[Xenon]', message] });
    };

    if (config === null) {
      reply('Account linking is not configured on this server.');
      return;
    }

    const code = args[0];
    if (code === undefined) {
      reply('Usage: /link XEN-7K4P9 — generate a code in your Xenon portal first.');
      return;
    }

    void (async (): Promise<void> => {
      const response = await callXenon<{
        ok: boolean;
        publicId?: string;
        displayName?: string | null;
        error?: string;
      }>(config, '/api/bridge/link', {
        code,
        identifiers: identifiersFor(source),
        playerName: GetPlayerName(String(source)),
      });

      if (response.body?.ok === true) {
        reply(
          `Linked to ${response.body.displayName ?? response.body.publicId ?? 'your Xenon account'}. ` +
            'Reconnect for your whitelist to take effect.',
        );
        return;
      }

      reply(
        response.body?.error ??
          'Could not reach Xenon. Try again in a moment, or open a support ticket.',
      );
    })().catch((error: unknown) => {
      console.error('[xenon_bridge] /link threw', error);
      reply('Something went wrong. Try again in a moment.');
    });
  },
  false,
);

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
