# Security

What is defended, how, and where the decision lives. Every control named here
is enforced on the server.

---

## The rule everything else follows

**A button is not an authorization boundary.**

Hiding a control is presentation. Every mutation re-checks the capability
server-side, in the domain service rather than at the call site, so a Discord
command or a worker that reaches the same function cannot arrive without one.

That placement is load-bearing: `setUserStatus` once checked nothing itself and
relied on the web action to check. The product was not exploitable, because the
only caller checked — but the next caller would not have. The check now lives in
the service.

---

## Authentication

- **Discord OAuth2** via Auth.js, database sessions, no JWTs in cookies.
- Identity is the **snowflake**, never the username. Usernames change and are
  re-usable; treating one as an identity eventually hands a stranger somebody
  else's whitelist.
- Cookies are `httpOnly`, `sameSite=lax`, and `secure` over HTTPS.
- OAuth **state** is verified by Auth.js on the callback.
- Sign-in is rate limited: 10 attempts per 5 minutes.
- Sanctioning an account **deletes its session rows**, so a ban takes effect
  now rather than at the next session expiry.

### The development sign-in route

`/api/dev/session` creates a real session for a fixture account. It has three
independent guards:

1. `AUTH_DEV_LOGIN` **and** a non-production `NODE_ENV`. A leaked flag in
   production does nothing.
2. Only Discord snowflakes in the fixture range (`9000000000000000…`), which
   Discord does not issue. It cannot be pointed at a real staff account even in
   development.
3. Returns **404**, not 403, when disabled. The route does not advertise that
   it exists.

---

## Authorization

Capability-based, not role-based. Roles are bundles of capabilities; code asks
for a capability.

- `Actor` carries capabilities resolved **from the database** at request time,
  never from Discord role membership observed at call time.
- `requirePermission` **throws**. A forgotten `if` is invisible; a forgotten
  `await require…` is not, and its failure mode is a refused request rather
  than a silent bypass.
- Ownership and capability are combined in one helper
  (`requireOwnerOrPermission`) so no call site gets the precedence subtly wrong.

### Privilege escalation

Two guards, both necessary, on every role change:

| Guard      | Stops                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------ |
| Priority   | A moderator promoting somebody to administrator                                            |
| Capability | Granting a capability you do not hold via a lower-priority role that happens to contain it |

Bootstrapping requires **database access**, not merely a session:

```bash
pnpm --filter @xenon/database grant-owner <discord-user-id>
```

See [PERMISSIONS.md](PERMISSIONS.md).

---

## Input handling

- Every input is parsed with Zod at the boundary. Unparsed input never reaches a
  service.
- Rich text is sanitized against an **allow-list**, not a deny-list.
- Client-supplied IDs are never trusted: ownership is re-read from the
  database.
- Public identifiers require context. `1842` alone is refused rather than
  resolved — guessing would return an unrelated record.
- Unknown answer keys in an autosave payload are skipped. A stale client or a
  tampered payload has nothing legitimate to store.

### Uploads

- Type is decided by **magic-number sniffing**, not by the declared MIME type
  or the extension.
- Size and count are bounded per question.
- The local driver has a path-traversal guard; the R2 driver is the only file
  that imports the S3 SDK.
- 40 uploads per hour per user.

---

## Transport and headers

Set in `next.config.ts` for every route:

| Header                      | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| `Content-Security-Policy`   | Written out explicitly; `frame-ancestors 'none'`        |
| `X-Content-Type-Options`    | `nosniff`                                               |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                       |
| `X-Frame-Options`           | `DENY`                                                  |
| `Permissions-Policy`        | camera, microphone, geolocation, interest-cohort off    |
| `Strict-Transport-Security` | 2 years, `includeSubDomains; preload` — production only |

Two CSP allowances are looser than they look, deliberately:

- `'unsafe-inline'` on `style-src` is required by Next's critical-CSS inlining
  and by Radix setting positioning styles on portalled elements. Style
  injection is a defacement risk, not a script-execution one; the alternative
  is a nonce plumbed through every component.
- `'unsafe-eval'` is allowed **in development only**, for React Refresh.
  Production gets neither.

Nothing on the site may be framed. The control centre has destructive buttons,
and clickjacking is exactly how they get clicked.

