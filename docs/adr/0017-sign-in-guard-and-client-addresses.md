# 17. Sign-in guard and client addresses

Status: Accepted - 2026-11-21

## Context

Every sign-in ran Argon2id (19 MiB, about 31 ms of CPU), up to 64 at once,
behind one global back-off. 64 wrong sign-ins took the server to 1.3 GB and
the back-off then refused everyone, the real administrator included. OPDS
shared the same back-off and counted requests without credentials as
failures. Limiting by client needs to know the client, and `X-Forwarded-For`
was never read.

## Decision

### Client addresses

- The client is the TCP peer unless the peer is a trusted proxy. Then it is
  the rightmost untrusted entry of one configured header (`forwardedHeader`:
  `x-forwarded-for` by default, or `forwarded`), read from the right so a
  client's own text can't change the proxy's entry.
- With `trustedProxies` unset, client addresses trust loopback only, while
  scheme and host detection keeps trusting private networks so proxied setups
  keep working. Setting `trustedProxies` replaces both. Proxy trust is
  configuration only, never stored in `citadel.db`.
- While `trustedProxies` is unset, an untrusted private-network peer that
  sends forwarding headers is probably an unconfigured proxy: it is logged
  once a minute, and its clients get no address bans (only the username
  limit applies) until it is configured.

### Sign-in guard

One guard judges browser sign-in, the setup code and OPDS device keys. It
never reads the database, so real and unknown usernames are treated alike.

- **Per address:** a client (`/32` or `/64`) may fail 100 times an hour, its
  network (`/24`, `/56`, `/48`) 400 to 1,000. Then it is banned for an hour,
  doubling up to a day.
- **Per username:** 10 guesses, then one every 30 s, answered 429 with
  `Retry-After`. Nobody is locked out.
- **Known devices** skip the username limit, each with 20 failures an hour of
  its own: a browser by a signed cookie (90 days), an e-reader by its
  address (30 days, in memory).
- **Repeats:** the same wrong credential from the same client counts once per
  10 minutes and isn't checked again.
- **Order:** limits are charged before any hashing. Argon2 runs on 2
  dedicated threads with a small queue that serves known devices first and
  takes turns between networks; when full, 503. Its memory goes back to the
  OS after each check.
- **OPDS** uses the guard but not the pool (its key check is cheap), ignores
  requests without credentials, and always hashes the key so timing doesn't
  reveal usernames.

All numbers are constants. This follows OWASP's device-cookie approach and
deliberately departs from NIST SP 800-63B-4 §3.2.2, which disables an
authenticator after 100 consecutive failures: on a home server, a lockout is
something anyone can trigger against the administrator.

## Consequences

- A flood costs at most 2 Argon2 checks at a time, and nobody else is locked
  out. A username under attack is slowed only for new devices.
- With generated device keys (about 30.5 bits, ADR 0013), the username limit
  holds a guesser to about 0.07 % per key per year, however many addresses
  they use.
- Clients behind an unconfigured proxy share one address until the proxy is
  added to `trustedProxies`.
- Changing a password to a value the same client just tried is refused there
  for up to 10 minutes.
