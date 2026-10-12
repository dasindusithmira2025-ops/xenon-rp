# Cfx.re account linking (website-first)

Players link FiveM to Xenon on the website. Nobody has to join the server or
type a command before they are whitelisted:

```
Discord login → join the Discord → Connect Cfx.re → profile → rules → application → approval → connect
```

## The method: Discourse User API keys on forum.cfx.re

Cfx.re has no public OAuth for third parties. Its forum (forum.cfx.re) runs
Discourse, which supports **User API keys**
([specification](https://meta.discourse.org/t/user-api-keys-specification/48536)).
The FiveM client, txAdmin and community projects use the same mechanism for
"Log in with Cfx.re"
([forum thread](https://forum.cfx.re/t/login-with-cfx-re-fivem/4835893),
[reference implementation](https://github.com/TheCoati/Cfx.re-Socialite)).
Restricted Cfx IDMS OAuth is **not** used.

| Step | What happens                                                                                                                                                                                                                                                                                                                                                                                 | Code                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1    | The signed-in player submits **Connect Cfx.re** (same-origin POST).                                                                                                                                                                                                                                                                                                                          | `POST /api/v1/me/cfx/authorize`              |
| 2    | Xenon creates a `cfx_link_attempts` row: a fresh RSA-2048 key pair (private key sealed with AES-256-GCM, key derived from `AUTH_SECRET` via HKDF), SHA-256 of a 256-bit nonce, and SHA-256 of a 256-bit browser secret. Any older open attempt is superseded.                                                                                                                                | `startCfxLink` (`packages/fivem/src/cfx.ts`) |
| 3    | The browser gets an httpOnly, `SameSite=Lax`, `Secure` (production) cookie `xenon_cfx_link=<attemptId>.<browserSecret>` scoped to `/api/v1/me/cfx`, and a 303 to `https://forum.cfx.re/user-api-key/new?application_name=…&client_id=xenonrp-<attempt>&scopes=session_info&nonce=…&auth_redirect=<site>/api/v1/me/cfx/callback&public_key=<SPKI PEM>`.                                       |                                              |
| 4    | The player signs in to Cfx.re if needed and approves "Xenon Roleplay".                                                                                                                                                                                                                                                                                                                       | forum.cfx.re                                 |
| 5    | The forum redirects to the fixed callback with `payload` = base64(RSA-PKCS#1(public key, `{"key","nonce","push","api"}`)).                                                                                                                                                                                                                                                                   | `GET /api/v1/me/cfx/callback`                |
| 6    | Xenon checks: signed-in session, cookie attempt belongs to that account, browser secret matches (constant time), attempt unused (claimed atomically before anything else) and unexpired (10 min), payload decrypts, nonce matches.                                                                                                                                                           | `completeCfxLink`                            |
| 7    | Xenon calls `GET https://forum.cfx.re/session/current.json` with headers `User-Api-Key` and a `User-Agent` (the forum answers "User ID was null" without one) and reads `current_user.id` and `current_user.username`. The numeric id is the value FXServer reports as `fivem:<id>`.                                                                                                         | `httpCfxForum`                               |
| 8    | The key is revoked immediately (`POST /user-api-key/revoke`) whether or not the lookup succeeded. It is never stored or logged.                                                                                                                                                                                                                                                              |                                              |
| 9    | In one transaction: refuse if that Cfx.re id is actively linked to another account, refuse if this account already has a different Cfx.re link, otherwise upsert `game_identities` (`kind FIVEM`, `linkedVia CFX`, `verifiedAt`, label = username), write an audit row, emit `PLAYER_IDENTITY_LINKED` (no ids in the payload) and queue a whitelist push. The attempt's sealed key is wiped. |                                              |
| 10   | 303 to `/portal/account?cfx=linked` (or a fixed failure key); onboarding progress refreshes.                                                                                                                                                                                                                                                                                                 |                                              |

Cancel and retry: **Cancel** (`POST /api/v1/me/cfx/cancel`) closes the
attempt. Returning from the forum without approving is recorded as
cancelled. **Unlink** (`POST /api/v1/me/cfx/unlink` with the typed phrase
`UNLINK`) marks the identity unlinked (kept for audit), queues a whitelist push
and blocks admission until the player links again, which needs a fresh
Cfx.re authorization.

### Threats and the control for each

| Threat                                                                                    | Control                                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSRF on start/cancel/unlink                                                               | Same-origin `Origin` check; cookies `SameSite=Lax`.                                                                                                            |
| Callback replay / double submit                                                           | Attempt claimed with `UPDATE … WHERE consumedAt IS NULL` before decryption.                                                                                    |
| Stale callback                                                                            | 10-minute expiry; a new attempt supersedes the old one.                                                                                                        |
| Link substitution (attacker's payload into victim's session, or victim's into attacker's) | Attempt is owned by one account and bound to one browser secret; the payload is encrypted to that attempt's one-time key; nonce must match.                    |
| Open redirect                                                                             | The callback URL is fixed server-side; every outcome redirects to `/portal/account?cfx=<fixed key>`.                                                           |
| Duplicate mapping                                                                         | `@@unique([kind, value])` on `game_identities` plus explicit conflict checks in the transaction.                                                               |
| Leaking provider material                                                                 | Payload and key never logged; key revoked; private key sealed and wiped; callback responses send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. |
| PKCS#1 v1.5 decryption oracle                                                             | Each key pair decrypts at most one payload and is destroyed; nothing to query.                                                                                 |
| Self-declared identity                                                                    | Usernames, URLs or ids typed by the player are never accepted.                                                                                                 |
| Concurrent links of the same Cfx.re id                                                    | Insert loses on the unique index; reclaiming an unlinked row is a guarded update. Exactly one link wins (tested).                                              |
| Ban evasion (banned player frees their Cfx.re id for a new Xenon account)                 | Self-unlink is refused unless the account is ACTIVE; a row owned by a sanctioned account is never reclaimed by another account.                                |

**Residual risk — key injection.** The nonce proves the payload is for this
attempt, but RSA encryption is not authentication and the attempt's public
key and nonce are visible to the player who started it. Someone who obtains
another person's Cfx.re user API key with the `session_info` scope (for
example by getting them to approve a different app) could encrypt it for their
own attempt and link that person's Cfx.re account to themselves. Discourse
does not reveal which app a key was issued to, so this cannot be closed at the
protocol level. Impact is a lockout, not access: the attacker still connects
only as their own Cfx.re account, while the victim's link attempt answers
`conflict`. Recovery: staff with `players.manage` call
`POST /api/v1/players/<XN-id>/cfx-unlink` (`{"reason": "…"}`, audited) and the
owner links again.

## Admission (FiveM)

`xenon_bridge` sends the identifiers FXServer read with `GetPlayerIdentifier`
to `POST /api/bridge/whitelist` (HMAC-signed). `whitelistStateForIdentifiers`:

1. Takes the `fivem:` identifier if it is a valid numeric id.
2. Finds the active, linked Xenon identity for it. Rockstar licences count only
   if they were proven by the retired in-game flow or added by staff, and in
   `FIVEM_ADMISSION_MODE=cfx-only` only staff exceptions count. Discord, Steam
   and other client-reported ids never count.
3. Refuses identifier sets that resolve to more than one account.
4. Requires `status = ACTIVE` (platform bans and suspensions) and
   `whitelistState = APPROVED`.

txAdmin enforces its own bans in its own `playerConnecting` handler; Xenon
never overrides that. A refusal from Xenon (4xx, including rate limits) is never
treated as "unreachable", so it cannot open the gate in fail-open mode.

**Missing Cfx.re identifier.** The player is told to sign in to Cfx.re in
FiveM (Settings → Account) and reconnect. If that is impossible, the exception
is staff-only: staff add the player's Rockstar licence as a `STAFF` identity,
which is audited, and it admits in both modes. There is no self-service
bypass.

## Configuration

| Variable               | Where                        | Default                                                                                                                                    |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `CFX_FORUM_URL`        | web (build **and** run time) | `https://forum.cfx.re` (must be https in production). The CSP `form-action` is computed at build time, so a changed value needs a rebuild. |
| `CFX_APP_NAME`         | web                          | `Xenon Roleplay` (consent screen and the player's Cfx.re Apps tab)                                                                         |
| `FIVEM_ADMISSION_MODE` | web                          | `cfx-or-legacy`; switch to `cfx-only` once existing players have linked Cfx.re                                                             |

The callback is `${NEXT_PUBLIC_SITE_URL}/api/v1/me/cfx/callback` and **must be
https**. Probing the live forum showed it refuses `http://` redirect targets
(it renders "Sorry, we are unable to issue user API keys") and accepts `https://`
ones. On an http origin Xenon therefore refuses to start an attempt and shows
`?cfx=insecure-callback`; use an https tunnel or staging host to test against
the real forum. The site's CSP `form-action` includes the forum origin, because
the browser checks the redirect after the form post against it.

## What has and has not been verified

| Claim                                                                                                                   | Status                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forum.cfx.re/user-api-key/new` is live and speaks User API key **v4**                                                  | Checked from this environment: `HEAD` answers `Auth-Api-Version: 4`.                                                                                                                                                                        |
| PKCS#1 v1.5 RSA decryption works on the pinned Node/OpenSSL                                                             | Checked (Node 24, OpenSSL 3.5).                                                                                                                                                                                                             |
| Our side of the protocol (binding, nonce, single use, expiry, conflicts, revocation, persistence, transaction rollback) | Covered by `packages/integration-tests/src/cfx-linking.test.ts` against PostgreSQL with a forum **double**.                                                                                                                                 |
| forum.cfx.re validates our request (scope `session_info`, SPKI PEM public key, https `auth_redirect`)                   | Checked from this environment without signing in: our parameters get `302 → /login` (accepted, sign-in required); an http `auth_redirect` gets the error page. Our real authorize URL was opened in a browser and reached the forum's page. |
| forum.cfx.re, after a real sign-in and approval, returns a payload our code decrypts                                    | **Not verified.** Needs a real Cfx.re account (staging step 3). The complete browser flow was exercised against a local forum double (consent → callback → linked → unlink).                                                                |
| `session/current.json` returns `current_user.id` equal to the in-game `fivem:` id                                       | **Not verified here.** Documented by Cfx.re staff in the forum thread above; staging step 4 confirms it.                                                                                                                                    |
| A real FXServer admits / refuses through the bridge                                                                     | **Not verified.** Staging steps 5–7.                                                                                                                                                                                                        |

## Staging verification (required before production)

1. Deploy web with `NEXT_PUBLIC_SITE_URL` on the staging https origin, then run `pnpm db:deploy`.
2. Sign in with Discord on staging and open **Account**.
3. **Connect Cfx.re** → approve on forum.cfx.re → you land on `/portal/account?cfx=linked`. If the forum refuses the redirect, it is not on its allow-list and this method cannot be used on that origin; stop and report.
4. Check forum.cfx.re → your profile → **Preferences → Apps**: there should be no Xenon key left (it was revoked). Then run `SELECT value, label, "linkedVia", "verifiedAt" FROM game_identities WHERE kind='FIVEM'` and compare `value` with `https://forum.cfx.re/u/<username>.json` → `user.id`.
5. On a staging FXServer with `xenon_bridge`, connect signed in to Cfx.re **before** being whitelisted: you are refused with "not whitelisted yet". Also check the server console identifiers: `fivem:<same id>`.
6. Approve the application in `/control`, then connect again: you are admitted.
7. Ban the test player in txAdmin and connect: txAdmin refuses. Suspend the Xenon account and connect: Xenon refuses.
8. Sign out of Cfx.re in the FiveM client and connect: you see the "sign in to Cfx.re" message.
9. Try the negative paths in a browser: start in one browser and finish in another (`?cfx=mismatch`), approve after 10 minutes (`?cfx=expired`), link the same Cfx.re account from a second Xenon account (`?cfx=conflict`).