CSRF is covered by Next server actions (origin-checked) plus `sameSite=lax`
cookies.

---

## The FiveM bridge

The only unauthenticated surface, so it carries its own four checks:

1. **The secret is configured.** Without it the endpoint returns 503 rather
   than existing with authentication disabled.
2. **HMAC-SHA256 over the exact bytes**, plus the timestamp and nonce, so
   nothing can be altered without invalidating the signature. Compared with
   `timingSafeEqual`, length-checked first.
3. **Timestamp inside 5 minutes.** Wide enough for a badly synced game box,
   narrow enough that a captured request is useless by the time it is found.
4. **Nonce not seen before**, recorded in Redis so replay defence holds across
   every web instance rather than per process. Recorded **only after** the
   signature passes, so an unauthenticated flood cannot fill the cache.

If Redis is down the request is accepted on signature and timestamp alone, and
that is logged. The request is authentic and at most five minutes old; refusing
every connecting player because the replay cache is unavailable would be worse.

Deliberately not JWT: there is no third party, no key-rotation story needed for
a single shared secret, and a signature over exact bytes is easier to reason
about than a token format with a decade of parser bugs.

---

## Rate limiting

Fixed-window, in Redis, **fail-open**. A Redis outage must not make the site
unusable, and everything behind these limits is additionally authorized and
audited — the limit is an abuse control, not an authorization boundary.

| Bucket             | Limit | Window |
| ------------------ | ----- | ------ |
| Sign-in            | 10    | 5 min  |
| Start application  | 10    | 1 hour |
| Submit application | 6     | 1 hour |
| Autosave           | 240   | 5 min  |
| Issue link code    | 5     | 15 min |
| Redeem link code   | 20    | 5 min  |
| Bridge request     | 600   | 1 min  |
| Create ticket      | 5     | 1 hour |
| Reply to ticket    | 30    | 10 min |
| Create report      | 5     | 1 hour |
| Create appeal      | 3     | 24 h   |
| Search             | 120   | 1 min  |
| Upload             | 40    | 1 hour |

---

## Data handling

- **IP addresses are never stored raw.** A peppered SHA-256 is recorded for
  abuse correlation. Without `HASH_PEPPER` a stored hash of an IPv4 address is
  trivially reversible by brute force, which is why production refuses to start
  without it.
- **Link codes are never stored.** Only the SHA-256, plus a two-character hint
  for support correlation. The audit entry records the hint, never the code.
- The logger redacts centrally, so a secret cannot be logged by a call site
  that forgot.
- Audit `before`/`after` projections carry safe fields only — never secrets,
  never tokens.
- Internal staff notes are filtered **at the query**, not in the view. A
  component that forgets to filter is a leak; a query that never returns them
  is not.

---

## Audit

Every consequential action writes an `AuditLog` row: actor, a preserved actor
label, source (`WEB` / `DISCORD` / `FIVEM` / `SYSTEM`), entity, before, after,
hashed IP.

The label is preserved separately so the log stays readable after an account is
deleted and `actorId` becomes null.

Applications additionally write `ApplicationEvent` rows, giving the applicant a
timeline and staff a decision history.

Readable at `/control → Audit` with the `audit.view` capability.

---

## Ordering: canonical state first

Postgres commits, then external effects are enqueued.

An approval writes the status, the granted roles and the whitelist **in one
transaction**, so an approval can never be recorded without the access it
promises. Discord and FXServer are told afterwards by jobs that retry.

Discord being down costs a message. It never costs the approval. There is an
integration test that runs an entire file with the queue dead and asserts
exactly this.

---

## Production configuration

The config layer refuses to start a production process with any of these
missing, rather than running degraded without saying so:

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`,
`R2_PUBLIC_URL`, `TURNSTILE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`,
`FIVEM_BRIDGE_SECRET`, `HASH_PEPPER`.

`next build` is exempt — it renders pages to discover their shape, in CI,
deliberately without real credentials. This does not weaken the guard: the same
schema is parsed again when the server process starts, and it fails there,
loudly, before serving a request.

---

## Reporting a vulnerability

Do not open a public issue. Contact a platform administrator through the
community's staff channel with enough detail to reproduce.
